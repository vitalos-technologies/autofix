import { describe, expect, it, vi } from "vitest";
import { CRON_JOBS, cronDedupeKey } from "@/lib/jobs/cron";
import { createNumbersProvisionHandler, NUMBERS_LEASE_SECONDS } from "@/lib/jobs/handlers/numbers-provision";
import { JOB_DEFINITIONS } from "@/lib/jobs/registry";
import { JOB_KINDS, type JobContext, type JobQueue, type JobRow } from "@/lib/jobs/types";
import { createMockTwilioNumbersClient } from "@/lib/messaging/twilio-numbers-mock";
import { TwilioNumbersError } from "@/lib/messaging/twilio-numbers-contract";
import type { NumbersRepo } from "@/lib/phone-numbers/provision";

// D22: the `numbers.provision` job around the provisioning step: the lease, bounded re-queues, and the
// configuration it runs with. The step's own decisions are in phone-numbers-provision.test.ts.

const GARAGE = "a0000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-30T11:05:00.000Z");
const ENV = { NEXT_PUBLIC_SITE_URL: "https://autofix.vitalos.co.uk", AUTOFIX_PLATFORM_VOICE_NUMBERS: "+441146974393" };

function repo(overrides: Partial<NumbersRepo> = {}) {
  const calls: string[] = [];
  const statuses: Array<{ ids: string[]; status: string; reason: string | null }> = [];
  const value: NumbersRepo = {
    listDue: vi.fn(async () => [{ garageId: GARAGE, garagePhone: "+441144960001", status: null, providerSid: null, number: null, routedNumber: null, routedSid: null }]),
    attach: vi.fn(async () => "ready" as const),
    setStatus: vi.fn(async (ids, status, reason) => {
      statuses.push({ ids, status, reason });
    }),
    recordPlatform: vi.fn(async () => undefined),
    claimLease: vi.fn(async (holder: string) => {
      calls.push(`claim:${holder}`);
      return true;
    }),
    releaseLease: vi.fn(async (holder: string) => {
      calls.push(`release:${holder}`);
    }),
    ...overrides,
  };
  return { value, calls, statuses };
}

function context(payload: Record<string, unknown>, options: { env?: Record<string, string>; deadlineInMs?: number } = {}) {
  const enqueued: Array<{ kind: string; payload: Record<string, unknown>; options: unknown }> = [];
  const queue: JobQueue = {
    enqueue: vi.fn(async (kind, jobPayload, jobOptions) => {
      enqueued.push({ kind, payload: jobPayload, options: jobOptions });
      return {} as JobRow;
    }),
    claim: vi.fn(async () => []),
    finish: vi.fn(async () => true),
    fail: vi.fn(async () => "queued"),
  };
  const warn = vi.fn();
  const job = { id: "job-1", kind: "numbers.provision", garage_id: (payload.garageId as string | undefined) ?? null, payload, dedupe_key: null, run_at: NOW.toISOString(), status: "running", attempts: 1, max_attempts: 5 } as JobRow;
  const value = {
    job,
    now: () => NOW,
    clock: () => 0,
    deadline: options.deadlineInMs ?? 15_000,
    queue,
    db: {},
    log: { info: vi.fn(), warn, error: vi.fn() },
    env: options.env ?? ENV,
  } as unknown as JobContext;
  return { value, enqueued, warn };
}

