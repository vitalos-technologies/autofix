import { describe, expect, it } from "vitest";
import { createMockTwilioNumbersClient, mockNumberSid, MOCK_ADDRESS_SID, MOCK_LOCAL_BUNDLE_SID, MOCK_MOBILE_BUNDLE_SID, type MockTwilioNumbersOptions } from "@/lib/messaging/twilio-numbers-mock";
import { TwilioNumbersError } from "@/lib/messaging/twilio-numbers-contract";
import { areaCodePattern, ukAreaCode } from "@/lib/phone-numbers/area-code";
import { DEFAULT_NUMBER_CAP, numberCap, readNumbersConfig, voiceWebhookUrl, type NumbersConfig } from "@/lib/phone-numbers/config";
import { deskNumberName, provisionNumbers, TEXTING_NUMBER_NAME, type AttachResult, type DueGarage, type NumbersRepo, type PlatformPatch, type ProvisionScope } from "@/lib/phone-numbers/provision";
import type { NumberStatus, WaitingStatus } from "@/lib/phone-numbers/state";

// D22: the number provisioning step against the mock Twilio client and an in-memory store that behaves like
// 20261029003400_twilio_numbers.sql (pgTAP 043 covers the SQL itself).

const PLATFORM_LINE = "+441146974393";
const VOICE_URL = "https://autofix.vitalos.co.uk/api/webhooks/twilio/voice";
const GARAGE_A = "a0000000-0000-4000-8000-0000000000a1";
const GARAGE_B = "a0000000-0000-4000-8000-0000000000b2";
/** Ofcom drama ranges: Sheffield 0114 496 0xxx, "any area" 01632 960xxx, mobiles 07700 900xxx. */
const SHEFFIELD = ["+441144960101", "+441144960102"];
const ANYWHERE = ["+441632960201", "+441632960202", "+441632960203"];
const MOBILES = ["+447700900301", "+447700900302"];
const PLATFORM_SID = mockNumberSid(9_000_001);
const platformLine = { sid: PLATFORM_SID, phoneNumber: PLATFORM_LINE, friendlyName: "Autofix own line", sms: false, voice: true };

const config = (overrides: Partial<NumbersConfig> = {}): NumbersConfig => ({
  cap: 20,
  voiceUrl: VOICE_URL,
  platformNumbers: new Set([PLATFORM_LINE]),
  ...overrides,
});

type GarageFixture = { id: string; phone: string | null };
type StoredState = { status: NumberStatus; reason: string | null; number: string | null; providerSid: string | null };
type Routing = { garageId: string; sid: string; ringGarageFirst: boolean };

/** The store, with the same rules as the SQL functions (attach refuses a second number or a taken one). */
function memoryRepo(garages: GarageFixture[]) {
  const states = new Map<string, StoredState>();
  const routing = new Map<string, Routing>();
  const platform: PlatformPatch & { leaseHolder?: string | null } = {};
  const attachCalls: Array<{ garageId: string; number: string; sid: string; ringGarageFirst: boolean | null }> = [];
  let failNextAttach = false;

  const routedFor = (garageId: string) => [...routing.entries()].find(([, route]) => route.garageId === garageId);

  const repo: NumbersRepo = {
    async listDue(garageId) {
      return garages
        .filter((garage) => !garageId || garage.id === garageId)
        .flatMap((garage): DueGarage[] => {
          const state = states.get(garage.id);
          const routed = routedFor(garage.id);
          if (state?.status === "ready" && routed) return [];
          return [{
            garageId: garage.id,
            garagePhone: garage.phone,
            status: state?.status ?? null,
            providerSid: state?.providerSid ?? null,
            number: state?.number ?? null,
            routedNumber: routed?.[0] ?? null,
            routedSid: routed?.[1].sid ?? null,
          }];
        });
    },
    async attach(garageId, number, sid, ringGarageFirst): Promise<AttachResult> {
      attachCalls.push({ garageId, number, sid, ringGarageFirst });
      if (failNextAttach) {
        failNextAttach = false;
        throw new Error("database unavailable");
      }
      const state = states.get(garageId);
      if (state?.providerSid && state.providerSid !== sid) return "already_provisioned";
      const existing = routing.get(number);
      if (existing && existing.garageId !== garageId) return "number_taken";
      routing.set(number, { garageId, sid, ringGarageFirst: ringGarageFirst ?? existing?.ringGarageFirst ?? true });
      states.set(garageId, { status: "ready", reason: null, number, providerSid: sid });
      return "ready";
    },
    async setStatus(garageIds, status: WaitingStatus, reason) {
      for (const id of garageIds) {
        const state = states.get(id);
        states.set(id, { status, reason, number: state?.number ?? null, providerSid: state?.providerSid ?? null });
      }
    },
    async recordPlatform(patch) {
      Object.assign(platform, patch);
    },
    async claimLease(holder) {
      if (platform.leaseHolder && platform.leaseHolder !== holder) return false;
      platform.leaseHolder = holder;
      return true;
    },
    async releaseLease(holder) {
      if (platform.leaseHolder === holder) platform.leaseHolder = null;
    },
  };
  return { repo, states, routing, platform, attachCalls, failAttachOnce: () => (failNextAttach = true) };
}

