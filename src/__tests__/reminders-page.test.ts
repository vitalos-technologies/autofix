import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery, type FakeResult } from "./support/fake-supabase";
import { testGarage } from "./support/garage";

// The Reminders page (P3.10): rule wording checks that match the senders, the rule in words, the
// "due in the next 30 days" rows, this month's figures through the member's RLS client, and the
// actions (owners and managers only, MFA, the garage from the session, review requests only after
// the consent note, "Send me a test" to the member's own address, rate-limited and audited).

const harness = vi.hoisted(() => ({
  strict: null as null | Record<string, unknown>,
  loose: null as null | Record<string, unknown>,
  revalidated: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  jobs: [] as Array<{ kind: string; payload: unknown; options: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("@/lib/tenancy/admin", () => ({
  getAdminContext: vi.fn(async (options?: { requireMfa?: boolean }) => (options?.requireMfa === false ? harness.loose : harness.strict)),
}));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminAudit: vi.fn(async (garageId: string, entry: Record<string, unknown>) => {
    harness.audits.push({ garageId, ...entry });
    return true;
  }),
}));
vi.mock("@/lib/booking-engine/slots", () => ({ clearSlotCache: () => undefined }));
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: vi.fn(async (kind: string, payload: unknown, options: unknown) => {
    harness.jobs.push({ kind, payload, options });
    return { id: "job" };
  }),
}));

const { allowedPlaceholders, checkTemplate, defaultTemplate, describeRule, parseOffsets, REVIEW_CONSENT_NOTE, RULE_KINDS, SAMPLE_LINK_TOKEN, sampleTemplateValues } = await import(
  "@/lib/reminders/rules"
);
const { bookedShare, sendStatus, shapeDueSoon } = await import("@/lib/admin/reminder-view");
const { loadDueSoon, loadReminderMonth, loadReminderRules, nextMonthStart } = await import("@/lib/admin/reminders");
const { composeTest, sendReminderTest, testRecipient } = await import("@/lib/reminders/test-send");
const { saveRuleAction, sendTestAction, toggleRuleAction } = await import("@/app/app/(protected)/reminders/actions");
const { clearMockOutbox, getMockOutbox, createMockChannel } = await import("@/lib/messaging");
const { renderTemplate, smsSegments, REMINDER_PLACEHOLDERS } = await import("@/lib/messaging/templates");

const garage = testGarage();
const USER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

type Role = "owner" | "manager" | "technician" | "front_desk";

function signIn(role: Role, handler: (query: FakeQuery) => FakeResult | undefined = () => undefined, overrides: Record<string, unknown> = {}) {
  const fake = createFakeSupabase({ from: (query) => handler(query) ?? {} });
  harness.strict = {
    user: { id: USER_ID, email: "dan@hartleyroadmotors.co.uk", phone: "447700900123" },
    garage: { ...garage, ...overrides },
    role,
    client: fake.client,
    mfaState: "verified",
  };
  harness.loose = harness.strict;
  return fake;
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return (error as Error).message.replace(/^REDIRECT:/, "");
  }
  throw new Error("expected a redirect");
}

const writes = (queries: FakeQuery[]) => queries.filter((query) => query.operation !== "select");

beforeEach(() => {
  harness.strict = null;
  harness.loose = null;
  harness.revalidated = [];
  harness.audits = [];
  harness.jobs = [];
  clearMockOutbox();
});

