import { handleVoiceSessionRequest } from "@/lib/ai-front-desk/voice-session";

/** `POST /api/voice/v1/session` (voice desk): the autofix-voice service trades a call's signed relay claim for its agent token. */
export function POST(request: Request) {
  return handleVoiceSessionRequest(request);
}