describe("numbers.provision job", () => {
  it("is registered, queued by the daily cron (once a day) and has a cron of its own", () => {
    expect(JOB_KINDS).toContain("numbers.provision");
    expect(JOB_DEFINITIONS.find((definition) => definition.kind === "numbers.provision")?.timeoutMs).toBe(18_000);
    expect(CRON_JOBS.daily).toContain("numbers.provision");
    expect(CRON_JOBS["numbers.provision"]).toEqual(["numbers.provision"]);
    expect(cronDedupeKey("numbers.provision", NOW)).toBe("cron:numbers.provision:2026-10-30");
    // Before the DVSA-bound work, so the daily drain reaches it.
    expect(JOB_KINDS.indexOf("numbers.provision")).toBeLessThan(JOB_KINDS.indexOf("customers.enrich"));
  });

  it("on the trial account records waiting for the upgrade, holding and then releasing the lease", async () => {
    const store = repo();
    const client = createMockTwilioNumbersClient();
    const handler = createNumbersProvisionHandler({ client: () => client, repo: () => store.value });
    const { value, enqueued } = context({});
    await expect(handler({}, value)).resolves.toMatchObject({ outcome: "waiting_upgrade" });
    expect(store.value.claimLease).toHaveBeenCalledWith("job-1", NUMBERS_LEASE_SECONDS);
    expect(store.calls).toEqual(["claim:job-1", "release:job-1"]);
    expect(store.statuses).toEqual([{ ids: [GARAGE], status: "waiting_upgrade", reason: null }]);
    expect(client.state.mutations).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("runs one garage when queued for it", async () => {
    const store = repo();
    const handler = createNumbersProvisionHandler({ client: () => createMockTwilioNumbersClient(), repo: () => store.value });
    await handler({ garageId: GARAGE }, context({ garageId: GARAGE }).value);
    expect(store.value.listDue).toHaveBeenCalledWith(GARAGE);
    expect(store.value.recordPlatform).not.toHaveBeenCalledWith(expect.objectContaining({ textingStatus: expect.anything() }));
  });

  it("waits for a busy lease once, then leaves it to the daily run (no loop)", async () => {
    const store = repo({ claimLease: vi.fn(async () => false) });
    const handler = createNumbersProvisionHandler({ client: () => createMockTwilioNumbersClient(), repo: () => store.value });
    const first = context({ garageId: GARAGE });
    await expect(handler({ garageId: GARAGE }, first.value)).resolves.toEqual({ outcome: "busy_requeued" });
    expect(first.enqueued).toEqual([{
      kind: "numbers.provision",
      payload: { garageId: GARAGE, attempt: 1 },
      options: { garageId: GARAGE, runAt: new Date(NOW.getTime() + 120_000), dedupeKey: "numbers.provision:continue:job-1" },
    }]);
    expect(store.value.listDue).not.toHaveBeenCalled();

    const last = context({ garageId: GARAGE, attempt: 3 });
    await expect(handler({ garageId: GARAGE, attempt: 3 }, last.value)).resolves.toEqual({ outcome: "busy" });
    expect(last.enqueued).toEqual([]);
    expect(last.warn).toHaveBeenCalledWith("numbers_provision_gave_up", { attempt: 3 });
  });

  it("re-queues after a rate limit no sooner than a minute, with a bounded attempt count", async () => {
    const limited = () => createMockTwilioNumbersClient({ accountType: "Full", failures: { getAccount: [new TwilioNumbersError("rate_limited", "Twilio account: HTTP 429", { httpStatus: 429, retryAfterMs: 5_000 })] } });
    const store = repo();
    const handler = createNumbersProvisionHandler({ client: limited, repo: () => store.value });
    const { value, enqueued } = context({});
    await expect(handler({}, value)).resolves.toMatchObject({ outcome: "stopped_rate_limited_requeued" });
    expect(enqueued[0]).toMatchObject({ payload: { attempt: 1 }, options: { garageId: null, runAt: new Date(NOW.getTime() + 60_000) } });
    expect(store.calls).toEqual(["claim:job-1", "release:job-1"]);
  });

  it("records not configured (production on the mock) without failing the job", async () => {
    const store = repo();
    const handler = createNumbersProvisionHandler({ repo: () => store.value });
    const { value, warn } = context({}, { env: { ...ENV, VERCEL_ENV: "production" } });
    await expect(handler({}, value)).resolves.toMatchObject({ outcome: "not_configured" });
    expect(store.statuses).toEqual([{ ids: [GARAGE], status: "not_configured", reason: "mode_not_live" }]);
    expect(warn).toHaveBeenCalledWith("numbers_not_configured");
  });

  it("says why live mode is refused off production", async () => {
    const store = repo();
    const handler = createNumbersProvisionHandler({ repo: () => store.value });
    const env = { ...ENV, TWILIO_NUMBERS_MODE: "live", VERCEL_ENV: "preview", TWILIO_ACCOUNT_SID: `AC${"0123456789abcdef".repeat(2)}`, TWILIO_AUTH_TOKEN: "token-0123456789", TWILIO_MESSAGING_SERVICE_SID: "MG0123456789abcdef0123456789abcdef" };
    await handler({}, context({}, { env }).value);
    expect(store.statuses).toEqual([{ ids: [GARAGE], status: "not_configured", reason: "not_production" }]);
  });

  it("refuses a payload it does not know for good", async () => {
    const handler = createNumbersProvisionHandler({ client: () => createMockTwilioNumbersClient(), repo: () => repo().value });
    await expect(handler({ garageId: "not-a-uuid" }, context({}).value)).rejects.toMatchObject({ code: "INVALID_PAYLOAD", retry: false });
    await expect(handler({ attempt: 9 }, context({}).value)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("releases the lease even when the store fails (the runner retries the job)", async () => {
    const store = repo({ listDue: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const handler = createNumbersProvisionHandler({ client: () => createMockTwilioNumbersClient(), repo: () => store.value });
    await expect(handler({}, context({}).value)).rejects.toThrow("db down");
    expect(store.calls).toEqual(["claim:job-1", "release:job-1"]);
  });
});
