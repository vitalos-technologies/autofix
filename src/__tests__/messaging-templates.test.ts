import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATES,
  GSM_BASIC_CHARACTER_COUNT,
  hasOptOut,
  OPT_OUT_LINE,
  renderTemplate,
  smsSegments,
  withOptOut,
  type TemplateVariables,
} from "@/lib/messaging/templates";

const vars: TemplateVariables = {
  first_name: "Sam",
  vehicle: "Ford Fiesta",
  reg: "AB12 CDE",
  due_date: "14 Nov",
  link: "https://hartley-road.pitline.co.uk/r/abc123",
  garage: "Hartley Road Garage",
  service: "Full service",
  date: "Tue 3 Nov",
  time: "09:30",
  reference: "HRG-1042",
  manage_link: "https://hartley-road.pitline.co.uk/m/xyz",
};

describe("renderTemplate", () => {
  it("renders the MOT reminder exactly as the consent wording draft for SMS", () => {
    const rendered = renderTemplate(DEFAULT_TEMPLATES.mot.body, vars, { channel: "sms" });
    expect(rendered.text).toBe(
      "Hartley Road Garage: Hi Sam, MOT due 14 Nov. Book: https://hartley-road.pitline.co.uk/r/abc123\n" + OPT_OUT_LINE,
    );
    expect(rendered.unknownPlaceholders).toEqual([]);
    expect(rendered.missingPlaceholders).toEqual([]);
  });

  it("renders the service reminder exactly as the consent wording draft for WhatsApp", () => {
    expect(renderTemplate(DEFAULT_TEMPLATES.service.body, vars, { channel: "whatsapp" }).text).toBe(
      "Hartley Road Garage: Hi Sam, service due. Book: https://hartley-road.pitline.co.uk/r/abc123\n" + OPT_OUT_LINE,
    );
  });

  it("keeps the missed-call and confirmation wording and adds the opt-out after it", () => {
    expect(renderTemplate(DEFAULT_TEMPLATES.missed_call.body, vars, { channel: "sms" }).text).toBe(
      "Hartley Road Garage: sorry we missed your call. Book at https://hartley-road.pitline.co.uk/r/abc123 or we'll call you back. " + OPT_OUT_LINE,
    );
    expect(renderTemplate(DEFAULT_TEMPLATES.booking_confirmed.body, vars, { channel: "sms" }).text).toBe(
      "Hartley Road Garage: you're booked in for Full service on Tue 3 Nov at 09:30. Ref HRG-1042. Change or cancel: https://hartley-road.pitline.co.uk/m/xyz\n" +
        OPT_OUT_LINE,
    );
  });

  it("adds no opt-out line for email or when no channel is given", () => {
    const email = renderTemplate(DEFAULT_TEMPLATES.mot.body, vars, { channel: "email" }).text;
    expect(hasOptOut(email)).toBe(false);
    expect(hasOptOut(renderTemplate(DEFAULT_TEMPLATES.mot.body, vars).text)).toBe(false);
  });

  it("every default template names the garage and renders with no gaps", () => {
    for (const template of Object.values(DEFAULT_TEMPLATES)) {
      expect(template.body).toContain("{garage}");
      const rendered = renderTemplate(template.body, vars, { channel: "sms" });
      expect(rendered.missingPlaceholders).toEqual([]);
      expect(rendered.unknownPlaceholders).toEqual([]);
      expect(rendered.text.endsWith(OPT_OUT_LINE)).toBe(true);
      expect(renderTemplate(template.subject, vars).missingPlaceholders).toEqual([]);
    }
  });

  it("every default SMS stays in GSM-7 (no curly quotes or emoji)", () => {
    for (const template of Object.values(DEFAULT_TEMPLATES)) {
      const info = smsSegments(renderTemplate(template.body, vars, { channel: "sms" }).text);
      expect(info.encoding).toBe("GSM-7");
      expect(info.segments).toBeLessThanOrEqual(2);
    }
  });

  it("marks reminders as needing consent and service messages as not", () => {
    expect(DEFAULT_TEMPLATES.mot.purpose).toBe("reminder");
    expect(DEFAULT_TEMPLATES.service.purpose).toBe("reminder");
    expect(DEFAULT_TEMPLATES.review.purpose).toBe("reminder");
    expect(DEFAULT_TEMPLATES.missed_call.purpose).toBe("service");
    expect(DEFAULT_TEMPLATES.booking_confirmed.purpose).toBe("service");
  });

  it("leaves unknown placeholders visible and reports them", () => {
    const rendered = renderTemplate("Hi {frist_name}, see {garage} at {Location}. {frist_name}", vars);
    expect(rendered.text).toBe("Hi {frist_name}, see Hartley Road Garage at {Location}. {frist_name}");
    expect(rendered.unknownPlaceholders).toEqual(["{frist_name}", "{Location}"]);
  });

  it("leaves known placeholders without a value visible and reports them", () => {
    const rendered = renderTemplate("Hi {first_name}, your {vehicle} is due on {due_date}.", { first_name: "  ", vehicle: null });
    expect(rendered.text).toBe("Hi {first_name}, your {vehicle} is due on {due_date}.");
    expect(rendered.missingPlaceholders).toEqual(["first_name", "vehicle", "due_date"]);
  });

  it("accepts spaced or capitalised placeholders", () => {
    expect(renderTemplate("Hi { first_name }, {GARAGE}", vars).text).toBe("Hi Sam, Hartley Road Garage");
  });

  it("does not expand placeholders inside values and flattens line breaks in values", () => {
    const rendered = renderTemplate("Hi {first_name}, book: {link}", { first_name: "{link}\nSTOP", link: "https://x.test/r/1" });
    expect(rendered.text).toBe("Hi {link} STOP, book: https://x.test/r/1");
  });
});

