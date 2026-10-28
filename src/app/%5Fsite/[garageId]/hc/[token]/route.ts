import { handleHealthCheckLinkRequest } from "@/lib/health-checks/link-route";

/**
 * Health check links (`/hc/{token}` on the garage host, P5.3): open a 60-minute signed session for
 * the check and send the customer on to `/health-check`. The token never stays in the URL.
 */
export async function GET(request: Request, context: { params: Promise<{ garageId: string; token: string }> }) {
  return handleHealthCheckLinkRequest(request, await context.params);
}
