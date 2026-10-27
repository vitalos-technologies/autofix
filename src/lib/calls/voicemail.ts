import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAdminAudit } from "@/lib/admin/audit";
import { readTwilioConfig, type MessagingEnv } from "@/lib/messaging/config";
import { isTwilioRecordingUrl } from "./twiml";

// Voicemail playback for staff (P4.1): GET /api/admin/calls/{id}/voicemail.
// Twilio recordings need the account's credentials, so the browser never gets
// the Twilio link: the call is read through the member's RLS client (another
// garage's call is "not found"), the stored link must be this account's own
// Recordings resource, and the MP3 is streamed back privately. Every play is
// audited (`call.voicemail_played`).

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" } as const;
const FETCH_TIMEOUT_MS = 10_000;

export type VoicemailRequest = {
  client: SupabaseClient;
  garageId: string;
  actorId: string;
  callId: string;
  env?: MessagingEnv;
  fetch?: typeof fetch;
  audit?: typeof recordAdminAudit;
};

function json(status: number, code: string) {
  return Response.json({ code }, { status, headers: PRIVATE_HEADERS });
}

export async function streamVoicemail(input: VoicemailRequest): Promise<Response> {
  const { data, error } = await input.client
    .from("calls")
    .select("id,voicemail_url")
    .eq("garage_id", input.garageId)
    .eq("id", input.callId)
    .maybeSingle();
  if (error) return json(503, "unavailable");
  const url = (data as { voicemail_url: string | null } | null)?.voicemail_url;
  if (!isTwilioRecordingUrl(url)) return json(404, "not_found");

  const twilio = readTwilioConfig(input.env);
  if (!twilio.accountSid || !twilio.authToken) return json(503, "not_configured");
  // Only ever send our credentials to our own account's recordings.
  if (!url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Recordings/`)) return json(404, "not_found");

  let upstream: Response;
  try {
    upstream = await (input.fetch ?? fetch)(`${url}.mp3`, {
      headers: { Authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`, "utf8").toString("base64")}`, Accept: "audio/mpeg" },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return json(502, "upstream_unavailable");
  }
  if (upstream.status === 404) return json(404, "not_found");
  if (!upstream.ok || !upstream.body) return json(502, "upstream_unavailable");

  await (input.audit ?? recordAdminAudit)(input.garageId, { actorId: input.actorId, action: "call.voicemail_played", entityType: "call", entityId: input.callId });
  return new Response(upstream.body, {
    status: 200,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "audio/mpeg", "Content-Disposition": "inline; filename=\"voicemail.mp3\"" },
  });
}