describe("withOptOut", () => {
  it("joins after a full stop and uses a new line otherwise", () => {
    expect(withOptOut("Thanks. Hartley Road.", "sms")).toBe("Thanks. Hartley Road. Reply STOP to opt out.");
    expect(withOptOut("Book: https://x.test/r/1", "whatsapp")).toBe("Book: https://x.test/r/1\nReply STOP to opt out.");
    expect(withOptOut("Thanks!  \n", "sms")).toBe("Thanks! Reply STOP to opt out.");
    expect(withOptOut("", "sms")).toBe(OPT_OUT_LINE);
  });

  it("does not add it twice", () => {
    expect(withOptOut("Hi. Reply STOP to opt out.", "sms")).toBe("Hi. Reply STOP to opt out.");
    expect(withOptOut("Hi. reply stop to opt out", "sms")).toBe("Hi. reply stop to opt out");
    const once = withOptOut("Hi", "sms");
    expect(withOptOut(once, "sms")).toBe(once);
  });

  it("leaves email unchanged", () => {
    expect(withOptOut("Hi there", "email")).toBe("Hi there");
  });
});

describe("smsSegments", () => {
  it("has the full GSM 03.38 basic set", () => {
    expect(GSM_BASIC_CHARACTER_COUNT).toBe(127);
  });

  it("counts 160 GSM characters as one segment and 161 as two", () => {
    expect(smsSegments("a".repeat(160))).toMatchObject({ encoding: "GSM-7", characters: 160, segments: 1, perSegment: 160, remaining: 0 });
    expect(smsSegments("a".repeat(161))).toMatchObject({ encoding: "GSM-7", characters: 161, segments: 2, perSegment: 153, remaining: 145 });
    expect(smsSegments("a".repeat(306))).toMatchObject({ segments: 2, remaining: 0 });
    expect(smsSegments("a".repeat(307))).toMatchObject({ segments: 3 });
  });

  it("counts extension characters such as the euro sign double", () => {
    expect(smsSegments("€")).toMatchObject({ encoding: "GSM-7", characters: 2, segments: 1 });
    expect(smsSegments(`${"a".repeat(158)}€`)).toMatchObject({ characters: 160, segments: 1 });
    expect(smsSegments(`${"a".repeat(159)}€`)).toMatchObject({ characters: 161, segments: 2 });
    expect(smsSegments("€".repeat(80))).toMatchObject({ characters: 160, segments: 1 });
    expect(smsSegments("[]{}~^|\\").characters).toBe(16);
  });

  it("never splits an escape pair across segments", () => {
    // 152 + 2 + 152 = 306 septets: naive division says 2 segments, but the euro cannot straddle the boundary.
    expect(smsSegments(`${"a".repeat(152)}€${"a".repeat(152)}`)).toMatchObject({ characters: 306, segments: 3 });
  });

  it("keeps £ and accented GSM letters in GSM-7", () => {
    expect(smsSegments("£45 for an MOT, café, Ñ, ß, Ä").encoding).toBe("GSM-7");
  });

  it("switches to UCS-2 for an emoji and reports what caused it", () => {
    const info = smsSegments("Hi 👋");
    expect(info).toMatchObject({ encoding: "UCS-2", characters: 5, segments: 1, perSegment: 70, remaining: 65 });
    expect(info.unicodeCharacters).toEqual(["👋"]);
  });

  it("switches to UCS-2 for a curly apostrophe", () => {
    const info = smsSegments("We’ll call you");
    expect(info.encoding).toBe("UCS-2");
    expect(info.unicodeCharacters).toEqual(["’"]);
  });

  it("uses 70 and 67 character UCS-2 segments", () => {
    expect(smsSegments(`${"ş".repeat(70)}`)).toMatchObject({ encoding: "UCS-2", characters: 70, segments: 1 });
    expect(smsSegments(`${"ş".repeat(71)}`)).toMatchObject({ characters: 71, segments: 2, perSegment: 67 });
    expect(smsSegments(`${"ş".repeat(134)}`)).toMatchObject({ segments: 2, remaining: 0 });
    expect(smsSegments(`${"ş".repeat(135)}`)).toMatchObject({ segments: 3 });
  });

  it("never splits a surrogate pair across UCS-2 segments", () => {
    // 66 + 2 + 66 = 134 units: naive division says 2, but the emoji cannot straddle the 67-unit boundary.
    expect(smsSegments(`${"ş".repeat(66)}😀${"ş".repeat(66)}`)).toMatchObject({ characters: 134, segments: 3 });
  });

  it("reports an empty body as zero segments", () => {
    expect(smsSegments("")).toMatchObject({ characters: 0, segments: 0, remaining: 160 });
  });
});
