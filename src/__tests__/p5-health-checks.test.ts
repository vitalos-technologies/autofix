import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bookingSiteCsp } from "@/lib/booking-page/security-headers";
import {
  approvedTotalPence,
  DEFAULT_CHECKLIST,
  defaultChecklist,
  formatPounds,
  groupBySection,
  mediaObjectPath,
  mediaProblem,
  parsePriceInput,
  penceToInput,
  ratingCounts,
  recommendedItems,
  visibleItems,
  type ChecklistItem,
} from "@/lib/health-checks/checklist";
import { parseDecisions, toDatabaseDecisions, undecidedItems } from "@/lib/health-checks/decisions";
import { parseItemForm, parseNewItemForm, parseSummaryForm } from "@/lib/health-checks/forms";
import { handleHealthCheckLinkRequest } from "@/lib/health-checks/link-route";
import { canSendHealthCheck, composeHealthCheckMessage, sendHealthCheck } from "@/lib/health-checks/send";
import {
  createHealthCheckSession,
  createHealthCheckToken,
  hashHealthCheckToken,
  HEALTH_CHECK_COOKIE,
  healthCheckLinkPath,
  isHealthCheckToken,
  readHealthCheckSession,
  redactHealthCheckLink,
} from "@/lib/health-checks/token";
import { healthCheckStatusLine, mediaByItem, toChecklistItem, toHealthCheckSummary } from "@/lib/health-checks/view";
import { FEATURES, proFeatureForPath } from "@/lib/plans/features";
import type { Garage } from "@/lib/tenancy/garage";

const GARAGE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GARAGE = "22222222-2222-4222-8222-222222222222";
const CHECK_ID = "33333333-3333-4333-8333-333333333333";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function item(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    section: "tyres",
    label: "Front left tyre",
    position: 10,
    motRelated: false,
    rating: "not_checked",
    note: null,
    recommendedWork: null,
    pricePence: null,
    decision: null,
    ...overrides,
  };
}

