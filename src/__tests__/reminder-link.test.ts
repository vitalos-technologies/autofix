import { describe, expect, it, vi } from "vitest";
import { BOOKING_STATE_COOKIE, openBookingSession } from "@/lib/booking-engine/state";
import { createReminderLinkToken, hashReminderLinkToken, isReminderLinkToken, REMINDER_LINK_TTL_MS } from "@/lib/reminders/link-token";
import { reminderLinkProblem } from "@/lib/reminders/link-problems";
import { handleReminderLinkRequest } from "@/lib/reminders/link-route";
import { openReminderLink, reminderService, type LinkedReminder, type LinkService, type ReminderLinkRepo } from "@/lib/reminders/open-link";
import { getRequest } from "./support/booking-routes";
import { testGarage } from "./support/garage";

// /r/{token} (P3.9): token hashing, the prefilled draft (car, service,
// reminderSendId; MOT facts only with MOT on), and the route: a 303 to /time
// that carries the sealed draft, never the token or the registration.

const NOW = new Date("2026-10-27T11:00:00Z");
const garage = testGarage({ motEnabled: true });
const SEND = "00000000-0000-4000-8000-000000000501";

const services: LinkService[] = [
  { id: "s-diag", name: "Diagnostics", isMot: false, locationMode: "both", sort: 2 },
  { id: "s-interim", name: "Interim service", isMot: false, locationMode: "workshop", sort: 4 },
  { id: "s-full", name: "Full service", isMot: false, locationMode: "workshop", sort: 3 },
  { id: "s-mot", name: "MOT", isMot: true, locationMode: "workshop", sort: 1 },
];

function linked(overrides: Partial<LinkedReminder> = {}): LinkedReminder {
  return {
    id: SEND,
    kind: "mot",
    status: "sent",
    linkExpiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    openedAt: null,
    vehicle: { registration: "AB12CDE", make: "Ford", model: "Focus", motExpiry: "2026-11-10" },
    ...overrides,
  };
}

function fakeRepo(found: LinkedReminder | null, list: LinkService[] = services) {
  const repo: ReminderLinkRepo & { opened: Array<{ garageId: string; id: string; at: Date }>; lookups: string[] } = {
    opened: [],
    lookups: [],
    async findByTokenHash(garageId, hash) {
      repo.lookups.push(`${garageId}:${hash}`);
      return garageId === garage.id ? found : null;
    },
    async markOpened(garageId, id, at) {
      repo.opened.push({ garageId, id, at });
    },
    async listOnlineServices() {
      return list;
    },
  };
  return repo;
}

describe("reminder link tokens", () => {
  it("are 16 random bytes in base64url (22 characters), stored as SHA-256 hex, valid for 30 days", () => {
    const first = createReminderLinkToken(NOW);
    const second = createReminderLinkToken(NOW);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(16);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(hashReminderLinkToken(first.token));
    expect(first.expiresAt).toEqual(new Date(NOW.getTime() + REMINDER_LINK_TTL_MS));
    expect(second.token).not.toBe(first.token);
    expect(isReminderLinkToken(first.token)).toBe(true);
    expect(isReminderLinkToken(`${first.token}=`)).toBe(false);
    expect(isReminderLinkToken("AB12CDE")).toBe(false);
  });

  it("still accepts the 43-character tokens sent before A185, and nothing in between", () => {
    const old = "7KQ2hT9mWc4pXv8RbN3sLq6dZf1JyG5aEu0kVo2MiCr";
    expect(old).toHaveLength(43);
    expect(isReminderLinkToken(old)).toBe(true);
    expect(hashReminderLinkToken(old)).toMatch(/^[0-9a-f]{64}$/);
    for (const length of [21, 23, 32, 42, 44]) expect(isReminderLinkToken("A".repeat(length))).toBe(false);
    expect(isReminderLinkToken(`${"A".repeat(21)}=`)).toBe(false);
    expect(isReminderLinkToken(`${"A".repeat(21)}/`)).toBe(false);
  });

  it("maps link problems for the /r page, defaulting to invalid", () => {
    expect(reminderLinkProblem("expired")).toBe("expired");
    expect(reminderLinkProblem(["limited", "x"])).toBe("limited");
    expect(reminderLinkProblem("<script>")).toBe("invalid");
    expect(reminderLinkProblem(undefined)).toBe("invalid");
  });
});

