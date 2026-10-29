import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { platformEmailBrand } from "@/lib/email/brand";
import { isValidEmailAddress } from "@/lib/email/identity";
import { renderPlatformEnquiryNotification } from "@/lib/email/templates/platform-enquiries";
import { getChannel, type MessageChannel } from "@/lib/messaging/channel";
import { createAdminClient } from "@/lib/supabase/server";
import { adminUrl } from "@/lib/tenancy/urls";
import { topicLabel, type PlatformEnquiryInput } from "./schema";

// Contact page enquiries (`/contact` on the admin host). POST /api/contact validates, runs the human
// check and the rate limits, then calls these: the row goes into public.platform_enquiries with the
// service key (a platform table, DECISIONS A10), and Vitalos gets an email through the existing email
// channel (mock unless MESSAGING_MODE=live) when PLATFORM_ENQUIRY_EMAIL is set.

export type StoredPlatformEnquiry = PlatformEnquiryInput & { id: string; receivedAt: string };

export class PlatformEnquiryUnavailable extends Error {
  constructor() {
    super("The enquiry could not be stored.");
    this.name = "PlatformEnquiryUnavailable";
  }
}

/** Stores one enquiry. Throws PlatformEnquiryUnavailable when there is no database or the insert fails. */
export async function createPlatformEnquiry(
  input: PlatformEnquiryInput,
  options: { ipHash?: string | null; client?: SupabaseClient | null } = {},
): Promise<StoredPlatformEnquiry> {
  const client = options.client === undefined ? createAdminClient() : options.client;
  if (!client) throw new PlatformEnquiryUnavailable();
  const { data, error } = await client
    .from("platform_enquiries")
    .insert({
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      garage_name: input.garageName ?? null,
      topic: input.topic,
      message: input.message,
      ip_hash: options.ipHash && /^[0-9a-f]{64}$/.test(options.ipHash) ? options.ipHash : null,
    })
    .select("id, received_at")
    .single();
  if (error || !data) throw new PlatformEnquiryUnavailable();
  const row = data as { id: string; received_at: string };
  return { ...input, id: row.id, receivedAt: row.received_at };
}

export type PlatformEnquiryNotification =
  | { status: "sent" }
  | { status: "not_configured" }
  | { status: "failed"; code: string };

/** The recipient from PLATFORM_ENQUIRY_EMAIL, or null when it is empty or not an address (nothing is sent). */
export function platformEnquiryRecipient(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env.PLATFORM_ENQUIRY_EMAIL?.trim();
  return value && isValidEmailAddress(value) ? value : null;
}

function londonTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(date);
}

/** Emails Vitalos about one enquiry. Never throws: the enquiry is already stored. */
export async function notifyPlatformEnquiry(
  enquiry: StoredPlatformEnquiry,
  options: { env?: Readonly<Record<string, string | undefined>>; channel?: MessageChannel } = {},
): Promise<PlatformEnquiryNotification> {
  const recipient = platformEnquiryRecipient(options.env);
  if (!recipient) return { status: "not_configured" };
  const topic = topicLabel(enquiry.topic);
  const rendered = renderPlatformEnquiryNotification({
    brand: platformEmailBrand(),
    name: enquiry.name,
    email: enquiry.email,
    phone: enquiry.phone,
    garageName: enquiry.garageName,
    topic,
    message: enquiry.message,
    receivedAt: londonTime(enquiry.receivedAt),
    url: adminUrl(`/superadmin/enquiries/${enquiry.id}/`),
  });
  try {
    const result = await (options.channel ?? getChannel("email")).send({
      garageId: "platform",
      to: recipient,
      replyTo: enquiry.email,
      subject: `New enquiry: ${topic} from ${enquiry.name}`,
      body: rendered.text,
      html: rendered.html,
      idempotencyKey: `platform_enquiry:${enquiry.id}`,
    });
    return result.ok ? { status: "sent" } : { status: "failed", code: result.code };
  } catch {
    return { status: "failed", code: "provider_error" };
  }
}
