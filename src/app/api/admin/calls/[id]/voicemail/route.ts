import { z } from "zod";
import { streamVoicemail } from "@/lib/calls/voicemail";
import { getAdminContext } from "@/lib/tenancy/admin";

/**
 * Plays a missed call's voicemail for the signed-in member (P4.1). The call is read through the
 * member's RLS garage client; the Twilio recording is fetched server-side with the account's
 * credentials and streamed back privately. See src/lib/calls/voicemail.ts.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return Response.json({ code: "unauthorised" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ code: "not_found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return streamVoicemail({ client: admin.client, garageId: admin.garage.id, actorId: admin.user.id, callId: id });
}
