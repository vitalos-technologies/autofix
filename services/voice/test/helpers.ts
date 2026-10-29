import type Anthropic from "@anthropic-ai/sdk";
import type { AgentToolName, AutofixClient, AutofixSession, ToolResponse } from "../src/autofix.js";
import type { Engine, EngineStep } from "../src/llm.js";
import type { LogFields, Logger } from "../src/log.js";

export const SECRET = "test-secret-test-secret-test-secret";
export const GARAGE = "a0000000-0000-4000-8000-00000000000a";
export const CALL = "CA00000000000000000000000000000001";
export const CALLER = "+447700900123";
export const SERVICE = "33333333-3333-4333-8333-333333333333";

export const profile = {
  garage: { name: "Hartley Road Motors", phone: "+441302555000", address: { line1: "1 Hartley Road", town: "Doncaster", postcode: "DN1 2AB" }, timezone: "Europe/London", motEnabled: true },
  openingHours: [{ day: "Monday", opens: "08:00", closes: "17:30" }],
  closures: [],
  policies: { cancellationCutoffHours: 24 },
  faqs: [{ question: "Courtesy cars?", answer: "Yes, ask when you book." }],
};

export function fakeAutofix(handlers: Partial<Record<AgentToolName, (body: Record<string, unknown>) => ToolResponse>> = {}, options: { refuse?: string } = {}) {
  const calls: Array<{ tool: AgentToolName; body: Record<string, unknown> }> = [];
  const session: AutofixSession = {
    async tool(name, body) {
      calls.push({ tool: name, body });
      const handler = handlers[name];
      if (handler) return handler(body);
      if (name === "garage_profile") return { status: 200, body: profile };
      if (name === "list_services") return { status: 200, body: { services: [{ id: SERVICE, name: "Full service", description: "", durationMin: 120, priceText: "£189.00", locationMode: "workshop", isMot: false }] } };
      if (name === "report_usage") return { status: 201, body: { usage: { replayed: false } } };
      if (name === "log_call_summary") return { status: 201, body: { stored: true } };
      return { status: 200, body: {} };
    },
  };
  const client: AutofixClient = {
    async openSession() {
      if (options.refuse) throw Object.assign(new Error(options.refuse), { name: "SessionError" });
      return session;
    },
  };
  return { client, calls };
}

type Script = (input: { messages: Anthropic.MessageParam[]; signal: AbortSignal; onText: (text: string) => void }) => Promise<EngineStep>;

export function text(value: string): Anthropic.TextBlock {
  return { type: "text", text: value, citations: null } as Anthropic.TextBlock;
}

export function toolUse(name: string, input: Record<string, unknown>, id = `toolu_${name}`): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

/** An engine that plays the scripted steps in order, streaming each step's text. */
export function scriptedEngine(steps: Array<EngineStep | Script>, summary: Awaited<ReturnType<Engine["summarise"]>> = { summary: "Sam booked a full service.", outcome: "booked" }) {
  const seen: Anthropic.MessageParam[][] = [];
  const engine: Engine = {
    async step({ messages, signal, onText }) {
      seen.push(structuredClone(messages));
      const next = steps.shift();
      if (!next) throw new Error("script ran out");
      if (typeof next === "function") return next({ messages, signal, onText });
      for (const block of next.content) if (block.type === "text") onText(block.text);
      return next;
    },
    async summarise() {
      return summary;
    },
  };
  return { engine, seen };
}

export function memoryLog() {
  const lines: string[] = [];
  const write = (level: string) => (event: string, fields?: LogFields) => { lines.push(JSON.stringify({ level, event, ...fields })); };
  const logger: Logger = { info: write("info"), warn: write("warn"), error: write("error") };
  return { logger, lines };
}

export function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  let closed: number | undefined;
  return {
    socket: { send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>); }, close: (code?: number) => { closed = code ?? 1000; } },
    sent,
    closed: () => closed,
    spoken: () => sent.filter((message) => message.type === "text").map((message) => message.token).join(""),
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}
