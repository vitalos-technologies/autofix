import { describe, expect, it, vi } from "vitest";
import { askbridgeFromSettings, askbridgeScriptUrl, askbridgeWidgetFor } from "@/lib/askbridge/config";
import {
  askbridgeOutbox,
  AskbridgeSyncError,
  buildAskbridgeKnowledge,
  getAskbridgeReadiness,
  runAskbridgeSync,
  signAskbridgeBody,
  verifyAskbridgeSignature,
  type AskbridgeSyncDeps,
} from "@/lib/askbridge/sync";
import type { AgentGarageRecord } from "@/lib/agent-api/store";
import type { OnlineService } from "@/lib/booking-engine/types";

const GARAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-27T10:00:00Z");
const SECRET = "test-askbridge-secret-at-least-32-characters";

const record: AgentGarageRecord = {
  name: "Hartley Road Motors",
  slug: "hartley-road",
  customDomain: null,
  phone: "+441302000101",
  whatsapp: null,
  email: "desk@hartleyroad.example",
  address: { line1: "1 Hartley Road", town: "Doncaster", postcode: "DN4 5AA" },
  timezone: "Europe/London",
  motEnabled: true,
  approveOnline: false,
  serviceArea: ["DN4"],
  cancellationCutoffH: 24,
  openingHours: [{ weekday: 1, opens: "08:00", closes: "17:30" }],
  closures: [],
  faqs: [{ question: "Do you have parking?", answer: "Yes, three spaces." }],
};

const service = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Full service",
  description: "Oil, filters and checks",
  durationMin: 180,
  bufferMin: 0,
  pricePence: 18900,
  priceMode: "fixed",
  locationMode: "workshop",
  resourceKind: "bay",
  needsApproval: false,
  minNoticeH: 2,
  maxDaysAhead: 60,
  isMot: false,
  sort: 1,
} as unknown as OnlineService;

const enabledGarage = { status: "active", timezone: "Europe/London", settings: { askbridge: { enabled: true, widgetId: "wid_hartley" } } };

function deps(overrides: AskbridgeSyncDeps = {}): AskbridgeSyncDeps {
  return {
    loadGarage: async () => enabledGarage,
    loadProfile: async () => record,
    listServices: async () => [service],
    now: NOW,
    env: { NODE_ENV: "test" },
    ...overrides,
  };
}

describe("widget gating", () => {
  const env = { NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "https://widget.askbridge.example/v1/widget.js", VERCEL_ENV: "production" };

  it("loads only when the garage has it on with a valid id and the platform has a script", () => {
    expect(askbridgeWidgetFor({ askbridge: { enabled: true, widgetId: "wid_1234" } }, env)).toEqual({
      scriptUrl: "https://widget.askbridge.example/v1/widget.js",
      origin: "https://widget.askbridge.example",
      widgetId: "wid_1234",
    });
    expect(askbridgeWidgetFor({ askbridge: { enabled: false, widgetId: "wid_1234" } }, env)).toBeNull();
    expect(askbridgeWidgetFor({ askbridge: { enabled: true, widgetId: "<x>" } }, env)).toBeNull();
    expect(askbridgeWidgetFor({ askbridge: { enabled: "true", widgetId: "wid_1234" } }, env)).toBeNull();
    expect(askbridgeWidgetFor({}, env)).toBeNull();
    expect(askbridgeWidgetFor({ askbridge: { enabled: true, widgetId: "wid_1234" } }, { VERCEL_ENV: "production" })).toBeNull();
  });

  it("accepts https scripts, and a loopback stub except on a Vercel production deployment", () => {
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://127.0.0.1:4100/widget.js", NODE_ENV: "production" })?.origin).toBe("http://127.0.0.1:4100");
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://127.0.0.1:4100/widget.js", VERCEL_ENV: "production" })).toBeNull();
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://widget.askbridge.example/w.js", NODE_ENV: "development" })).toBeNull();
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "javascript:alert(1)" })).toBeNull();
    expect(askbridgeScriptUrl({})).toBeNull();
  });

  it("reads settings defensively", () => {
    expect(askbridgeFromSettings({ askbridge: { enabled: true } })).toEqual({ enabled: false, widgetId: null });
    expect(askbridgeFromSettings("nope")).toEqual({ enabled: false, widgetId: null });
  });
});

