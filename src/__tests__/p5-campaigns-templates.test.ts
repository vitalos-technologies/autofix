import { describe, expect, it } from "vitest";
import { describeSegment, parseStoredSegment, segmentFromForm } from "@/lib/campaigns/segment";
import { campaignLinkPath } from "@/lib/campaigns/send";
import {
  availableStarters,
  CAMPAIGN_STARTERS,
  campaignSampleValues,
  checkCampaignTemplate,
  nextMonth,
  STARTERS,
  starterSegment,
  starterService,
} from "@/lib/campaigns/templates";
import { campaignStatusPill, formatSendTime, localInputValue, recipientPill } from "@/lib/campaigns/view";
import { zonedInstant } from "@/lib/admin/dates";
import { OPT_OUT_LINE, renderTemplate, smsSegments } from "@/lib/messaging/templates";
import { createReminderLinkToken } from "@/lib/reminders/link-token";
import { garageUrl } from "@/lib/tenancy/urls";

// P5.5 campaign wording, segments and how the pages show them.

const PRODUCTION = { NODE_ENV: "production", VERCEL_ENV: "production" } as const;
const longGarage = { id: "0d5c3c1e-6b7a-4f0e-9a51-2b8f4e6d7c90", slug: "doncaster-car-centre", customDomain: null };

