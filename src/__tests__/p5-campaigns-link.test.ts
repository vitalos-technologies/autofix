import { beforeEach, describe, expect, it, vi } from "vitest";
import { openBookingSession } from "@/lib/booking-engine/state";
import { handleCampaignLinkRequest, openCampaignLink, type CampaignLinkRepo, type LinkedCampaignSend } from "@/lib/campaigns/open-link";
import { createReminderLinkToken, hashReminderLinkToken } from "@/lib/reminders/link-token";
import type { Garage } from "@/lib/tenancy/garage";

// /c/{token} (P5.5): a campaign link opens the booking page with the car (and the campaign's
// service) filled in, records the first open, and carries campaignSendId for attribution. The
// token never appears in the redirect or the problem page's address.

const GARAGE_ID = "a0000000-0000-4000-8000-00000000000a";
const NOW = new Date("2026-10-27T11:00:00Z");
const SEND_ID = "00000000-0000-4000-8000-0000000000d1";

function linked(overrides: Partial<LinkedCampaignSend> = {}): LinkedCampaignSend {
  return {
    id: SEND_ID,
    status: "sent",
    linkExpiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    openedAt: null,
    serviceId: null,
    vehicle: { registration: "AB12CDE", make: "Ford", model: "Focus", motExpiry: "2027-03-15" },
    ...overrides,
  };
}

function repo(send: LinkedCampaignSend | null, services = [{ id: "svc-full", name: "Full service", isMot: false, locationMode: "workshop" as const, sort: 1 }]) {
  const seen: string[] = [];
  const opened: string[] = [];
  const value: CampaignLinkRepo = {
    findByTokenHash: vi.fn(async (_garageId, hash) => {
      seen.push(hash);
      return send;
    }),
    markOpened: vi.fn(async (_garageId, id) => {
      opened.push(id);
    }),
    listOnlineServices: vi.fn(async () => services),
  };
  return { repo: value, seen, opened };
}

beforeEach(() => {
  process.env.BOOKING_STATE_SECRET = "unit-test-booking-state-secret-0123456789";
});

describe("openCampaignLink", () => {
  it("prefills the car, records the first open and carries the send id", async () => {
    const token = createReminderLinkToken(NOW).token;
    const fake = repo(linked());
    const opened = await openCampaignLink({ garage: { id: GARAGE_ID, motEnabled: true }, token, repo: fake.repo, now: NOW });
    expect(fake.seen).toEqual([hashReminderLinkToken(token)]);
    expect(fake.opened).toEqual([SEND_ID]);
    expect(opened).toMatchObject({ ok: true, next: "/service", draft: { garageId: GARAGE_ID, campaignSendId: SEND_ID, vehicle: { registration: "AB12CDE", make: "Ford", model: "Focus", motExpiry: "2027-03-15" } } });
  });

  it("goes straight to the times for the campaign's workshop service", async () => {
    const opened = await openCampaignLink({ garage: { id: GARAGE_ID, motEnabled: false }, token: createReminderLinkToken(NOW).token, repo: repo(linked({ serviceId: "svc-full", openedAt: NOW.toISOString() })).repo, now: NOW });
    expect(opened).toMatchObject({ ok: true, next: "/time", draft: { serviceId: "svc-full", locationMode: "workshop" } });
    if (opened.ok) expect(opened.draft.vehicle?.motExpiry).toBeUndefined();
  });

  it("an MOT service while MOTs are off picks on the service step", async () => {
    const opened = await openCampaignLink({
      garage: { id: GARAGE_ID, motEnabled: false },
      token: createReminderLinkToken(NOW).token,
      repo: repo(linked({ serviceId: "svc-mot" }), [{ id: "svc-mot", name: "MOT", isMot: true, locationMode: "workshop", sort: 1 }]).repo,
      now: NOW,
    });
    expect(opened).toMatchObject({ ok: true, next: "/service" });
    if (opened.ok) expect(opened.draft.serviceId).toBeUndefined();
  });

  it.each([
    ["a malformed token", "not-a-token", linked(), "invalid"],
    ["an unknown token", createReminderLinkToken(NOW).token, null, "invalid"],
    ["a send that never went out", createReminderLinkToken(NOW).token, linked({ status: "scheduled" }), "invalid"],
    ["an expired link", createReminderLinkToken(NOW).token, linked({ linkExpiresAt: new Date(NOW.getTime() - 1).toISOString() }), "expired"],
  ] as const)("opens nothing for %s", async (_label, token, send, problem) => {
    const fake = repo(send);
    expect(await openCampaignLink({ garage: { id: GARAGE_ID, motEnabled: true }, token, repo: fake.repo, now: NOW })).toEqual({ ok: false, problem });
    expect(fake.opened).toEqual([]);
  });
});

describe("GET /c/{token}", () => {
  const garage = { id: GARAGE_ID, motEnabled: true } as Garage;

  it("answers 303 to the next step with the sealed draft, no-referrer and no token in Location", async () => {
    const token = createReminderLinkToken(NOW).token;
    const response = await handleCampaignLinkRequest(new Request(`https://hartley-road.example/c/${token}`), { garageId: GARAGE_ID, token }, {
      hostGarage: async () => garage,
      repo: () => repo(linked()).repo,
      rateLimit: async () => true,
      now: () => NOW,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/service");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Location")).not.toContain(token);
    const cookie = response.headers.get("set-cookie") ?? "";
    const sealed = /af_booking=([^;]+)/.exec(cookie)?.[1];
    expect(sealed).toBeTruthy();
    expect(openBookingSession(GARAGE_ID, decodeURIComponent(sealed!)).draft?.campaignSendId).toBe(SEND_ID);
  });

  it("is 404 on another garage's host and rate limited per visitor", async () => {
    const token = createReminderLinkToken(NOW).token;
    const other = await handleCampaignLinkRequest(new Request("https://x.example/"), { garageId: "b0000000-0000-4000-8000-00000000000b", token }, { hostGarage: async () => garage });
    expect(other.status).toBe(404);
    const limited = await handleCampaignLinkRequest(new Request("https://x.example/"), { garageId: GARAGE_ID, token }, { hostGarage: async () => garage, rateLimit: async () => false });
    expect(limited.headers.get("Location")).toBe("/r?link=limited");
  });
});