/** An upgraded account with approved bundles, an address and numbers to sell, unless told otherwise. */
function fullAccount(options: MockTwilioNumbersOptions = {}) {
  return createMockTwilioNumbersClient({
    accountType: "Full",
    bundles: { mobile: true, local: true },
    address: true,
    owned: [platformLine],
    available: { mobile: [...MOBILES], local: [...SHEFFIELD, ...ANYWHERE] },
    ...options,
  });
}

const ALL: ProvisionScope = { kind: "all" };
const sheffieldGarage: GarageFixture = { id: GARAGE_A, phone: "+441144960001" };

describe("numbers.provision on a trial account", () => {
  it("records waiting for the upgrade and does nothing else", async () => {
    const client = createMockTwilioNumbersClient({ accountType: "Trial", bundles: { mobile: true, local: true }, address: true, owned: [platformLine], available: { mobile: MOBILES, local: ANYWHERE } });
    const store = memoryRepo([sheffieldGarage]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });

    expect(summary).toMatchObject({ outcome: "waiting_upgrade", accountType: "Trial", bought: 0, waiting: 1, texting: "waiting_upgrade", stopped: null });
    expect(store.states.get(GARAGE_A)).toEqual({ status: "waiting_upgrade", reason: null, number: null, providerSid: null });
    expect(store.platform).toMatchObject({ accountType: "Trial", textingStatus: "waiting_upgrade", numberCap: 20 });
    // One read of the account and nothing more: no listing, no search, no purchase.
    expect(client.state.calls).toEqual(["getAccount"]);
    expect(client.state.mutations).toEqual([]);
  });

  it("is what the shared dev mock does out of the box", async () => {
    const client = createMockTwilioNumbersClient();
    const store = memoryRepo([sheffieldGarage]);
    await expect(provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } })).resolves.toMatchObject({ outcome: "waiting_upgrade", texting: "skipped" });
    expect(store.states.get(GARAGE_A)?.status).toBe("waiting_upgrade");
  });
});

describe("numbers.provision without an approved bundle", () => {
  it("waits for the bundle for both the texting number and the garage, buying nothing", async () => {
    const client = fullAccount({ bundles: {} });
    const store = memoryRepo([sheffieldGarage]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });
    expect(summary).toMatchObject({ outcome: "checked", texting: "waiting_bundle", waiting: 1, bought: 0 });
    expect(store.states.get(GARAGE_A)?.status).toBe("waiting_bundle");
    expect(store.platform.textingStatus).toBe("waiting_bundle");
    expect(client.state.mutations).toEqual([]);
  });

  it("needs a business bundle for local numbers: a mobile bundle alone buys the texting number only", async () => {
    const client = fullAccount({ bundles: { mobile: true } });
    const store = memoryRepo([sheffieldGarage]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });
    expect(store.states.get(GARAGE_A)?.status).toBe("waiting_bundle");
    expect(client.state.mutations.map((mutation) => mutation.op)).toEqual(["buy", "addToService"]);
  });
});

