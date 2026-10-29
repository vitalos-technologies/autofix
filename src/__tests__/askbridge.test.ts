import { describe, expect, it } from "vitest";
import {
  ASKBRIDGE_DEFAULT_SCRIPT_URL,
  askbridgeAllowedOrigins,
  askbridgeFromSettings,
  askbridgeScriptUrl,
  askbridgeWidgetFor,
  parseAskbridgeSiteKey,
} from "@/lib/askbridge/config";
import { getAskbridgeEnvironmentReadiness } from "@/lib/env";

// Askbridge as it ships (docs/autofix/askbridge.md): a site key per garage (`pk_` + 32 hex, Askbridge
// app.sites.site_key) and Askbridge's loader script. There is no knowledge sync to test any more.

const KEY = "pk_0123456789abcdef0123456789abcdef";

describe("site key", () => {
  it("accepts exactly pk_ and 32 lower-case hex characters", () => {
    expect(parseAskbridgeSiteKey(KEY)).toBe(KEY);
    expect(parseAskbridgeSiteKey(`  ${KEY}\n`)).toBe(KEY);
    expect(parseAskbridgeSiteKey("pk_" + "f".repeat(32))).toBe("pk_" + "f".repeat(32));
  });

  it.each([
    ["the old widget id format", "wid_1234"],
    ["upper-case hex", "pk_0123456789ABCDEF0123456789ABCDEF"],
    ["an upper-case prefix", "PK_0123456789abcdef0123456789abcdef"],
    ["31 hex characters", KEY.slice(0, -1)],
    ["33 hex characters", `${KEY}0`],
    ["a non-hex letter", "pk_0123456789abcdeg0123456789abcdef"],
    ["the whole install snippet", `<script src="${ASKBRIDGE_DEFAULT_SCRIPT_URL}" data-site="${KEY}" async></script>`],
    ["a secret key", "sk_0123456789abcdef0123456789abcdef"],
    ["nothing", ""],
  ])("refuses %s", (_name, value) => {
    expect(parseAskbridgeSiteKey(value)).toBeNull();
  });

  it("refuses values that are not strings", () => {
    expect(parseAskbridgeSiteKey(null)).toBeNull();
    expect(parseAskbridgeSiteKey(123)).toBeNull();
    expect(parseAskbridgeSiteKey({ siteKey: KEY })).toBeNull();
  });
});

describe("garage setting", () => {
  it("is on only with a valid site key", () => {
    expect(askbridgeFromSettings({ askbridge: { enabled: true, siteKey: KEY } })).toEqual({ enabled: true, siteKey: KEY });
    expect(askbridgeFromSettings({ askbridge: { enabled: false, siteKey: KEY } })).toEqual({ enabled: false, siteKey: KEY });
    expect(askbridgeFromSettings({ askbridge: { enabled: true, siteKey: "wid_1234" } })).toEqual({ enabled: false, siteKey: null });
    expect(askbridgeFromSettings({ askbridge: { enabled: "true", siteKey: KEY } })).toEqual({ enabled: false, siteKey: KEY });
  });

  it("ignores the old widget id, even a stored one", () => {
    expect(askbridgeFromSettings({ askbridge: { enabled: true, widgetId: "wid_1234" } })).toEqual({ enabled: false, siteKey: null });
  });

  it("reads settings defensively", () => {
    expect(askbridgeFromSettings({ askbridge: { enabled: true } })).toEqual({ enabled: false, siteKey: null });
    expect(askbridgeFromSettings({})).toEqual({ enabled: false, siteKey: null });
    expect(askbridgeFromSettings(null)).toEqual({ enabled: false, siteKey: null });
    expect(askbridgeFromSettings("nope")).toEqual({ enabled: false, siteKey: null });
  });
});

describe("loader script URL", () => {
  it("defaults to Askbridge's own loader", () => {
    expect(ASKBRIDGE_DEFAULT_SCRIPT_URL).toBe("https://askbridge.vitalos.co.uk/widget/v1/askbridge.js");
    expect(askbridgeScriptUrl({})?.toString()).toBe(ASKBRIDGE_DEFAULT_SCRIPT_URL);
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "  ", VERCEL_ENV: "production" })?.toString()).toBe(ASKBRIDGE_DEFAULT_SCRIPT_URL);
  });

  it("takes an https override, and a loopback stub except on a Vercel production deployment", () => {
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "https://cdn.askbridge.example/widget/v1/askbridge.js" })?.origin).toBe("https://cdn.askbridge.example");
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://127.0.0.1:4100/widget/v1/askbridge.js", NODE_ENV: "production" })?.origin).toBe("http://127.0.0.1:4100");
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://127.0.0.1:4100/widget/v1/askbridge.js", VERCEL_ENV: "production" })).toBeNull();
  });

  it("hides the chat when the override is set but invalid (never falls back)", () => {
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://askbridge.example/widget/v1/askbridge.js" })).toBeNull();
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "javascript:alert(1)" })).toBeNull();
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "not a url" })).toBeNull();
    expect(askbridgeScriptUrl({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "https://user:pass@askbridge.example/a.js" })).toBeNull();
  });
});

describe("widget gating", () => {
  it("loads only when the garage has it on with a valid key and the loader URL is valid", () => {
    expect(askbridgeWidgetFor({ askbridge: { enabled: true, siteKey: KEY } }, {})).toEqual({
      scriptUrl: ASKBRIDGE_DEFAULT_SCRIPT_URL,
      origin: "https://askbridge.vitalos.co.uk",
      siteKey: KEY,
    });
    expect(askbridgeWidgetFor({ askbridge: { enabled: false, siteKey: KEY } }, {})).toBeNull();
    expect(askbridgeWidgetFor({ askbridge: { enabled: true, siteKey: "<x>" } }, {})).toBeNull();
    expect(askbridgeWidgetFor({}, {})).toBeNull();
    expect(askbridgeWidgetFor({ askbridge: { enabled: true, siteKey: KEY } }, { NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "ftp://askbridge.example/a.js" })).toBeNull();
  });
});

describe("allowed websites to add in Askbridge", () => {
  it("lists the free link, then the garage's own address once connected", () => {
    expect(askbridgeAllowedOrigins("https://hartley-road.autofix.vitalos.co.uk")).toEqual(["https://hartley-road.autofix.vitalos.co.uk"]);
    expect(askbridgeAllowedOrigins("https://hartley-road.autofix.vitalos.co.uk/", " Book.HartleyRoad.co.uk ")).toEqual([
      "https://hartley-road.autofix.vitalos.co.uk",
      "https://book.hartleyroad.co.uk",
    ]);
    expect(askbridgeAllowedOrigins("http://hartley-road.localhost:3000", null)).toEqual(["http://hartley-road.localhost:3000"]);
  });
});

describe("readiness", () => {
  it("is ready with no configuration at all (no secrets needed)", () => {
    expect(getAskbridgeEnvironmentReadiness({})).toEqual({ ready: true, missing: [] });
    expect(getAskbridgeEnvironmentReadiness({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "https://cdn.askbridge.example/a.js" })).toEqual({ ready: true, missing: [] });
  });

  it("reports an invalid override", () => {
    expect(getAskbridgeEnvironmentReadiness({ NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: "http://127.0.0.1:4100/a.js", VERCEL_ENV: "production" })).toEqual({
      ready: false,
      missing: ["NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL"],
    });
  });
});
