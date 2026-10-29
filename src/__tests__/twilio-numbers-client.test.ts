import { describe, expect, it, vi } from "vitest";
import {
  createTwilioNumbersClient,
  getTwilioNumbersClient,
  getTwilioNumbersReadiness,
  mapTwilioNumbersError,
  sharedMockTwilioNumbersClient,
  TwilioNumbersError,
} from "@/lib/messaging/twilio-numbers";

// D22: the live Twilio numbers client against a fake fetch (nothing here reaches Twilio), and when the app
// may use it at all.

const ACCOUNT = `AC${"0123456789abcdef".repeat(2)}`;
const TOKEN = "twilio-numbers-test-token-0123456789";
const SERVICE = "MG0123456789abcdef0123456789abcdef";
const PN = "PN0123456789abcdef0123456789abcdef";

type Call = { url: string; method: string; body: string; authorization: string | null };

function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "", authorization: headers.get("authorization") });
    const next = queue.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function client(responses: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(responses);
  return { ...fake, client: createTwilioNumbersClient({ accountSid: ACCOUNT, authToken: TOKEN, messagingServiceSid: SERVICE, fetch: fake.fetchImpl, sleep: async () => undefined }) };
}

describe("live Twilio numbers client", () => {
  it("reads the account type with Basic auth and never puts the token in a URL or an error", async () => {
    const { calls, client: twilio } = client([{ body: { type: "Trial", status: "active" } }, { status: 401, body: { code: 20003, message: `Authenticate ${TOKEN}` } }]);
    await expect(twilio.getAccount()).resolves.toEqual({ type: "Trial", status: "active" });
    expect(calls[0]).toMatchObject({ url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}.json`, method: "GET" });
    expect(calls[0]!.authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
    const error = await twilio.getAccount().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TwilioNumbersError);
    expect(error).toMatchObject({ kind: "configuration_required", reason: "twilio:20003" });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
  });

  it("lists every number on the account across pages", async () => {
    const { calls, client: twilio } = client([
      { body: { incoming_phone_numbers: [{ sid: PN, phone_number: "+447700900301", friendly_name: "Autofix texts", capabilities: { sms: true, voice: true } }], next_page_uri: `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?Page=1&PageSize=1000` } },
      { body: { incoming_phone_numbers: [{ sid: PN.replace("PN0", "PN1"), phone_number: "+441146974393", friendly_name: "Line", capabilities: { sms: false, voice: true } }], next_page_uri: null } },
    ]);
    await expect(twilio.listNumbers()).resolves.toEqual([
      { sid: PN, phoneNumber: "+447700900301", friendlyName: "Autofix texts", sms: true, voice: true },
      { sid: PN.replace("PN0", "PN1"), phoneNumber: "+441146974393", friendlyName: "Line", sms: false, voice: true },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=1000`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?Page=1&PageSize=1000`,
    ]);
  });

  it("reads the Messaging Service's numbers with their capabilities array", async () => {
    const { calls, client: twilio } = client([{ body: { phone_numbers: [{ sid: PN, phone_number: "+447700900301", capabilities: ["SMS", "Voice"] }], meta: { next_page_url: null } } }]);
    await expect(twilio.listServiceNumbers()).resolves.toEqual([{ sid: PN, phoneNumber: "+447700900301", capabilities: ["SMS", "Voice"] }]);
    expect(calls[0]!.url).toBe(`https://messaging.twilio.com/v1/Services/${SERVICE}/PhoneNumbers?PageSize=1000`);
  });

  it("looks for an approved GB bundle by number type (and business for local numbers), and a GB address", async () => {
    const { calls, client: twilio } = client([
      { body: { results: [{ sid: "BU0123456789abcdef0123456789abcdef", status: "twilio-approved" }] } },
      { body: { results: [] } },
      { body: { addresses: [{ sid: "AD0123456789abcdef0123456789abcdef" }] } },
    ]);
    await expect(twilio.findApprovedBundle("local", "business")).resolves.toBe("BU0123456789abcdef0123456789abcdef");
    await expect(twilio.findApprovedBundle("mobile")).resolves.toBeNull();
    await expect(twilio.findAddress()).resolves.toBe("AD0123456789abcdef0123456789abcdef");
    expect(calls.map((call) => call.url)).toEqual([
      "https://numbers.twilio.com/v2/RegulatoryCompliance/Bundles?Status=twilio-approved&IsoCountry=GB&NumberType=local&PageSize=20&EndUserType=business",
      "https://numbers.twilio.com/v2/RegulatoryCompliance/Bundles?Status=twilio-approved&IsoCountry=GB&NumberType=mobile&PageSize=20",
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Addresses.json?IsoCountry=GB&PageSize=20`,
    ]);
  });

  it("searches GB local numbers from the start of an area code, and mobiles that text", async () => {
    const { calls, client: twilio } = client([
      { body: { available_phone_numbers: [{ phone_number: "+441302960001", address_requirements: "local", capabilities: { voice: true, sms: false } }] } },
      { body: { available_phone_numbers: [] } },
    ]);
    await expect(twilio.searchAvailable("local", { contains: "+441302", limit: 3 })).resolves.toEqual([{ phoneNumber: "+441302960001", sms: false, voice: true, addressRequirements: "local" }]);
    await twilio.searchAvailable("mobile", { sms: true });
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/AvailablePhoneNumbers/GB/Local.json?VoiceEnabled=true&PageSize=3&Contains=%2B441302`);
    expect(calls[1]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/AvailablePhoneNumbers/GB/Mobile.json?VoiceEnabled=true&PageSize=5&SmsEnabled=true`);
  });

  it("buys with the bundle, address, name and voice webhook, and adds a number to the service", async () => {
    const { calls, client: twilio } = client([
      { status: 201, body: { sid: PN, phone_number: "+447700900301", friendly_name: "Autofix texts", capabilities: { sms: true, voice: true } } },
      { status: 201, body: { sid: PN } },
    ]);
    await expect(twilio.buyNumber({ phoneNumber: "+447700900301", friendlyName: "Autofix texts", voiceUrl: "https://autofix.vitalos.co.uk/api/webhooks/twilio/voice", bundleSid: "BU0123456789abcdef0123456789abcdef", addressSid: "AD0123456789abcdef0123456789abcdef" }))
      .resolves.toEqual({ sid: PN, phoneNumber: "+447700900301", friendlyName: "Autofix texts", sms: true, voice: true });
    await twilio.addToService(PN);
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json` });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      PhoneNumber: "+447700900301",
      FriendlyName: "Autofix texts",
      VoiceUrl: "https://autofix.vitalos.co.uk/api/webhooks/twilio/voice",
      VoiceMethod: "POST",
      StatusCallback: "https://autofix.vitalos.co.uk/api/webhooks/twilio/voice",
      StatusCallbackMethod: "POST",
      BundleSid: "BU0123456789abcdef0123456789abcdef",
      AddressSid: "AD0123456789abcdef0123456789abcdef",
    });
    expect(calls[1]).toMatchObject({ method: "POST", url: `https://messaging.twilio.com/v1/Services/${SERVICE}/PhoneNumbers`, body: `PhoneNumberSid=${PN}` });
  });

  it.each([
    [400, 21404, "trial_account"],
    [400, 21649, "bundle_required"],
    [400, 21631, "address_required"],
    [400, 21422, "number_unavailable"],
    [429, 20429, "rate_limited"],
    [503, null, "provider_error"],
  ] as const)("never retries a purchase: HTTP %s %s is %s", async (status, code, kind) => {
    const { calls, client: twilio } = client([{ status, body: code ? { code, message: "refused" } : {} }, { status: 201, body: { sid: PN, phone_number: "+447700900301" } }]);
    await expect(twilio.buyNumber({ phoneNumber: "+447700900301", friendlyName: "x", voiceUrl: "https://x.test/v", bundleSid: "BU0123456789abcdef0123456789abcdef" })).rejects.toMatchObject({ kind });
    expect(calls).toHaveLength(1);
  });

  it("calls a purchase that timed out ambiguous (timeout), without retrying", async () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const { calls, client: twilio } = client([abort]);
    await expect(twilio.buyNumber({ phoneNumber: "+447700900301", friendlyName: "x", voiceUrl: "https://x.test/v", bundleSid: "BU0123456789abcdef0123456789abcdef" })).rejects.toMatchObject({ kind: "timeout" });
    expect(calls).toHaveLength(1);
  });

  it("retries a read once after a back-off on 429 or 5xx, then gives up", async () => {
    const sleep = vi.fn(async () => undefined);
    const fake = fakeFetch([{ status: 429, body: { code: 20429 }, headers: { "retry-after": "1" } }, { body: { type: "Full", status: "active" } }, { status: 503 }, { status: 503 }]);
    const twilio = createTwilioNumbersClient({ accountSid: ACCOUNT, authToken: TOKEN, messagingServiceSid: SERVICE, fetch: fake.fetchImpl, sleep });
    await expect(twilio.getAccount()).resolves.toEqual({ type: "Full", status: "active" });
    expect(sleep).toHaveBeenCalledWith(1000);
    await expect(twilio.getAccount()).rejects.toMatchObject({ kind: "provider_error", httpStatus: 503 });
    expect(fake.calls).toHaveLength(4);
  });

  it("maps errors by code first, then by HTTP status", () => {
    expect(mapTwilioNumbersError("x", 400, 21404).kind).toBe("trial_account");
    expect(mapTwilioNumbersError("x", 403, null).kind).toBe("configuration_required");
    expect(mapTwilioNumbersError("x", 400, 12345)).toMatchObject({ kind: "refused", reason: "twilio:12345" });
    expect(mapTwilioNumbersError("x", 429, null, "2").retryAfterMs).toBe(2000);
  });
});

