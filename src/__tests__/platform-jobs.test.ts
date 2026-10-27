import { describe, expect, it, vi } from "vitest";
import { platformCloseImpersonationsHandler } from "@/lib/platform/jobs";
import type { JobContext } from "@/lib/jobs/types";

function context(result: { data: unknown; error: { code?: string } | null }) {
  const rpc = vi.fn(async () => result);
  const info = vi.fn();
  return { rpc, info, value: { db: { rpc }, log: { info, warn: vi.fn(), error: vi.fn() } } as unknown as JobContext };
}

describe("platform.close_impersonations", () => {
  it("closes expired sessions through the service-role function and reports the count", async () => {
    const { rpc, info, value } = context({ data: 2, error: null });
    await expect(platformCloseImpersonationsHandler({}, value)).resolves.toEqual({ outcome: "closed", counts: { closed: 2 } });
    expect(rpc).toHaveBeenCalledWith("close_expired_impersonations");
    expect(info).toHaveBeenCalledWith("platform.impersonations_closed", { closed: 2 });
  });

  it("is a no-op when nothing expired and throws on a database error (the runner retries)", async () => {
    await expect(platformCloseImpersonationsHandler({}, context({ data: 0, error: null }).value)).resolves.toEqual({ outcome: "none", counts: { closed: 0 } });
    await expect(platformCloseImpersonationsHandler({}, context({ data: null, error: { code: "42501" } }).value)).rejects.toThrow("CLOSE_IMPERSONATIONS_FAILED: 42501");
  });
});
