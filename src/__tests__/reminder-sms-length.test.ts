import { describe, expect, it } from "vitest";
import { parseLegalMarkdown } from "@/lib/legal/markdown";
import { LEGAL_SOURCES } from "@/lib/legal/sources.generated";
import { DEFAULT_TEMPLATES, OPT_OUT_LINE, renderTemplate, smsSegments } from "@/lib/messaging/templates";
import { formatReminderDate } from "@/lib/reminders/compose";
import { createReminderLinkToken, reminderLinkPath } from "@/lib/reminders/link-token";
import { RULE_KINDS, SAMPLE_LINK_TOKEN, sampleTemplateValues } from "@/lib/reminders/rules";
import { garageUrl } from "@/lib/tenancy/urls";

// DECISIONS A169, A184-A185: every default reminder and the missed-call
// text-back fit one GSM-7 text (160 characters, opt-out line included) with
// long real-world values: a 20-character slug on the free link host, a
// 20-character garage name, a 12-character first name, the longest short date
// and a real 22-character reminder link token.

const PRODUCTION = { NODE_ENV: "production", VERCEL_ENV: "production" } as const;
const garage = { id: "0d5c3c1e-6b7a-4f0e-9a51-2b8f4e6d7c90", slug: "doncaster-car-centre", customDomain: null };
const GARAGE_NAME = "Doncaster Car Centre";
const FIRST_NAME = "Christabelle";

function longValues(kind: (typeof RULE_KINDS)[number]) {
  const base = garageUrl(garage, "/", PRODUCTION).replace(/\/$/, "");
  const values = sampleTemplateValues({ kind, garageName: GARAGE_NAME, bookingBaseUrl: base, dueDate: formatReminderDate("2026-11-24") });
  if (kind === "missed_call") return values;
  return { ...values, first_name: FIRST_NAME, link: garageUrl(garage, reminderLinkPath(createReminderLinkToken().token), PRODUCTION) };
}

describe("default reminder wording fits one text", () => {
  it("uses the long sample values it claims to", () => {
    expect(garage.slug).toHaveLength(20);
    expect(GARAGE_NAME).toHaveLength(20);
    expect(FIRST_NAME).toHaveLength(12);
    expect(longValues("mot").link).toMatch(/^https:\/\/doncaster-car-centre\.autofix\.vitalos\.co\.uk\/r\/[A-Za-z0-9_-]{22}$/);
    expect(longValues("missed_call").link).toBe("https://doncaster-car-centre.autofix.vitalos.co.uk/");
  });

  it.each(RULE_KINDS)("the %s default renders to one GSM-7 SMS of at most 160 characters", (kind) => {
    const text = renderTemplate(DEFAULT_TEMPLATES[kind].body, longValues(kind), { channel: "sms" }).text;
    const info = smsSegments(text);
    expect(text.endsWith(OPT_OUT_LINE)).toBe(true);
    expect(text).toContain(GARAGE_NAME);
    expect(info.encoding).toBe("GSM-7");
    expect(info.unicodeCharacters).toEqual([]);
    expect(info.characters, text).toBeLessThanOrEqual(160);
    expect(info.segments).toBe(1);
  });

  it("keeps what each reminder must say: the date for the MOT, the link everywhere", () => {
    expect(renderTemplate(DEFAULT_TEMPLATES.mot.body, longValues("mot")).text).toContain("MOT due 24 Nov");
    expect(renderTemplate(DEFAULT_TEMPLATES.service.body, longValues("service")).text).toContain("service due");
    for (const kind of RULE_KINDS) {
      const values = longValues(kind);
      expect(renderTemplate(DEFAULT_TEMPLATES[kind].body, values).text).toContain(values.link);
    }
  });

  it("no short date is longer than the one the test uses", () => {
    const lengths = Array.from({ length: 366 }, (_, day) => formatReminderDate(new Date(Date.UTC(2028, 0, 1 + day)).toISOString().slice(0, 10)).length);
    expect(Math.max(...lengths)).toBe(formatReminderDate("2026-11-24").length);
  });

  it("is the wording in the consent and messaging draft, opt-out line included", () => {
    const quotes = parseLegalMarkdown(LEGAL_SOURCES.consentWording).flatMap((block) => (block.kind === "quote" ? [block.text] : []));
    for (const kind of RULE_KINDS) expect(quotes).toContain(renderTemplate(DEFAULT_TEMPLATES[kind].body, {}, { channel: "sms" }).text);
  });

  it("the sample token is as long as a real one, so the editor's counter is honest", () => {
    expect(SAMPLE_LINK_TOKEN).toHaveLength(createReminderLinkToken().token.length);
  });
});

describe("formatReminderDate", () => {
  it("writes the day and a three-letter month", () => {
    expect(formatReminderDate("2026-11-24")).toBe("24 Nov");
    expect(formatReminderDate("2026-09-03")).toBe("3 Sep");
    expect(formatReminderDate("2027-01-01", "2026-12-04T09:00:00Z")).toBe("1 Jan");
  });

  it("adds the year when the date is more than 180 days from the send", () => {
    expect(formatReminderDate("2027-11-24", "2026-11-24T09:00:00Z")).toBe("24 Nov 2027");
    expect(formatReminderDate("2027-06-01", new Date("2026-11-24T09:00:00Z"))).toBe("1 Jun 2027");
    expect(formatReminderDate("2027-05-22", "2026-11-24T09:00:00Z")).toBe("22 May");
  });

  it("is empty for anything that is not a real date (the sender then refuses the template)", () => {
    for (const value of ["", "2026-02-30", "24/11/2026", "2026-13-01", "2026-11-24T00:00:00Z"]) expect(formatReminderDate(value)).toBe("");
  });
});