describe("numbers.provision at the cap", () => {
  it("counts every number on the account and buys nothing at or over TWILIO_NUMBER_CAP", async () => {
    const other = { sid: mockNumberSid(9_000_002), phoneNumber: "+441632960999", friendlyName: "Another Vitalos product", sms: false, voice: true };
    const client = fullAccount({ owned: [platformLine, other] });
    const store = memoryRepo([sheffieldGarage, { id: GARAGE_B, phone: null }]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config({ cap: 2 }), scope: ALL });
    expect(summary).toMatchObject({ held: 2, bought: 0, texting: "cap_reached", waiting: 2 });
    expect(store.states.get(GARAGE_A)?.status).toBe("cap_reached");
    expect(store.states.get(GARAGE_B)?.status).toBe("cap_reached");
    expect(store.platform).toMatchObject({ numbersHeld: 2, numberCap: 2 });
    expect(client.state.mutations).toEqual([]);
  });

  it("stops buying when a purchase reaches the cap; the rest wait their turn", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage, { id: GARAGE_B, phone: null }]);
    // Platform line (1) + texting mobile (2) + garage A (3) = cap 3: garage B waits.
    const summary = await provisionNumbers({ client, repo: store.repo, config: config({ cap: 3 }), scope: ALL });
    expect(summary).toMatchObject({ bought: 2, held: 3, attached: 1 });
    expect(store.states.get(GARAGE_A)?.status).toBe("ready");
    expect(store.states.get(GARAGE_B)?.status).toBe("cap_reached");
  });
});

