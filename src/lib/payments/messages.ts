import type { ChannelKind } from "@/lib/messaging/channel";
import { renderTemplate } from "@/lib/messaging/templates";
import { formatPounds, type PaymentKind } from "./amounts";

// Payment-link messages (P5.4). Service messages about the customer's own invoice or booking: sent
// straight away when staff press "Send payment link" (like booking updates), never marketing. Texts
// honour STOP (`customers.opted_out_at`): an opted-out customer gets the link by email if we have
// one, otherwise nothing is sent and staff see why. Pure: ./server.ts sends.

export type LinkCustomer = {
  name: string | null;
  phone: string | null;
  email: string | null;
  channel: string | null;
  optedOutAt: string | null;
};

export type LinkChannelChoice =
  | { channel: Exclude<ChannelKind, "email">; to: string }
  | { channel: "email"; to: string }
  | { channel: "none"; reason: "opted_out" | "no_contact" };

/** The customer's own channel, unless STOP was sent; email is the fallback. */
export function chooseLinkChannel(customer: LinkCustomer | null): LinkChannelChoice {
  if (!customer) return { channel: "none", reason: "no_contact" };
  const email = customer.email?.trim() || null;
  const wantsText = customer.channel !== "email";
  if (wantsText && customer.phone && !customer.optedOutAt) {
    return { channel: customer.channel === "whatsapp" ? "whatsapp" : "sms", to: customer.phone };
  }
  if (email) return { channel: "email", to: email };
  return { channel: "none", reason: wantsText && customer.optedOutAt ? "opted_out" : "no_contact" };
}

export type LinkMessageInput = {
  kind: PaymentKind;
  garageName: string;
  amountPence: number;
  /** "Invoice INV-2026-000012" / "booking HRD-1042". */
  what: string;
  link: string;
};

function firstLine(input: LinkMessageInput): string {
  const amount = formatPounds(input.amountPence);
  if (input.kind === "no_show_fee") return `{garage}: sorry we missed you. The missed appointment fee for ${input.what} is ${amount}.`;
  if (input.kind === "deposit") return `{garage}: please pay the ${amount} deposit for ${input.what}.`;
  return `{garage}: ${input.what} for ${amount} is ready to pay.`;
}

/** The text (SMS/WhatsApp, with the opt-out line) or the email body. */
export function composeLinkMessage(input: LinkMessageInput, channel: ChannelKind): { body: string; subject: string; html: string | null } {
  const rendered = renderTemplate(`${firstLine(input)} Pay securely: {link}`, { garage: input.garageName, link: input.link }, channel === "email" ? {} : { channel });
  const subject = input.kind === "no_show_fee" ? `Missed appointment fee from ${input.garageName}` : `Payment request from ${input.garageName}`;
  if (channel !== "email") return { body: rendered.text, subject, html: null };
  const text = `${rendered.text}\n\nThe link is for you only. If you have already paid, you can ignore this email.`;
  const html = `<p>${escapeHtml(rendered.text.replace(/ Pay securely: .*$/, ""))}</p>`
    + `<p><a href="${escapeHtml(input.link)}">Pay ${escapeHtml(formatPounds(input.amountPence))} securely</a></p>`
    + "<p>The link is for you only. If you have already paid, you can ignore this email.</p>";
  return { body: text, subject, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
