// Number provisioning (D22, DECISIONS A431–A438): the step that makes Autofix's Twilio numbers appear by
// themselves once the account is upgraded. Run by the `numbers.provision` job (daily, and at once when an
// owner switches the AI front desk on); this module holds the decisions, against two interfaces: the Twilio
// numbers client (live or mock) and the store (Supabase, or a fake in tests).
//
// A. One UK mobile for texts (platform run only). Texts go out through the Messaging Service, so it needs one
//    SMS-capable number. Bought only when the service has none (a re-run never buys a second), and only with an
//    approved GB mobile regulatory bundle. Its calls and call status point at the voice webhook.
// B. One UK local number per Pro garage with the AI front desk on and no routed number. In the garage's area
//    code when Twilio has one there (from the garage's phone), else any UK local number, with an approved GB
//    local business bundle. It is routed to the garage with ring_garage_first = false: the garage's own phone
//    forwards missed calls to it, so it never rings that phone back (A432).
//
// Order and guards, every run:
//   1. Settle what needs no purchase: a garage that already has a routed number is marked ready with it; a
//      number bought earlier whose routing row has gone is routed again (never a second purchase, A434).
//   2. Account: not `Full` (a trial) -> everyone waiting is recorded `waiting_upgrade` and nothing else
//      happens. Not active -> `failed`.
//   3. Count every number the account holds. At or over TWILIO_NUMBER_CAP -> `cap_reached`, nothing bought.
//   4. A number bought by an earlier run that could not record it is found again by its FriendlyName
//      (`Autofix texts`, `Autofix desk <garage id>`) and used instead of buying again.
//   5. No approved bundle -> `waiting_bundle`.
//   6. Buy, route, record. Purchases are never retried in the same run; a 429/5xx stops the run (the job
//      re-queues itself a bounded number of times), an unconfirmed purchase is found by name next time.
// Autofix's own line (AUTOFIX_PLATFORM_VOICE_NUMBERS, A420) is never bought, adopted, routed, counted as a
// texting number or changed. Nothing is ever released or deleted (A436).

import type { JobLogger } from "@/lib/jobs/types";
import {
  isTwilioNumbersError,
  type AvailableNumber,
  type OwnedNumber,
  type TwilioNumbersClient,
  type TwilioNumbersError,
} from "@/lib/messaging/twilio-numbers-contract";
import { areaCodePattern, ukAreaCode } from "./area-code";
import type { NumbersConfig } from "./config";
import type { NumberStatus, WaitingStatus } from "./state";

/** FriendlyName of the texting number (the same name Launch ops `twilio-buy-mobile` uses). */
export const TEXTING_NUMBER_NAME = "Autofix texts";
/** FriendlyName of a garage's AI desk number: 13 + 36 characters, inside Twilio's 64. */
export function deskNumberName(garageId: string): string {
  return `Autofix desk ${garageId}`;
}

const PN_SID = /^PN[0-9a-fA-F]{32}$/;
/** Numbers asked for per search; the next is tried when one has just been sold to someone else (21422). */
const CANDIDATES = 3;

/** A garage whose AI desk needs a number (ai_front_desk_numbers_due()). */
export type DueGarage = {
  garageId: string;
  garagePhone: string | null;
  status: NumberStatus | null;
  /** The number recorded as bought for this garage, if any. */
  providerSid: string | null;
  number: string | null;
  /** A number already routed to the garage (garage_phone_numbers with provider_sid). */
  routedNumber: string | null;
  routedSid: string | null;
};

export type AttachResult = "ready" | "number_taken" | "already_provisioned";

export type PlatformPatch = {
  accountType?: string | null;
  numbersHeld?: number | null;
  numberCap?: number | null;
  textingStatus?: NumberStatus;
  textingReason?: string | null;
  textingNumber?: string | null;
  textingSid?: string | null;
};

/** The store. `createSupabaseNumbersRepo` is the real one. */
export interface NumbersRepo {
  listDue(garageId?: string): Promise<DueGarage[]>;
  /** Routes the number to the garage and marks it ready (one transaction). */
  attach(garageId: string, number: string, providerSid: string, ringGarageFirst: boolean | null): Promise<AttachResult>;
  setStatus(garageIds: string[], status: WaitingStatus, reason: string | null): Promise<void>;
  recordPlatform(patch: PlatformPatch): Promise<void>;
  claimLease(holder: string, seconds: number): Promise<boolean>;
  releaseLease(holder: string): Promise<void>;
}

export type ProvisionScope = { kind: "all" } | { kind: "garage"; garageId: string };

export type StopReason = "rate_limited" | "provider_error" | "deadline" | "unconfirmed";

