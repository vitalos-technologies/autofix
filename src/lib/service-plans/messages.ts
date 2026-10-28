import type { ChannelKind } from "@/lib/messaging/channel";
import { renderTemplate } from "@/lib/messaging/templates";
import { monthlyPrice } from "./view";

// Service plan notices (P5.11): the sign-up confirmation and the payment-failed notice. Service
// messages about the customer's own Direct Debit (like booking confirmations and P5.4 payment links),
// sent when the news arrives, never marketing. The channel is chosen by chooseLinkChannel() from
// src/lib/payments/messages.ts: the customer's own channel unless they sent STOP, then email, else
// nothing (staff see why). Texts end with "Reply STOP to opt out." Pure: ./server.ts sends.

export type PlanNoticeKind = "confirmation" | "payment_failed";

export type PlanNoticeInput = {
  kind: PlanNoticeKind;
  garageName: string;
  garagePhone: string | null;
  planName: string;
  pricePence: number;
  /** The car as the customer knows it ("Ford Fiesta"): never the registration. */
  carName: string | null;
};

function firstLine(input: PlanNoticeInput): string {
  const car = input.carName ? ` for your ${input.carName}` : "";
  if (input.kind === "confirmation") {
    return `{garage}: you're on our ${input.planName} plan${car}. Your Direct Debit of ${monthlyPrice(input.pricePence)} is set up; your bank statement will show the first payment soon. Book any time on our booking page.`;
  }
  const call = input.garagePhone ? ` Call us on ${input.garagePhone} if you need help.` : "";
  return `{garage}: your ${input.planName} plan payment of ${monthlyPrice(input.pricePence).replace(" a month", "")} didn't go through. We'll try again in a few days, so please check your bank account has the funds.${call}`;
}

export function planNoticeSubject(input: PlanNoticeInput): string {
  return input.kind === "confirmation" ? `You're on the ${input.planName} plan at ${input.garageName}` : `Your ${input.planName} plan payment didn't go through`;
}

/** The text (SMS/WhatsApp, with the opt-out line) or the email body. */
export function composePlanNotice(input: PlanNoticeInput, channel: ChannelKind): { body: string; subject: string; html: string | null } {
  const rendered = renderTemplate(firstLine(input), { garage: input.garageName }, channel === "email" ? {} : { channel });
  const subject = planNoticeSubject(input);
  if (channel !== "email") return { body: rendered.text, subject, html: null };
  const text = `${rendered.text}\n\nYou can cancel your Direct Debit at any time by contacting your bank or building society, or ${input.garageName}.`;
  const html = `<p>${escapeHtml(rendered.text)}</p><p>You can cancel your Direct Debit at any time by contacting your bank or building society, or ${escapeHtml(input.garageName)}.</p>`;
  return { body: text, subject, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
