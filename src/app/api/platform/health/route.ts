import { json, withPlatformAdmin } from "@/lib/platform/api";
import { getJobHealth } from "@/lib/platform/store";

/** GET /api/platform/health — job queue and reminder-send health (errors redacted, no payloads). */
export async function GET(request: Request) {
  return withPlatformAdmin(request, async (admin) => json(await getJobHealth(admin.client)));
}
