import { describe, expect, it, vi } from "vitest";
import { createJobLogger } from "@/lib/jobs/log";
import { drainJobs } from "@/lib/jobs/runner";
import { permanentJobError, retryableJobError, type JobDefinition, type JobKind, type JobQueue, type JobRow } from "@/lib/jobs/types";
import { cronDedupeKey, isCronAuthorized } from "@/lib/jobs/cron";
import { localDate, utcSlot } from "@/lib/jobs/periods";

// drainJobs(): kinds in registry order, one claim at a time, finish/fail with
// retry or not, per-attempt timeouts, the overall budget, and logs that carry
// ids and counts only.

const GARAGE = "a0000000-0000-4000-8000-000000000001";

function job(kind: JobKind, id: string, payload: Record<string, unknown> = {}, garageId: string | null = null): JobRow {
  return { id, kind, garage_id: garageId, payload, dedupe_key: null, run_at: new Date().toISOString(), status: "running", attempts: 1, max_attempts: 5 };
}

function fakeQueue(rows: JobRow[]) {
  const pending = [...rows];
  const calls = { claims: [] as string[], finished: [] as string[], failed: [] as Array<{ id: string; error: string; retry: boolean }> };
  const queue: JobQueue = {
    enqueue: vi.fn(async (kind, payload) => job(kind, `new-${pending.length}`, payload)),
    claim: vi.fn(async (kind) => {
      calls.claims.push(kind);
      const index = pending.findIndex((row) => row.kind === kind);
      return index < 0 ? [] : pending.splice(index, 1);
    }),
    finish: vi.fn(async (id) => {
      calls.finished.push(id);
      return true;
    }),
    fail: vi.fn(async (id, error, retry) => {
      calls.failed.push({ id, error, retry });
      return retry ? "queued" : "failed";
    }),
  };
  return { queue, calls };
}

function definition(kind: JobKind, handler: JobDefinition["handler"], timeoutMs = 5_000): JobDefinition {
  return { kind, handler, timeoutMs };
}

function capture() {
  const lines: string[] = [];
  return { lines, log: createJobLogger({}, (_level, line) => lines.push(line)) };
}

const db = {} as never;

