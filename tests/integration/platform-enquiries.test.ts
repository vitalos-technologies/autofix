/**
 * Contact page enquiries against local Supabase: the app stores them with the service key
 * (createPlatformEnquiry), nobody else reads or writes the table through PostgREST, and
 * platform_update_enquiry() is not callable through the API at all (the Django super admin's
 * database role is its only grantee). The function's own rules are covered by pgTAP 040 and the
 * super admin's integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformEnquiry } from "@/lib/platform-enquiries/server";
import { rateLimitIdentifierHash } from "@/lib/rate-limit";
import {
  createLocalClient,
  createLocalMfaIdentity,
  executeLocalOwnerSql,
  getLocalSupabaseConfig,
  localRunId,
  queryLocalOwnerSql,
  type LocalTestIdentity,
} from "../helpers/local-supabase";

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);
const anon = createLocalClient(config.publishableKey);

let platformAdmin: LocalTestIdentity;
const created: string[] = [];

beforeAll(async () => {
  platformAdmin = await createLocalMfaIdentity(service, config.publishableKey, `enquiry-admin-${localRunId}@example.test`);
  const { error } = await service.from("platform_admins").insert({ user_id: platformAdmin.id });
  if (error) throw new Error(error.message);
});

afterAll(async () => {
  // The service role cannot delete enquiries (nobody can through the API): the owner cleans up.
  if (created.length) executeLocalOwnerSql("delete from public.platform_enquiries where id = any(string_to_array(:'ids', ',')::uuid[]);", { ids: created.join(",") });
  await service.from("platform_admins").delete().eq("user_id", platformAdmin.id);
  await service.auth.admin.deleteUser(platformAdmin.id);
});

describe("platform_enquiries through PostgREST", () => {
  it("the app stores an enquiry with the service key, with the IP as a day-salted hash", async () => {
    const stored = await createPlatformEnquiry(
      { name: `Priya ${localRunId}`, email: `priya-${localRunId}@example.test`, phone: "07700 900123", garageName: "Shah Motors", topic: "sales", message: "We would like a demo for our two sites." },
      { client: service, ipHash: rateLimitIdentifierHash("203.0.113.9") },
    );
    created.push(stored.id);
    const [row] = queryLocalOwnerSql<{ status: string; topic: string; ip_hash: string; handled_by: string | null }>(
      "select status, topic, ip_hash, handled_by from public.platform_enquiries where id = :'id'::uuid",
      { id: stored.id },
    );
    expect(row).toEqual({ status: "new", topic: "sales", ip_hash: rateLimitIdentifierHash("203.0.113.9"), handled_by: null });
  });

  it("the database refuses what the form would refuse", async () => {
    const { error } = await service.from("platform_enquiries").insert({ name: "Ann", email: "ann@example.test", topic: "billing", message: "A question about billing." });
    expect(error?.code).toBe("23514");
  });

  it("the service role can neither change nor delete an enquiry", async () => {
    const id = created[0]!;
    const update = await service.from("platform_enquiries").update({ status: "closed" }).eq("id", id);
    expect(update.error?.code).toBe("42501");
    const remove = await service.from("platform_enquiries").delete().eq("id", id);
    expect(remove.error?.code).toBe("42501");
  });

  it("anon and a signed-in platform admin read and write nothing", async () => {
    const staff = createLocalClient(config.publishableKey, platformAdmin.accessToken);
    for (const client of [anon, staff]) {
      const read = await client.from("platform_enquiries").select("*");
      expect(read.error?.code).toBe("42501");
      const insert = await client.from("platform_enquiries").insert({ name: "Spam Bot", email: "bot@example.test", topic: "general", message: "Buy cheap links now please." });
      expect(insert.error?.code).toBe("42501");
    }
  });

  it("platform_update_enquiry is not callable through the API, even by a platform admin at AAL2", async () => {
    const staff = createLocalClient(config.publishableKey, platformAdmin.accessToken);
    for (const client of [anon, staff, service]) {
      const { error } = await client.rpc("platform_update_enquiry", { p_enquiry_id: created[0], p_status: "closed", p_notes: null });
      expect(error?.code).toBe("42501");
    }
    const [row] = queryLocalOwnerSql<{ status: string }>("select status from public.platform_enquiries where id = :'id'::uuid", { id: created[0]! });
    expect(row?.status).toBe("new");
  });
});
