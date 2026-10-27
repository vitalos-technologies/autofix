import { json, notFoundJson, readJson, UUID_PATTERN, withPlatformAdmin } from "@/lib/platform/api";
import { cleanReason } from "@/lib/platform/policy";
import { retryJob } from "@/lib/platform/store";

/** POST /api/platform/jobs/:id/retry {reason} — puts a failed job back in the queue (audited). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return withPlatformAdmin(request, async (admin) => {
    if (!UUID_PATTERN.test(jobId)) return notFoundJson();
    const reason = cleanReason((await readJson(request))?.reason);
    if (!reason) return json({ error: "INVALID_REQUEST" }, 422);
    const retried = await retryJob(admin.client, jobId, reason);
    return retried ? json({ retried }) : json({ error: "NOT_RETRYABLE" }, 409);
  }, { mutation: true });
}
