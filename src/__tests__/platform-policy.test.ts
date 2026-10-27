import { describe, expect, it } from "vitest";
import { cleanReason, isPrefetch, isReadRequest, platformAccess, redactJobError, toImpersonation } from "@/lib/platform/policy";
import { REQUEST_METHOD_HEADER } from "@/lib/tenancy/request-headers";

describe("platformAccess", () => {
  it("is not_found for signed-out users and anyone not in platform_admins, whatever their MFA", () => {
    expect(platformAccess({ signedIn: false, isPlatformAdmin: true, currentLevel: "aal2", nextLevel: "aal2" })).toBe("not_found");
    expect(platformAccess({ signedIn: true, isPlatformAdmin: false, currentLevel: "aal2", nextLevel: "aal2" })).toBe("not_found");
  });

  it("allows a platform admin only at AAL2", () => {
    expect(platformAccess({ signedIn: true, isPlatformAdmin: true, currentLevel: "aal2", nextLevel: "aal2" })).toBe("allowed");
    expect(platformAccess({ signedIn: true, isPlatformAdmin: true, currentLevel: "aal1", nextLevel: "aal2" })).toBe("challenge");
    expect(platformAccess({ signedIn: true, isPlatformAdmin: true, currentLevel: "aal1", nextLevel: "aal1" })).toBe("enroll");
    expect(platformAccess({ signedIn: true, isPlatformAdmin: true, currentLevel: null, nextLevel: null })).toBe("enroll");
  });
});

describe("isReadRequest", () => {
  it("is true only for GET/HEAD without a server action", () => {
    expect(isReadRequest(new Headers({ [REQUEST_METHOD_HEADER]: "GET" }))).toBe(true);
    expect(isReadRequest(new Headers({ [REQUEST_METHOD_HEADER]: "head" }))).toBe(true);
    expect(isReadRequest(new Headers({ [REQUEST_METHOD_HEADER]: "POST" }))).toBe(false);
    expect(isReadRequest(new Headers({ [REQUEST_METHOD_HEADER]: "GET", "next-action": "x" }))).toBe(false);
    expect(isReadRequest(new Headers())).toBe(false);
  });

  it("recognises prefetches", () => {
    expect(isPrefetch(new Headers({ "next-router-prefetch": "1" }))).toBe(true);
    expect(isPrefetch(new Headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(new Headers())).toBe(false);
  });
});

describe("toImpersonation", () => {
  const row = { id: "s1", garage_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", garage_name: "G", reason: "Ticket 1", started_at: "2026-10-27T09:00:00Z", expires_at: "2026-10-27T09:30:00Z" };

  it("keeps an open session and lower-cases the garage id", () => {
    expect(toImpersonation(row, Date.parse("2026-10-27T09:29:59Z"))).toMatchObject({ garageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expiresAt: row.expires_at });
  });

  it("drops an expired, malformed or missing session", () => {
    expect(toImpersonation(row, Date.parse("2026-10-27T09:30:00Z"))).toBeNull();
    expect(toImpersonation({ ...row, expires_at: "soon" })).toBeNull();
    expect(toImpersonation(null)).toBeNull();
  });
});

describe("cleanReason", () => {
  it("needs 5 to 500 characters after collapsing whitespace and control characters", () => {
    expect(cleanReason("  Ticket\n 42  ")).toBe("Ticket 42");
    expect(cleanReason("abc")).toBeNull();
    expect(cleanReason("x".repeat(501))).toBeNull();
    expect(cleanReason(42)).toBeNull();
  });
});

describe("redactJobError", () => {
  it("masks emails, phone numbers and registrations but keeps ids and codes", () => {
    const error = "SEND_FAILED for jo@example.com +44 7700 900123 / 07700900123 car AB12 CDE (ab12cde) job 3c000000-0000-4000-8000-000000000001";
    expect(redactJobError(error)).toBe("SEND_FAILED for [email] [phone] / [phone] car [reg] ([reg]) job 3c000000-0000-4000-8000-000000000001");
  });

  it("leaves ordinary errors alone and caps the length", () => {
    expect(redactJobError("LOCK_EXPIRED: the worker neither finished nor failed attempt 5")).toBe("LOCK_EXPIRED: the worker neither finished nor failed attempt 5");
    expect(redactJobError("x".repeat(400))).toHaveLength(300);
    expect(redactJobError(null)).toBe("");
  });
});
