import { describe, expect, it } from "vitest";
import { signClaim, verifyClaim } from "../src/claim.js";
import { CALL, GARAGE, SECRET } from "./helpers.js";

describe("relay claim", () => {
  it("matches the shared test vector (Pitline: src/__tests__/p5-ai-front-desk.test.ts)", () => {
    expect(signClaim(SECRET, { garageId: GARAGE, callSid: CALL, expires: 1793000000 })).toBe("a8df7828c754f67da80ce34466c1e0b0da5e6ec95ed72d8f3c475c3b429d746e");
  });

  it("accepts a signed, unexpired claim and refuses anything changed, expired or too far ahead", () => {
    const now = new Date(1793000000 * 1000 - 60_000);
    const query = (overrides: Record<string, string> = {}) => new URLSearchParams({ g: GARAGE, c: CALL, e: "1793000000", s: signClaim(SECRET, { garageId: GARAGE, callSid: CALL, expires: 1793000000 }), ...overrides });
    expect(verifyClaim(SECRET, query(), now)).toMatchObject({ garageId: GARAGE, callSid: CALL, expires: 1793000000 });
    expect(verifyClaim("another-secret-another-secret-another", query(), now)).toBeNull();
    expect(verifyClaim(SECRET, query({ c: "CA00000000000000000000000000000002" }), now)).toBeNull();
    expect(verifyClaim(SECRET, query({ g: "b0000000-0000-4000-8000-00000000000b" }), now)).toBeNull();
    expect(verifyClaim(SECRET, query(), new Date(1793000000 * 1000))).toBeNull();
    expect(verifyClaim(SECRET, query(), new Date(1793000000 * 1000 - 3_600_000))).toBeNull();
    expect(verifyClaim(SECRET, query({ s: "zz" }), now)).toBeNull();
    expect(verifyClaim(SECRET, new URLSearchParams(), now)).toBeNull();
  });
});