describe("health check checklist (P5.3)", () => {
  it("is the same default checklist as the migration, in the same order", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261029000300_health_checks.sql"), "utf8");
    const rows = [...sql.matchAll(/^\s+\('(\w+)', '([^']+)', (\d+)\),?$/gm)].map((match) => ({ section: match[1], label: match[2], ord: Number(match[3]) }));
    expect(rows.map(({ section, label }) => ({ section, label }))).toEqual(DEFAULT_CHECKLIST);
    expect(rows.map((row) => row.ord)).toEqual(DEFAULT_CHECKLIST.map((_, index) => index + 1));
  });

  it("leaves the MOT lines out for garages without MOT (rule 6)", () => {
    expect(defaultChecklist(true)).toHaveLength(25);
    expect(defaultChecklist(false)).toHaveLength(20);
    expect(defaultChecklist(false).some((line) => line.section === "mot")).toBe(false);
  });

  it("hides untouched MOT lines once a garage turns MOT off, but keeps rated ones", () => {
    const lines = [item({ id: "a", motRelated: true }), item({ id: "b", motRelated: true, rating: "red" }), item({ id: "c" })];
    expect(visibleItems(lines, false).map((line) => line.id)).toEqual(["b", "c"]);
    expect(visibleItems(lines, true)).toHaveLength(3);
  });

  it("groups by section in checklist order and counts ratings", () => {
    const lines = [item({ id: "b", section: "brakes", position: 60, rating: "amber" }), item({ id: "a", position: 10, rating: "red" }), item({ id: "c", position: 20, rating: "green" })];
    expect(groupBySection(lines).map((group) => [group.section, group.items.map((line) => line.id)])).toEqual([
      ["tyres", ["a", "c"]],
      ["brakes", ["b"]],
    ]);
    expect(ratingCounts(lines)).toEqual({ red: 1, amber: 1, green: 1, not_checked: 0 });
  });

  it("formats and parses prices in pence", () => {
    expect(formatPounds(16000)).toBe("£160.00");
    expect(formatPounds(123456)).toBe("£1,234.56");
    expect(parsePriceInput("£89.5")).toBe(8950);
    expect(parsePriceInput("1,200")).toBe(120000);
    expect(parsePriceInput("12.345")).toBeNull();
    expect(parsePriceInput("100001")).toBeNull();
    expect(penceToInput(8950)).toBe("89.50");
    expect(penceToInput(null)).toBe("");
  });

  it("totals approved work from stored decisions or the customer's choices", () => {
    const lines = [
      item({ id: "a", recommendedWork: "Tyres", pricePence: 16000, decision: "approved" }),
      item({ id: "b", recommendedWork: "Pads", pricePence: 8950, decision: "declined" }),
      item({ id: "c" }),
    ];
    expect(recommendedItems(lines).map((line) => line.id)).toEqual(["a", "b"]);
    expect(approvedTotalPence(lines)).toBe(16000);
    expect(approvedTotalPence(lines, { a: "approved", b: "approved" })).toBe(24950);
    expect(approvedTotalPence(lines, {})).toBe(0);
    expect(undecidedItems(lines, { a: "approved" }).map((line) => line.id)).toEqual(["b"]);
  });

  it("limits media to photos and MP4/MOV videos of a sensible size, in the garage's folder", () => {
    expect(mediaProblem({ type: "image/jpeg", size: 2_000_000 })).toBeNull();
    expect(mediaProblem({ type: "video/quicktime", size: 40 * 1024 * 1024 })).toBeNull();
    expect(mediaProblem({ type: "image/jpeg", size: 11 * 1024 * 1024 })).toBe("size");
    expect(mediaProblem({ type: "video/mp4", size: 51 * 1024 * 1024 })).toBe("size");
    expect(mediaProblem({ type: "image/gif", size: 10 })).toBe("type");
    expect(mediaProblem({ type: "image/png", size: 0 })).toBe("empty");
    expect(mediaObjectPath(GARAGE_ID, CHECK_ID, "55555555-5555-4555-8555-555555555555", "video/quicktime")).toBe(
      `${GARAGE_ID}/health-checks/${CHECK_ID}/55555555-5555-4555-8555-555555555555.mov`,
    );
  });

  it("is a Pro feature at /app/health-checks", () => {
    expect(FEATURES.health_checks.plan).toBe("pro");
    expect(proFeatureForPath("/app/health-checks/abc")).toBe("health_checks");
  });
});

describe("health check forms", () => {
  it("needs both recommended work and its price, or neither", () => {
    expect(parseItemForm(form({ rating: "red", note: " Worn ", work: "Two tyres", price: "160" }))).toEqual({
      ok: true,
      value: { rating: "red", note: "Worn", recommended_work: "Two tyres", price_pence: 16000 },
    });
    expect(parseItemForm(form({ rating: "green", note: "", work: "", price: "" }))).toEqual({
      ok: true,
      value: { rating: "green", note: null, recommended_work: null, price_pence: null },
    });
    const noPrice = parseItemForm(form({ rating: "amber", work: "Pads", price: "" }));
    expect(noPrice.ok ? null : noPrice.fieldErrors.price).toMatch(/price/);
    const noWork = parseItemForm(form({ rating: "amber", work: "", price: "20" }));
    expect(noWork.ok ? null : noWork.fieldErrors.work).toBeTruthy();
    const badRating = parseItemForm(form({ rating: "purple" }));
    expect(badRating.ok ? null : badRating.fieldErrors.rating).toBeTruthy();
  });

  it("parses new lines and the summary", () => {
    expect(parseNewItemForm(form({ section: "other", label: "Rear wiper arm" }))).toEqual({ ok: true, value: { section: "other", label: "Rear wiper arm" } });
    expect(parseNewItemForm(form({ section: "roof", label: "" })).ok).toBe(false);
    expect(parseSummaryForm(form({ summary: "All good", mileage: "42,180" }))).toEqual({ ok: true, value: { summary: "All good", mileage: 42180 } });
    expect(parseSummaryForm(form({ summary: "", mileage: "lots" })).ok).toBe(false);
  });
});