describe("knowledge payload", () => {
  it("is the agent API's garage_profile + list_services and nothing else", () => {
    const knowledge = buildAskbridgeKnowledge({ garageId: GARAGE_ID, widgetId: "wid_hartley", garage: record, services: [service], now: NOW });
    expect(Object.keys(knowledge).sort()).toEqual(["contentHash", "event", "garageId", "generatedAt", "profile", "schema", "services", "widgetId"]);
    expect(knowledge.schema).toBe("autofix.askbridge.knowledge.v1");
    expect(knowledge.profile.garage.name).toBe("Hartley Road Motors");
    expect(knowledge.profile.garage.bookingUrl).toMatch(/hartley-road/);
    expect(knowledge.profile.openingHours[0]).toMatchObject({ day: "Monday", opens: "08:00" });
    expect(knowledge.profile.faqs).toEqual(record.faqs);
    expect(knowledge.services).toEqual([expect.objectContaining({ id: service.id, priceText: "£189.00", durationMin: 180 })]);
    expect(knowledge.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes content, not time", () => {
    const a = buildAskbridgeKnowledge({ garageId: GARAGE_ID, widgetId: "wid_hartley", garage: record, services: [service], now: NOW });
    const b = buildAskbridgeKnowledge({ garageId: GARAGE_ID, widgetId: "wid_hartley", garage: record, services: [service], now: new Date(NOW.getTime() + 60_000) });
    const c = buildAskbridgeKnowledge({ garageId: GARAGE_ID, widgetId: "wid_hartley", garage: { ...record, phone: "+441302000999" }, services: [service], now: NOW });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });
});

describe("signature", () => {
  it("signs t.body with HMAC-SHA-256 and verifies within 5 minutes", () => {
    const header = signAskbridgeBody('{"a":1}', SECRET, 1_793_000_000);
    expect(header).toMatch(/^t=1793000000,v1=[0-9a-f]{64}$/);
    expect(verifyAskbridgeSignature('{"a":1}', header, SECRET, 1_793_000_100)).toBe(true);
    expect(verifyAskbridgeSignature('{"a":2}', header, SECRET, 1_793_000_100)).toBe(false);
    expect(verifyAskbridgeSignature('{"a":1}', header, "another-secret", 1_793_000_100)).toBe(false);
    expect(verifyAskbridgeSignature('{"a":1}', header, SECRET, 1_793_000_400)).toBe(false);
    expect(verifyAskbridgeSignature('{"a":1}', "garbage", SECRET, 1_793_000_000)).toBe(false);
  });
});

describe("runAskbridgeSync", () => {
  const liveEnv = { NODE_ENV: "production", ASKBRIDGE_SYNC_URL: "https://api.askbridge.example/v1/knowledge", ASKBRIDGE_WEBHOOK_SECRET: SECRET };

  it("posts the signed knowledge with an idempotency key", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 202 }));
    const result = await runAskbridgeSync({ garageId: GARAGE_ID }, deps({ env: liveEnv, fetch: fetchMock as unknown as typeof fetch }));
    expect(result).toMatchObject({ status: "sent", httpStatus: 202 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(liveEnv.ASKBRIDGE_SYNC_URL);
    const headers = init!.headers as Record<string, string>;
    const body = String(init!.body);
    expect(verifyAskbridgeSignature(body, headers["autofix-signature"] ?? null, SECRET, Math.floor(NOW.getTime() / 1000))).toBe(true);
    expect(headers["idempotency-key"]).toMatch(new RegExp(`^askbridge-sync:${GARAGE_ID}:[0-9a-f]{32}$`));
    expect(JSON.parse(body)).toMatchObject({ garageId: GARAGE_ID, widgetId: "wid_hartley", event: "knowledge.sync" });
    // No customer data: only the garage's own contact details appear.
    expect(body).not.toMatch(/registration|customer/i);
  });

  it("treats 409 (already has this content) as sent", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 409 }));
    await expect(runAskbridgeSync({ garageId: GARAGE_ID }, deps({ env: liveEnv, fetch: fetchMock as unknown as typeof fetch }))).resolves.toMatchObject({ status: "sent" });
  });

  it.each([[500, true], [503, true], [429, true], [400, false], [401, false], [422, false]])("HTTP %i → retryable %s", async (status, retryable) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    const error = await runAskbridgeSync({ garageId: GARAGE_ID }, deps({ env: liveEnv, fetch: fetchMock as unknown as typeof fetch })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AskbridgeSyncError);
    expect((error as AskbridgeSyncError).retryable).toBe(retryable);
  });

  it("retries when Askbridge can't be reached", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(runAskbridgeSync({ garageId: GARAGE_ID }, deps({ env: liveEnv, fetch: fetchMock as unknown as typeof fetch }))).rejects.toMatchObject({ retryable: true });
  });

  it("skips garages without the widget, inactive or missing garages", async () => {
    await expect(runAskbridgeSync({ garageId: GARAGE_ID }, deps({ loadGarage: async () => ({ ...enabledGarage, settings: {} }) }))).resolves.toEqual({ status: "skipped", reason: "askbridge_disabled" });
    await expect(runAskbridgeSync({ garageId: GARAGE_ID }, deps({ loadGarage: async () => ({ ...enabledGarage, status: "suspended" }) }))).resolves.toEqual({ status: "skipped", reason: "garage_inactive" });
    await expect(runAskbridgeSync({ garageId: GARAGE_ID }, deps({ loadGarage: async () => null }))).resolves.toEqual({ status: "skipped", reason: "garage_not_found" });
  });

  it("refuses a bad payload without retrying", async () => {
    await expect(runAskbridgeSync({ garageId: "nope" }, deps())).rejects.toMatchObject({ retryable: false });
  });

  it("uses the mock outbox outside production and never calls the network", async () => {
    const fetchMock = vi.fn();
    const before = askbridgeOutbox().length;
    const result = await runAskbridgeSync({ garageId: GARAGE_ID }, deps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(result.status).toBe("mocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(askbridgeOutbox().length).toBe(before + 1);
  });

  it("fails (and retries later) in production without configuration", async () => {
    expect(getAskbridgeReadiness({ NODE_ENV: "production" })).toEqual({ status: "configuration_required", missing: ["ASKBRIDGE_SYNC_URL", "ASKBRIDGE_WEBHOOK_SECRET"] });
    await expect(runAskbridgeSync({ garageId: GARAGE_ID }, deps({ env: { NODE_ENV: "production" } }))).rejects.toMatchObject({ retryable: true });
    expect(getAskbridgeReadiness({ NODE_ENV: "production", ASKBRIDGE_SYNC_URL: "http://api.askbridge.example", ASKBRIDGE_WEBHOOK_SECRET: SECRET }).status).toBe("configuration_required");
    expect(getAskbridgeReadiness(liveEnv)).toEqual({ status: "operational", missing: [] });
  });
});
