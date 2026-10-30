/**
 * Voice desk: POST /api/voice/v1/session. The voice service trades the signed relay claim for the call's
 * agent token: its own key first, then the claim's signature and expiry, then issue_voice_call_token().
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => null }));

import { relayConnectUrl, VOICE_SERVICE_KEY_HEADER, type VoiceRelayTarget } from "@/lib/ai-front-desk/voice-relay";
import { handleVoiceSessionRequest } from "@/lib/ai-front-desk/voice-session";

const SECRET = "voice-relay-secret-0123456789-abcdefghij";
const ENV = { VOICE_RELAY_URL: "wss://voice.example/relay", VOICE_RELAY_SECRET: SECRET };
const TARGET: VoiceRelayTarget = { url: ENV.VOICE_RELAY_URL, healthUrl: "https://voice.example/healthz", secret: SECRET };
const GARAGE = "a0000000-0000-4000-8000-00000000000a";
const CALL = "CA00000000000000000000000000000001";
const NOW = new Date("2026-10-29T10:00:00Z");

function claimBody(now = NOW) {
  const url = new URL(relayConnectUrl(TARGET, { garageId: GARAGE, callSid: CALL, now }));
  return { garageId: url.searchParams.get("g"), callSid: url.searchParams.get("c"), expires: Number(url.searchParams.get("e")), signature: url.searchParams.get("s") };
}

function request(body: unknown, key: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers[VOICE_SERVICE_KEY_HEADER] = key;
  return new Request("https://pitline.co.uk/api/voice/v1/session", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("POST /api/voice/v1/session", () => {
  it("201 with the call's token for a valid claim from the voice service", async () => {
    const issue = vi.fn(async () => ({ ok: true as const, token: `afat_${"T".repeat(43)}`, expiresAt: "2026-10-29T10:30:00.000Z" }));
    const response = await handleVoiceSessionRequest(request(claimBody()), { env: ENV, issue, now: () => NOW });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ token: `afat_${"T".repeat(43)}`, expiresAt: "2026-10-29T10:30:00.000Z" });
    expect(issue).toHaveBeenCalledWith({ garageId: GARAGE, callSid: CALL, now: NOW });
  });

  it("refuses before any work: not configured, wrong or missing key, bad JSON, a forged, changed or expired claim", async () => {
    const issue = vi.fn();
    const cases: Array<[Request, Record<string, string | undefined>, number, string]> = [
      [request(claimBody()), {}, 503, "NOT_CONFIGURED"],
      [request(claimBody(), null), ENV, 401, "UNAUTHORIZED"],
      [request(claimBody(), "wrong-key-wrong-key-wrong-key-wrong-key!"), ENV, 401, "UNAUTHORIZED"],
      [request("{not json"), ENV, 400, "INVALID_REQUEST"],
      [request([]), ENV, 400, "INVALID_REQUEST"],
      [request({ ...claimBody(), signature: "0".repeat(64) }), ENV, 401, "INVALID_CLAIM"],
      [request({ ...claimBody(), garageId: "b0000000-0000-4000-8000-00000000000b" }), ENV, 401, "INVALID_CLAIM"],
      [request(claimBody(new Date(NOW.getTime() - 10 * 60_000))), ENV, 401, "INVALID_CLAIM"],
    ];
    for (const [req, env, status, code] of cases) {
      const response = await handleVoiceSessionRequest(req, { env, issue, now: () => NOW });
      expect(response.status, code).toBe(status);
      expect(await response.json()).toEqual({ code });
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it.each([
    ["CALL_NOT_FOUND", 404],
    ["FRONT_DESK_OFF", 403],
    ["ALREADY_ISSUED", 409],
    ["UNAVAILABLE", 503],
  ] as const)("%s from the database answers %i", async (code, status) => {
    const response = await handleVoiceSessionRequest(request(claimBody()), { env: ENV, issue: async () => ({ ok: false, code }), now: () => NOW });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });
});
