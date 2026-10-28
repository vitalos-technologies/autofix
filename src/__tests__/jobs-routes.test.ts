import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrainOptions, DrainSummary } from "@/lib/jobs/runner";
import { recordingQueue } from "./support/jobs";

// GET /api/cron/[job] and POST /api/jobs/drain (CRON_SECRET), and
// notifyBooking() queueing notifications.booking (P3.7).

const harness = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  enqueue: vi.fn(),
  drain: vi.fn(),
  send: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => harness.afterTasks.push(task) };
});
vi.mock("@/lib/jobs/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jobs/queue")>();
  return { ...actual, enqueueJob: harness.enqueue };
});
vi.mock("@/lib/jobs/runner", () => ({ drainJobs: harness.drain }));
vi.mock("@/lib/bookings/notifications", () => ({ sendBookingNotifications: harness.send }));

const { handleCronRequest, handleDrainRequest, CRON_DRAIN_BUDGET_MS } = await import("@/lib/jobs/http");
const { bookingNoticeDedupeKey, notifyBooking } = await import("@/lib/booking-engine/notify");

const SECRET = "cron-secret-value-0123456789";
const ENV = { CRON_SECRET: SECRET };
const NOW = new Date("2026-10-27T11:07:00Z");
const db = {} as never;

function summary(overrides: Partial<DrainSummary> = {}): DrainSummary {
  return { ok: true, stoppedBy: "empty", claimed: 3, done: 3, retried: 0, failed: 0, timedOut: 0, byKind: { "reminders.send": { done: 3, retried: 0, failed: 0 } }, elapsedMs: 120, ...overrides };
}

function cron(authorization?: string) {
  return new Request("https://autofix.vitalos.co.uk/api/cron/daily", { headers: authorization ? { authorization } : {} });
}

beforeEach(() => {
  harness.afterTasks.length = 0;
  harness.enqueue.mockReset();
  harness.drain.mockReset();
  harness.send.mockReset();
});

describe("GET /api/cron/[job]", () => {
  it("refuses calls without the exact bearer secret, before touching the queue", async () => {
    const { queue } = recordingQueue();
    const drain = vi.fn();
    for (const authorization of [undefined, "Bearer wrong", `bearer ${SECRET}`, SECRET, `Bearer ${SECRET} `.repeat(2)]) {
      const response = await handleCronRequest(cron(authorization), "daily", { db, queue, drain, env: ENV, now: () => NOW });
      expect(response.status).toBe(401);
    }
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    // No secret configured: nothing is accepted.
    expect((await handleCronRequest(cron("Bearer "), "daily", { db, queue, drain, env: {}, now: () => NOW })).status).toBe(401);
  });

  it("queues every daily kind with a per-period dedupe key, then drains for up to 20 s", async () => {
    const { queue, enqueued } = recordingQueue();
    const drain = vi.fn(async (options: DrainOptions) => summary({ elapsedMs: options.budgetMs > 0 ? 120 : 0 }));
    const response = await handleCronRequest(cron(`Bearer ${SECRET}`), "daily", { db, queue, drain, env: ENV, now: () => NOW });
    expect(response.status).toBe(200);
    expect(enqueued.map((entry) => [entry.kind, entry.payload, entry.options.dedupeKey, entry.options.garageId])).toEqual([
      ["reminders.schedule", {}, "cron:reminders.schedule:2026-10-27", undefined],
      ["reminders.send", {}, "cron:reminders.send:2026-10-27T11:00Z", undefined],
      ["campaigns.send", {}, "cron:campaigns.send:2026-10-27T11:00Z", undefined],
      ["domains.check", {}, "cron:domains.check:2026-10-27T11:05Z", undefined],
      ["retention", {}, "cron:retention:2026-10-27", undefined],
      ["platform.close_impersonations", {}, "cron:platform.close_impersonations:2026-10-27T11:00Z", undefined],
      ["plans.expire_trials", {}, "cron:plans.expire_trials:2026-10-27", undefined],
      ["billing.close_usage", {}, "cron:billing.close_usage:2026-10-27", undefined],
      ["payments.expire_deposits", {}, "cron:payments.expire_deposits:2026-10-27T11:05Z", undefined],
      ["customers.enrich", {}, "cron:customers.enrich:2026-10-27", undefined],
      ["mot.refresh", {}, "cron:mot.refresh:2026-10-27", undefined],
    ]);
    expect(drain).toHaveBeenCalledWith(expect.objectContaining({ db, queue, budgetMs: CRON_DRAIN_BUDGET_MS }));
    expect(CRON_DRAIN_BUDGET_MS).toBe(20_000);
    const body = await response.json();
    expect(body).toEqual({ job: "daily", queued: 11, drain: summary() });
  });

  it("queues just one kind for a per-kind cron, and 404s unknown names", async () => {
    const { queue, enqueued } = recordingQueue();
    const drain = vi.fn(async () => summary());
    await handleCronRequest(cron(`Bearer ${SECRET}`), "reminders.send", { db, queue, drain, env: ENV, now: () => NOW });
    expect(enqueued.map((entry) => entry.kind)).toEqual(["reminders.send"]);
    expect((await handleCronRequest(cron(`Bearer ${SECRET}`), "everything", { db, queue, drain, env: ENV })).status).toBe(404);
    expect((await handleCronRequest(cron(`Bearer ${SECRET}`), "notifications.booking", { db, queue, drain, env: ENV })).status).toBe(404);
  });

  it("answers 503 without a database and 500 when the drain failed", async () => {
    const { queue } = recordingQueue();
    expect((await handleCronRequest(cron(`Bearer ${SECRET}`), "daily", { db: null, queue, env: ENV })).status).toBe(503);
    const failed = await handleCronRequest(cron(`Bearer ${SECRET}`), "daily", { db, queue, drain: vi.fn(async () => summary({ ok: false, stoppedBy: "queue_error" })), env: ENV });
    expect(failed.status).toBe(500);
  });
});

