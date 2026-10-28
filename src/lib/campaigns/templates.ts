// Campaign wording (P5.5): the placeholders a campaign can fill in, the checks the editor and the
// server both run, and the ready-made starting points. Pure and client-safe.
//
// Campaigns use the same rendering as reminders (renderTemplate in src/lib/messaging/templates.ts):
// texts and WhatsApp always end with "Reply STOP to opt out." (added for the garage), emails get
// the signed "Stop reminders" link instead (src/lib/campaigns/compose.ts). The starters fit one
// GSM-7 text with a 20-character garage name and free-link slug, a 12-character first name and a
// real 22-character link token (src/__tests__/p5-campaigns-templates.test.ts).

import type { TemplatePlaceholder, TemplateVariables } from "@/lib/messaging/templates";
import { SAMPLE_LINK_TOKEN } from "@/lib/reminders/rules";
import type { CampaignSegment } from "./segment";

/** What the campaign sender fills in. No `{due_date}`: a campaign is not about one date. */
export const CAMPAIGN_PLACEHOLDERS = ["first_name", "vehicle", "reg", "link", "garage"] as const satisfies readonly TemplatePlaceholder[];

export const CAMPAIGN_TEMPLATE_MAX = 1000;
export const CAMPAIGN_EMAIL_TEMPLATE_MAX = 2000;
export const CAMPAIGN_SUBJECT_MAX = 150;
export const CAMPAIGN_NAME_MAX = 80;

const PLACEHOLDER = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

export type CampaignTemplateCheck = { ok: boolean; errors: string[]; warnings: string[] };

/** The sender refuses what this refuses: unknown placeholders, an empty text, and wording without `{garage}`. */
export function checkCampaignTemplate(template: string, options: { max?: number; requireGarage?: boolean } = {}): CampaignTemplateCheck {
  const text = template.trim();
  const max = options.max ?? CAMPAIGN_TEMPLATE_MAX;
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = new Set<string>(CAMPAIGN_PLACEHOLDERS);
  const used = new Set<string>();
  const unknown: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? "").toLowerCase();
    if (allowed.has(name)) used.add(name);
    else if (!unknown.includes(match[0])) unknown.push(match[0]);
  }
  if (!text) errors.push("Write the message first.");
  if (text.length > max) errors.push(`Keep the message under ${max} characters.`);
  if (unknown.length > 0) {
    errors.push(
      `${unknown.join(", ")} ${unknown.length === 1 ? "isn't a placeholder" : "aren't placeholders"} a campaign can fill in. Use ${CAMPAIGN_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}.`,
    );
  }
  if (text && (options.requireGarage ?? true) && !used.has("garage")) errors.push("Include {garage}: every message must say who it is from.");
  if (text && !used.has("link")) warnings.push("There is no {link}, so customers can't book straight from the message.");
  return { ok: errors.length === 0, errors, warnings };
}

/** Sample details for the preview, the counter and the test: as long as the real thing, never a real customer. */
export function campaignSampleValues(input: { garageName: string; bookingBaseUrl: string }): TemplateVariables {
  const base = input.bookingBaseUrl.replace(/\/+$/, "");
  return { first_name: "Priya", vehicle: "Toyota Yaris", reg: "BC23 DEF", link: `${base}/c/${SAMPLE_LINK_TOKEN}`, garage: input.garageName };
}

export const CAMPAIGN_STARTERS = ["winter_check", "summer_aircon", "win_back", "mot_month"] as const;
export type CampaignStarter = (typeof CAMPAIGN_STARTERS)[number];

export function isCampaignStarter(value: unknown): value is CampaignStarter {
  return typeof value === "string" && (CAMPAIGN_STARTERS as readonly string[]).includes(value);
}

export type StarterDefinition = {
  key: CampaignStarter;
  title: string;
  description: string;
  name: string;
  template: string;
  emailSubject: string;
  /** Needs `garages.mot_enabled` (MOT month). */
  mot?: boolean;
  /** Words to look for in the garage's service names for the link (first match wins). */
  serviceHints: readonly RegExp[];
};

export const STARTERS: Readonly<Record<CampaignStarter, StarterDefinition>> = {
  winter_check: {
    key: "winter_check",
    title: "Winter check",
    description: "Seasonal: battery, tyres, lights and antifreeze before the cold sets in.",
    name: "Winter check",
    template: "{garage}: Hi {first_name}, book a winter check: {link}",
    emailSubject: "Is your car ready for winter?",
    serviceHints: [/\bwinter\b/i, /\bhealth check\b/i, /\bcheck\b/i],
  },
  summer_aircon: {
    key: "summer_aircon",
    title: "Summer air-con",
    description: "Seasonal: an air-con check or regas before the hot weather.",
    name: "Summer air-con",
    template: "{garage}: Hi {first_name}, air-con check? Book: {link}",
    emailSubject: "Is your air-con blowing cold?",
    serviceHints: [/\bair[- ]?con/i, /\bregas\b/i, /\bclimate\b/i],
  },
  win_back: {
    key: "win_back",
    title: "Win-back",
    description: "Customers you haven't seen for 12 months or more.",
    name: "We miss you",
    template: "{garage}: Hi {first_name}, we miss you! Book: {link}",
    emailSubject: "It's been a while",
    serviceHints: [/^full service$/i, /\bservice\b/i],
  },
  mot_month: {
    key: "mot_month",
    title: "MOT month",
    description: "Cars whose MOT runs out next month.",
    name: "MOT due next month",
    template: "{garage}: Hi {first_name}, MOT due soon. Book: {link}",
    emailSubject: "Your MOT is due soon",
    mot: true,
    serviceHints: [],
  },
};

/** The starters this garage can use (MOT month only while MOTs are on). */
export function availableStarters(motEnabled: boolean): StarterDefinition[] {
  return CAMPAIGN_STARTERS.map((key) => STARTERS[key]).filter((starter) => motEnabled || !starter.mot);
}

/** "2026-10-28" (garage-local today) → 11: next month's number. */
export function nextMonth(today: string): number {
  const month = Number(today.slice(5, 7));
  return month === 12 ? 1 : month + 1;
}

export type StarterService = { id: string; name: string; isMot: boolean };

/** The starter's segment as of `today` (garage-local, YYYY-MM-DD). */
export function starterSegment(starter: CampaignStarter, today: string): CampaignSegment {
  if (starter === "win_back") return { not_seen_months: 12 };
  if (starter === "mot_month") return { mot_months: [nextMonth(today)] };
  return {};
}

/** The service the starter's link opens: the MOT for MOT month, else the first service whose name fits. */
export function starterService(starter: CampaignStarter, services: readonly StarterService[]): string | null {
  if (starter === "mot_month") return services.find((service) => service.isMot)?.id ?? null;
  for (const hint of STARTERS[starter].serviceHints) {
    const match = services.find((service) => !service.isMot && hint.test(service.name));
    if (match) return match.id;
  }
  return null;
}