describe("reminderService", () => {
  it("picks the MOT for an MOT reminder only while MOT is on", () => {
    expect(reminderService("mot", services, true)?.id).toBe("s-mot");
    expect(reminderService("mot", services, false)).toBeNull();
  });

  it("picks the full service for a service reminder, else the first service-like one", () => {
    expect(reminderService("service", services, true)?.id).toBe("s-full");
    expect(reminderService("service", services.filter((service) => service.id !== "s-full"), true)?.id).toBe("s-interim");
    expect(reminderService("service", [services[0]!], true)).toBeNull();
    expect(reminderService("review", services, true)).toBeNull();
  });
});

describe("openReminderLink", () => {
  const { token } = createReminderLinkToken(NOW);

  it("prefills the car, the MOT service and the reminder, records the first open and goes to /time", async () => {
    const repo = fakeRepo(linked());
    const opened = await openReminderLink({ garage, token, repo, now: NOW });
    expect(repo.lookups).toEqual([`${garage.id}:${hashReminderLinkToken(token)}`]);
    expect(opened).toEqual({
      ok: true,
      next: "/time",
      draft: {
        v: 1,
        garageId: garage.id,
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        vehicle: { registration: "AB12CDE", make: "Ford", model: "Focus", motExpiry: "2026-11-10" },
        serviceId: "s-mot",
        locationMode: "workshop",
        reminderSendId: SEND,
      },
    });
    expect(repo.opened).toEqual([{ garageId: garage.id, id: SEND, at: NOW }]);
  });

  it("opens a link sent before A185 with a 43-character token", async () => {
    const old = "7KQ2hT9mWc4pXv8RbN3sLq6dZf1JyG5aEu0kVo2MiCr";
    const repo = fakeRepo(linked());
    expect(await openReminderLink({ garage, token: old, repo, now: NOW })).toMatchObject({ ok: true, next: "/time", draft: { reminderSendId: SEND } });
    expect(repo.lookups).toEqual([`${garage.id}:${hashReminderLinkToken(old)}`]);
  });

  it("leaves MOT facts and services out while the garage has MOT off", async () => {
    const opened = await openReminderLink({ garage: { ...garage, motEnabled: false }, token, repo: fakeRepo(linked()), now: NOW });
    expect(opened).toMatchObject({ ok: true, next: "/service" });
    if (!opened.ok) throw new Error("expected a draft");
    expect(opened.draft.vehicle).toEqual({ registration: "AB12CDE", make: "Ford", model: "Focus" });
    expect(opened.draft.serviceId).toBeUndefined();
  });

  it("does not record a second open", async () => {
    const repo = fakeRepo(linked({ openedAt: "2026-10-20T10:00:00Z" }));
    await openReminderLink({ garage, token, repo, now: NOW });
    expect(repo.opened).toEqual([]);
  });

  it("sends service reminders to the full service, and mobile-only services to the service step", async () => {
    const service = await openReminderLink({ garage, token, repo: fakeRepo(linked({ kind: "service" })), now: NOW });
    expect(service).toMatchObject({ ok: true, next: "/time", draft: { serviceId: "s-full", locationMode: "workshop" } });
    const mobile = await openReminderLink({ garage, token, repo: fakeRepo(linked({ kind: "service" }), [{ id: "s-van", name: "Full service", isMot: false, locationMode: "mobile", sort: 1 }]), now: NOW });
    expect(mobile).toMatchObject({ ok: true, next: "/service", draft: { serviceId: "s-van" } });
    if (mobile.ok) expect(mobile.draft.locationMode).toBeUndefined();
    const review = await openReminderLink({ garage, token, repo: fakeRepo(linked({ kind: "review" })), now: NOW });
    expect(review).toMatchObject({ ok: true, next: "/service", draft: { reminderSendId: SEND } });
  });

  it("opens nothing for an expired, unsent, unknown, malformed or other garage's link", async () => {
    expect(await openReminderLink({ garage, token, repo: fakeRepo(linked({ linkExpiresAt: NOW.toISOString() })), now: NOW })).toEqual({ ok: false, problem: "expired" });
    expect(await openReminderLink({ garage, token, repo: fakeRepo(linked({ status: "skipped" })), now: NOW })).toEqual({ ok: false, problem: "invalid" });
    expect(await openReminderLink({ garage, token, repo: fakeRepo(null), now: NOW })).toEqual({ ok: false, problem: "invalid" });
    const repo = fakeRepo(linked());
    expect(await openReminderLink({ garage, token: "not-a-token", repo, now: NOW })).toEqual({ ok: false, problem: "invalid" });
    expect(repo.lookups).toEqual([]);
    expect(await openReminderLink({ garage: { ...garage, id: "22222222-2222-4222-8222-222222222222" }, token, repo, now: NOW })).toEqual({ ok: false, problem: "invalid" });
  });
});