export type ProvisionSummary = {
  outcome: "nothing_due" | "waiting_upgrade" | "account_inactive" | "not_configured" | "checked" | "stopped";
  accountType: string | null;
  held: number | null;
  bought: number;
  attached: number;
  waiting: number;
  failed: number;
  texting: NumberStatus | "skipped";
  stopped: { reason: StopReason; retryAfterMs: number | null } | null;
};

export type ProvisionInput = {
  /** Null when the client is not configured here: garages are recorded `not_configured` with `unconfiguredReason`. */
  client: TwilioNumbersClient | null;
  unconfiguredReason?: string;
  repo: NumbersRepo;
  config: NumbersConfig;
  scope: ProvisionScope;
  /** False once there is no time left to start a purchase (the job's deadline). Default: always true. */
  canStartPurchase?: () => boolean;
  log?: JobLogger;
};

/** Ends the run early without failing it (rate limit, Twilio down, out of time, an unconfirmed purchase). */
class Stop extends Error {
  constructor(readonly reason: StopReason, readonly retryAfterMs: number | null) {
    super(reason);
  }
}

/** Transient Twilio failures stop the run; a purchase that timed out is `unconfirmed` (it may have gone through). */
function stopFor(error: TwilioNumbersError, buying = false): Stop | null {
  if (error.kind === "rate_limited") return new Stop("rate_limited", error.retryAfterMs);
  if (error.kind === "provider_error") return new Stop("provider_error", error.retryAfterMs);
  if (error.kind === "timeout") return new Stop(buying ? "unconfirmed" : "provider_error", null);
  return null;
}

/** The state for everyone still waiting when Twilio refuses for an account-wide reason, else null. */
function accountWide(error: TwilioNumbersError): { status: WaitingStatus; reason: string | null } | null {
  switch (error.kind) {
    case "trial_account":
      return { status: "waiting_upgrade", reason: null };
    case "bundle_required":
      return { status: "waiting_bundle", reason: error.reason };
    case "configuration_required":
      return { status: "not_configured", reason: error.reason };
    case "address_required":
      return { status: "failed", reason: error.reason };
    default:
      return null;
  }
}

type GarageOutcome = "next" | { status: WaitingStatus; reason: string | null };

class ProvisionRun {
  readonly summary: ProvisionSummary;
  private readonly settled = new Set<string>();
  private readonly platformRun: boolean;
  private client!: TwilioNumbersClient;
  private owned: OwnedNumber[] = [];
  private held = 0;
  private address: string | null | undefined;

  constructor(private readonly input: ProvisionInput, private readonly voiceUrl: string) {
    this.platformRun = input.scope.kind === "all";
    this.summary = {
      outcome: "checked",
      accountType: null,
      held: null,
      bought: 0,
      attached: 0,
      waiting: 0,
      failed: 0,
      texting: this.platformRun ? "pending" : "skipped",
      stopped: null,
    };
  }

  private isPlatform(number: string | null | undefined) {
    return Boolean(number && this.input.config.platformNumbers.has(number));
  }

  async setStatus(garages: DueGarage[], status: WaitingStatus, reason: string | null) {
    const open = garages.filter((garage) => !this.settled.has(garage.garageId));
    if (!open.length) return;
    await this.input.repo.setStatus(open.map((garage) => garage.garageId), status, reason);
    for (const garage of open) this.settled.add(garage.garageId);
    if (status === "failed") this.summary.failed += open.length;
    else this.summary.waiting += open.length;
  }

  async attach(garage: DueGarage, number: string, sid: string, ringGarageFirst: boolean | null) {
    const result = await this.input.repo.attach(garage.garageId, number, sid, ringGarageFirst);
    if (result !== "ready") return this.setStatus([garage], "failed", result);
    this.settled.add(garage.garageId);
    this.summary.attached += 1;
  }

  async setTexting(status: NumberStatus, reason: string | null = null, number?: { phoneNumber: string; sid: string }) {
    this.summary.texting = status;
    await this.input.repo.recordPlatform({
      textingStatus: status,
      textingReason: reason,
      ...(number ? { textingNumber: number.phoneNumber, textingSid: PN_SID.test(number.sid) ? number.sid : null } : {}),
    });
  }

  private ownedByName(name: string) {
    return this.owned.find((number) => number.friendlyName === name && !this.isPlatform(number.phoneNumber) && PN_SID.test(number.sid));
  }

  private async addressSid() {
    if (this.address === undefined) this.address = await this.client.findAddress();
    return this.address;
  }

  private canStartPurchase() {
    return this.input.canStartPurchase ? this.input.canStartPurchase() : true;
  }

