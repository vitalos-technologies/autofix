import type { RelayClaim } from "./claim.js";

// Pitline, seen from the voice service: the session exchange (POST /api/voice/v1/session with the relay
// claim and VOICE_RELAY_SECRET as the service key) and the agent tool API (POST /api/agent/v1/<tool> with
// the call's token). The garage always comes from the token; nothing here names one in a tool body.

export type ToolResponse = { status: number; body: unknown };

export type AutofixSession = {
  tool(name: AgentToolName, body: Record<string, unknown>): Promise<ToolResponse>;
};

export type AgentToolName =
  | "lookup_vehicle"
  | "list_services"
  | "available_slots"
  | "create_booking"
  | "get_booking"
  | "garage_profile"
  | "report_usage"
  | "log_call_summary";

export class SessionError extends Error {
  constructor(readonly code: string) {
    super(`voice session refused: ${code}`);
    this.name = "SessionError";
  }
}

export type AutofixClient = { openSession(claim: RelayClaim): Promise<AutofixSession> };

type Fetch = typeof fetch;

const TOOL_TIMEOUT_MS = 8_000;

export function createAutofixClient(input: { baseUrl: string; serviceKey: string; fetch?: Fetch }): AutofixClient {
  const doFetch = input.fetch ?? fetch;
  return {
    async openSession(claim) {
      const response = await doFetch(`${input.baseUrl}/api/voice/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-autofix-voice-key": input.serviceKey },
        body: JSON.stringify({ garageId: claim.garageId, callSid: claim.callSid, expires: claim.expires, signature: claim.signature }),
        signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as { token?: unknown; code?: unknown };
      if (response.status !== 201 || typeof body.token !== "string") throw new SessionError(typeof body.code === "string" ? body.code : `http_${response.status}`);
      const token = body.token;
      return {
        async tool(name, toolBody) {
          const result = await doFetch(`${input.baseUrl}/api/agent/v1/${name}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(toolBody),
            signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
          });
          return { status: result.status, body: await result.json().catch(() => null) };
        },
      };
    },
  };
}