describe("template checks (what the senders accept)", () => {
  it("accepts every default wording", () => {
    for (const kind of RULE_KINDS) expect(checkTemplate(kind, defaultTemplate(kind))).toMatchObject({ ok: true, errors: [] });
  });

  it("refuses placeholders the sender can't fill in, naming the ones it can", () => {
    const check = checkTemplate("mot", "Hi {frist_name}, MOT due {due_date}. {link} {garage}");
    expect(check.ok).toBe(false);
    expect(check.unknown).toEqual(["{frist_name}"]);
    expect(check.errors[0]).toBe("{frist_name} isn't a placeholder this message can fill in. Use {first_name}, {vehicle}, {reg}, {due_date}, {link}, {garage}.");
    // Booking placeholders are known to renderTemplate but reminders never fill them: the sender refuses them.
    expect(checkTemplate("service", "Your {service} is due. {link} {garage}").unknown).toEqual(["{service}"]);
    expect(renderTemplate("Your {service} is due.", {}).missingPlaceholders).toEqual(["service"]);
  });

  it("only offers the missed-call text-back what src/lib/calls/text-back.ts fills in", () => {
    expect(allowedPlaceholders("missed_call")).toEqual(["first_name", "link", "garage"]);
    expect(allowedPlaceholders("review")).toEqual(REMINDER_PLACEHOLDERS);
    expect(checkTemplate("missed_call", "Sorry about your {vehicle}. {link} {garage}").unknown).toEqual(["{vehicle}"]);
    expect(checkTemplate("missed_call", "Hi {first_name}, sorry we missed you. {link} {garage}").warnings[0]).toMatch(/callers we don't know get no text/);
  });

  it("needs the garage's name, warns without a link, and limits the length", () => {
    expect(checkTemplate("mot", "Your MOT is due {link}").errors).toEqual(["Include {garage}: every message must say who it is from."]);
    expect(checkTemplate("mot", "Your MOT is due. {garage}").warnings[0]).toMatch(/no \{link\}/);
    expect(checkTemplate("mot", "   ").errors).toEqual(["Write the message first."]);
    expect(checkTemplate("mot", `${"x".repeat(1000)} {garage}`).errors).toContain("Keep the message under 1000 characters.");
  });
});

describe("the rule in words, timing and sample details", () => {
  it("describes each automation as the list shows it", () => {
    expect(describeRule("mot", [7, 28])).toBe("28 days and 7 days before the MOT runs out");
    expect(describeRule("service", [335])).toBe("11 months after the last service");
    expect(describeRule("review", [1])).toBe("The day after collection, asks for a review");
    expect(describeRule("missed_call", [0])).toBe("Texts a booking link within a minute of an unanswered call");
  });

  it("parses the days field", () => {
    expect(parseOffsets("28, 7")).toEqual({ ok: true, value: [28, 7] });
    expect(parseOffsets("7 28 7")).toEqual({ ok: true, value: [28, 7] });
    expect(parseOffsets("")).toMatchObject({ ok: false });
    expect(parseOffsets("2.5")).toMatchObject({ ok: false });
    expect(parseOffsets("731")).toEqual({ ok: false, error: "Use at most 730 days." });
    expect(parseOffsets("1,2,3,4,5,6,7")).toEqual({ ok: false, error: "Use at most 6 reminders." });
  });

  it("uses sample details as long as the real ones, so the 160-character counter is honest", () => {
    expect(SAMPLE_LINK_TOKEN).toHaveLength(43);
    const values = sampleTemplateValues({ kind: "mot", garageName: "Hartley Road Motors", bookingBaseUrl: "https://hartley-road.autofix.vitalos.co.uk", dueDate: "24 November 2026" });
    expect(values.link).toBe(`https://hartley-road.autofix.vitalos.co.uk/r/${SAMPLE_LINK_TOKEN}`);
    const sms = renderTemplate(defaultTemplate("mot"), values, { channel: "sms" }).text;
    expect(sms.endsWith("Reply STOP to opt out.")).toBe(true);
    // The drafted MOT wording with a real-length link takes two texts (reported in DECISIONS).
    expect(smsSegments(sms)).toMatchObject({ encoding: "GSM-7", segments: 2 });
    expect(sampleTemplateValues({ kind: "missed_call", garageName: "G", bookingBaseUrl: "https://x.example/", dueDate: "" })).toEqual({ first_name: "Priya", link: "https://x.example/", garage: "G" });
  });

  it("states the review-request consent caveat (A54)", () => {
    expect(REVIEW_CONSENT_NOTE).toMatch(/doesn't mention review requests/);
  });
});

describe("due in the next 30 days", () => {
  const base = { send_at: "2026-10-06T09:00:00Z", skip_reason: null, sent_at: null, booking_id: null, customer_id: "c1", vehicle_id: "v1", customers: { name: "Priya Shah" }, vehicles: { registration: "BC23DEF", make: "Toyota", model: "Yaris" } };

  it("shows one row per car and due date: booked, then sent, then the next send", () => {
    const rows = shapeDueSoon({
      sends: [
        { ...base, id: "s1", kind: "mot", due_date: "2026-11-03", offset_days: 28, status: "sent", sent_at: "2026-10-06T09:01:00Z" } as never,
        { ...base, id: "s2", kind: "mot", due_date: "2026-11-03", status: "scheduled", send_at: "2026-10-27T09:00:00Z" } as never,
        { ...base, id: "s3", kind: "service", due_date: "2026-11-12", vehicle_id: "v2", customer_id: "c2", customers: { name: "Amira Hassan" }, vehicles: { registration: "FG16HJK" }, status: "scheduled", send_at: "2026-10-29T09:00:00Z" } as never,
        { ...base, id: "s4", kind: "mot", due_date: "2026-11-07", vehicle_id: "v3", customer_id: "c3", customers: { name: "Tom Reilly" }, vehicles: { registration: "DE45FGH" }, status: "sent", sent_at: "2026-10-10T09:00:00Z", booking_id: "b1", bookings: { created_at: "2026-10-30T12:00:00Z" } } as never,
      ],
      motVehicles: [
        { id: "v1", registration: "BC23DEF", mot_expiry: "2026-11-03", customer_id: "c1", customers: { name: "Priya Shah", reminder_consent: true, opted_out_at: null, anonymised_at: null } },
        { id: "v9", registration: "KL19MNP", mot_expiry: "2026-11-21", customer_id: "c9", customers: { name: "Mark Evans", reminder_consent: false, opted_out_at: null, anonymised_at: null } },
        { id: "v8", registration: "HJ67KLM", mot_expiry: "2026-11-19", customer_id: "c8", customers: { name: "Leon Clarke", reminder_consent: true, opted_out_at: "2026-10-01T00:00:00Z", anonymised_at: null } },
        { id: "v7", registration: "AB12CDE", mot_expiry: "2026-11-20", customer_id: "c7", customers: { name: "Gone", reminder_consent: true, opted_out_at: null, anonymised_at: "2026-10-01T00:00:00Z" } },
      ],
      motRuleOn: true,
      today: "2026-10-27",
      timeZone: "Europe/London",
    });
    expect(rows.map((row) => [row.customerName, row.registration, row.dueDate, row.kind, row.label, row.muted])).toEqual([
      ["Priya Shah", "BC23DEF", "2026-11-03", "mot", "Sent 6 Oct", false],
      ["Tom Reilly", "DE45FGH", "2026-11-07", "mot", "Booked 30 Oct", false],
      ["Amira Hassan", "FG16HJK", "2026-11-12", "service", "Sends 29 Oct", false],
      ["Leon Clarke", "HJ67KLM", "2026-11-19", "mot", "Opted out, won't send", true],
      ["Mark Evans", "KL19MNP", "2026-11-21", "mot", "No consent, won't send", true],
    ]);
  });

  it("says why a reminder won't go", () => {
    const skipped = (reason: string) => sendStatus({ ...base, id: "s", kind: "mot", due_date: "2026-11-03", status: "skipped", skip_reason: reason } as never, "Europe/London", 2026);
    expect(skipped("opted_out")).toMatchObject({ status: "no_consent", label: "Opted out, won't send", muted: true });
    expect(skipped("rule_disabled").label).toBe("Reminders off");
    expect(skipped("already_booked")).toMatchObject({ status: "booked", muted: false });
    expect(sendStatus({ ...base, id: "s", kind: "mot", due_date: "2026-11-03", status: "failed" } as never, "Europe/London", 2026).label).toBe("Didn't send");
    const late = { ...base, id: "s", kind: "mot", due_date: "2026-11-03", status: "scheduled", send_at: "2026-10-25T09:00:00Z" } as never;
    expect(sendStatus(late, "Europe/London", 2026, "2026-10-27").label).toBe("Waiting to send");
    expect(sendStatus(late, "Europe/London", 2026, "2026-10-25").label).toBe("Sends 25 Oct");
    const off = shapeDueSoon({ sends: [], motVehicles: [{ id: "v", registration: "BC23DEF", mot_expiry: "2026-11-03", customer_id: "c", customers: { name: "P", reminder_consent: true, opted_out_at: null, anonymised_at: null } }], motRuleOn: false, today: "2026-10-27", timeZone: "Europe/London" });
    expect(off[0]!.label).toBe("Reminders off");
  });

  it("reads sends and MOT cars through the RLS client, MOTs only when the garage does them", async () => {
    const fake = createFakeSupabase({ from: () => ({ data: [] }) });
    await expect(loadDueSoon(fake.client, garage.id, { today: "2026-10-27", timeZone: "Europe/London", motEnabled: false, motRuleOn: true })).resolves.toEqual([]);
    expect(fake.queries.map((query) => query.table)).toEqual(["reminder_sends"]);
    expect(filterValue(fake.queries[0]!, "eq", "garage_id")).toBe(garage.id);
    expect(filterValue(fake.queries[0]!, "in", "kind")).toEqual(["service"]);
    expect(filterValue(fake.queries[0]!, "lte", "due_date")).toBe("2026-11-26");
    expect(fake.queries[0]!.columns).toContain("bookings!reminder_sends_booking_id_fkey(created_at)");

    const withMot = createFakeSupabase({ from: () => ({ data: [] }) });
    await loadDueSoon(withMot.client, garage.id, { today: "2026-10-27", timeZone: "Europe/London", motEnabled: true, motRuleOn: true });
    expect(withMot.queries.map((query) => query.table)).toEqual(["reminder_sends", "vehicles"]);
    expect(filterValue(withMot.queries[0]!, "in", "kind")).toEqual(["mot", "service"]);
    expect(hasFilter(withMot.queries[1]!, "eq", "garage_id", garage.id)).toBe(true);

    const failing = createFakeSupabase({ from: () => ({ error: { code: "42501" } }) });
    await expect(loadDueSoon(failing.client, garage.id, { today: "2026-10-27", timeZone: "Europe/London", motEnabled: true, motRuleOn: true })).resolves.toBeNull();
  });
});

describe("this month's figures (A53 without the service role)", () => {
  it("counts sent reminders, credited bookings with invoice totals, and opt-outs", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "reminder_sends") return { count: 142 };
        if (query.table === "customers") return { count: 3 };
        if (query.table === "bookings") return { data: [{ id: "b1", price_pence: 5000, status: "confirmed" }, { id: "b2", price_pence: 4500, status: "collected" }, { id: "b3", price_pence: null, status: "requested" }] };
        if (query.table === "invoices") return { data: [{ booking_id: "b2", total_pence: 12000 }, { booking_id: "b2", total_pence: 3000 }] };
        return {};
      },
    });
    await expect(loadReminderMonth(fake.client, garage.id, "2026-10-01", "Europe/London")).resolves.toEqual({ sent: 142, booked: 3, pence: 5000 + 15000, optedOut: 3 });
    const bookings = fake.queries.find((query) => query.table === "bookings")!;
    expect(hasFilter(bookings, "not", "reminder_send_id")).toBe(true);
    expect(filterValue(bookings, "not", "status")).toBe("in");
    expect(filterValue(bookings, "gte", "created_at")).toBe("2026-09-30T23:00:00.000Z");
    expect(filterValue(bookings, "lt", "created_at")).toBe("2026-11-01T00:00:00.000Z");
    const invoices = fake.queries.find((query) => query.table === "invoices")!;
    expect(filterValue(invoices, "in", "status")).toEqual(["issued", "paid"]);
    expect(filterValue(invoices, "in", "booking_id")).toEqual(["b1", "b2", "b3"]);
    for (const query of fake.queries) expect(filterValue(query, "eq", "garage_id")).toBe(garage.id);
    expect(fake.rpcs).toEqual([]);
    expect(nextMonthStart("2026-12-01")).toBe("2027-01-01");
    expect(bookedShare(38, 142)).toBe("27%");
    expect(bookedShare(0, 10)).toBeNull();
  });

  it("returns null rather than zeros when it can't read", async () => {
    const fake = createFakeSupabase({ from: (query) => (query.table === "customers" ? { error: { code: "42501" } } : { data: [], count: 0 }) });
    await expect(loadReminderMonth(fake.client, garage.id, "2026-10-01")).resolves.toBeNull();
  });

  it("loads rules in the page's order, ignoring kinds it doesn't know", async () => {
    const fake = createFakeSupabase({
      from: () => ({
        data: [
          { id: "r2", kind: "review", enabled: false, offset_days: [1], channel: "customer", template: "t", updated_at: null },
          { id: "r1", kind: "mot", enabled: true, offset_days: [28, 7], channel: "sms", template: "t", updated_at: null },
          { id: "r9", kind: "birthday", enabled: true, offset_days: [0], channel: "sms", template: "t", updated_at: null },
        ],
      }),
    });
    const rules = await loadReminderRules(fake.client, garage.id);
    expect(rules?.map((rule) => rule.kind)).toEqual(["mot", "review"]);
    expect(filterValue(fake.queries[0]!, "eq", "garage_id")).toBe(garage.id);
  });
});

