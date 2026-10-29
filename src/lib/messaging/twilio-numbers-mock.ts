// In-memory Twilio numbers client (D22) for dev, preview and tests. It never calls Twilio. Out of the box it
// is a trial account with no bundles, which is what the real account is today, so the provisioning step only
// records "waiting for the upgrade". Tests build richer accounts with options and read `state` afterwards:
// every purchase and every Messaging Service change is in `state.mutations`.
//
// Numbers it offers come from Ofcom's drama ranges (never allocated to anyone): mobiles 07700 900xxx,
// geographic 01632 960xxx and the city ranges such as 0114 496 0xxx.

import {
  TwilioNumbersError,
  type AvailableNumber,
  type BuyNumberInput,
  type NumberKind,
  type OwnedNumber,
  type ServiceNumber,
  type TwilioNumbersClient,
} from "./twilio-numbers-contract";

export type MockTwilioNumbersOptions = {
  /** Default `Trial`. */
  accountType?: string;
  /** Default `active`. */
  accountStatus?: string;
  /** Approved GB bundles: mobile (any end user) and local (business). Default none. */
  bundles?: { mobile?: boolean; local?: boolean };
  /** A GB address on the account. Default false. */
  address?: boolean;
  /** Numbers the account already holds. */
  owned?: OwnedNumber[];
  /** SIDs of owned numbers already in the Messaging Service. */
  inService?: string[];
  /** Numbers Twilio would sell, E.164. Default: none. */
  available?: { mobile?: string[]; local?: string[] };
  /** Make a call fail (once per entry, in order). */
  failures?: Partial<Record<"getAccount" | "listNumbers" | "listServiceNumbers" | "searchAvailable" | "buyNumber" | "addToService", TwilioNumbersError[]>>;
  /** SIDs for the numbers it sells, in order (then a process-wide counter). */
  sids?: string[];
};

export type MockMutation =
  | { op: "buy"; sid: string; phoneNumber: string; friendlyName: string; voiceUrl: string; bundleSid: string; addressSid: string | null }
  | { op: "addToService"; sid: string };

export type MockTwilioNumbersState = {
  owned: OwnedNumber[];
  inService: Set<string>;
  available: { mobile: string[]; local: string[] };
  mutations: MockMutation[];
  /** Every call by name, in order (reads too). */
  calls: string[];
};

export type MockTwilioNumbersClient = TwilioNumbersClient & { readonly state: MockTwilioNumbersState };

export const MOCK_MOBILE_BUNDLE_SID = "BU00000000000000000000000000000001";
export const MOCK_LOCAL_BUNDLE_SID = "BU00000000000000000000000000000002";
export const MOCK_ADDRESS_SID = "AD00000000000000000000000000000001";

let sidCounter = 0;

/** A PN… SID shaped like Twilio's (PN + 32 hex). */
export function mockNumberSid(seed?: number): string {
  const value = seed ?? (sidCounter += 1);
  return `PN${value.toString(16).padStart(32, "0")}`;
}

const MOBILE = /^\+447/;