describe("drainJobs", () => {
  it("runs each kind in order until its queue is empty, then the next kind", async () => {
    const { queue, calls } = fakeQueue([job("retention", "r1"), job("reminders.schedule", "s1"), job("reminders.schedule", "s2")]);
    const seen: string[] = [];
    const handler: JobDefinition["handler"] = async (_payload, context) => {
      seen.push(context.job.id);
      return { outcome: "ok" };
    };
    const { log } = capture();
    const summary = await drainJobs({
      db,
      queue,
      log,
      budgetMs: 10_000,
      definitions: [definition("reminders.schedule", handler), definition("retention", handler)],
    });
    expect(seen).toEqual(["s1", "s2", "r1"]);
    expect(calls.claims).toEqual(["reminders.schedule", "reminders.schedule", "reminders.schedule", "retention", "retention"]);
    expect(calls.finished).toEqual(["s1", "s2", "r1"]);
    expect(summary).toMatchObject({ ok: true, stoppedBy: "empty", claimed: 3, done: 3, retried: 0, failed: 0 });
    expect(summary.byKind).toEqual({ "reminders.schedule": { done: 2, retried: 0, failed: 0 }, retention: { done: 1, retried: 0, failed: 0 } });
  });

  it("only drains the kinds asked for", async () => {
    const { queue, calls } = fakeQueue([job("retention", "r1"), job("reminders.send", "s1")]);
    const { log } = capture();
    await drainJobs({
      db,
      queue,
      log,
      budgetMs: 10_000,
      kinds: ["reminders.send"],
      definitions: [definition("reminders.send", async () => undefined), definition("retention", async () => undefined)],
    });
    expect(calls.claims).toEqual(["reminders.send", "reminders.send"]);
    expect(calls.finished).toEqual(["s1"]);
  });

  it("retries unknown and retryable errors, and fails permanent ones for good", async () => {
    const { queue, calls } = fakeQueue([job("retention", "a"), job("retention", "b"), job("retention", "c")]);
    const errors = [new Error("boom +447700900123"), retryableJobError("SEND_RETRY", "rate_limited:20429"), permanentJobError("INVALID_PAYLOAD")];
    const { log, lines } = capture();
    const summary = await drainJobs({
      db,
      queue,
      log,
      budgetMs: 10_000,
      definitions: [definition("retention", async () => {
        throw errors.shift();
      })],
    });
    expect(calls.failed).toEqual([
      { id: "a", error: "Error", retry: true },
      { id: "b", error: "SEND_RETRY: rate_limited:20429", retry: true },
      { id: "c", error: "INVALID_PAYLOAD", retry: false },
    ]);
    expect(summary).toMatchObject({ retried: 2, failed: 1, done: 0 });
    // The raw error message (which could hold a number) is never stored or logged.
    expect(lines.join("\n")).not.toContain("+447700900123");
  });

  it("gives up on an attempt after its timeout and queues it again", async () => {
    vi.useFakeTimers();
    try {
      const { queue, calls } = fakeQueue([job("reminders.send", "slow")]);
      const { log } = capture();
      const drained = drainJobs({
        db,
        queue,
        log,
        budgetMs: 60_000,
        definitions: [definition("reminders.send", () => new Promise(() => undefined), 2_000)],
      });
      await vi.advanceTimersByTimeAsync(2_500);
      const summary = await drained;
      expect(calls.failed).toEqual([{ id: "slow", error: "TIMEOUT", retry: true }]);
      expect(summary).toMatchObject({ timedOut: 1, retried: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops claiming when the budget is spent", async () => {
    let now = 0;
    const { queue, calls } = fakeQueue([job("retention", "a"), job("retention", "b"), job("retention", "c")]);
    const { log } = capture();
    const summary = await drainJobs({
      db,
      queue,
      log,
      clock: () => now,
      budgetMs: 5_000,
      definitions: [definition("retention", async () => {
        now += 3_000;
      })],
    });
    expect(calls.finished).toEqual(["a", "b"]);
    expect(summary).toMatchObject({ stoppedBy: "budget", claimed: 2 });
  });

  it("hands handlers a deadline before the timeout, the clock and the job", async () => {
    const { queue } = fakeQueue([job("reminders.send", "j1", { garageId: GARAGE }, GARAGE)]);
    const { log } = capture();
    let seen: { deadline: number; garage: string | null } | null = null;
    await drainJobs({
      db,
      queue,
      log,
      clock: () => 1_000,
      budgetMs: 60_000,
      definitions: [definition("reminders.send", async (_payload, context) => {
        seen = { deadline: context.deadline, garage: context.job.garage_id };
      }, 18_000)],
    });
    expect(seen).toEqual({ deadline: 1_000 + 15_000, garage: GARAGE });
  });

  it("logs one JSON line per job with job_id, kind, garage_id and counts, never the payload", async () => {
    const { queue } = fakeQueue([job("reminders.schedule", "j1", { garageId: GARAGE, secret: "AB12CDE" }, GARAGE)]);
    const { log, lines } = capture();
    await drainJobs({
      db,
      queue,
      log,
      budgetMs: 10_000,
      definitions: [definition("reminders.schedule", async () => ({ outcome: "scheduled", counts: { mot: 2, service: undefined } }))],
    });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ scope: "jobs", event: "job_done", job_id: "j1", kind: "reminders.schedule", garage_id: GARAGE, outcome: "scheduled", mot: 2 });
    expect(lines[0]).not.toContain("AB12CDE");
  });

  it("reports not_configured without a database", async () => {
    expect(await drainJobs({ db: null, budgetMs: 1_000 })).toMatchObject({ ok: false, stoppedBy: "not_configured", claimed: 0 });
  });

  it("stops (without throwing) when the queue itself fails", async () => {
    const { queue } = fakeQueue([]);
    queue.claim = vi.fn(async () => {
      throw new Error("down");
    });
    const { log } = capture();
    expect(await drainJobs({ db, queue, log, budgetMs: 1_000, definitions: [definition("retention", async () => undefined)] })).toMatchObject({ ok: false, stoppedBy: "queue_error" });
  });
});

describe("cron helpers", () => {
  it("accepts only the exact bearer secret, and nothing without a long enough secret", () => {
    const env = { CRON_SECRET: "cron-secret-value-1234" };
    expect(isCronAuthorized("Bearer cron-secret-value-1234", env)).toBe(true);
    expect(isCronAuthorized("Bearer cron-secret-value-12345", env)).toBe(false);
    expect(isCronAuthorized("cron-secret-value-1234", env)).toBe(false);
    expect(isCronAuthorized("Bearer ", env)).toBe(false);
    expect(isCronAuthorized(null, env)).toBe(false);
    expect(isCronAuthorized("Bearer short", { CRON_SECRET: "short" })).toBe(false);
    expect(isCronAuthorized("Bearer undefined", {})).toBe(false);
  });

  it("keys cron jobs by day, or by 10-minute (sends) and 5-minute (domains) slots", () => {
    const at = new Date("2026-10-27T11:17:42Z");
    expect(cronDedupeKey("reminders.schedule", at)).toBe("cron:reminders.schedule:2026-10-27");
    expect(cronDedupeKey("reminders.send", at)).toBe("cron:reminders.send:2026-10-27T11:10Z");
    expect(cronDedupeKey("domains.check", at)).toBe("cron:domains.check:2026-10-27T11:15Z");
    expect(cronDedupeKey("retention", at)).toBe("cron:retention:2026-10-27");
    expect(utcSlot(new Date("2026-10-27T11:19:59Z"), 10)).toBe("2026-10-27T11:10Z");
  });

  it("works out garage-local dates across midnight and the clock changes", () => {
    // 23:30 UTC on 30 June is 00:30 on 1 July in London (BST).
    expect(localDate(new Date("2026-06-30T23:30:00Z"), "Europe/London")).toBe("2026-07-01");
    // 23:30 UTC on 25 October is still 25 October in London (GMT from 01:00 UTC that day).
    expect(localDate(new Date("2026-10-25T23:30:00Z"), "Europe/London")).toBe("2026-10-25");
    expect(localDate(new Date("2026-03-28T23:59:00Z"), "Europe/London")).toBe("2026-03-28");
  });
});
