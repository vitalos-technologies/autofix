import { z } from "zod";
import { askbridgeScriptUrl } from "@/lib/askbridge/config";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
});

export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || undefined,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || undefined,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined,
});

export const requiredProductionVariables = [
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "RESEND_API_KEY",
  // Platform sender; each garage's name is the display name and its own
  // address the reply-to (RESEND_REPLY_TO is an optional fallback).
  "RESEND_FROM_EMAIL",
  "ENQUIRY_REPLY_DOMAIN",
  "RESEND_WEBHOOK_SECRET",
  "CLOUDFLARE_EMAIL_WEBHOOK_SECRET",
  "TURNSTILE_SECRET_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "CRON_SECRET",
] as const;

// The booking engine runs in our own database; it only needs the secret that
// signs manage links, manage sessions and calendar downloads.
export const requiredBookingVariables = [
  "BOOKING_MANAGEMENT_SECRET",
] as const;

export function getEnvironmentReadiness() {
  const missing: string[] = requiredProductionVariables.filter((name) => !process.env[name]);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.NODE_ENV === "production" && siteUrl) {
    const parsed = new URL(siteUrl);
    if (parsed.protocol !== "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      missing.push("NEXT_PUBLIC_SITE_URL_PRODUCTION_DOMAIN");
    }
  }
  if (process.env.LEGAL_COPY_APPROVED !== "true") missing.push("LEGAL_COPY_APPROVED");
  if (process.env.COOKIE_CONFIGURATION_APPROVED !== "true") missing.push("COOKIE_CONFIGURATION_APPROVED");
  return { ready: missing.length === 0, missing };
}

/**
 * Askbridge (P4.6): optional, and needs no secrets. `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL` overrides the loader
 * URL (Askbridge's own when unset); a value that is set but invalid hides the chat and is reported here.
 * Never blocks launch.
 */
export const askbridgeVariables = ["NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL"] as const;

export function getAskbridgeEnvironmentReadiness(env: Readonly<Record<string, string | undefined>> = process.env) {
  const missing: string[] = askbridgeScriptUrl(env) ? [] : [...askbridgeVariables];
  return { ready: missing.length === 0, missing };
}

export function getBookingEnvironmentReadiness() {
  const missing: string[] = requiredBookingVariables.filter((name) => !process.env[name]);
  return { ready: missing.length === 0, missing };
}
