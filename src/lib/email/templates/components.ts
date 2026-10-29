import "server-only";

import { PLATFORM_NAME, type EmailBrand } from "@/lib/email/brand";

export type RenderedEmail = { html: string; text: string };
export type Detail = { label: string; value?: string | null };
export type StatusTone = "info" | "success" | "warning" | "cancelled";

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function textToHtml(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

export function detailCard(details: Detail[]) {
  const rows = details.filter((detail) => detail.value).map(({ label, value }) => `
    <tr>
      <td style="padding:10px 12px;color:#586575;font-size:12px;font-weight:700;line-height:18px;text-transform:uppercase;letter-spacing:.5px;vertical-align:top;width:38%;">${escapeHtml(label)}</td>
      <td style="padding:10px 12px;color:#071127;font-size:15px;font-weight:700;line-height:21px;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #DCE6F2;border-radius:12px;background:#F4F7FA;border-collapse:separate;overflow:hidden;">${rows}</table>`;
}

export function notice(title: string, copy: string, brand?: Pick<EmailBrand, "accent">) {
  return `<div style="margin:22px 0;padding:16px 18px;border-left:4px solid ${escapeHtml(brand?.accent ?? "#155fba")};background:#F4F7FA;color:#071127;font-size:15px;line-height:22px;"><strong>${escapeHtml(title)}</strong><br><span style="color:#586575;">${escapeHtml(copy)}</span></div>`;
}

/** "Sent by Pitline on behalf of Hartley Road Motors" (garage mail only). */
export function onBehalfLine(brand: Pick<EmailBrand, "kind" | "name">) {
  return brand.kind === "garage" ? `Sent by ${PLATFORM_NAME} on behalf of ${brand.name}` : `Sent by ${PLATFORM_NAME}`;
}

function header(brand: EmailBrand) {
  if (brand.logoUrl) {
    return `<img src="${escapeHtml(brand.logoUrl)}" width="170" alt="${escapeHtml(brand.name)}" style="display:inline-block;width:auto;max-width:170px;max-height:72px;height:auto;border:0;color:#FFFFFF;font-size:20px;font-weight:700;">`;
  }
  return `<span style="display:inline-block;color:#FFFFFF;font-size:22px;font-weight:700;line-height:28px;letter-spacing:.3px;">${escapeHtml(brand.name)}</span>`;
}

/** Links under the garage's details in the footer (privacy notice, stop reminders). */
export type FooterLink = { label: string; url: string };

function footerHtml(brand: EmailBrand, links: FooterLink[] = []) {
  const contact = [
    brand.phone && brand.phoneHref ? `<a href="${escapeHtml(brand.phoneHref)}" style="color:#9CCBFF;text-decoration:none;">${escapeHtml(brand.phone)}</a>` : "",
    brand.email ? `<a href="mailto:${escapeHtml(brand.email)}" style="color:#9CCBFF;text-decoration:none;">${escapeHtml(brand.email)}</a>` : "",
  ].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");
  return [
    `<strong style="color:#FFFFFF;font-size:14px;">${escapeHtml(brand.legalName)}</strong>`,
    brand.tagline ? escapeHtml(brand.tagline) : "",
    contact,
    `<a href="${escapeHtml(brand.baseUrl)}" style="color:#9CCBFF;text-decoration:none;">${escapeHtml(brand.website)}</a>`,
    brand.address ? escapeHtml(brand.address) : "",
    brand.companyNumber ? `Company no. ${escapeHtml(brand.companyNumber)}` : "",
    links.length ? links.map((link) => `<a href="${escapeHtml(link.url)}" style="color:#9CCBFF;text-decoration:underline;">${escapeHtml(link.label)}</a>`).join(" &nbsp;&middot;&nbsp; ") : "",
    `<span style="color:#B8C6D6;">${escapeHtml(onBehalfLine(brand))}</span>`,
  ].filter(Boolean).join("<br>");
}

export function emailLayout(input: {
  brand: EmailBrand;
  preheader: string;
  status: string;
  tone?: StatusTone;
  title: string;
  intro?: string;
  contentHtml: string;
  cta?: { label: string; url: string };
  secondaryCtas?: Array<{ label: string; url: string }>;
  afterCta?: string;
  compact?: boolean;
  footerLinks?: FooterLink[];
}) {
  const { brand } = input;
  const accent = escapeHtml(brand.accent);
  const tones: Record<StatusTone, { bg: string; fg: string }> = {
    info: { bg: "#E7F2FF", fg: "#0B4C99" },
    success: { bg: "#E7F7EF", fg: "#17663B" },
    warning: { bg: "#FFF3D6", fg: "#7A5300" },
    cancelled: { bg: "#F8E9EB", fg: "#7B2935" },
  };
  const tone = tones[input.tone ?? "info"];
  const button = input.cta ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 18px;"><tr><td align="center"><a href="${escapeHtml(input.cta.url)}" style="display:block;box-sizing:border-box;max-width:320px;min-height:46px;padding:13px 22px;border-radius:12px;background:${accent};color:#FFFFFF;font-size:16px;font-weight:700;line-height:20px;text-align:center;text-decoration:none;">${escapeHtml(input.cta.label)}</a></td></tr></table>` : "";
  const secondaryButtons = input.secondaryCtas?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td align="center">${input.secondaryCtas.map((cta) => `<a href="${escapeHtml(cta.url)}" style="display:inline-block;box-sizing:border-box;min-height:42px;margin:4px;padding:10px 14px;border:1px solid ${accent};border-radius:10px;color:${accent};font-size:14px;font-weight:700;line-height:20px;text-decoration:none;">${escapeHtml(cta.label)}</a>`).join("")}</td></tr></table>` : "";
  const intro = input.intro ? `<p style="margin:0 0 24px;color:#586575;font-size:16px;line-height:25px;">${escapeHtml(input.intro)}</p>` : "";
  const afterCta = input.afterCta ? `<p style="margin:0;color:#586575;font-size:14px;line-height:22px;">${escapeHtml(input.afterCta)}</p>` : "";
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(input.title)}</title>
<style>@media only screen and (max-width:620px){.email-shell{width:100%!important}.email-body{padding:28px 20px!important}.email-header{padding:22px 20px!important}.email-footer{padding:24px 20px!important}h1{font-size:27px!important;line-height:33px!important}a{overflow-wrap:anywhere}}@media (prefers-color-scheme:dark){.email-page{background:#111827!important}.email-card{background:#FFFFFF!important}.email-body{color:#071127!important}}</style></head>
<body class="email-page" style="margin:0;padding:0;background:#F4F7FA;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FA;"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" class="email-shell email-card" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid #DCE6F2;border-radius:16px;border-collapse:separate;overflow:hidden;">
<tr><td class="email-header" style="padding:24px 32px;background:#071127;border-bottom:4px solid ${accent};text-align:center;">${header(brand)}</td></tr>
<tr><td class="email-body" style="padding:${input.compact ? "30px 34px" : "38px 40px"};color:#071127;">
<span style="display:inline-block;margin:0 0 18px;padding:7px 10px;border-radius:999px;background:${tone.bg};color:${tone.fg};font-size:12px;font-weight:700;line-height:16px;letter-spacing:.7px;">${escapeHtml(input.status)}</span>
<h1 style="margin:0 0 14px;color:#071127;font-size:${input.compact ? "26px" : "30px"};line-height:${input.compact ? "32px" : "37px"};font-weight:700;letter-spacing:-.4px;">${escapeHtml(input.title)}</h1>
${intro}${input.contentHtml}${button}${secondaryButtons}${afterCta}
</td></tr>
<tr><td class="email-footer" style="padding:27px 32px;background:#071127;color:#DCE6F2;text-align:center;font-size:12px;line-height:19px;">
${footerHtml(brand, input.footerLinks)}
</td></tr></table></td></tr></table></body></html>`;
}

/** First line of plain-text mail, e.g. "HARTLEY ROAD MOTORS". */
export function plainTextHeader(brand: Pick<EmailBrand, "name">) {
  return brand.name.toUpperCase();
}

export function plainTextFooter(brand: EmailBrand, links: FooterLink[] = []) {
  return [
    "",
    brand.legalName,
    brand.tagline ?? "",
    [brand.phone, brand.email].filter(Boolean).join(" · "),
    brand.website,
    brand.address,
    ...links.map((link) => `${link.label}: ${link.url}`),
    onBehalfLine(brand),
  ].filter((line, index) => index === 0 || line !== "").join("\n");
}

export function detailsText(details: Detail[]) {
  return details.filter((detail) => detail.value).map(({ label, value }) => `${label}: ${value}`).join("\n");
}
