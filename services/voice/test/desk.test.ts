import { describe, expect, it } from "vitest";
import { DeskCall, LINES } from "../src/desk.js";
import { CALL, CALLER, fakeAutofix, GARAGE, memoryLog, scriptedEngine, SERVICE, settle, text, toolUse, fakeSocket } from "./helpers.js";

const claim = { garageId: GARAGE, callSid: CALL, expires: 0, signature: "s" };
const setup = JSON.stringify({ type: "setup", sessionId: "VX1", callSid: CALL, from: CALLER, to: "+447700100200", customParameters: {} });
const prompt = (voicePrompt: string) => JSON.stringify({ type: "prompt", voicePrompt, lang: "en-GB", last: true });

function start(engine: ReturnType<typeof scriptedEngine>["engine"], autofix = fakeAutofix(), clock = { t: Date.parse("2026-10-29T10:00:00Z") }) {
  const ws = fakeSocket();
  const { logger, lines } = memoryLog();
  const call = new DeskCall(claim, ws.socket, { autofix: autofix.client, engine, log: logger, maxCallSeconds: 600, now: () => new Date(clock.t), sleep: async () => undefined });
  return { call, ws, lines, autofix, clock };
}

describe("a booking call end to end", () => {
  it("greets, checks times, books a request, says goodbye, hangs up, then reports minutes and the summary", async () => {
    const slot = "2026-11-03T09:00:00.000Z";
    const { engine, seen } = scriptedEngine([
      { content: [text("Let me check. "), toolUse("available_slots", { serviceId: SERVICE, from: "2026-11-03", to: "2026-11-03" })], stopReason: "tool_use" },
      { content: [text("I can do Tuesday at nine. Shall I book that?")], stopReason: "end_turn" },
      { content: [toolUse("create_booking", { serviceId: SERVICE, startsAt: slot, customerName: "Sam Patel", mobile: null, registration: "AB12 CDE", make: null, model: null, notes: "Full service" })], stopReason: "tool_use" },
      { content: [text("Done: that's a request for Tuesday at nine; the garage will text to confirm. Anything else?")], stopReason: "end_turn" },
      { content: [text("Thanks Sam, goodbye."), toolUse("end_call", { next: "goodbye" })], stopReason: "tool_use" },
    ]);
    const autofix = fakeAutofix({
      available_slots: () => ({ status: 200, body: { slots: [{ startsAt: slot, endsAt: "2026-11-03T11:00:00.000Z" }] } }),
      create_booking: () => ({ status: 201, body: { booking: { reference: "HRM-4821", status: "requested", startsAt: slot, endsAt: "2026-11-03T11:00:00.000Z" }, replayed: false } }),
    });
    const { call, ws, lines, clock } = start(engine, autofix);

    call.handle(setup);
    expect(ws.sent[0]).toEqual({ type: "text", token: LINES.greeting, last: true });
    call.handle(prompt("I need a full service on Tuesday"));
    await settle();
    expect(ws.spoken()).toContain("I can do Tuesday at nine.");
    call.handle(prompt("Yes please, Sam Patel, AB12 CDE"));
    await settle();
    call.handle(prompt("No that's all, thanks"));
    await settle();

    expect(ws.sent.at(-1)).toEqual({ type: "end", handoffData: JSON.stringify({ to: "hangup" }) });
    expect(seen[0]?.[0]).toEqual({ role: "user", content: "I need a full service on Tuesday" });
    // The model saw its own earlier turns unchanged and every tool result.
    expect(JSON.stringify(seen[4])).toContain("HRM-4821");

    clock.t += 150_000; // 2.5 minutes
    await call.close();
    const tools = autofix.calls.map((entry) => entry.tool);
    expect(tools).toEqual(["garage_profile", "list_services", "available_slots", "create_booking", "report_usage", "log_call_summary"]);
    expect(autofix.calls[4]?.body).toMatchObject({ conversationId: CALL, channel: "call", minutes: 3 });
    expect(autofix.calls[5]?.body).toEqual({ callSid: CALL, summary: "Sam booked a full service.", outcome: "booked" });

    // Logs: ids and outcomes, never the caller's number, the registration or what was said.
    const log = lines.join("\n");
    expect(log).toContain('"event":"call_finished"');
    for (const secret of [CALLER, "AB12", "Sam", "full service", "Tuesday"]) expect(log).not.toContain(secret);
  });
});

