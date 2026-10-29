import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createVoiceApp, type VoiceApp } from "../src/app.js";
import { signClaim } from "../src/claim.js";
import { loadConfig } from "../src/config.js";
import { twilioSignature } from "../src/twilio-signature.js";
import { CALL, fakeAutofix, GARAGE, memoryLog, scriptedEngine, SECRET, settle } from "./helpers.js";

const TWILIO_TOKEN = "twilio-auth-token-0123456789abcdef";
let app: VoiceApp | null = null;

async function listen(env: Record<string, string>) {
  const config = loadConfig({ VOICE_RELAY_SECRET: SECRET, ANTHROPIC_API_KEY: "test-key", AUTOFIX_BASE_URL: "http://localhost:3000", ...env });
  const autofix = fakeAutofix();
  app = createVoiceApp(config, { autofix: autofix.client, engine: scriptedEngine([]).engine, log: memoryLog().logger, sleep: async () => undefined });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  return { port: (app.server.address() as AddressInfo).port, autofix };
}

function relayQuery(expires = Math.floor(Date.now() / 1000) + 300) {
  return `?${new URLSearchParams({ g: GARAGE, c: CALL, e: String(expires), s: signClaim(SECRET, { garageId: GARAGE, callSid: CALL, expires }) })}`;
}

function connect(port: number, query: string, headers: Record<string, string> = {}) {
  return new Promise<{ ws: WebSocket } | { status: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay${query}`, { headers });
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_request, response) => resolve({ status: response.statusCode ?? 0 }));
    ws.on("error", () => undefined);
  });
}

afterEach(async () => {
  if (app) await new Promise((resolve) => app!.server.close(resolve));
  app = null;
});

describe("voice service HTTP and WebSocket", () => {
  it("/healthz always answers; /readyz needs the relay secret and the Claude key", async () => {
    const { port } = await listen({});
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    await new Promise((resolve) => app!.server.close(resolve));
    const second = await listen({ ANTHROPIC_API_KEY: "" });
    expect((await fetch(`http://127.0.0.1:${second.port}/readyz`)).status).toBe(503);
    expect(await connect(second.port, relayQuery())).toEqual({ status: 503 });
  });

  it("refuses a missing, forged or expired claim before the upgrade", async () => {
    const { port } = await listen({});
    expect(await connect(port, "")).toEqual({ status: 403 });
    expect(await connect(port, relayQuery().replace(/s=[0-9a-f]+/, `s=${"0".repeat(64)}`))).toEqual({ status: 403 });
    expect(await connect(port, relayQuery(Math.floor(Date.now() / 1000) - 1))).toEqual({ status: 403 });
  });

  it("accepts a signed claim, greets on setup, and wraps up when the socket closes", async () => {
    const { port, autofix } = await listen({});
    const result = await connect(port, relayQuery());
    if (!("ws" in result)) throw new Error(`refused ${result.status}`);
    const received: unknown[] = [];
    result.ws.on("message", (data) => received.push(JSON.parse(String(data))));
    result.ws.send(JSON.stringify({ type: "setup", callSid: CALL, from: "+447700900123" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received[0]).toMatchObject({ type: "text", last: true });
    expect(app!.activeCalls()).toBe(1);
    expect(await connect(port, relayQuery())).toEqual({ status: 409 });
    result.ws.close();
    for (let i = 0; i < 20 && app!.activeCalls(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    await settle();
    expect(app!.activeCalls()).toBe(0);
    expect(autofix.calls.map((entry) => entry.tool)).toContain("log_call_summary");
  });

  it("with TWILIO_AUTH_TOKEN set, also needs Twilio's signature over the relay URL", async () => {
    const { port } = await listen({ TWILIO_AUTH_TOKEN: TWILIO_TOKEN, PUBLIC_RELAY_URL: "wss://voice.example/relay" });
    const query = relayQuery();
    expect(await connect(port, query)).toEqual({ status: 403 });
    expect(await connect(port, query, { "x-twilio-signature": "bogus" })).toEqual({ status: 403 });
    const ok = await connect(port, query, { "x-twilio-signature": twilioSignature(TWILIO_TOKEN, `wss://voice.example/relay${query}`) });
    expect("ws" in ok).toBe(true);
    if ("ws" in ok) ok.ws.close();
  });
});
