import { qrPng, qrSvg } from "@/lib/booking-page/qr";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageBaseUrl } from "@/lib/tenancy/urls";

/**
 * QR code for the selected garage's booking link, drawn on the server (no external QR service).
 * `?format=png` (default) or `svg`, served as a download. Any member may download it.
 */
export async function GET(request: Request) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return new Response("Sign in to download the QR code.", { status: 401, headers: { "cache-control": "no-store" } });

  const format = new URL(request.url).searchParams.get("format") === "svg" ? "svg" : "png";
  const link = `${garageBaseUrl({ slug: admin.garage.slug, customDomain: admin.garage.customDomain })}/`;
  const name = `${admin.garage.slug}-booking-qr.${format}`;
  const headers = { "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
  if (format === "svg") return new Response(qrSvg(link, { title: `Book online with ${admin.garage.name}` }), { headers: { ...headers, "content-type": "image/svg+xml; charset=utf-8" } });
  return new Response(Buffer.from(qrPng(link)), { headers: { ...headers, "content-type": "image/png" } });
}