describe("rule actions", () => {
  it("lets owners and managers switch an automation, through the RLS client, for the session's garage", async () => {
    const fake = signIn("manager", (query) => (query.operation === "update" ? { data: [{ id: "r1" }] } : undefined));
    const to = await redirectOf(() => toggleRuleAction(form({ kind: "service", enabled: "false", garageId: "99999999-9999-4999-8999-999999999999" })));
    expect(to).toBe("/app/reminders?done=service_off");
    const [update] = writes(fake.queries);
    expect(update).toMatchObject({ table: "reminder_rules", operation: "update", values: { enabled: false } });
    expect(filterValue(update!, "eq", "garage_id")).toBe(garage.id);
    expect(filterValue(update!, "eq", "kind")).toBe("service");
    expect(harness.audits).toEqual([expect.objectContaining({ garageId: garage.id, action: "reminder_rule.disabled", entityId: "service" })]);
    expect(harness.jobs).toEqual([expect.objectContaining({ kind: "reminders.schedule", payload: { garageId: garage.id } })]);
  });

  it.each(["technician", "front_desk"] as const)("keeps %s read only", async (role) => {
    const fake = signIn(role);
    expect(await redirectOf(() => toggleRuleAction(form({ kind: "service", enabled: "true" })))).toBe("/app/reminders?error=not_allowed");
    const state = await saveRuleAction(initialSetupFormState as SetupFormState<never>, form({ kind: "service", template: defaultTemplate("service"), offsets: "335", channel: "sms" }));
    expect(state).toMatchObject({ status: "error", message: "Only the garage's owners and managers can change this." });
    const test = await sendTestAction(initialSetupFormState, form({ kind: "service" }));
    expect(test.status).toBe("error");
    expect(writes(fake.queries)).toEqual([]);
    expect(getMockOutbox()).toEqual([]);
  });

  it("asks for MFA before a change", async () => {
    harness.strict = null;
    harness.loose = { user: { id: USER_ID }, garage, role: "owner", mfaState: "challenge_required" };
    expect(await redirectOf(() => toggleRuleAction(form({ kind: "mot", enabled: "true" })))).toBe("/app/mfa?returnTo=%2Fapp%2Freminders&stepUp=1");
  });

  it("shows the consent note before review requests go on, and only switches them on when confirmed", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: [{ id: "r4" }] } : undefined));
    expect(await redirectOf(() => toggleRuleAction(form({ kind: "review", enabled: "true" })))).toBe("/app/reminders?confirm=review#review-confirm");
    expect(writes(fake.queries)).toEqual([]);
    expect(await redirectOf(() => toggleRuleAction(form({ kind: "review", enabled: "true", confirmed: "yes" })))).toBe("/app/reminders?done=review_on");
    expect(writes(fake.queries)[0]).toMatchObject({ values: { enabled: true } });
    // Switching them off needs no confirmation.
    expect(await redirectOf(() => toggleRuleAction(form({ kind: "review", enabled: "false" })))).toBe("/app/reminders?done=review_off");
  });

  it("won't switch MOT reminders on for a garage that doesn't do MOTs", async () => {
    const fake = signIn("owner", () => undefined, { motEnabled: false });
    expect(await redirectOf(() => toggleRuleAction(form({ kind: "mot", enabled: "true" })))).toBe("/app/reminders?error=mot_off");
    expect(writes(fake.queries)).toEqual([]);
  });

  it("adds the rule with the defaults when the garage has none of that kind yet", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: [] } : undefined));
    await redirectOf(() => toggleRuleAction(form({ kind: "missed_call", enabled: "true" })));
    const [, insert] = writes(fake.queries);
    expect(insert).toMatchObject({ operation: "insert", values: { garage_id: garage.id, kind: "missed_call", enabled: true, offset_days: [0], channel: "customer", template: defaultTemplate("missed_call") } });
    expect(harness.jobs).toEqual([]);
  });

  it("refuses unknown placeholders and bad timing before writing anything", async () => {
    const fake = signIn("owner");
    const state = await saveRuleAction(initialSetupFormState as SetupFormState<never>, form({ kind: "service", template: "Hi {name}, {link} {garage}", offsets: "11 months", channel: "fax" }));
    expect(state.status).toBe("error");
    expect(state.fieldErrors).toEqual({
      template: "{name} isn't a placeholder this message can fill in. Use {first_name}, {vehicle}, {reg}, {due_date}, {link}, {garage}.",
      offsets: "Use whole numbers of days, like 28, 7.",
      channel: "Choose how the message is sent.",
    });
    expect(writes(fake.queries)).toEqual([]);
  });

  it("saves wording, timing and channel", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: [{ id: "r1" }] } : undefined), { motEnabled: true });
    const template = "Hi {first_name}, the MOT on your {reg} is due {due_date}.\r\nBook: {link}\n{garage}";
    const state = await saveRuleAction(initialSetupFormState as SetupFormState<never>, form({ kind: "mot", template, offsets: "7, 28", channel: "whatsapp" }));
    expect(state).toMatchObject({ status: "saved" });
    const [update] = writes(fake.queries);
    expect(update).toMatchObject({ values: { template: template.replace("\r\n", "\n"), offset_days: [28, 7], channel: "whatsapp" } });
    expect(filterValue(update!, "eq", "garage_id")).toBe(garage.id);
    expect(harness.audits[0]).toMatchObject({ action: "reminder_rule.updated", detail: { kind: "mot", channel: "whatsapp", offset_days: [28, 7] } });
    // No wording in the audit log.
    expect(JSON.stringify(harness.audits)).not.toContain("Book:");
  });

  it("keeps the missed-call delay at 0 (the voice webhook sends it)", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: [{ id: "r3" }] } : undefined));
    await saveRuleAction(initialSetupFormState as SetupFormState<never>, form({ kind: "missed_call", template: defaultTemplate("missed_call"), offsets: "30", channel: "sms" }));
    expect(writes(fake.queries)[0]).toMatchObject({ values: { offset_days: [0], channel: "sms" } });
  });
});

