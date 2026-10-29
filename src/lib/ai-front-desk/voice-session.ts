import "server-only";

import { NextResponse } from "next/server";
import { issueVoiceCallToken, type VoiceCallTokenResult } from "@/lib/agent-api/store";
import { parseVoiceRelayTarget, VOICE_SERVICE_KEY_HEADER, verifyRelayClaim, voiceServiceKeyMatches } from "./voice-relay";

// POST /api/voice/v1/session (voice desk): the autofix-voice service trades the signed claim it got in
// the ConversationRelay URL for the call's agent token. Two checks: the service's key
// (VOICE_RELAY_SECRET in x-autofix-voice-key) and the claim's own signature and expiry. Then
// issue_voice_call_token() checks the call is this garage's and recent, the front desk is on (Pro),
// and that no token was minted for this call yet. Logs carry outcome codes only.

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 2_000;

export type VoiceSessionDeps = {
  env?: Readonly<Record<string, string | undefined>>;
  issue?: (input: { garageId: string; callSid: string; now: Date }) => Promise<VoiceCallTokenResult>;
  now?: () => Date;
};

const STATUS: Record<"CALL_NOT_FOUND" | "FRONT_DESK_OFF" | "ALREADY_ISSUED" | "UNAVAILABLE", number> = {
  CALL_NOT_FOUND: 404,
  FRONT_DESK_OFF: 403,
  ALREADY_ISSUED: 409,
  UNAVAILABLE: 503,
};

function answer(status: number, body: Record<string, unknown>) {
  console.info(JSON.stringify({ event: "voice_session", status, code: body.code ?? "OK" }));
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function handleVoiceSessionRequest(request: Request, deps: VoiceSessionDeps = {}): Promise<Response> {
  const target = parseVoiceRelayTarget(deps.env ?? process.env);
  if (!target) return answer(503, { code: "NOT_CONFIGURED" });
  if (!voiceServiceKeyMatches(target.secret, request.headers.get(VOICE_SERVICE_KEY_HEADER))) return answer(401, { code: "UNAUTHORIZED" });

  const text = await request.text().catch(() => "");
  if (!text || Buffer.byteLength(text) > MAX_BODY_BYTES) return answer(400, { code: "INVALID_REQUEST" });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return answer(400, { code: "INVALID_REQUEST" });
    body = parsed as Record<string, unknown>;
  } catch {
    return answer(400, { code: "INVALID_REQUEST" });
  }

  const now = (deps.now ?? (() => new Date()))();
  const claim = verifyRelayClaim(target.secret, { garageId: body.garageId, callSid: body.callSid, expires: body.expires, signature: body.signature }, now);
  if (!claim) return answer(401, { code: "INVALID_CLAIM" });

  const issued = await (deps.issue ?? ((input) => issueVoiceCallToken(input)))({ garageId: claim.garageId, callSid: claim.callSid, now });
  if (!issued.ok) return answer(STATUS[issued.code], { code: issued.code });
  return answer(201, { token: issued.token, expiresAt: issued.expiresAt });
}
