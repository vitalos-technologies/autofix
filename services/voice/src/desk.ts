import type Anthropic from "@anthropic-ai/sdk";
import type { AutofixClient, AutofixSession } from "./autofix.js";
import type { RelayClaim } from "./claim.js";
import type { Engine, SummaryOutcome } from "./llm.js";
import { errorCode, type Logger } from "./log.js";
import { systemPrompt, type GarageProfile, type Service } from "./prompt.js";
import { runTool, toolDefinitions, type CallFacts, type ToolOutcome } from "./tools.js";

// One AI front desk call over Twilio ConversationRelay
// (https://www.twilio.com/docs/voice/conversationrelay/websocket-messages): Twilio turns the caller's
// speech into `prompt` messages and speaks the `text` tokens we stream back; `interrupt` means the caller
// talked over us; `end` hands the call back to Autofix's voice webhook (?step=relay) with HandoffData
// {"to":"hangup"} or {"to":"voicemail"}.
//
// When the socket closes the desk reports the minutes (report_usage, per started minute, counted once per
// CallSid) and writes the staff summary (log_call_summary). If Autofix or Claude cannot be reached the
// desk apologises and hands the caller to the voicemail. The conversation history is append-only; a reply
// the caller cut off is kept as the words they actually heard.

export type RelaySocket = { send(data: string): void; close(code?: number): void };