describe("when things go wrong", () => {
  it("Pitline refuses the session: the caller is told and sent to the voicemail; no minutes are reported", async () => {
    const { engine } = scriptedEngine([]);
    const autofix = fakeAutofix({}, { refuse: "FRONT_DESK_OFF" });
    const { call, ws } = start(engine, autofix);
    call.handle(setup);
    await settle();
    expect(ws.spoken()).toContain(LINES.unavailable);
    expect(ws.sent.at(-1)).toEqual({ type: "end", handoffData: JSON.stringify({ to: "voicemail" }) });
    await call.close();
    expect(autofix.calls).toEqual([]);
  });

  it("Claude fails: an apology, then a polite hang-up; the summary still reaches staff", async () => {
    const { engine } = scriptedEngine([async () => { throw Object.assign(new Error("overloaded"), { status: 529 }); }], null);
    const { call, ws, autofix } = start(engine);
    call.handle(setup);
    call.handle(prompt("Do you do tyres?"));
    await settle();
    expect(ws.spoken()).toContain(LINES.trouble);
    expect(ws.sent.at(-1)).toEqual({ type: "end", handoffData: JSON.stringify({ to: "hangup" }) });
    await call.close();
    expect(autofix.calls.at(-1)).toMatchObject({ tool: "log_call_summary", body: { outcome: "callback" } });
  });

  it("a caller who talks over the desk cuts the reply off; only what they heard stays in the history", async () => {
    let release: (() => void) | undefined;
    const { engine, seen } = scriptedEngine([
      ({ signal, onText }) => new Promise((_, reject) => {
        onText("We are open Monday to ");
        signal.addEventListener("abort", () => reject(signal.reason));
        release = () => undefined;
      }),
      { content: [text("Sure, a full service. Which day suits you?")], stopReason: "end_turn" },
    ]);
    const { call, ws } = start(engine);
    call.handle(setup);
    call.handle(prompt("When are you open?"));
    await settle();
    expect(release).toBeDefined();
    call.handle(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "We are open Monday", durationUntilInterruptMs: 900 }));
    call.handle(prompt("Actually I want a full service"));
    await settle();
    expect(ws.spoken()).toContain("Which day suits you?");
    expect(seen[1]).toEqual([
      { role: "user", content: "When are you open?" },
      { role: "assistant", content: "We are open Monday" },
      { role: "user", content: "Actually I want a full service" },
    ]);
  });

  it("a caller asking for the voicemail is handed back with {to: voicemail}", async () => {
    const { engine } = scriptedEngine([{ content: [text("Of course, leave your message after the tone."), toolUse("end_call", { next: "voicemail" })], stopReason: "tool_use" }], { summary: "Wanted to leave a voicemail.", outcome: "message" });
    const { call, ws } = start(engine);
    call.handle(setup);
    call.handle(prompt("Can I just leave a message?"));
    await settle();
    expect(ws.sent.at(-1)).toEqual({ type: "end", handoffData: JSON.stringify({ to: "voicemail" }) });
  });

  it("a caller who hangs up straight away is logged as dropped without asking Claude", async () => {
    const { engine } = scriptedEngine([]);
    const { call, autofix } = start(engine);
    call.handle(setup);
    await settle();
    await call.close();
    expect(autofix.calls.at(-1)).toEqual({ tool: "log_call_summary", body: { callSid: CALL, summary: "The caller hung up before saying what they wanted.", outcome: "dropped" } });
    expect(autofix.calls.find((entry) => entry.tool === "report_usage")?.body).toMatchObject({ minutes: 1 });
  });

  it("refuses a setup for another call", async () => {
    const { engine } = scriptedEngine([]);
    const { call, ws } = start(engine);
    call.handle(JSON.stringify({ type: "setup", callSid: "CA00000000000000000000000000000009" }));
    expect(ws.closed()).toBe(1008);
  });

  it("a Claude refusal ends politely", async () => {
    const { engine } = scriptedEngine([{ content: [], stopReason: "refusal" }]);
    const { call, ws } = start(engine);
    call.handle(setup);
    call.handle(prompt("..."));
    await settle();
    expect(ws.spoken()).toContain(LINES.refused);
    expect(ws.sent.at(-1)).toMatchObject({ type: "end" });
  });
});