describe("POST /api/jobs/drain", () => {
  function drainRequest(body?: unknown, authorization = `Bearer ${SECRET}`, contentType = "application/json") {
    return new Request("https://autofix.vitalos.co.uk/api/jobs/drain", {
      method: "POST",
      headers: { authorization, "content-type": contentType },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("needs the cron secret", async () => {
    const drain = vi.fn();
    expect((await handleDrainRequest(drainRequest(undefined, "Bearer nope"), { db, drain, env: ENV })).status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
  });

  it("drains every kind for 20 s by default, or the kinds and budget asked for", async () => {
    const drain = vi.fn(async () => summary());
    expect((await handleDrainRequest(drainRequest(), { db, drain, env: ENV })).status).toBe(200);
    expect(drain).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: undefined, budgetMs: 20_000 }));
    await handleDrainRequest(drainRequest({ kinds: ["reminders.send", "messages.reply"], budgetMs: 45_000 }), { db, drain, env: ENV });
    expect(drain).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ["reminders.send", "messages.reply"], budgetMs: 45_000 }));
  });

  it("validates the body strictly", async () => {
    const drain = vi.fn(async () => summary());
    expect((await handleDrainRequest(drainRequest({ kinds: ["rm -rf"] }), { db, drain, env: ENV })).status).toBe(422);
    expect((await handleDrainRequest(drainRequest({ budgetMs: 600_000 }), { db, drain, env: ENV })).status).toBe(422);
    expect((await handleDrainRequest(drainRequest({ garageId: "x" }), { db, drain, env: ENV })).status).toBe(422);
    expect((await handleDrainRequest(drainRequest("{not json"), { db, drain, env: ENV })).status).toBe(400);
    expect((await handleDrainRequest(drainRequest("kinds=retention", `Bearer ${SECRET}`, "application/x-www-form-urlencoded"), { db, drain, env: ENV })).status).toBe(415);
    expect(drain).not.toHaveBeenCalled();
  });
});

describe("notifyBooking", () => {
  const notice = { type: "created" as const, garageId: "a0000000-0000-4000-8000-00000000000a", bookingId: "b0000000-0000-4000-8000-00000000000b" };

  it("queues a notifications.booking job (deduped per booking event) and drains it after the response", async () => {
    harness.enqueue.mockResolvedValue({ id: "job-1" });
    harness.drain.mockResolvedValue(summary());
    await notifyBooking(notice);
    expect(harness.enqueue).toHaveBeenCalledWith("notifications.booking", notice, {
      garageId: notice.garageId,
      dedupeKey: `notifications.booking:${notice.garageId}:${notice.bookingId}:created:once`,
    });
    expect(harness.drain).not.toHaveBeenCalled();
    expect(harness.afterTasks).toHaveLength(1);
    await harness.afterTasks[0]!();
    expect(harness.drain).toHaveBeenCalledWith({ kinds: ["notifications.booking"], budgetMs: 15_000 });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("sends straight after the response when the queue cannot be reached", async () => {
    harness.enqueue.mockRejectedValue(new Error("db down"));
    await notifyBooking(notice);
    await harness.afterTasks[0]!();
    expect(harness.send).toHaveBeenCalledWith(notice);
    expect(harness.drain).not.toHaveBeenCalled();
  });

  it("keys a move by the start it moved from", () => {
    const moved = { ...notice, type: "rescheduled" as const, previousStartsAt: "2026-11-02T10:00:00.000Z" };
    const again = { ...moved, previousStartsAt: "2026-11-03T10:00:00.000Z" };
    expect(bookingNoticeDedupeKey(moved)).toMatch(/:rescheduled:[0-9a-f]{16}$/);
    expect(bookingNoticeDedupeKey(moved)).not.toBe(bookingNoticeDedupeKey(again));
    expect(bookingNoticeDedupeKey({ ...notice, type: "cancelled" })).toBe(`notifications.booking:${notice.garageId}:${notice.bookingId}:cancelled:once`);
  });
});

afterEach(() => vi.unstubAllEnvs());