describe("numbers.provision on an upgraded account", () => {
  it("buys one mobile for texts and one local number per garage, in the garage's area, routed without ringing the garage", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });

    expect(summary).toMatchObject({ outcome: "checked", accountType: "Full", bought: 2, attached: 1, texting: "ready", held: 3, stopped: null });
    const [mobile, inService, local] = client.state.mutations;
    expect(mobile).toEqual({ op: "buy", sid: expect.stringMatching(/^PN[0-9a-f]{32}$/), phoneNumber: MOBILES[0], friendlyName: TEXTING_NUMBER_NAME, voiceUrl: VOICE_URL, bundleSid: MOCK_MOBILE_BUNDLE_SID, addressSid: MOCK_ADDRESS_SID });
    expect(inService).toEqual({ op: "addToService", sid: mobile!.op === "buy" ? mobile!.sid : "" });
    expect(local).toMatchObject({ op: "buy", phoneNumber: SHEFFIELD[0], friendlyName: deskNumberName(GARAGE_A), voiceUrl: VOICE_URL, bundleSid: MOCK_LOCAL_BUNDLE_SID, addressSid: MOCK_ADDRESS_SID });
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "ready", number: SHEFFIELD[0] });
    expect(store.routing.get(SHEFFIELD[0]!)).toEqual({ garageId: GARAGE_A, sid: expect.any(String), ringGarageFirst: false });
    expect(store.platform).toMatchObject({ textingStatus: "ready", textingNumber: MOBILES[0], numbersHeld: 3 });
  });

  it("is idempotent: a second run buys nothing and changes nothing", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });
    const before = client.state.mutations.length;
    const again = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });
    expect(again).toMatchObject({ bought: 0, attached: 0, texting: "ready" });
    expect(client.state.mutations).toHaveLength(before);
    expect(store.attachCalls).toHaveLength(1);
    // A garage-only run for a garage that is ready asks Twilio nothing at all.
    client.state.calls.length = 0;
    await expect(provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } })).resolves.toMatchObject({ outcome: "nothing_due" });
    expect(client.state.calls).toEqual([]);
  });

  it("falls back to any UK local number when the garage's area has none", async () => {
    const client = fullAccount();
    const store = memoryRepo([{ id: GARAGE_B, phone: "+441302000101" }]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_B } });
    expect(store.states.get(GARAGE_B)).toMatchObject({ status: "ready", number: SHEFFIELD[0] });
    const doncaster = memoryRepo([{ id: GARAGE_B, phone: "+441302000101" }]);
    const onlyAnywhere = fullAccount({ available: { mobile: MOBILES, local: ANYWHERE } });
    await provisionNumbers({ client: onlyAnywhere, repo: doncaster.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_B } });
    expect(doncaster.states.get(GARAGE_B)).toMatchObject({ status: "ready", number: ANYWHERE[0] });
  });

  it("buys the texting mobile only when the Messaging Service has no number that can text", async () => {
    const existing = { sid: mockNumberSid(9_000_003), phoneNumber: "+447700900399", friendlyName: "Bought by hand", sms: true, voice: true };
    const withTexting = fullAccount({ owned: [platformLine, existing], inService: [existing.sid] });
    const store = memoryRepo([]);
    await expect(provisionNumbers({ client: withTexting, repo: store.repo, config: config(), scope: ALL })).resolves.toMatchObject({ texting: "ready", bought: 0 });
    expect(store.platform).toMatchObject({ textingStatus: "ready", textingNumber: existing.phoneNumber, textingSid: existing.sid });
    expect(withTexting.state.mutations).toEqual([]);

    // A voice-only number in the service (a landline) does not text: the mobile is bought.
    const landline = { sid: mockNumberSid(9_000_004), phoneNumber: "+441632960998", friendlyName: "Landline", sms: false, voice: true };
    const voiceOnly = fullAccount({ owned: [platformLine, landline], inService: [landline.sid] });
    await provisionNumbers({ client: voiceOnly, repo: memoryRepo([]).repo, config: config(), scope: ALL });
    expect(voiceOnly.state.mutations.map((mutation) => mutation.op)).toEqual(["buy", "addToService"]);
  });

  it("adds a texting number bought earlier (by name) to the service instead of buying another", async () => {
    const earlier = { sid: mockNumberSid(9_000_005), phoneNumber: "+447700900398", friendlyName: TEXTING_NUMBER_NAME, sms: true, voice: true };
    const client = fullAccount({ owned: [platformLine, earlier] });
    const store = memoryRepo([]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });
    expect(client.state.mutations).toEqual([{ op: "addToService", sid: earlier.sid }]);
    expect(store.platform.textingStatus).toBe("ready");
  });

  it("finds a garage number whose purchase was never recorded (by name) instead of buying a second", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage]);
    store.failAttachOnce();
    await expect(provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } })).rejects.toThrow("database unavailable");
    expect(client.state.mutations.filter((mutation) => mutation.op === "buy")).toHaveLength(1);

    const retry = await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(retry).toMatchObject({ bought: 0, attached: 1 });
    expect(client.state.mutations.filter((mutation) => mutation.op === "buy")).toHaveLength(1);
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "ready", number: SHEFFIELD[0] });
  });

  it("routes a bought number again when its routing row has gone, without asking Twilio", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    store.routing.clear();
    client.state.calls.length = 0;
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(summary).toMatchObject({ bought: 0, attached: 1 });
    expect(client.state.calls).toEqual([]);
    expect(store.routing.get(SHEFFIELD[0]!)).toMatchObject({ garageId: GARAGE_A, ringGarageFirst: false });
  });

  it("marks a garage that already has a routed number ready with it, keeping how that number rings", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage]);
    const handSid = mockNumberSid(9_000_006);
    store.routing.set("+447700900397", { garageId: GARAGE_A, sid: handSid, ringGarageFirst: true });
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(store.attachCalls).toEqual([{ garageId: GARAGE_A, number: "+447700900397", sid: handSid, ringGarageFirst: null }]);
    expect(store.routing.get("+447700900397")?.ringGarageFirst).toBe(true);
    expect(client.state.mutations).toEqual([]);
  });

  it("only a garage run's own garage is looked at, and it never buys the texting number", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage, { id: GARAGE_B, phone: null }]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(summary).toMatchObject({ texting: "skipped", bought: 1 });
    expect(store.states.has(GARAGE_B)).toBe(false);
    expect(client.state.calls).not.toContain("listServiceNumbers");
  });

  it("tries the next number when one was just sold to someone else (21422)", async () => {
    const client = fullAccount({ failures: { buyNumber: [new TwilioNumbersError("number_unavailable", "Twilio buy number: HTTP 400 21422", { providerCode: 21422, httpStatus: 400 })] } });
    const store = memoryRepo([sheffieldGarage]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "ready", number: SHEFFIELD[1] });
  });

  it("records a failure with its reason when Twilio has no number to sell, and tries again next run", async () => {
    const client = fullAccount({ available: { mobile: [], local: [] } });
    const store = memoryRepo([sheffieldGarage]);
    await expect(provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL })).resolves.toMatchObject({ failed: 1, texting: "failed" });
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "failed", reason: "no_numbers_available" });
    expect(store.platform).toMatchObject({ textingStatus: "failed", textingReason: "no_numbers_available" });
    // Still due the next day.
    expect(await store.repo.listDue()).toHaveLength(1);
  });

  it("turns an account-wide refusal at purchase into a state for everyone left (21404, 21631)", async () => {
    const trialAtPurchase = fullAccount({ failures: { buyNumber: [new TwilioNumbersError("trial_account", "Twilio buy number: HTTP 400 21404", { providerCode: 21404, httpStatus: 400 })] } });
    const store = memoryRepo([sheffieldGarage, { id: GARAGE_B, phone: null }]);
    await provisionNumbers({ client: trialAtPurchase, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(store.states.get(GARAGE_A)?.status).toBe("waiting_upgrade");

    const noAddress = fullAccount({ failures: { buyNumber: [new TwilioNumbersError("address_required", "Twilio buy number: HTTP 400 21631", { providerCode: 21631, httpStatus: 400 })] } });
    const both = memoryRepo([sheffieldGarage, { id: GARAGE_B, phone: null }]);
    const summary = await provisionNumbers({ client: noAddress, repo: both.repo, config: config({ platformNumbers: new Set() }), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(summary.failed).toBe(1);
    expect(both.states.get(GARAGE_A)).toMatchObject({ status: "failed", reason: "twilio:21631" });
    expect(noAddress.state.calls.filter((call) => call === "buyNumber")).toHaveLength(1);
  });
});

describe("numbers.provision never touches Autofix's own line (A420)", () => {
  it("does not count it as the texting number or adopt it, even in the service with SMS and our name", async () => {
    const disguised = { ...platformLine, friendlyName: TEXTING_NUMBER_NAME, sms: true };
    // Sheffield's drama range shares 0114 with the platform line: it is offered first, and skipped.
    const client = fullAccount({ owned: [disguised], inService: [disguised.sid], available: { mobile: [...MOBILES], local: [PLATFORM_LINE, ...ANYWHERE] } });
    const store = memoryRepo([sheffieldGarage]);
    // The garage was once routed to the platform line by hand (D22 removed that): it is not its AI desk number.
    store.routing.set(PLATFORM_LINE, { garageId: GARAGE_A, sid: PLATFORM_SID, ringGarageFirst: true });
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });

    expect(summary.texting).toBe("ready");
    expect(store.platform.textingNumber).toBe(MOBILES[0]);
    const touched = client.state.mutations.flatMap((mutation) => (mutation.op === "buy" ? [mutation.sid, mutation.phoneNumber] : [mutation.sid]));
    expect(touched).not.toContain(PLATFORM_LINE);
    expect(touched).not.toContain(PLATFORM_SID);
    expect(store.attachCalls.map((call) => call.number)).not.toContain(PLATFORM_LINE);
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "ready", number: ANYWHERE[0] });
    expect(store.routing.get(PLATFORM_LINE)).toEqual({ garageId: GARAGE_A, sid: PLATFORM_SID, ringGarageFirst: true });
  });

  it("does not adopt it as a garage's desk number either", async () => {
    const client = fullAccount({ owned: [{ ...platformLine, friendlyName: deskNumberName(GARAGE_A) }] });
    const store = memoryRepo([sheffieldGarage]);
    await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(store.attachCalls.map((call) => call.number)).toEqual([SHEFFIELD[0]]);
    expect(client.state.mutations.map((mutation) => mutation.op)).toEqual(["buy"]);
  });
});