function form(entries: Array<[string, string]>) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("ready-made starting points", () => {
  it.each(CAMPAIGN_STARTERS)("the %s starter fits one GSM-7 text with long real values and the opt-out line", (key) => {
    const values = {
      ...campaignSampleValues({ garageName: "Doncaster Car Centre", bookingBaseUrl: garageUrl(longGarage, "/", PRODUCTION) }),
      first_name: "Christabelle",
      link: garageUrl(longGarage, campaignLinkPath(createReminderLinkToken().token), PRODUCTION),
    };
    expect(values.link).toMatch(/^https:\/\/doncaster-car-centre\.pitline\.co\.uk\/c\/[A-Za-z0-9_-]{22}$/);
    const text = renderTemplate(STARTERS[key].template, values, { channel: "sms" }).text;
    const info = smsSegments(text);
    expect(text.endsWith(OPT_OUT_LINE)).toBe(true);
    expect(info.encoding).toBe("GSM-7");
    expect(info.characters, text).toBeLessThanOrEqual(160);
    expect(checkCampaignTemplate(STARTERS[key].template)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("MOT month is only offered while the garage does MOTs", () => {
    expect(availableStarters(false).map((starter) => starter.key)).toEqual(["winter_check", "summer_aircon", "win_back"]);
    expect(availableStarters(true).map((starter) => starter.key)).toContain("mot_month");
  });

  it("win-back is not seen for 12 months; MOT month is next month (December wraps)", () => {
    expect(starterSegment("win_back", "2026-10-28")).toEqual({ not_seen_months: 12 });
    expect(starterSegment("mot_month", "2026-10-28")).toEqual({ mot_months: [11] });
    expect(nextMonth("2026-12-03")).toBe(1);
    expect(starterSegment("winter_check", "2026-10-28")).toEqual({});
  });

  it("picks a fitting service for the link", () => {
    const services = [
      { id: "mot", name: "MOT", isMot: true },
      { id: "full", name: "Full service", isMot: false },
      { id: "aircon", name: "Air-con regas", isMot: false },
      { id: "check", name: "Winter health check", isMot: false },
    ];
    expect(starterService("mot_month", services)).toBe("mot");
    expect(starterService("summer_aircon", services)).toBe("aircon");
    expect(starterService("winter_check", services)).toBe("check");
    expect(starterService("win_back", services)).toBe("full");
    expect(starterService("summer_aircon", [{ id: "x", name: "Tyres", isMot: false }])).toBeNull();
  });
});

describe("checkCampaignTemplate", () => {
  it("refuses unknown placeholders (including the reminder-only {due_date}) and wording without {garage}", () => {
    const check = checkCampaignTemplate("Hi {first_name}, MOT due {due_date}: {link}");
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toContain("{due_date} isn't a placeholder");
    expect(check.errors.join(" ")).toContain("Include {garage}");
  });

  it("warns, without refusing, when there is no link", () => {
    expect(checkCampaignTemplate("{garage}: hello {first_name}")).toMatchObject({ ok: true, warnings: [expect.stringContaining("{link}")] });
  });

  it("refuses an empty or over-long message", () => {
    expect(checkCampaignTemplate("  ").ok).toBe(false);
    expect(checkCampaignTemplate(`{garage} ${"x".repeat(1000)}`).ok).toBe(false);
  });
});

describe("segment builder", () => {
  it("reads every filter", () => {
    const parsed = segmentFromForm(
      form([
        ["carAgeMin", "3"],
        ["carAgeMax", "10"],
        ["motMonth", "3"],
        ["motMonth", "1"],
        ["notSeen", "12"],
        ["history", "never"],
        ["historyService", "11111111-1111-4111-8111-111111111111"],
        ["channel", "sms"],
        ["channel", "email"],
      ]),
      { motEnabled: true },
    );
    expect(parsed).toEqual({
      ok: true,
      segment: {
        car_age_min: 3,
        car_age_max: 10,
        mot_months: [1, 3],
        not_seen_months: 12,
        service_id: "11111111-1111-4111-8111-111111111111",
        service_history: "never",
        channels: ["sms", "email"],
      },
    });
  });

  it("empty filters, or every channel ticked, mean everyone", () => {
    expect(segmentFromForm(form([["history", "any"], ["channel", "sms"], ["channel", "whatsapp"], ["channel", "email"]]), { motEnabled: true })).toEqual({ ok: true, segment: {} });
  });

  it("ignores MOT months when the garage does not do MOTs", () => {
    expect(segmentFromForm(form([["motMonth", "3"]]), { motEnabled: false })).toEqual({ ok: true, segment: {} });
  });

  it.each([
    ["an age range the wrong way round", [["carAgeMin", "9"], ["carAgeMax", "2"]], "carAge"],
    ["an age that is not a number", [["carAgeMin", "old"]], "carAge"],
    ["a month out of range", [["motMonth", "13"]], "motMonths"],
    ["history without a service", [["history", "had"]], "service"],
    ["an unknown channel", [["channel", "fax"]], "channels"],
  ] as const)("refuses %s", (_label, entries, field) => {
    const parsed = segmentFromForm(form(entries.map(([key, value]) => [key, value])), { motEnabled: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.fieldErrors)).toContain(field);
  });

  it("describes segments in words", () => {
    expect(describeSegment({})).toEqual(["Every customer you may send offers to"]);
    expect(describeSegment({ car_age_min: 3, car_age_max: 8, mot_months: [3, 4], not_seen_months: 12, service_id: "s", service_history: "had", channels: ["sms"] }, { serviceName: () => "Air-con regas" })).toEqual([
      "Cars 3 to 8 years old",
      "MOT due in March and April",
      "Not seen for 12 months or more",
      "Have had Air-con regas",
      "Who hear from you by text",
    ]);
  });

  it("a stored segment that does not parse is shown as everyone", () => {
    expect(parseStoredSegment({ postcode: "DN1" })).toEqual({});
    expect(parseStoredSegment({ not_seen_months: 6 })).toEqual({ not_seen_months: 6 });
  });
});

describe("times in the garage's time zone", () => {
  it("formats send times in UK time across the clock change", () => {
    expect(formatSendTime("2026-10-24T09:00:00Z", "Europe/London")).toBe("Sat 24 Oct, 10:00");
    expect(formatSendTime("2026-10-26T10:00:00Z", "Europe/London")).toBe("Mon 26 Oct, 10:00");
  });

  it("round-trips the date-time field on both clock-change days", () => {
    for (const value of ["2026-03-29T10:00", "2026-10-25T10:00", "2026-06-01T09:30"]) {
      const instant = zonedInstant(value, "Europe/London");
      expect(instant).not.toBeNull();
      expect(localInputValue(instant!, "Europe/London")).toBe(value);
    }
    expect(zonedInstant("2026-03-29T01:30", "Europe/London")).toBeNull();
  });
});

describe("status pills", () => {
  it("labels campaigns and recipients", () => {
    expect(campaignStatusPill("draft")).toEqual({ status: "no_consent", label: "Draft" });
    expect(campaignStatusPill("cancelled").label).toBe("Stopped");
    expect(recipientPill({ status: "delivered", skipReason: null, booked: true })).toEqual({ status: "booked" });
    expect(recipientPill({ status: "cancelled", skipReason: "opted_out", booked: false })).toEqual({ status: "cancelled", label: "Opted out" });
    expect(recipientPill({ status: "sent", skipReason: null, booked: false })).toEqual({ status: "sent" });
  });
});
