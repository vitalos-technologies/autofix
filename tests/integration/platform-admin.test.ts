/**
 * Super admin (P4.5) against local Supabase through PostgREST, exactly as the
 * app calls it: non-admins are refused; a platform admin at AAL2 sees every
 * garage; impersonation admits one garage, for reads only (PostgREST runs GET
 * and stable RPCs read-only), until it ends or expires; every action is in the
 * garage's own audit log, which its owner can read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalClient,
  createLocalGarage,
  createLocalIdentity,
  createLocalMfaIdentity,
  getLocalSupabaseConfig,
  localRunId,
  type LocalTestGarage,
  type LocalTestIdentity,
} from "../helpers/local-supabase";

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);

let garageA: LocalTestGarage;
let garageB: LocalTestGarage;
let platformAdmin: LocalTestIdentity;
let platformAdminAal1: LocalTestIdentity;
let ownerA: LocalTestIdentity;
let customerA: string;
let failedJob: string;

const as = (identity: LocalTestIdentity, garageId?: string): SupabaseClient => createLocalClient(config.publishableKey, identity.accessToken, garageId);

beforeAll(async () => {
  garageA = await createLocalGarage(service, "pa");
  garageB = await createLocalGarage(service, "pb");
  platformAdmin = await createLocalMfaIdentity(service, config.publishableKey, `platform-${localRunId}@example.test`);
  platformAdminAal1 = await createLocalIdentity(service, config.publishableKey, `platform-aal1-${localRunId}@example.test`);
  ownerA = await createLocalMfaIdentity(service, config.publishableKey, `platform-owner-a-${localRunId}@example.test`);
  const { error: adminError } = await service.from("platform_admins").insert([{ user_id: platformAdmin.id }, { user_id: platformAdminAal1.id }]);
  if (adminError) throw new Error(adminError.message);
  const { error: memberError } = await service.from("garage_members").insert({ garage_id: garageA.id, user_id: ownerA.id, role: "owner" });
  if (memberError) throw new Error(memberError.message);
  const customers = await service.from("customers").insert([
    { garage_id: garageA.id, name: `Platform customer A ${localRunId}`, phone: "+447700900401", preferred_contact: "phone" },
    { garage_id: garageB.id, name: `Platform customer B ${localRunId}`, phone: "+447700900402", preferred_contact: "phone" },
  ]).select("id,garage_id");
  if (customers.error) throw new Error(customers.error.message);
  customerA = customers.data.find((row) => row.garage_id === garageA.id)!.id;
  const job = await service.from("jobs").insert({
    kind: "platform.it_probe", garage_id: garageA.id, status: "failed", attempts: 5, max_attempts: 5,
    finished_at: new Date().toISOString(), last_error: "SEND_FAILED for jo@example.com AB12 CDE",
  }).select("id").single();
  if (job.error) throw new Error(job.error.message);
  failedJob = job.data.id;
});

afterAll(async () => {
  await service.from("jobs").delete().eq("id", failedJob);
  await service.from("garages").delete().in("id", [garageA.id, garageB.id]);
  for (const identity of [platformAdmin, platformAdminAal1, ownerA]) if (identity) await service.auth.admin.deleteUser(identity.id);
});

describe("platform access", () => {
  it("refuses garage owners and platform admins without MFA", async () => {
    for (const client of [as(ownerA, garageA.id), as(platformAdminAal1)]) {
      const { error } = await client.rpc("platform_garages", { p_search: localRunId });
      expect(error?.code).toBe("42501");
      expect((await client.rpc("platform_job_health")).error?.code).toBe("42501");
      expect((await client.rpc("platform_start_impersonation", { p_garage_id: garageB.id, p_reason: "Just looking", p_minutes: 30 })).error?.code).toBe("42501");
    }
  });

  it("platform tables are closed to everyone but the service role", async () => {
    for (const table of ["platform_audit_log", "platform_impersonations"]) {
      const { error } = await as(platformAdmin).from(table).select("id").limit(1);
      expect(error?.code).toBe("42501");
    }
  });

  it("shows a platform admin at AAL2 every garage", async () => {
    const { data, error } = await as(platformAdmin).rpc("platform_garages", { p_search: localRunId });
    expect(error).toBeNull();
    expect((data as Array<{ id: string }>).map((row) => row.id).sort()).toEqual([garageA.id, garageB.id].sort());
  });

  it("changes plan and status with a reason, visible in the garage's audit log", async () => {
    const { data, error } = await as(platformAdmin).rpc("platform_update_garage", {
      p_garage_id: garageB.id, p_plan: "front_desk", p_status: "suspended", p_reason: "Integration check",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ plan: "front_desk", status: "suspended" });
    const { data: audit } = await service.from("admin_audit_log").select("action,detail").eq("garage_id", garageB.id).like("action", "platform.%");
    expect(audit?.map((row) => row.action).sort()).toEqual(["platform.garage_plan_changed", "platform.garage_status_changed"]);
  });
});

describe("impersonation", () => {
  it("admits exactly one garage, read-only, and logs it where the owner can see", async () => {
    const admin = as(platformAdmin);
    // Before: nothing.
    expect((await as(platformAdmin, garageA.id).from("customers").select("id")).data).toEqual([]);

    const started = await admin.rpc("platform_start_impersonation", { p_garage_id: garageA.id, p_reason: "Support ticket IT-1", p_minutes: 30 });
    expect(started.error).toBeNull();
    expect((await admin.rpc("current_impersonation")).data).toMatchObject([{ garage_id: garageA.id }]);

    const inA = as(platformAdmin, garageA.id);
    expect((await inA.from("customers").select("id")).data?.map((row) => row.id)).toEqual([customerA]);
    expect((await inA.from("garages").select("id").eq("id", garageA.id)).data).toHaveLength(1);
    // Other garage: nothing.
    expect((await as(platformAdmin, garageB.id).from("customers").select("id")).data).toEqual([]);

    // Writes run read-write, where impersonation never applies.
    const insert = await inA.from("customers").insert({ garage_id: garageA.id, name: "Written by support", phone: "+447700900403", preferred_contact: "phone" });
    expect(insert.error?.code).toBe("42501");
    const update = await inA.from("customers").update({ name: "Tampered" }).eq("id", customerA).select("id");
    expect(update.data ?? []).toEqual([]);
    const { data: unchanged } = await service.from("customers").select("name").eq("id", customerA).single();
    expect(unchanged?.name).toBe(`Platform customer A ${localRunId}`);

    expect((await admin.rpc("log_impersonation_event", { p_action: "platform.impersonation_page_view", p_path: "/app/customers" })).data).toBe(true);

    // The owner reads the trail in their own audit log.
    const { data: trail } = await as(ownerA, garageA.id).from("admin_audit_log").select("action,detail").like("action", "platform.impersonation_%");
    expect(trail?.map((row) => row.action)).toEqual(expect.arrayContaining(["platform.impersonation_started", "platform.impersonation_page_view"]));
    expect(trail?.find((row) => row.action === "platform.impersonation_started")?.detail).toMatchObject({ reason: "Support ticket IT-1" });

    expect((await admin.rpc("platform_end_impersonation")).data).toBe(true);
    expect((await inA.from("customers").select("id")).data).toEqual([]);
  });

  it("stops admitting the garage once the session expires", async () => {
    const admin = as(platformAdmin);
    await admin.rpc("platform_start_impersonation", { p_garage_id: garageA.id, p_reason: "Support ticket IT-2", p_minutes: 5 });
    expect((await as(platformAdmin, garageA.id).from("customers").select("id")).data).toHaveLength(1);
    await service.from("platform_impersonations")
      .update({ started_at: new Date(Date.now() - 600_000).toISOString(), expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("admin_user_id", platformAdmin.id).is("ended_at", null);
    expect((await as(platformAdmin, garageA.id).from("customers").select("id")).data).toEqual([]);
    expect((await admin.rpc("current_impersonation")).data).toEqual([]);
    await admin.rpc("platform_end_impersonation");
    const { data: sessions } = await service.from("platform_impersonations").select("end_reason").eq("admin_user_id", platformAdmin.id);
    expect(sessions?.map((row) => row.end_reason).sort()).toEqual(["ended", "expired"]);
  });

  it("gives a platform admin without MFA nothing, even with an open session row", async () => {
    await service.from("platform_impersonations").insert({
      garage_id: garageA.id, admin_user_id: platformAdminAal1.id, reason: "Inserted directly",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    expect((await as(platformAdminAal1, garageA.id).from("customers").select("id")).data).toEqual([]);
  });
});

describe("job health", () => {
  it("lists failures and retries one, audited", async () => {
    const admin = as(platformAdmin);
    const { data: health, error } = await admin.rpc("platform_job_health");
    expect(error).toBeNull();
    expect((health as { recent_failures: Array<{ id: string }> }).recent_failures.map((row) => row.id)).toContain(failedJob);
    expect((await admin.rpc("platform_retry_job", { p_job_id: failedJob, p_reason: "Provider fixed" })).data).toBe(true);
    const { data: job } = await service.from("jobs").select("status,attempts").eq("id", failedJob).single();
    expect(job).toEqual({ status: "queued", attempts: 0 });
    const { data: audit } = await service.from("platform_audit_log").select("action").eq("entity_id", failedJob);
    expect(audit).toEqual([{ action: "platform.job_retried" }]);
  });
});