describe("numbers.provision when Twilio is busy, down or slow", () => {
  it("stops on a rate limit without changing the garage's state (the job re-queues itself)", async () => {
    const client = fullAccount({ failures: { buyNumber: [new TwilioNumbersError("rate_limited", "Twilio buy number: HTTP 429 20429", { providerCode: 20429, httpStatus: 429, retryAfterMs: 30_000 })] } });
    const store = memoryRepo([sheffieldGarage]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(summary).toMatchObject({ outcome: "stopped", stopped: { reason: "rate_limited", retryAfterMs: 30_000 }, bought: 0 });
    expect(store.states.has(GARAGE_A)).toBe(false);
  });

  it("stops on Twilio being down while reading the account", async () => {
    const client = fullAccount({ failures: { getAccount: [new TwilioNumbersError("provider_error", "Twilio account: HTTP 503", { httpStatus: 503 })] } });
    const store = memoryRepo([sheffieldGarage]);
    await expect(provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL })).resolves.toMatchObject({ stopped: { reason: "provider_error" } });
  });

  it("an unconfirmed purchase waits for the next run, which finds the number by name", async () => {
    const client = fullAccount({ failures: { buyNumber: [new TwilioNumbersError("timeout", "Twilio buy number: timed out")] } });
    const store = memoryRepo([sheffieldGarage]);
    const first = await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(first.stopped?.reason).toBe("unconfirmed");
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "pending", reason: "purchase_unconfirmed" });
    // Twilio had sold it after all.
    client.state.owned.push({ sid: mockNumberSid(9_000_008), phoneNumber: SHEFFIELD[0]!, friendlyName: deskNumberName(GARAGE_A), sms: false, voice: true });
    const second = await provisionNumbers({ client, repo: store.repo, config: config(), scope: { kind: "garage", garageId: GARAGE_A } });
    expect(second).toMatchObject({ bought: 0, attached: 1 });
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "ready", number: SHEFFIELD[0] });
  });

  it("starts no purchase without time left before the job's deadline", async () => {
    const client = fullAccount();
    const store = memoryRepo([sheffieldGarage]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL, canStartPurchase: () => false });
    expect(summary).toMatchObject({ stopped: { reason: "deadline" }, bought: 0 });
    expect(client.state.mutations).toEqual([]);
  });

  it("records a refusal of a read (bad credentials) once instead of looping on it", async () => {
    const client = fullAccount({ failures: { listNumbers: [new TwilioNumbersError("configuration_required", "Twilio numbers: HTTP 401 20003", { providerCode: 20003, httpStatus: 401 })] } });
    const store = memoryRepo([sheffieldGarage]);
    const summary = await provisionNumbers({ client, repo: store.repo, config: config(), scope: ALL });
    expect(summary.stopped).toBeNull();
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "not_configured", reason: "twilio:20003" });
    expect(store.platform).toMatchObject({ textingStatus: "not_configured", textingReason: "twilio:20003" });
  });

  it("records not configured (with a reason) when there is no client or no https origin", async () => {
    const store = memoryRepo([sheffieldGarage]);
    await expect(provisionNumbers({ client: null, unconfiguredReason: "mode_not_live", repo: store.repo, config: config(), scope: ALL })).resolves.toMatchObject({ outcome: "not_configured" });
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "not_configured", reason: "mode_not_live" });
    const client = fullAccount();
    await provisionNumbers({ client, repo: store.repo, config: config({ voiceUrl: null }), scope: ALL });
    expect(store.states.get(GARAGE_A)).toMatchObject({ status: "not_configured", reason: "no_webhook_origin" });
    expect(client.state.calls).toEqual([]);
  });
});