export type DeskDeps = {
  autofix: AutofixClient;
  engine: Engine;
  log: Logger;
  maxCallSeconds: number;
  now?: () => Date;
  /** Waits while the goodbye is spoken before hanging up. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
};

type Turn = { who: "caller" | "desk"; text: string };

const MAX_STEPS_PER_TURN = 6;
const MAX_CALLER_TURNS = 40;
const SUMMARY_TIMEOUT_MS = 15_000;
const E164 = /^\+[1-9]\d{6,14}$/;

export const LINES = {
  greeting: "What can I help you with?",
  unavailable: "Sorry, I can't reach the diary right now. Please leave a message after the tone and the team will call you back.",
  trouble: "Sorry, I'm having trouble with that. I'll ask the team to call you back. Goodbye.",
  wrapUp: "I'm sorry, I need to wrap up now. I'll ask the team to call you back. Goodbye.",
  refused: "Sorry, I can't help with that one. I'll ask the team to call you back. Goodbye.",
} as const;

class Interrupted extends Error {}

export class DeskCall {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startedAt: Date;
  private readonly messages: Anthropic.MessageParam[] = [];
  private readonly transcript: Turn[] = [];
  private readonly queue: string[] = [];
  private facts: CallFacts | null = null;
  private prepared: Promise<{ session: AutofixSession; system: string } | null> | null = null;
  private session: AutofixSession | null = null;
  private current: { controller: AbortController; spoken: string; heard: string | null } | null = null;
  private running = false;
  private ending = false;
  private finished = false;
  private booked = false;
  private callerTurns = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Resolves when the call is fully wrapped up (minutes and summary sent). */
  done: Promise<void>;
  private resolveDone: () => void = () => undefined;

  constructor(private readonly claim: RelayClaim, private readonly socket: RelaySocket, private readonly deps: DeskDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startedAt = this.now();
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }

  private ids() {
    return { garage_id: this.claim.garageId, call_sid: this.claim.callSid };
  }

  private send(message: Record<string, unknown>) {
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The caller has gone; close() wraps up.
    }
  }

  private say(text: string) {
    this.transcript.push({ who: "desk", text });
    this.send({ type: "text", token: text, last: true });
  }

  /** A message from Twilio (one WebSocket text frame). */
  handle(raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "setup":
        this.setup(message);
        break;
      case "prompt": {
        if (message.last === false || this.ending) return;
        const text = typeof message.voicePrompt === "string" ? message.voicePrompt.trim().slice(0, 2_000) : "";
        if (!text) return;
        this.transcript.push({ who: "caller", text });
        this.queue.push(text);
        // A new prompt while we are still talking means the caller moved on.
        this.current?.controller.abort(new Interrupted());
        void this.pump();
        break;
      }
      case "interrupt":
        if (this.current) {
          this.current.heard = typeof message.utteranceUntilInterrupt === "string" ? message.utteranceUntilInterrupt : this.current.spoken;
          this.current.controller.abort(new Interrupted());
        }
        break;
      case "error":
        this.deps.log.warn("relay_error", this.ids());
        break;
      default:
        break;
    }
  }

  private setup(message: Record<string, unknown>) {
    if (this.prepared) return;
    if (message.callSid !== this.claim.callSid) {
      this.deps.log.warn("setup_call_mismatch", this.ids());
      this.socket.close(1008);
      return;
    }
    const from = typeof message.from === "string" && E164.test(message.from) ? message.from : null;
    this.deps.log.info("call_started", { ...this.ids(), caller_known: Boolean(from) });
    this.prepared = this.prepare(from);
    this.timer = setTimeout(() => void this.wrapUp(), this.deps.maxCallSeconds * 1000);
    this.timer.unref?.();
    this.say(LINES.greeting);
    void this.prepared.then((ready) => {
      if (!ready) void this.handBack(LINES.unavailable, "voicemail");
    });
  }

  private async prepare(callerNumber: string | null) {
    try {
      const session = await this.deps.autofix.openSession(this.claim);
      this.session = session;
      const [profile, services] = await Promise.all([session.tool("garage_profile", {}), session.tool("list_services", {})]);
      if (profile.status !== 200) throw new Error(`garage_profile ${profile.status}`);
      const garage = profile.body as GarageProfile;
      const list = services.status === 200 ? ((services.body as { services?: Service[] }).services ?? []) : [];
      this.facts = { callSid: this.claim.callSid, callerNumber, timezone: garage.garage.timezone || "Europe/London" };
      return { session, system: systemPrompt({ profile: garage, services: list, now: this.now(), callerNumberKnown: Boolean(callerNumber) }) };
    } catch (error) {
      this.deps.log.error("prepare_failed", { ...this.ids(), error: errorCode(error) });
      return null;
    }
  }

  /** Runs the caller's queued words through the desk, one turn at a time. */
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.ending) {
        const words = this.queue.splice(0).join(" ");
        this.callerTurns += 1;
        if (this.callerTurns > MAX_CALLER_TURNS) {
          await this.handBack(LINES.wrapUp, "hangup");
          return;
        }
        this.messages.push({ role: "user", content: words });
        await this.turn();
      }
    } finally {
      this.running = false;
    }
  }

  private async turn() {
    const ready = await this.prepared;
    if (!ready || !this.facts || this.ending) return;
    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      if (this.queue.length) return; // the caller has said more: answer that instead
      const controller = new AbortController();
      const current = { controller, spoken: "", heard: null as string | null };
      this.current = current;
      let content: Anthropic.ContentBlock[];
      let stopReason: string | null;
      try {
        const result = await this.deps.engine.step({
          system: ready.system,
          messages: this.messages,
          tools: toolDefinitions,
          signal: controller.signal,
          onText: (text) => {
            if (controller.signal.aborted) return;
            current.spoken += text;
            this.send({ type: "text", token: text, last: false });
          },
        });
        content = result.content;
        stopReason = result.stopReason;
      } catch (error) {
        this.current = null;
        if (controller.signal.aborted) {
          // Keep only what the caller heard (append-only history; the cut-off step is not replayed).
          const heard = (current.heard ?? current.spoken).trim();
          if (heard) {
            this.messages.push({ role: "assistant", content: heard });
            this.transcript.push({ who: "desk", text: `${heard} [interrupted]` });
          }
          return;
        }
        this.deps.log.error("engine_failed", { ...this.ids(), error: errorCode(error) });
        await this.handBack(LINES.trouble, "hangup");
        return;
      }
      this.current = null;
      if (current.spoken) {
        this.send({ type: "text", token: "", last: true });
        this.transcript.push({ who: "desk", text: current.spoken.trim() });
      }
      if (stopReason === "refusal") {
        await this.handBack(LINES.refused, "hangup");
        return;
      }
      this.messages.push({ role: "assistant", content });
      const uses = content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (!uses.length) return;

      const results: Anthropic.ToolResultBlockParam[] = [];
      let end: ToolOutcome["end"];
      for (const use of uses) {
        let outcome: ToolOutcome;
        try {
          outcome = await runTool(use.name, (use.input ?? {}) as Record<string, unknown>, ready.session, this.facts);
        } catch (error) {
          this.deps.log.warn("tool_failed", { ...this.ids(), tool: use.name, error: errorCode(error) });
          outcome = { content: JSON.stringify({ status: 503, code: "UNAVAILABLE", message: "The garage system is temporarily unavailable. Offer a callback from the garage." }), isError: true };
        }
        this.deps.log.info("tool", { ...this.ids(), tool: use.name, error: outcome.isError });
        if (outcome.booked) this.booked = true;
        if (outcome.end) end = outcome.end;
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: outcome.isError });
      }
      this.messages.push({ role: "user", content: results });
      if (end) {
        await this.finishSpeaking(current.spoken);
        this.end(end === "voicemail" ? "voicemail" : "hangup");
        return;
      }
      if (stopReason === "max_tokens") {
        await this.handBack(LINES.trouble, "hangup");
        return;
      }
    }
    await this.handBack(LINES.trouble, "hangup");
  }

  /** Roughly how long the last words take to say, so the goodbye is not cut off. */
  private async finishSpeaking(text: string) {
    await this.sleep(Math.min(8_000, 700 + text.length * 60));
  }

  private end(to: "hangup" | "voicemail") {
    if (this.finished) return;
    this.ending = true;
    this.send({ type: "end", handoffData: JSON.stringify({ to }) });
  }

  private async handBack(line: string, to: "hangup" | "voicemail") {
    if (this.ending) return;
    this.ending = true;
    this.current?.controller.abort(new Interrupted());
    this.say(line);
    await this.finishSpeaking(line);
    this.ending = false;
    this.end(to);
  }

  private async wrapUp() {
    if (this.ending || this.finished) return;
    this.deps.log.info("call_too_long", this.ids());
    await this.handBack(LINES.wrapUp, "hangup");
  }

  /** The socket closed: report the minutes and the summary to Autofix. Never throws. */
  async close() {
    if (this.finished) return this.done;
    this.finished = true;
    this.ending = true;
    if (this.timer) clearTimeout(this.timer);
    this.current?.controller.abort(new Interrupted());
    try {
      const ready = this.prepared ? await this.prepared : null;
      const session = ready?.session ?? this.session;
      const endedAt = this.now();
      const seconds = Math.max(0, (endedAt.getTime() - this.startedAt.getTime()) / 1000);
      const minutes = Math.min(600, Math.max(1, Math.ceil(seconds / 60)));
      let outcome: SummaryOutcome = "dropped";
      if (session) {
        const usage = await session.tool("report_usage", { conversationId: this.claim.callSid, channel: "call", minutes, endedAt: endedAt.toISOString() }).catch(() => null);
        if (!usage || usage.status >= 300) this.deps.log.warn("usage_not_reported", { ...this.ids(), status: usage?.status ?? 0 });
        const note = await this.summary();
        outcome = note.outcome;
        const logged = await session.tool("log_call_summary", { callSid: this.claim.callSid, summary: note.summary, outcome: note.outcome }).catch(() => null);
        if (!logged || logged.status >= 300) this.deps.log.warn("summary_not_logged", { ...this.ids(), status: logged?.status ?? 0 });
      }
      this.deps.log.info("call_finished", { ...this.ids(), seconds: Math.round(seconds), minutes, caller_turns: this.callerTurns, booked: this.booked, outcome });
    } catch (error) {
      this.deps.log.error("close_failed", { ...this.ids(), error: errorCode(error) });
    } finally {
      this.resolveDone();
    }
    return this.done;
  }

  private async summary(): Promise<{ summary: string; outcome: SummaryOutcome }> {
    if (!this.transcript.some((turn) => turn.who === "caller")) {
      return { summary: "The caller hung up before saying what they wanted.", outcome: "dropped" };
    }
    const fallback = this.booked
      ? { summary: "A booking request was made on this call. Check Bookings to confirm it.", outcome: "booked" as const }
      : { summary: "The caller spoke to the AI front desk. Please call them back.", outcome: "callback" as const };
    const transcript = this.transcript.map((turn) => `${turn.who === "caller" ? "Caller" : "Assistant"}: ${turn.text}`).join("\n").slice(-12_000);
    try {
      const note = await this.deps.engine.summarise({ transcript, booked: this.booked, signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS) });
      if (!note || !note.summary.trim()) return fallback;
      return { summary: note.summary.trim().slice(0, 1000), outcome: this.booked ? "booked" : note.outcome };
    } catch (error) {
      this.deps.log.warn("summary_failed", { ...this.ids(), error: errorCode(error) });
      return fallback;
    }
  }
}