describe("customer decisions", () => {
  const a = "66666666-6666-4666-8666-666666666666";
  const b = "77777777-7777-4777-8777-777777777777";

  it("accepts one approve/decline per line with the price the customer saw", () => {
    const parsed = parseDecisions(JSON.stringify([{ itemId: a, decision: "approved", pricePence: 16000 }, { itemId: b, decision: "declined", pricePence: 8950 }]));
    expect(parsed).toHaveLength(2);
    expect(toDatabaseDecisions(parsed!)).toEqual([
      { item_id: a, decision: "approved", price_pence: 16000 },
      { item_id: b, decision: "declined", price_pence: 8950 },
    ]);
  });

  it("refuses duplicates, unknown decisions and junk", () => {
    expect(parseDecisions(JSON.stringify([{ itemId: a, decision: "approved", pricePence: 1 }, { itemId: a, decision: "declined", pricePence: 1 }]))).toBeNull();
    expect(parseDecisions(JSON.stringify([{ itemId: a, decision: "maybe", pricePence: 1 }]))).toBeNull();
    expect(parseDecisions("{")).toBeNull();
    expect(parseDecisions(null)).toBeNull();
    expect(parseDecisions("[]")).toEqual([]);
  });
});

describe("health check links and sessions", () => {
  it("makes 22-character tokens and stores only their SHA-256", () => {
    const token = createHealthCheckToken(new Date("2026-10-28T09:00:00Z"));
    expect(isHealthCheckToken(token.token)).toBe(true);
    expect(token.hash).toBe(hashHealthCheckToken(token.token));
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.expiresAt.toISOString()).toBe("2026-11-11T09:00:00.000Z");
    expect(isHealthCheckToken("short")).toBe(false);
  });

  it("never stores the token in the message body", () => {
    const token = createHealthCheckToken();
    const body = `Garage: your car's health check is ready: https://book.example${healthCheckLinkPath(token.token)}`;
    const stored = redactHealthCheckLink(body, token.token);
    expect(stored).not.toContain(token.token);
    expect(stored).toContain("/hc/…");
  });

  it("opens the session only on its garage, unchanged and before it expires", () => {
    const now = Date.parse("2026-10-28T09:00:00Z");
    const value = createHealthCheckSession(GARAGE_ID, CHECK_ID, now);
    expect(readHealthCheckSession(value, GARAGE_ID, now)).toEqual({ checkId: CHECK_ID });
    expect(readHealthCheckSession(value, OTHER_GARAGE, now)).toBeNull();
    expect(readHealthCheckSession(value, GARAGE_ID, now + 61 * 60 * 1000)).toBeNull();
    const [encoded, signature] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ g: GARAGE_ID, c: OTHER_GARAGE, e: Math.floor(now / 1000) + 600 })).toString("base64url");
    expect(readHealthCheckSession(`${forged}.${signature}`, GARAGE_ID, now)).toBeNull();
    expect(readHealthCheckSession(`${encoded}.x${signature}`, GARAGE_ID, now)).toBeNull();
  });

  const garage = { id: GARAGE_ID } as Garage;
  const request = () => new Request("http://hartley-road.localhost:3000/hc/token", { headers: { "x-forwarded-for": "203.0.113.9" } });

  it("swaps a good token for the httpOnly session and a clean /health-check", async () => {
    const token = createHealthCheckToken();
    const openLink = vi.fn(async () => ({ status: "ok" as const, check_id: CHECK_ID }));
    const response = await handleHealthCheckLinkRequest(request(), { garageId: GARAGE_ID, token: token.token }, { hostGarage: async () => garage, openLink, rateLimit: async () => true });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/health-check");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(openLink).toHaveBeenCalledWith(GARAGE_ID, token.hash);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${HEALTH_CHECK_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/health-check/);
    expect(cookie).not.toContain(token.token);
  });

  it("sends bad, expired and rate-limited links to an explanation, and other hosts to a 404", async () => {
    const deps = { hostGarage: async () => garage, rateLimit: async () => true };
    const bad = await handleHealthCheckLinkRequest(request(), { garageId: GARAGE_ID, token: "not-a-token" }, deps);
    expect(bad.headers.get("location")).toBe("/health-check?link=invalid");
    const expired = await handleHealthCheckLinkRequest(request(), { garageId: GARAGE_ID, token: createHealthCheckToken().token }, { ...deps, openLink: async () => ({ status: "expired" as const }) });
    expect(expired.headers.get("location")).toBe("/health-check?link=expired");
    const limited = await handleHealthCheckLinkRequest(request(), { garageId: GARAGE_ID, token: createHealthCheckToken().token }, { ...deps, rateLimit: async () => false });
    expect(limited.headers.get("location")).toBe("/health-check?link=limited");
    const elsewhere = await handleHealthCheckLinkRequest(request(), { garageId: OTHER_GARAGE, token: createHealthCheckToken().token }, deps);
    expect(elsewhere.status).toBe(404);
  });
});