describe("GET /r/[token]", () => {
  const { token } = createReminderLinkToken(NOW);

  function deps(found: LinkedReminder | null, overrides: Record<string, unknown> = {}) {
    return { hostGarage: async () => garage, repo: () => fakeRepo(found), rateLimit: vi.fn(async () => true), now: () => NOW, ...overrides };
  }

  it("answers 303 to /time with the sealed draft, keeping the token and registration out of the URL", async () => {
    const response = await handleReminderLinkRequest(getRequest(`/r/${token}`), { garageId: garage.id, token }, deps(linked()));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/time");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${BOOKING_STATE_COOKIE}=`));
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).not.toContain("AB12CDE");
    expect(cookie).not.toContain(token);
    const sealed = decodeURIComponent(/af_booking=([^;]+)/.exec(cookie)?.[1] ?? "");
    const session = openBookingSession(garage.id, sealed);
    expect(session.draft).toMatchObject({ reminderSendId: SEND, serviceId: "s-mot", vehicle: { registration: "AB12CDE" } });
  });

  it("sends problems to /r?link=… and never sets a draft", async () => {
    const expired = await handleReminderLinkRequest(getRequest(`/r/${token}`), { garageId: garage.id, token }, deps(linked({ linkExpiresAt: "2026-10-01T00:00:00Z" })));
    expect(expired.headers.get("location")).toBe("/r?link=expired");
    expect(expired.headers.get("set-cookie")).toBeNull();
    const unknown = await handleReminderLinkRequest(getRequest(`/r/${token}`), { garageId: garage.id, token }, deps(null));
    expect(unknown.headers.get("location")).toBe("/r?link=invalid");
    const limited = await handleReminderLinkRequest(getRequest(`/r/${token}`), { garageId: garage.id, token }, deps(linked(), { rateLimit: vi.fn(async () => false) }));
    expect(limited.headers.get("location")).toBe("/r?link=limited");
    const broken = await handleReminderLinkRequest(getRequest(`/r/${token}`), { garageId: garage.id, token }, deps(linked(), {
      repo: () => ({ ...fakeRepo(linked()), findByTokenHash: async () => { throw new Error("db down"); } }),
    }));
    expect(broken.headers.get("location")).toBe("/r?link=unavailable");
  });

  it("is a 404 when the route's garage is not the host's garage", async () => {
    const response = await handleReminderLinkRequest(getRequest(`/r/${token}`), { garageId: "22222222-2222-4222-8222-222222222222", token }, deps(linked()));
    expect(response.status).toBe(404);
  });

  it("rate-limits per garage and IP", async () => {
    const rateLimit = vi.fn(async () => true);
    await handleReminderLinkRequest(getRequest(`/r/${token}`, { ip: "203.0.113.9" }), { garageId: garage.id, token }, deps(linked(), { rateLimit }));
    expect(rateLimit).toHaveBeenCalledWith(`${garage.id}:203.0.113.9`, "reminder_link", 30, 600);
  });
});
