import { handleCampaignLinkRequest } from "@/lib/campaigns/open-link";

/**
 * Campaign links (`/c/{token}` on the garage host, P5.5): prefill the booking draft from the campaign send and
 * send the customer on to `/time` (or `/service`). The token never stays in the URL.
 */
export async function GET(request: Request, context: { params: Promise<{ garageId: string; token: string }> }) {
  return handleCampaignLinkRequest(request, await context.params);
}
