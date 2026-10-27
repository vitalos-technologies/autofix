import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AskbridgeSyncError, type runAskbridgeSync } from "@/lib/askbridge/sync";
import { createAskbridgeSyncHandler } from "@/lib/jobs/handlers/askbridge-sync";
import { JOB_DEFINITIONS } from "@/lib/jobs/registry";
import { JobError, type JobContext } from "@/lib/jobs/types";

const GARAGE = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-27T10:30:00Z");

function context(garageId: string | null = GARAGE) {
  const info = vi.fn();
  const value = {
    job: { id: "job-1", kind: "askbridge.sync", garage_id: garageId, payload: {}, dedupe_key: null, run_at: NOW.toISOString(), status: "running", attempts: 1, max_attempts: 5 },
    now: () => NOW,
    env: { ASKBRIDGE_SYNC_URL: "https://askbridge.example/sync" },
    log: { info, warn: vi.fn(), error: vi.fn() },
  } as unknown as JobContext;
  return { value, info };
}

function handlerWith(run: (...args: Parameters<typeof runAskbridgeSync>) => ReturnType<typeof runAskbridgeSync>) {
  const spy = vi.fn(run);
  return { spy, handler: createAskbridgeSyncHandler(spy as unknown as typeof runAskbridgeSync) };
}

describe("askbridge.sync job", () => {
  it("is registered with the runner", () => {
    expect(JOB_DEFINITIONS.find((definition) => definition.kind === "askbridge.sync")).toBeDefined();
  });

  it("syncs the job's garage with the runner's clock and env, and reports the outcome", async () => {
    const { spy, handler } = handlerWith(async () => ({ status: "sent", httpStatus: 202, contentHash: "abc", idempotencyKey: "key" }));
    const { value, info } = context();
    await expect(handler({ garageId: GARAGE }, value)).resolves.toEqual({ outcome: "sent" });
    expect(spy).toHaveBeenCalledWith({ garageId: GARAGE }, { now: NOW, env: value.env });
    expect(info).toHaveBeenCalledWith("askbridge.synced", { status: "sent", reason: undefined });
  });

  it("finishes skipped garages (chat off, inactive, gone)", async () => {
    const { handler } = handlerWith(async () => ({ status: "skipped", reason: "askbridge_disabled" }));
    await expect(handler({ garageId: GARAGE }, context().value)).resolves.toEqual({ outcome: "skipped_askbridge_disabled" });
  });

  it("retries what Askbridge says is retryable and fails the rest for good", async () => {
    const retry = handlerWith(async () => { throw new AskbridgeSyncError("Askbridge answered 503", true, 503); });
    await expect(retry.handler({ garageId: GARAGE }, context().value)).rejects.toMatchObject({ retry: true, message: "ASKBRIDGE_SYNC_FAILED: Askbridge answered 503" });
    const permanent = handlerWith(async () => { throw new AskbridgeSyncError("Askbridge answered 422", false, 422); });
    await expect(permanent.handler({ garageId: GARAGE }, context().value)).rejects.toMatchObject({ retry: false });
  });

  it("refuses a bad payload or one for another garage than the job's", async () => {
    const { spy, handler } = handlerWith(async () => ({ status: "mocked", contentHash: "abc", idempotencyKey: "key" }));
    await expect(handler({}, context().value)).rejects.toBeInstanceOf(JobError);
    await expect(handler({ garageId: GARAGE, extra: true }, context().value)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(handler({ garageId: GARAGE }, context("22222222-2222-4222-8222-222222222222").value)).rejects.toMatchObject({ code: "GARAGE_MISMATCH" });
    expect(spy).not.toHaveBeenCalled();
  });
});