  /** Buys one number; counts it at once so the cap holds within the run. */
  private async buy(phoneNumber: string, friendlyName: string, bundleSid: string): Promise<OwnedNumber> {
    const number = await this.client.buyNumber({ phoneNumber, friendlyName, voiceUrl: this.voiceUrl, bundleSid, addressSid: await this.addressSid() });
    this.held += 1;
    this.owned.push(number);
    this.summary.held = this.held;
    this.summary.bought += 1;
    this.input.log?.info("number_bought", { purpose: friendlyName === TEXTING_NUMBER_NAME ? "texting" : "ai_desk" });
    await this.input.repo.recordPlatform({ numbersHeld: this.held });
    return number;
  }

  async run(client: TwilioNumbersClient, due: DueGarage[]): Promise<ProvisionSummary> {
    const { repo, config } = this.input;
    this.client = client;

    // 2. The account. A trial records "waiting for the upgrade" and does nothing else.
    const account = await client.getAccount();
    this.summary.accountType = account.type;
    if (account.status !== "active") {
      const reason = `account_${account.status.toLowerCase().replace(/[^a-z]/g, "") || "unknown"}`;
      await this.setStatus(due, "failed", reason);
      if (this.platformRun) await this.setTexting("failed", reason);
      await repo.recordPlatform({ accountType: account.type, numberCap: config.cap });
      this.summary.outcome = "account_inactive";
      return this.summary;
    }
    if (account.type !== "Full") {
      await this.setStatus(due, "waiting_upgrade", null);
      if (this.platformRun) await this.setTexting("waiting_upgrade");
      await repo.recordPlatform({ accountType: account.type, numberCap: config.cap });
      this.summary.outcome = "waiting_upgrade";
      return this.summary;
    }

    // 3. Everything the account holds, for the cap and to find numbers bought by an earlier run.
    this.owned = await client.listNumbers();
    this.held = this.owned.length;
    this.summary.held = this.held;
    await repo.recordPlatform({ accountType: account.type, numbersHeld: this.held, numberCap: config.cap });

    if (this.platformRun) await this.textingNumber();
    await this.deskNumbers(due);
    return this.summary;
  }

  /** A. The Messaging Service's texting number. */
  private async textingNumber() {
    const { client } = this;
    const { config } = this.input;
    const service = await client.listServiceNumbers();
    const texting = service.find((number) => number.capabilities.some((capability) => capability.toUpperCase() === "SMS") && !this.isPlatform(number.phoneNumber));
    if (texting) return this.setTexting("ready", null, texting);

    // Bought before (by an earlier run or Launch ops) but not in the service: add it rather than buy again.
    const named = this.ownedByName(TEXTING_NUMBER_NAME);
    if (named?.sms) return this.addToService(named);

    const bundle = await client.findApprovedBundle("mobile");
    if (!bundle) return this.setTexting("waiting_bundle");
    if (this.held >= config.cap) return this.setTexting("cap_reached");
    if (!this.canStartPurchase()) throw new Stop("deadline", null);

    const candidates = (await client.searchAvailable("mobile", { sms: true, limit: CANDIDATES }))
      .filter((number) => number.sms && number.voice && !this.isPlatform(number.phoneNumber));
    for (const candidate of candidates) {
      let number: OwnedNumber;
      try {
        number = await this.buy(candidate.phoneNumber, TEXTING_NUMBER_NAME, bundle);
      } catch (error) {
        if (!isTwilioNumbersError(error)) throw error;
        if (error.kind === "number_unavailable") continue;
        const stop = stopFor(error, true);
        if (stop?.reason === "unconfirmed") await this.setTexting("pending", "purchase_unconfirmed");
        if (stop) throw stop;
        const wide = accountWide(error);
        return this.setTexting(wide?.status ?? "failed", wide ? wide.reason : error.reason);
      }
      return this.addToService(number);
    }
    return this.setTexting("failed", "no_numbers_available");
  }

  private async addToService(number: OwnedNumber) {
    try {
      await this.client.addToService(number.sid);
    } catch (error) {
      if (!isTwilioNumbersError(error)) throw error;
      const stop = stopFor(error);
      if (stop) throw stop;
      // The number stays on the account; the next run finds it by name and tries the service again.
      return this.setTexting("failed", `service_${error.reason}`.replace(/[^a-z0-9_.:-]/g, "_").slice(0, 80));
    }
    return this.setTexting("ready", null, number);
  }

  /** B. One number per garage that still needs one. */
  private async deskNumbers(due: DueGarage[]) {
    const { client } = this;
    const { config } = this.input;
    const toBuy: DueGarage[] = [];
    for (const garage of due) {
      const found = this.ownedByName(deskNumberName(garage.garageId));
      if (found) await this.attach(garage, found.phoneNumber, found.sid, false);
      else toBuy.push(garage);
    }
    if (!toBuy.length) return;

    const bundle = await client.findApprovedBundle("local", "business");
    if (!bundle) return this.setStatus(toBuy, "waiting_bundle", null);

    for (let index = 0; index < toBuy.length; index += 1) {
      const rest = toBuy.slice(index);
      if (this.held >= config.cap) return this.setStatus(rest, "cap_reached", null);
      if (!this.canStartPurchase()) throw new Stop("deadline", null);
      const outcome = await this.buyForGarage(toBuy[index]!, bundle);
      if (outcome !== "next") return this.setStatus(rest, outcome.status, outcome.reason);
    }
  }

