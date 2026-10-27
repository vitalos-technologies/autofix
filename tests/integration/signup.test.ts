/**
 * Sign-up end to end against local Supabase (P4.4): an owner creates a garage with
 * create_garage(), its free link resolves (`<slug>.localhost`), the defaults are bookable,
 * staff are invited and join, and the garage goes live once the DPA is accepted.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearHostCache, resolveHost } from "@/lib/tenancy/resolve";
import { createLocalClient, createLocalIdentity, createLocalMfaIdentity, getLocalSupabaseConfig, type LocalTestIdentity } from "../helpers/local-supabase";

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);
const run = randomUUID().slice(0, 8);
const slug = `it-signup-${run}`;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

let owner: LocalTestIdentity;
let invited: LocalTestIdentity;
let garageId: string;
let ownerClient: SupabaseClient;

beforeAll(async () => {
  // resolveHost's default lookup reads these (service role, as in the proxy).
  process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
  process.env.SUPABASE_SECRET_KEY = config.secretKey;
  owner = await createLocalMfaIdentity(service, config.publishableKey, `signup-owner-${run}@example.test`);
  invited = await createLocalIdentity(service, config.publishableKey, `signup-invited-${run}@example.test`);
}, 60_000);

afterAll(async () => {
  if (garageId) await service.from("garages").delete().eq("id", garageId);
  for (const identity of [owner, invited]) if (identity) await service.auth.admin.deleteUser(identity.id);
});

describe("sign-up", () => {
  it("does not resolve the free link before the garage exists", async () => {
    clearHostCache();
    expect(await resolveHost(`${slug}.localhost:3000`, { env: {} })).toEqual({ kind: "unknown" });
  });

  it("creates the garage, its owner and its defaults in one call", async () => {
    clearHostCache();
    const { data, error } = await service.rpc("create_garage", {
      p_user_id: owner.id,
      p_garage: {
        name: "Integration Signup Motors",
        slug,
        phone: "+441632960999",
        address: { line1: "1 Test Street", town: "Doncaster", postcode: "DN1 1AA" },
        opening_hours: [],
      },
    });
    expect(error).toBeNull();
    garageId = (data as { garage_id: string }).garage_id;
    expect(data).toMatchObject({ slug, status: "onboarding", seeded: { opening_hours: 6, resources: 4, services: 6, reminder_rules: 4 } });
    ownerClient = createLocalClient(config.publishableKey, owner.accessToken, garageId);
    const { data: team } = await ownerClient.rpc("list_garage_team");
    expect(team).toEqual([expect.objectContaining({ user_id: owner.id, role: "owner", is_self: true, email: owner.email })]);
  });

  it("serves the booking page on <slug>.localhost straight away", async () => {
    clearHostCache();
    expect(await resolveHost(`${slug}.localhost:3000`, { env: {} })).toEqual({
      kind: "garage",
      via: "dev-garage",
      // A new garage has no embed sites and no Askbridge chat yet (P4.3/P4.6).
      garage: { id: garageId, slug, status: "onboarding", embedOrigins: [], widgetEnabled: false },
    });
  });

  it("has bookable times for a seeded service", async () => {
    const { data: services } = await service.from("services").select("id,name").eq("garage_id", garageId).eq("name", "Diagnostics").single();
    const today = new Date();
    const inTwoWeeks = new Date(today.getTime() + 14 * 86_400_000);
    const { data: slots, error } = await service.rpc("available_slots", {
      p_garage_id: garageId,
      p_service_id: (services as { id: string }).id,
      p_from: today.toISOString().slice(0, 10),
      p_to: inTwoWeeks.toISOString().slice(0, 10),
    });
    expect(error).toBeNull();
    expect((slots as Array<{ free_count: number }>).some((slot) => slot.free_count > 0)).toBe(true);
  });

  it("refuses a second garage with the same slug", async () => {
    const { error } = await service.rpc("create_garage", { p_user_id: owner.id, p_garage: { name: "Copycat", slug } });
    expect(error?.message).toBe("SLUG_TAKEN");
  });

  it("invites staff, who join with the invited role", async () => {
    const token = randomBytes(32).toString("base64url");
    const { data: invite, error } = await ownerClient.rpc("create_garage_invite", { p_email: invited.email, p_role: "front_desk", p_token_hash: hash(token) });
    expect(error).toBeNull();
    expect(invite).toMatchObject({ email: invited.email, role: "front_desk", resent: false });
    const { data: listed } = await ownerClient.rpc("list_garage_invites");
    expect(listed).toEqual([expect.objectContaining({ email: invited.email, role: "front_desk", sent_count: 1 })]);
    expect(Object.keys((listed as object[])[0]!)).not.toContain("token_hash");
    const { error: directRead } = await ownerClient.from("garage_invites").select("email").eq("garage_id", garageId);
    expect(directRead?.code).toBe("42501");

    const invitedClient = createLocalClient(config.publishableKey, invited.accessToken);
    const { data: accepted, error: acceptError } = await invitedClient.rpc("accept_garage_invite", { p_token_hash: hash(token) });
    expect(acceptError).toBeNull();
    expect(accepted).toEqual({ garage_id: garageId, role: "front_desk", already_member: false });
    const { data: memberships } = await invitedClient.from("garage_members").select("garage_id,role").eq("user_id", invited.id);
    expect(memberships).toEqual([{ garage_id: garageId, role: "front_desk" }]);
  });

  it("goes live only after the DPA is accepted", async () => {
    const before = await ownerClient.rpc("complete_garage_onboarding");
    expect(before.error?.message).toBe("DPA_NOT_ACCEPTED");
    const { error: dpaError } = await service.rpc("accept_garage_agreement", {
      p_garage_id: garageId,
      p_user_id: owner.id,
      p_kind: "dpa",
      p_version: "0.1",
      p_text_hash: "b".repeat(64),
      p_accepted_by_name: "Integration Owner",
    });
    expect(dpaError).toBeNull();
    const after = await ownerClient.rpc("complete_garage_onboarding");
    expect(after).toMatchObject({ data: "active", error: null });
    clearHostCache();
    expect(await resolveHost(`${slug}.localhost:3000`, { env: {} })).toMatchObject({ kind: "garage", garage: { id: garageId, status: "active" } });
  });
});
