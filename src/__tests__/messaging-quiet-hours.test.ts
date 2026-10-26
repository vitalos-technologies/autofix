import { describe, expect, it } from "vitest";
import { isWithinSendWindow, nextSendWindow } from "@/lib/messaging/quiet-hours";

const at = (iso: string) => new Date(iso);

describe("isWithinSendWindow (09:00 to 19:00, Monday to Saturday, Europe/London)", () => {
  it.each([
    // Monday 26 Oct 2026, GMT (UTC+0)
    ["2026-10-26T08:59:59.999Z", false, "08:59 GMT"],
    ["2026-10-26T09:00:00.000Z", true, "09:00 GMT"],
    ["2026-10-26T18:59:59.999Z", true, "18:59 GMT"],
    ["2026-10-26T19:00:00.000Z", false, "19:00 GMT"],
    // Wednesday 15 Jul 2026, BST (UTC+1)
    ["2026-07-15T07:59:00.000Z", false, "08:59 BST"],
    ["2026-07-15T08:00:00.000Z", true, "09:00 BST"],
    ["2026-07-15T17:59:00.000Z", true, "18:59 BST"],
    ["2026-07-15T18:00:00.000Z", false, "19:00 BST"],
    // Saturday is open
    ["2026-10-31T12:00:00.000Z", true, "Saturday midday"],
    ["2026-10-31T19:00:00.000Z", false, "Saturday 19:00"],
  ])("%s is %s (%s)", (iso, expected) => {
    expect(isWithinSendWindow(at(iso))).toBe(expected);
    expect(isWithinSendWindow(at(iso), "Europe/London")).toBe(expected);
  });

  it("is closed all Sunday, including both 2026 clock-change days", () => {
    for (const iso of [
      "2026-03-29T00:59:59Z", // 00:59 GMT, just before clocks go forward
      "2026-03-29T01:00:00Z", // 02:00 BST
      "2026-03-29T09:00:00Z", // 10:00 BST
      "2026-03-29T12:00:00Z",
      "2026-10-25T00:30:00Z", // 01:30 BST (first time round)
      "2026-10-25T01:30:00Z", // 01:30 GMT (second time round)
      "2026-10-25T09:00:00Z",
      "2026-10-25T18:59:00Z",
    ]) {
      expect(isWithinSendWindow(at(iso))).toBe(false);
    }
  });

  it("uses the new offset on the days either side of the spring change", () => {
    // Saturday 28 Mar 2026 is still GMT: 09:00 local is 09:00Z.
    expect(isWithinSendWindow(at("2026-03-28T08:59:00Z"))).toBe(false);
    expect(isWithinSendWindow(at("2026-03-28T09:00:00Z"))).toBe(true);
    expect(isWithinSendWindow(at("2026-03-28T18:59:00Z"))).toBe(true);
    expect(isWithinSendWindow(at("2026-03-28T19:00:00Z"))).toBe(false);
    // Monday 30 Mar 2026 is BST: 09:00 local is 08:00Z, 19:00 local is 18:00Z.
    expect(isWithinSendWindow(at("2026-03-30T07:59:00Z"))).toBe(false);
    expect(isWithinSendWindow(at("2026-03-30T08:00:00Z"))).toBe(true);
    expect(isWithinSendWindow(at("2026-03-30T17:59:00Z"))).toBe(true);
    expect(isWithinSendWindow(at("2026-03-30T18:00:00Z"))).toBe(false);
  });

  it("uses the new offset on the days either side of the autumn change", () => {
    // Saturday 24 Oct 2026 is BST.
    expect(isWithinSendWindow(at("2026-10-24T07:59:00Z"))).toBe(false);
    expect(isWithinSendWindow(at("2026-10-24T08:00:00Z"))).toBe(true);
    expect(isWithinSendWindow(at("2026-10-24T17:59:00Z"))).toBe(true);
    expect(isWithinSendWindow(at("2026-10-24T18:00:00Z"))).toBe(false);
    // Monday 26 Oct 2026 is GMT.
    expect(isWithinSendWindow(at("2026-10-26T08:00:00Z"))).toBe(false);
    expect(isWithinSendWindow(at("2026-10-26T09:00:00Z"))).toBe(true);
  });

  it("follows the garage's own time zone", () => {
    // 00:00Z Monday 26 Oct 2026 is 09:00 in Tokyo (no daylight saving).
    expect(isWithinSendWindow(at("2026-10-26T00:00:00Z"), "Asia/Tokyo")).toBe(true);
    expect(isWithinSendWindow(at("2026-10-25T23:59:00Z"), "Asia/Tokyo")).toBe(false);
  });

  it("fails closed on a bad time zone or date", () => {
    expect(() => isWithinSendWindow(at("2026-10-26T12:00:00Z"), "Mars/Olympus_Mons")).toThrow(RangeError);
    expect(() => isWithinSendWindow(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("nextSendWindow", () => {
  it("returns the same instant inside the window", () => {
    const now = at("2026-10-26T12:34:56.789Z");
    const next = nextSendWindow(now);
    expect(next.toISOString()).toBe(now.toISOString());
    expect(next).not.toBe(now);
  });

  it.each([
    ["2026-10-26T06:00:00Z", "2026-10-26T09:00:00.000Z", "Monday before opening -> Monday 09:00"],
    ["2026-10-26T19:00:00Z", "2026-10-27T09:00:00.000Z", "Monday 19:00 -> Tuesday 09:00"],
    ["2026-10-30T19:00:00Z", "2026-10-31T09:00:00.000Z", "Friday 19:00 -> Saturday 09:00"],
    ["2026-10-31T07:00:00Z", "2026-10-31T09:00:00.000Z", "Saturday early -> Saturday 09:00"],
    ["2026-10-31T19:00:00Z", "2026-11-02T09:00:00.000Z", "Saturday 19:00 -> Monday 09:00"],
    ["2026-11-01T10:00:00Z", "2026-11-02T09:00:00.000Z", "Sunday -> Monday 09:00"],
  ])("%s -> %s (%s)", (from, expected) => {
    expect(nextSendWindow(at(from)).toISOString()).toBe(expected);
  });

  it("crosses the spring clock change (29 Mar 2026) to Monday 09:00 BST", () => {
    const monday0900Bst = "2026-03-30T08:00:00.000Z";
    expect(nextSendWindow(at("2026-03-28T19:00:00Z")).toISOString()).toBe(monday0900Bst); // Sat 19:00 GMT
    expect(nextSendWindow(at("2026-03-29T00:30:00Z")).toISOString()).toBe(monday0900Bst); // Sun 00:30 GMT
    expect(nextSendWindow(at("2026-03-29T01:30:00Z")).toISOString()).toBe(monday0900Bst); // Sun 02:30 BST
    expect(nextSendWindow(at("2026-03-29T22:00:00Z")).toISOString()).toBe(monday0900Bst); // Sun 23:00 BST
    expect(isWithinSendWindow(at(monday0900Bst))).toBe(true);
  });

  it("crosses the autumn clock change (25 Oct 2026) to Monday 09:00 GMT", () => {
    const monday0900Gmt = "2026-10-26T09:00:00.000Z";
    expect(nextSendWindow(at("2026-10-24T18:00:00Z")).toISOString()).toBe(monday0900Gmt); // Sat 19:00 BST
    expect(nextSendWindow(at("2026-10-25T00:30:00Z")).toISOString()).toBe(monday0900Gmt); // Sun 01:30 BST
    expect(nextSendWindow(at("2026-10-25T01:30:00Z")).toISOString()).toBe(monday0900Gmt); // Sun 01:30 GMT
    expect(nextSendWindow(at("2026-10-25T23:59:59Z")).toISOString()).toBe(monday0900Gmt);
    expect(isWithinSendWindow(at(monday0900Gmt))).toBe(true);
  });

  it("always lands inside the window, hour by hour across a clock-change week", () => {
    const start = Date.parse("2026-03-26T00:00:00Z");
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      const from = new Date(start + hour * 3_600_000);
      const next = nextSendWindow(from);
      expect(next.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(isWithinSendWindow(next)).toBe(true);
      // No earlier allowed instant was skipped: one minute before is closed, unless we returned `from` itself.
      if (next.getTime() !== from.getTime()) expect(isWithinSendWindow(new Date(next.getTime() - 60_000))).toBe(false);
    }
  });

  it("works in another time zone", () => {
    // Saturday 31 Oct 2026 19:00 in Tokyo (10:00Z) -> Monday 2 Nov 09:00 JST (00:00Z).
    expect(nextSendWindow(at("2026-10-31T10:00:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
});