describe("when the app may buy numbers", () => {
  const credentials = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_MESSAGING_SERVICE_SID: SERVICE };

  it("is the trial-account mock by default, outside production", () => {
    expect(getTwilioNumbersReadiness({})).toEqual({ mode: "mock", status: "mock", missing: [] });
    expect(getTwilioNumbersClient({})).toBe(sharedMockTwilioNumbersClient());
    expect(getTwilioNumbersClient({ TWILIO_NUMBERS_MODE: "mock", VERCEL_ENV: "preview" }).mode).toBe("mock");
  });

  it("is live only on the production deployment with the Twilio credentials", () => {
    expect(getTwilioNumbersReadiness({ ...credentials, TWILIO_NUMBERS_MODE: "live", VERCEL_ENV: "production" })).toEqual({ mode: "live", status: "operational", missing: [] });
    expect(getTwilioNumbersClient({ ...credentials, TWILIO_NUMBERS_MODE: "live", VERCEL_ENV: "production" }).mode).toBe("live");
  });

  it.each([
    [{ ...credentials, TWILIO_NUMBERS_MODE: "live" }, ["VERCEL_ENV"]],
    [{ ...credentials, TWILIO_NUMBERS_MODE: "live", VERCEL_ENV: "preview" }, ["VERCEL_ENV"]],
    [{ TWILIO_NUMBERS_MODE: "live", VERCEL_ENV: "production" }, ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID"]],
    [{ ...credentials, VERCEL_ENV: "production" }, ["TWILIO_NUMBERS_MODE"]],
    [{ TWILIO_NUMBERS_MODE: "sometimes" }, ["TWILIO_NUMBERS_MODE"]],
  ])("fails closed (configuration required) for %o", (env, missing) => {
    expect(getTwilioNumbersReadiness(env)).toMatchObject({ status: "configuration_required", missing });
    expect(() => getTwilioNumbersClient(env)).toThrow(TwilioNumbersError);
    try {
      getTwilioNumbersClient(env);
    } catch (error) {
      expect((error as TwilioNumbersError).kind).toBe("configuration_required");
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});
