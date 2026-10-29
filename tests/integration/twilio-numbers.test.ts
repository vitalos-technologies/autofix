/**
 * D22 number provisioning against local Supabase: the real store (createSupabaseNumbersRepo, the SQL
 * functions of 20261029003400_twilio_numbers.sql through PostgREST) with the mock Twilio client. A garage
 * on a trial account waits for the upgrade; on an upgraded account it gets one number, routed so the voice
 * webhook never rings the garage back; a re-run buys nothing; the owner reads the state through RLS and
 * another garage's owner reads nothing. Only garage-scoped runs, so other suites' garages are untouched.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockTwilioNumbersClient } from "@/lib/messaging/twilio-numbers-mock";
import { createSupabaseTwilioWebhookRepo } from "@/lib/messaging/twilio-webhook-repository";
import { provisionNumbers, type NumbersRepo } from "@/lib/phone-numbers/provision";
import { createSupabaseNumbersRepo, loadAiDeskNumber } from "@/lib/phone-numbers/repository";
import {
  createLocalClient,
  createLocalGarage,
  createLocalMfaIdentity,
  getLocalSupabaseConfig,
  localRunId,
  type LocalTestGarage,
  type LocalTestIdentity,
} from "../helpers/local-supabase";

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);
const numbersConfig = { cap: 20, voiceUrl: "https://autofix.vitalos.co.uk/api/webhooks/twilio/voice", platformNumbers: new Set(["+441146974393"]) };

/** A number from Ofcom's 01632 960xxx drama range and a PN SID, both unique to this run. */
const suffix = (BigInt(`0x${localRunId}`) % 1000n).toString().padStart(3, "0");
const NUMBER = `+441632960${suffix}`;
const SID = `PN${createHash("sha256").update(`numbers-${localRunId}`).digest("hex").slice(0, 32)}`;

let garageA: LocalTestGarage;
let garageB: LocalTestGarage;
let ownerA: LocalTestIdentity;
let ownerB: LocalTestIdentity;
let ownerAClient: SupabaseClient;
let ownerBForgingA: SupabaseClient;
let repo: NumbersRepo;

beforeAll(async () => {
  garageA = await createLocalGarage(service, "na");
  garageB = await createLocalGarage(service, "nb");
  ownerA = await createLocalMfaIdentity(service, config.publishableKey, `numbers-a-${localRunId}@example.test`);
  ownerB = await createLocalMfaIdentity(service, config.publishableKey, `numbers-b-${localRunId}@example.test`);
  for (const [garage, owner] of [[garageA, ownerA], [garageB, ownerB]] as const) {
    const member = await service.from("garage_members").insert({ garage_id: garage.id, user_id: owner.id, role: "owner" });
    if (member.error) throw new Error(member.error.message);
    // New garages are on the Pro trial; the owner has switched the AI front desk on.
    const desk = await service.from("ai_front_desk_settings").insert({ garage_id: garage.id, enabled: true, enabled_at: new Date().toISOString() });
    if (desk.error) throw new Error(desk.error.message);
  }
  ownerAClient = createLocalClient(config.publishableKey, ownerA.accessToken, garageA.id);
  ownerBForgingA = createLocalClient(config.publishableKey, ownerB.accessToken, garageA.id);
  repo = createSupabaseNumbersRepo(service);
});

afterAll(async () => {
  for (const garage of [garageA, garageB]) if (garage) await service.from("garages").delete().eq("id", garage.id);
  for (const owner of [ownerA, ownerB]) if (owner) await service.auth.admin.deleteUser(owner.id);
});

describe("number provisioning through PostgREST", () => {
  it("lists the Pro garage with the desk on as due, with its phone for the area code", async () => {
    const due = await repo.listDue(garageA.id);
    expect(due).toEqual([{ garageId: garageA.id, garagePhone: "+441302000101", status: null, providerSid: null, number: null, routedNumber: null, routedSid: null }]);
  });

  it("on a trial account records waiting for the upgrade, which the owner reads and nobody else does", async () => {
    const client = createMockTwilioNumbersClient();
    await expect(provisionNumbers({ client, repo, config: numbersConfig, scope: { kind: "garage", garageId: garageA.id } })).resolves.toMatchObject({ outcome: "waiting_upgrade" });
    expect(await loadAiDeskNumber(ownerAClient, garageA.id)).toMatchObject({ status: "waiting_upgrade", number: null });
    const forged = await ownerBForgingA.from("ai_front_desk_numbers").select("garage_id").eq("garage_id", garageA.id);
    expect(forged.data ?? []).toEqual([]);
    const write = await ownerAClient.from("ai_front_desk_numbers").update({ status: "ready" }).eq("garage_id", garageA.id);
    expect(write.error?.code).toBe("42501");
  });

  it("on an upgraded account buys one number, routed so calls never ring the garage back", async () => {
    const client = createMockTwilioNumbersClient({ accountType: "Full", bundles: { mobile: true, local: true }, address: true, available: { local: [NUMBER] }, sids: [SID] });
    const summary = await provisionNumbers({ client, repo, config: numbersConfig, scope: { kind: "garage", garageId: garageA.id } });
    expect(summary).toMatchObject({ bought: 1, attached: 1 });

    expect(await loadAiDeskNumber(ownerAClient, garageA.id)).toMatchObject({ status: "ready", number: NUMBER, ringsGarageFirst: false });
    const routed = await createSupabaseTwilioWebhookRepo(service).findGarageByNumber(NUMBER);
    expect(routed).toMatchObject({ garageId: garageA.id, purpose: "forwarding", ringGarageFirst: false });
    expect(await repo.listDue(garageA.id)).toEqual([]);

    // A second run, even with numbers on offer, buys nothing.
    const again = createMockTwilioNumbersClient({ accountType: "Full", bundles: { mobile: true, local: true }, address: true, available: { local: ["+441632960999"] } });
    await expect(provisionNumbers({ client: again, repo, config: numbersConfig, scope: { kind: "garage", garageId: garageA.id } })).resolves.toMatchObject({ outcome: "nothing_due", bought: 0 });
    expect(again.state.calls).toEqual([]);
  });

  it("refuses to give that number to another garage", async () => {
    await expect(repo.attach(garageB.id, NUMBER, SID, false)).resolves.toBe("number_taken");
  });

  it("lets one run hold the lease at a time", async () => {
    const first = randomUUID();
    const second = randomUUID();
    expect(await repo.claimLease(first, 30)).toBe(true);
    expect(await repo.claimLease(second, 30)).toBe(false);
    await repo.releaseLease(first);
    expect(await repo.claimLease(second, 30)).toBe(true);
    await repo.releaseLease(second);
  });

  it("keeps the platform row out of the API for staff", async () => {
    const read = await ownerAClient.from("twilio_number_provisioning").select("*");
    expect(read.error?.code).toBe("42501");
  });
});
