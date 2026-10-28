import { describe, expect, it } from "vitest";
import { dayCount, MAX_REPORT_DAYS, presetRange, rangeQuery, resolveReportRange } from "@/lib/reports/range";

describe("P5.6 report ranges (garage-local dates)", () => {
  const today = "2026-10-28";

  it("this month is the whole calendar month", () => {
    expect(presetRange("this_month", today)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", days: 31, label: "1 Oct to 31 Oct 2026" });
  });

  it("last month crosses the year and knows February", () => {
    expect(presetRange("last_month", "2026-01-15")).toMatchObject({ from: "2025-12-01", to: "2025-12-31", label: "1 Dec to 31 Dec 2025" });
    expect(presetRange("last_month", "2028-03-01")).toMatchObject({ from: "2028-02-01", to: "2028-02-29", days: 29 });
  });

  it("last 90 days ends today", () => {
    expect(presetRange("last_90_days", today)).toMatchObject({ from: "2026-07-31", to: today, days: 90 });
  });

  it("counts calendar days, not hours, across both clock changes", () => {
    expect(dayCount("2026-03-29", "2026-03-29")).toBe(1);
    expect(dayCount("2026-03-28", "2026-03-30")).toBe(3);
    expect(dayCount("2026-10-24", "2026-10-26")).toBe(3);
    expect(dayCount("2026-01-01", "2026-12-31")).toBe(365);
  });

  it("reads custom dates and labels a single day", () => {
    const { range, problem } = resolveReportRange({ range: "custom", from: "2026-10-25", to: "2026-10-25" }, today);
    expect(problem).toBeNull();
    expect(range).toMatchObject({ preset: "custom", from: "2026-10-25", to: "2026-10-25", days: 1, label: "25 Oct 2026" });
  });

  it("dates alone mean custom", () => {
    expect(resolveReportRange({ from: "2026-10-01", to: "2026-10-07" }, today).range.preset).toBe("custom");
  });

  it("falls back to this month with the problem for bad input", () => {
    expect(resolveReportRange({ range: "custom", from: "2026-02-30", to: "2026-03-01" }, today)).toMatchObject({ problem: "invalid_dates", range: { preset: "this_month" } });
    expect(resolveReportRange({ range: "custom", from: "2026-10-10", to: "2026-10-01" }, today).problem).toBe("order");
    expect(resolveReportRange({ range: "custom", from: "2025-01-01", to: "2026-10-01" }, today).problem).toBe("too_long");
    expect(resolveReportRange({ range: "custom", from: "2025-10-01", to: "2026-09-30" }, today).problem).toBeNull();
    expect(dayCount("2025-10-01", "2026-09-30")).toBeLessThanOrEqual(MAX_REPORT_DAYS);
  });

  it("unknown presets are this month", () => {
    expect(resolveReportRange({ range: "forever" }, today)).toMatchObject({ problem: null, range: { preset: "this_month" } });
  });

  it("the query string holds only the preset and dates", () => {
    expect(rangeQuery({ preset: "last_month", from: "2026-09-01", to: "2026-09-30" })).toBe("range=last_month");
    expect(rangeQuery({ preset: "custom", from: "2026-09-01", to: "2026-09-30" })).toBe("range=custom&from=2026-09-01&to=2026-09-30");
  });
});
