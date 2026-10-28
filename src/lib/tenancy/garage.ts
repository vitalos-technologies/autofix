import "server-only";

import { createClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { PublicGarage } from "@/components/garage/garage-provider";
import { askbridgeFromSettings } from "@/lib/askbridge/config";
import { resolveHost } from "@/lib/tenancy/resolve";

export type GarageAddress = { line1?: string; line2?: string; town?: string; postcode?: string };

/** Bank details printed on invoices (`garages.settings.invoicePayment`). */
export type GarageInvoicePayment = { accountName: string; sortCode: string; accountNumber: string };

/** Garage profile used by booking sites, emails and the admin. Never holds secrets. */
export type Garage = {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  companyNumber: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: GarageAddress;
  timezone: string;
  logoUrl: string | null;
  accent: string;
  /** `garages.plan`: `essentials` or `pro` (P5.2). Check features with `hasFeature()` (src/lib/plans), not this. */
  plan: string;
  /** End of the Pro trial, or null (P5.2). */
  trialEndsAt?: string | null;
  /** What the garage chose or pays for (`essentials`/`pro`), or null (P5.2). */
  planChosen?: string | null;
  motEnabled: boolean;
  bookingPrefix: string;
  slotStepMin: number;
  approveOnline: boolean;
  serviceArea: string[];
  cancellationCutoffH: number;
  smsSender: string | null;
  status: string;
  /** Active, verified custom booking host (e.g. `book.hartleyroad.co.uk`), if any. */
  customDomain: string | null;
  /** Short strap line from `settings.tagline`, shown on invoices and emails. */
  tagline: string | null;
  /** Invoice bank details from `settings.invoicePayment`; null hides the payment block. */
  invoicePayment: GarageInvoicePayment | null;
  /** Askbridge widget id from `settings.askbridge` while the owner has it on (P4.6); otherwise null. */
  askbridgeWidgetId?: string | null;
};

type GarageDomainRow = { hostname: string; kind?: string | null; status?: string | null; deleted_at?: string | null; created_at?: string | null };

export type GarageRow = {
  id: string;
  slug: string;
  name: string;
  legal_name?: string | null;
  company_number?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: GarageAddress | null;
  timezone?: string | null;
  logo_url?: string | null;
  accent?: string | null;
  plan?: string | null;
  trial_ends_at?: string | null;
  plan_chosen?: string | null;
  mot_enabled?: boolean | null;
  booking_prefix?: string | null;
  slot_step_min?: number | null;
  approve_online?: boolean | null;
  service_area?: string[] | null;
  cancellation_cutoff_h?: number | null;
  sms_sender?: string | null;
  status: string;
  settings?: Record<string, unknown> | null;
  garage_domains?: GarageDomainRow[] | null;
};

/** Columns read for a garage profile (plus its domains, for links in emails). */
export const GARAGE_SELECT = "*, garage_domains(hostname,kind,status,deleted_at,created_at)";

function text(value: unknown, max = 200) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function invoicePaymentFrom(settings: Record<string, unknown> | null | undefined): GarageInvoicePayment | null {
  const raw = settings?.invoicePayment;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const accountName = text(value.accountName, 120);
  const sortCode = text(value.sortCode, 20);
  const accountNumber = text(value.accountNumber, 20);
  return accountName && sortCode && accountNumber ? { accountName, sortCode, accountNumber } : null;
}

function activeCustomDomain(domains: GarageDomainRow[] | null | undefined) {
  const active = (domains ?? [])
    .filter((domain) => domain.kind === "custom" && domain.status === "active" && !domain.deleted_at && domain.hostname)
    .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
  return active[0]?.hostname ?? null;
}

export function garageFromRow(row: GarageRow): Garage {
  const askbridge = askbridgeFromSettings(row.settings);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name ?? null,
    companyNumber: row.company_number ?? null,
    phone: row.phone ?? null,
    whatsapp: row.whatsapp ?? null,
    email: row.email ?? null,
    address: row.address ?? {},
    timezone: row.timezone || "Europe/London",
    logoUrl: row.logo_url ?? null,
    accent: row.accent || "#155fba",
    plan: row.plan || "essentials",
    trialEndsAt: row.trial_ends_at ?? null,
    planChosen: row.plan_chosen ?? null,
    motEnabled: row.mot_enabled ?? false,
    bookingPrefix: row.booking_prefix || "AF",
    slotStepMin: row.slot_step_min ?? 15,
    approveOnline: row.approve_online ?? false,
    serviceArea: row.service_area ?? [],
    cancellationCutoffH: row.cancellation_cutoff_h ?? 24,
    smsSender: row.sms_sender ?? null,
    status: row.status,
    customDomain: activeCustomDomain(row.garage_domains),
    tagline: text(row.settings?.tagline, 160),
    invoicePayment: invoicePaymentFrom(row.settings),
    askbridgeWidgetId: askbridge.enabled ? askbridge.widgetId : null,
  };
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return null;
  return createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads a garage by id with the service role. Deduplicated per request. */
export const getGarageById = cache(async (garageId: string): Promise<Garage | null> => {
  const client = serviceClient();
  if (!client || !UUID_PATTERN.test(garageId)) return null;
  const { data, error } = await client.from("garages").select(GARAGE_SELECT).eq("id", garageId).maybeSingle();
  if (error) throw new Error(`garage load failed: ${error.code ?? "unknown"}`);
  return data ? garageFromRow(data as GarageRow) : null;
});

/** The garage whose booking site the current request is on, or null on the admin host. */
export const getHostGarage = cache(async (): Promise<Garage | null> => {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const cookieHeader = requestHeaders.get("cookie") ?? "";
  const devCookie = /(?:^|;\s*)af_dev_garage=([^;]+)/.exec(cookieHeader)?.[1] ?? null;
  const resolution = await resolveHost(host, { devGarageParam: devCookie ? decodeURIComponent(devCookie) : null });
  if (resolution.kind !== "garage") return null;
  return getGarageById(resolution.garage.id);
});

/** For public routes and pages: the host's garage, or a 404. */
export async function getGarage(): Promise<Garage> {
  const garage = await getHostGarage();
  if (!garage) notFound();
  return garage;
}

/**
 * For pages under `/_site/[garageId]`: the route param must be the host's garage.
 * The proxy only rewrites to the host's own id, so a mismatch means a crafted request.
 */
export async function requireSiteGarage(garageId: string): Promise<Garage> {
  const garage = await getHostGarage();
  if (!garage || garage.id !== garageId) notFound();
  return garage;
}

/** One-line location for headers and emails, e.g. "Doncaster". */
export function garageLocation(garage: Pick<Garage, "address">) {
  return garage.address.town ?? garage.address.postcode ?? "";
}

/** The subset of a garage that is safe to hand to client components. */
export function publicGarage(garage: Garage): PublicGarage {
  return {
    id: garage.id,
    slug: garage.slug,
    name: garage.name,
    phone: garage.phone,
    whatsapp: garage.whatsapp,
    email: garage.email,
    line1: garage.address.line1 ?? null,
    line2: garage.address.line2 ?? null,
    town: garage.address.town ?? null,
    postcode: garage.address.postcode ?? null,
    timezone: garage.timezone,
    logoUrl: garage.logoUrl,
    accent: garage.accent,
    motEnabled: garage.motEnabled,
    bookingPrefix: garage.bookingPrefix,
  };
}