  private async buyForGarage(garage: DueGarage, bundle: string): Promise<GarageOutcome> {
    for (const candidate of await this.localCandidates(garage)) {
      let number: OwnedNumber;
      try {
        number = await this.buy(candidate.phoneNumber, deskNumberName(garage.garageId), bundle);
      } catch (error) {
        if (!isTwilioNumbersError(error)) throw error;
        if (error.kind === "number_unavailable") continue;
        const stop = stopFor(error, true);
        // Twilio may have sold it: the next run finds it by name instead of buying another.
        if (stop?.reason === "unconfirmed") await this.setStatus([garage], "pending", "purchase_unconfirmed");
        if (stop) throw stop;
        const wide = accountWide(error);
        if (wide) return wide;
        await this.setStatus([garage], "failed", error.reason);
        return "next";
      }
      await this.attach(garage, number.phoneNumber, number.sid, false);
      return "next";
    }
    await this.setStatus([garage], "failed", "no_numbers_available");
    return "next";
  }

  /** In the garage's area code first (from its phone), else any UK local number; voice only, never ours. */
  private async localCandidates(garage: DueGarage): Promise<AvailableNumber[]> {
    const { client } = this;
    const usable = (numbers: AvailableNumber[]) => numbers.filter((number) => number.voice && !this.isPlatform(number.phoneNumber));
    const area = ukAreaCode(garage.garagePhone);
    if (area) {
      const local = usable(await client.searchAvailable("local", { contains: areaCodePattern(area), limit: CANDIDATES }));
      if (local.length) return local;
    }
    return usable(await client.searchAvailable("local", { limit: CANDIDATES }));
  }

  /** Twilio refused a read for good (bad credentials, a wrong service): record it once, never loop on it. */
  async refused(error: TwilioNumbersError, due: DueGarage[]) {
    const wide = accountWide(error) ?? { status: "failed" as const, reason: error.reason };
    await this.setStatus(due, wide.status, wide.reason);
    if (this.platformRun && this.summary.texting === "pending") await this.setTexting(wide.status, wide.reason);
    this.input.log?.warn("numbers_provision_refused", { code: error.reason });
  }
}

/** The run. Twilio failures become states or a stop, never an exception; store errors propagate (job retry). */
export async function provisionNumbers(input: ProvisionInput): Promise<ProvisionSummary> {
  const { repo, config, scope } = input;
  const isPlatform = (number: string | null | undefined) => Boolean(number && config.platformNumbers.has(number));
  const run = new ProvisionRun(input, config.voiceUrl ?? "");

  // 1. Settle what needs no purchase.
  const due = await repo.listDue(scope.kind === "garage" ? scope.garageId : undefined);
  const needNumber: DueGarage[] = [];
  for (const garage of due) {
    if (garage.routedNumber && garage.routedSid && !isPlatform(garage.routedNumber) && PN_SID.test(garage.routedSid)) {
      await run.attach(garage, garage.routedNumber, garage.routedSid, null);
    } else if (garage.providerSid && garage.number && !isPlatform(garage.number)) {
      await run.attach(garage, garage.number, garage.providerSid, false);
    } else {
      needNumber.push(garage);
    }
  }
  if (scope.kind === "garage" && needNumber.length === 0) {
    run.summary.outcome = due.length ? "checked" : "nothing_due";
    return run.summary;
  }
  if (!input.client || !config.voiceUrl) {
    const reason = !input.client ? (input.unconfiguredReason ?? "not_configured") : "no_webhook_origin";
    await run.setStatus(needNumber, "not_configured", reason);
    if (scope.kind === "all") await run.setTexting("not_configured", reason);
    run.summary.outcome = "not_configured";
    return run.summary;
  }

  try {
    return await run.run(input.client, needNumber);
  } catch (error) {
    const stop = error instanceof Stop ? error : isTwilioNumbersError(error) ? stopFor(error) : null;
    if (stop) {
      run.summary.stopped = { reason: stop.reason, retryAfterMs: stop.retryAfterMs };
      run.summary.outcome = "stopped";
      input.log?.warn("numbers_provision_stopped", { reason: stop.reason });
      return run.summary;
    }
    if (isTwilioNumbersError(error)) {
      await run.refused(error, needNumber);
      return run.summary;
    }
    throw error;
  }
}