describe("area codes and configuration", () => {
  it.each([
    ["+441302000101", "1302"],
    ["01302 000101", "1302"],
    ["+441144960001", "114"],
    ["0121 496 0000", "121"],
    ["+442079460000", "20"],
    ["+441632960001", "1632"],
    ["+447700900123", null],
    ["+443001234567", null],
    [null, null],
  ])("%s has area code %s", (phone, area) => {
    expect(ukAreaCode(phone)).toBe(area);
  });

  it("searches from the start of the number", () => {
    expect(areaCodePattern("1302")).toBe("+441302");
  });

  it("reads the cap (default 20) and the https voice webhook", () => {
    expect(numberCap({})).toBe(DEFAULT_NUMBER_CAP);
    expect(numberCap({ TWILIO_NUMBER_CAP: "5" })).toBe(5);
    expect(numberCap({ TWILIO_NUMBER_CAP: "0" })).toBe(0);
    for (const bad of ["-1", "2.5", "lots", "5000"]) expect(numberCap({ TWILIO_NUMBER_CAP: bad })).toBe(DEFAULT_NUMBER_CAP);
    expect(voiceWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: "https://autofix.vitalos.co.uk/" })).toBe(VOICE_URL);
    expect(voiceWebhookUrl({ NEXT_PUBLIC_SITE_URL: "https://autofix.vitalos.co.uk" })).toBe(VOICE_URL);
    expect(voiceWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: "http://localhost:3000", NEXT_PUBLIC_SITE_URL: "https://autofix.vitalos.co.uk" })).toBe(VOICE_URL);
    expect(voiceWebhookUrl({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })).toBeNull();
    expect(readNumbersConfig({ AUTOFIX_PLATFORM_VOICE_NUMBERS: `${PLATFORM_LINE}, nonsense` }).platformNumbers).toEqual(new Set([PLATFORM_LINE]));
  });

  it("names numbers within Twilio's 64 characters", () => {
    expect(deskNumberName(GARAGE_A).length).toBeLessThanOrEqual(64);
  });
});