describe("send me a test", () => {
  const rule = { kind: "mot" as const, channel: "customer" as const, template: defaultTemplate("mot") };
  const input = (overrides: Partial<Parameters<typeof sendReminderTest>[0]> = {}) => ({
    garage: { id: garage.id, name: garage.name, slug: garage.slug },
    user: { id: USER_ID, email: "dan@hartleyroadmotors.co.uk", phone: "447700900123" },
    rule,
    sampleDueDate: "2026-11-24",
    channelFor: (kind: "sms" | "whatsapp" | "email") => createMockChannel(kind),
    rateLimit: async () => true,
    audit: vi.fn(async () => true),
    env: {},
    ...overrides,
  });

  it("texts the member's own mobile, marked as a test, with the opt-out line, and audits without the address", async () => {
    const audit = vi.fn(async () => true);
    const result = await sendReminderTest(input({ audit }));
    expect(result).toEqual({ ok: true, channel: "sms", to: "07••• •••123", mode: "mock" });
    const [sent] = getMockOutbox();
    expect(sent).toMatchObject({ kind: "sms", to: "+447700900123", garageId: garage.id });
    expect(sent!.body).toMatch(/^Test: Hi Priya, the MOT on your Toyota Yaris \(BC23 DEF\) is due on 24 November 2026\. Book a time: http:\/\/hartley-road\.localhost:3000\/\n/);
    expect(sent!.body.endsWith("Reply STOP to opt out.")).toBe(true);
    expect(audit).toHaveBeenCalledWith(garage.id, expect.objectContaining({ action: "reminder.test_sent", detail: { kind: "mot", outcome: "sent", channel: "sms" } }));
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/7700900123|dan@/);
  });

  it("falls back to the member's own email, and never to anyone else", async () => {
    expect(testRecipient({ id: USER_ID, email: "dan@example.com", phone: null }, rule)).toEqual({ channel: "email", to: "dan@example.com" });
    expect(testRecipient({ id: USER_ID, email: "dan@example.com", phone: "447700900123" }, { kind: "mot", channel: "email" })).toEqual({ channel: "email", to: "dan@example.com" });
    expect(testRecipient({ id: USER_ID, email: "dan@example.com", phone: "447700900123" }, { kind: "mot", channel: "whatsapp" })).toEqual({ channel: "whatsapp", to: "+447700900123" });
    expect(testRecipient({ id: USER_ID, email: "dan@example.com", phone: null }, { kind: "missed_call", channel: "customer" })).toBeNull();
    const result = await sendReminderTest(input({ user: { id: USER_ID, email: null, phone: null } }));
    expect(result).toEqual({ ok: false, code: "no_address" });
    const email = await sendReminderTest(input({ user: { id: USER_ID, email: "dan@example.com", phone: null } }));
    expect(email).toMatchObject({ ok: true, channel: "email", to: "d•••@example.com" });
    expect(getMockOutbox()[0]).toMatchObject({ kind: "email", to: "dan@example.com", subject: "Test: Your MOT is due on 24 November 2026" });
  });

  it("is rate limited per member (5 in 10 minutes) and audits the refusal", async () => {
    const rateLimit = vi.fn(async () => false);
    const audit = vi.fn(async () => true);
    await expect(sendReminderTest(input({ rateLimit, audit }))).resolves.toEqual({ ok: false, code: "rate_limited" });
    expect(rateLimit).toHaveBeenCalledWith(USER_ID, "reminder_test", 5, 600);
    expect(getMockOutbox()).toEqual([]);
    expect(audit).toHaveBeenCalledWith(garage.id, expect.objectContaining({ detail: { kind: "mot", outcome: "rate_limited" } }));
  });

  it("refuses a template the sender would refuse", async () => {
    const result = await sendReminderTest(input({ rule: { ...rule, template: "Hi {nickname} {garage}" } }));
    expect(result).toMatchObject({ ok: false, code: "template" });
    expect(getMockOutbox()).toEqual([]);
  });

  it("reports a live channel without credentials plainly", async () => {
    const result = await sendReminderTest(input({ channelFor: () => ({ kind: "sms", mode: "live", send: async () => ({ ok: false, code: "configuration_required", retryable: false }) }) }));
    expect(result).toEqual({ ok: false, code: "configuration_required" });
  });

  it("composes the missed-call test with the booking page link", () => {
    const composed = composeTest({ garage: { id: garage.id, name: garage.name, slug: garage.slug }, rule: { kind: "missed_call", channel: "sms", template: defaultTemplate("missed_call") }, sampleDueDate: "2026-11-24", env: {} }, "sms");
    expect(composed.body).toBe("Test: Sorry we missed your call. Book online in about a minute: http://hartley-road.localhost:3000/ or we'll call you back soon. Hartley Road Motors\nReply STOP to opt out.");
    expect(composed.unknown).toEqual([]);
  });

  it("the action sends the saved wording of the garage's own rule to the signed-in member", async () => {
    const fake = signIn("owner", (query) => (query.table === "reminder_rules" ? { data: { kind: "service", channel: "customer", template: defaultTemplate("service") } } : undefined));
    const state = await sendTestAction(initialSetupFormState, form({ kind: "service", to: "+447700900999" }));
    expect(state).toMatchObject({ status: "saved" });
    expect(state.message).toMatch(/test outbox/);
    expect(filterValue(fake.queries[0]!, "eq", "garage_id")).toBe(garage.id);
    expect(getMockOutbox().map((entry) => entry.to)).toEqual(["+447700900123"]);
  });
});

describe("page wiring", () => {
  it("never reads the garage from the form or query, uses no service role, and keeps registrations out of links", () => {
    const page = readFileSync("src/app/app/(protected)/reminders/page.tsx", "utf8");
    const actions = readFileSync("src/app/app/(protected)/reminders/actions.ts", "utf8");
    for (const source of [page, actions]) {
      expect(source).not.toContain("createAdminClient(");
      expect(source).not.toMatch(/formData\.get\(["']garage/);
    }
    expect(page).toContain("`/app/customers/${row.customerId}`");
    expect(page).not.toMatch(/href=\{`[^`]*registration/);
    expect(page).toContain("kind !== \"mot\" || motEnabled");
    expect(page).toContain("REVIEW_CONSENT_NOTE");
  });
});