describe("sending a health check", () => {
  it("words the message per channel, with the opt-out line on texts only", () => {
    const sms = composeHealthCheckMessage({ garageName: "Hartley Road Motors", link: "https://book.example/hc/abc", hasRecommendedWork: true, channel: "sms" });
    expect(sms.body).toContain("approve any extra work: https://book.example/hc/abc");
    expect(sms.body).toMatch(/STOP/);
    const email = composeHealthCheckMessage({ garageName: "Hartley Road Motors", link: "https://book.example/hc/abc", hasRecommendedWork: false, channel: "email" });
    expect(email.body).not.toMatch(/STOP/);
    expect(email.subject).toBe("Your car's health check from Hartley Road Motors");
  });

  it("only owners, managers and front desk send", () => {
    expect(canSendHealthCheck("owner")).toBe(true);
    expect(canSendHealthCheck("front_desk")).toBe(true);
    expect(canSendHealthCheck("technician")).toBe(false);
  });

  function fakeDb(claim: unknown) {
    const rpc = vi.fn(async () => ({ data: claim, error: null }));
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    const chain = (result: unknown) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) builder[method] = () => builder;
      builder.maybeSingle = async () => result;
      return builder;
    };
    const from = vi.fn((table: string) => {
      if (table === "health_checks") return chain({ data: { id: CHECK_ID, booking_id: "88888888-8888-4888-8888-888888888888", bookings: { customers: { channel: "sms" } } }, error: null });
      if (table === "messages") return { update: (value: unknown) => { updates.push(value); return { eq: () => ({ eq: async () => ({ error: null }) }) }; } };
      return { insert: async (value: unknown) => { inserts.push(value); return { error: null }; } };
    });
    return { db: { rpc, from } as never, rpc, updates, inserts };
  }

  it("claims first, sends the real link and records the result without the token", async () => {
    const fake = fakeDb({ status: "claimed", message_id: "99999999-9999-4999-8999-999999999999", channel: "sms", to: "+447700900123" });
    const sent: Array<{ body: string; idempotencyKey: string }> = [];
    const channel = { kind: "sms" as const, mode: "mock" as const, send: vi.fn(async (message: { body: string; idempotencyKey: string }) => { sent.push(message); return { ok: true as const, providerMessageId: "SM1", status: "sent" as const }; }) };
    const result = await sendHealthCheck({
      garage: { id: GARAGE_ID, name: "Hartley Road Motors", slug: "hartley-road" },
      member: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      checkId: CHECK_ID,
      hasRecommendedWork: true,
      db: fake.db,
      channelFor: () => channel as never,
      rateLimit: async () => true,
    });
    expect(result).toEqual({ ok: true, messageId: "99999999-9999-4999-8999-999999999999", channel: "sms", mode: "mock" });
    const args = (fake.rpc.mock.calls[0] as unknown as [string, Record<string, string>])[1];
    expect(args.p_body).toContain("/hc/…");
    const link = sent[0]!.body.match(/\/hc\/([A-Za-z0-9_-]{22})/);
    expect(link).not.toBeNull();
    expect(args.p_token_hash).toBe(hashHealthCheckToken(link![1]!));
    expect(args.p_body).not.toContain(link![1]!);
    expect(sent[0]!.idempotencyKey).toBe("health_check:99999999-9999-4999-8999-999999999999");
    expect(fake.updates).toEqual([{ status: "sent", provider_msg_id: "SM1" }]);
    expect(fake.inserts).toEqual([expect.objectContaining({ type: "notification_sent", data: { kind: "sms", status: "sent", source: "health_check" } })]);
  });

  it("sends nothing when the claim is skipped (opted out, no plan, ...)", async () => {
    const fake = fakeDb({ status: "skipped", reason: "opted_out" });
    const channel = { kind: "sms" as const, mode: "mock" as const, send: vi.fn() };
    const result = await sendHealthCheck({
      garage: { id: GARAGE_ID, name: "Hartley Road Motors", slug: "hartley-road" },
      member: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      checkId: CHECK_ID,
      hasRecommendedWork: false,
      db: fake.db,
      channelFor: () => channel as never,
      rateLimit: async () => true,
    });
    expect(result).toEqual({ ok: false, code: "opted_out" });
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe("health check views", () => {
  it("maps rows and says where a check stands", () => {
    const summary = toHealthCheckSummary({
      id: CHECK_ID,
      booking_id: "b",
      status: "responded",
      summary: null,
      mileage: 42000,
      sent_at: "2026-10-28T09:00:00Z",
      sent_count: 1,
      sent_channel: "sms",
      first_viewed_at: "2026-10-28T09:05:00Z",
      responded_at: "2026-10-28T09:10:00Z",
      approved_total_pence: "16000",
      invoice_id: null,
      invoiced_at: null,
      token_expires_at: null,
      created_at: "2026-10-28T08:00:00Z",
      updated_at: "2026-10-28T09:10:00Z",
      bookings: [{ reference: "HRM-1001", starts_at: "2026-10-28T08:00:00Z", status: "in_progress", customers: { name: "Holly", channel: "sms", opted_out_at: null }, vehicles: { registration: "AB12CDE", make: "Ford", model: "Fiesta" }, services: { name: "Service" } }],
    });
    expect(summary.approvedTotalPence).toBe(16000);
    expect(summary.vehicleName).toBe("Ford Fiesta");
    expect(healthCheckStatusLine(summary, formatPounds)).toBe("Customer approved £160.00");
    expect(healthCheckStatusLine({ status: "sent", approvedTotalPence: 0, firstViewedAt: null }, formatPounds)).toBe("Sent, not opened yet");
    const line = toChecklistItem({ id: "x", section: "nonsense", label: "L", position: 1, mot_related: false, rating: "red", note: null, recommended_work: "W", price_pence: "100", decision: "approved" });
    expect(line).toMatchObject({ section: "other", pricePence: 100, decision: "approved" });
    const grouped = mediaByItem([
      { id: "1", itemId: null, kind: "image", contentType: "image/jpeg", sizeBytes: 1, objectPath: "p", url: null },
      { id: "2", itemId: "x", kind: "video", contentType: "video/mp4", sizeBytes: 1, objectPath: "q", url: null },
    ]);
    expect([...grouped.keys()]).toEqual(["check", "x"]);
  });

  it("lets the booking page play videos from signed storage URLs", () => {
    expect(bookingSiteCsp({})).toContain("media-src 'self' blob: https:");
  });
});