export function createMockTwilioNumbersClient(options: MockTwilioNumbersOptions = {}): MockTwilioNumbersClient {
  const state: MockTwilioNumbersState = {
    owned: (options.owned ?? []).map((number) => ({ ...number })),
    inService: new Set(options.inService ?? []),
    available: { mobile: [...(options.available?.mobile ?? [])], local: [...(options.available?.local ?? [])] },
    mutations: [],
    calls: [],
  };
  const failures = Object.fromEntries(Object.entries(options.failures ?? {}).map(([key, list]) => [key, [...(list ?? [])]])) as NonNullable<MockTwilioNumbersOptions["failures"]>;
  const accountType = options.accountType ?? "Trial";
  const sids = [...(options.sids ?? [])];

  function enter(name: keyof NonNullable<MockTwilioNumbersOptions["failures"]> | "findApprovedBundle" | "findAddress") {
    state.calls.push(name);
    const queued = (failures as Record<string, TwilioNumbersError[] | undefined>)[name];
    const failure = queued?.shift();
    if (failure) throw failure;
  }

  const bundleFor = (kind: NumberKind) => (kind === "mobile" ? (options.bundles?.mobile ? MOCK_MOBILE_BUNDLE_SID : null) : options.bundles?.local ? MOCK_LOCAL_BUNDLE_SID : null);

  return {
    mode: "mock",
    state,

    async getAccount() {
      enter("getAccount");
      return { type: accountType, status: options.accountStatus ?? "active" };
    },

    async listNumbers() {
      enter("listNumbers");
      return state.owned.map((number) => ({ ...number }));
    },

    async listServiceNumbers(): Promise<ServiceNumber[]> {
      enter("listServiceNumbers");
      return state.owned
        .filter((number) => state.inService.has(number.sid))
        .map((number) => ({ sid: number.sid, phoneNumber: number.phoneNumber, capabilities: [...(number.sms ? ["SMS"] : []), ...(number.voice ? ["Voice"] : [])] }));
    },

    async findApprovedBundle(kind, endUserType) {
      enter("findApprovedBundle");
      if (kind === "local" && endUserType !== "business") return null;
      return bundleFor(kind);
    },

    async findAddress() {
      enter("findAddress");
      return options.address ? MOCK_ADDRESS_SID : null;
    },

    async searchAvailable(kind, search = {}): Promise<AvailableNumber[]> {
      enter("searchAvailable");
      const pattern = search.contains ?? "";
      const matches = (number: string) => !pattern || (pattern.startsWith("+") ? number.startsWith(pattern) : number.includes(pattern));
      return state.available[kind]
        .filter(matches)
        .filter(() => !search.sms || kind === "mobile")
        .slice(0, search.limit ?? 5)
        .map((phoneNumber) => ({ phoneNumber, sms: kind === "mobile", voice: true, addressRequirements: kind === "mobile" ? "any" : "local" }));
    },

    async buyNumber(input: BuyNumberInput) {
      enter("buyNumber");
      if (accountType !== "Full") throw new TwilioNumbersError("trial_account", "Twilio buy number: HTTP 400 21404", { providerCode: 21404, httpStatus: 400 });
      const kind: NumberKind = MOBILE.test(input.phoneNumber) ? "mobile" : "local";
      if (input.bundleSid !== bundleFor(kind)) throw new TwilioNumbersError("bundle_required", "Twilio buy number: HTTP 400 21649", { providerCode: 21649, httpStatus: 400 });
      const index = state.available[kind].indexOf(input.phoneNumber);
      if (index < 0) throw new TwilioNumbersError("number_unavailable", "Twilio buy number: HTTP 400 21422", { providerCode: 21422, httpStatus: 400 });
      state.available[kind].splice(index, 1);
      const bought: OwnedNumber = { sid: sids.shift() ?? mockNumberSid(), phoneNumber: input.phoneNumber, friendlyName: input.friendlyName.slice(0, 64), sms: kind === "mobile", voice: true };
      state.owned.push(bought);
      state.mutations.push({ op: "buy", sid: bought.sid, phoneNumber: bought.phoneNumber, friendlyName: bought.friendlyName, voiceUrl: input.voiceUrl, bundleSid: input.bundleSid, addressSid: input.addressSid ?? null });
      return { ...bought };
    },

    async addToService(numberSid) {
      enter("addToService");
      const number = state.owned.find((candidate) => candidate.sid === numberSid);
      if (!number) throw new TwilioNumbersError("refused", "Twilio add to service: HTTP 404", { httpStatus: 404 });
      if (state.inService.has(numberSid)) throw new TwilioNumbersError("refused", "Twilio add to service: HTTP 409", { httpStatus: 409 });
      state.inService.add(numberSid);
      state.mutations.push({ op: "addToService", sid: numberSid });
    },
  };
}
