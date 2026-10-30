import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /admin and /api/platform (P4.5): platform admins at AAL2 only; everyone else
// gets a 404, never a hint that the area exists; RPCs go through the user's
// own client (never the service role).

const harness = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  isPlatformAdmin: false,
  assurance: { currentLevel: "aal1", nextLevel: "aal1" },
  rpcCalls: [] as string[],
  serviceRoleUsed: false,
}));

vi.mock("server-only", () => ({}));
// getPlatformAdmin() waits for the request (connection()) so /admin is never prerendered.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    harness.serviceRoleUsed = true;
    return null;
  },
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: harness.user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: harness.assurance, error: null }) },
    },
    rpc: async (name: string) => {
      harness.rpcCalls.push(name);
      if (name === "is_platform_admin") return { data: harness.isPlatformAdmin, error: null };
      if (name === "platform_garages") return { data: [], error: null };
      return { data: null, error: null };
    },
  }),
}));

import { GET as garagesRoute } from "@/app/api/platform/garages/route";
import { PATCH as patchGarage } from "@/app/api/platform/garages/[garageId]/route";
import { requirePlatformAdmin } from "@/lib/platform/access";

const garageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function patchRequest(init: { origin?: string; contentType?: string } = {}) {
  return new NextRequest(`https://pitline.co.uk/api/platform/garages/${garageId}`, {
    method: "PATCH",
    headers: { host: "pitline.co.uk", "content-type": init.contentType ?? "application/json", ...(init.origin ? { origin: init.origin } : {}) },
    body: JSON.stringify({ status: "suspended", reason: "Unpaid for 60 days" }),
  });
}

describe("platform access", () => {
  beforeEach(() => {
    harness.user = { id: "user-1", email: "someone@example.test" };
    harness.isPlatformAdmin = false;
    harness.assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    harness.rpcCalls = [];
    harness.serviceRoleUsed = false;
  });

  it("404s signed-out users and garage staff, even at AAL2", async () => {
    await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    harness.user = null;
    await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sends a platform admin without MFA this session to /admin/verify", async () => {
    harness.isPlatformAdmin = true;
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/verify");
  });

  it("lets a platform admin at AAL2 in, without the service role", async () => {
    harness.isPlatformAdmin = true;
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ access: "allowed", user: { id: "user-1" } });
    expect(harness.serviceRoleUsed).toBe(false);
  });

  it("answers the JSON API with 404 for non-admins and without MFA", async () => {
    const response = await garagesRoute(new NextRequest("https://pitline.co.uk/api/platform/garages"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    harness.isPlatformAdmin = true;
    harness.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    expect((await garagesRoute(new NextRequest("https://pitline.co.uk/api/platform/garages"))).status).toBe(404);
    expect(harness.rpcCalls).not.toContain("platform_garages");
  });

  it("serves the list to a platform admin and validates filters", async () => {
    harness.isPlatformAdmin = true;
    const ok = await garagesRoute(new NextRequest("https://pitline.co.uk/api/platform/garages?status=active"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ page: 1, pageSize: 25, total: 0, garages: [] });
    expect((await garagesRoute(new NextRequest("https://pitline.co.uk/api/platform/garages?plan=gold"))).status).toBe(422);
  });

  it("refuses cross-site or non-JSON mutations", async () => {
    harness.isPlatformAdmin = true;
    const context = { params: Promise.resolve({ garageId }) };
    expect((await patchGarage(patchRequest({ origin: "https://evil.example" }), context)).status).toBe(400);
    expect((await patchGarage(patchRequest({ contentType: "text/plain" }), context)).status).toBe(400);
    expect(harness.rpcCalls).not.toContain("platform_update_garage");
    await patchGarage(patchRequest({ origin: "https://pitline.co.uk" }), context);
    expect(harness.rpcCalls).toContain("platform_update_garage");
  });
});
