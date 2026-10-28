import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultAdminNav, GROW_NAV_ITEMS } from "@/components/admin-ui/admin-nav";
import {
  extraSitePriceLine,
  extraSites,
  extraSitesLabel,
  groupReportCsv,
  groupReportFileName,
  overviewTotals,
  parseReportRange,
  reportTotals,
  toGroupSummary,
  toOverviewSite,
  toReportSite,
} from "@/lib/group/report";
import { FEATURES } from "@/lib/plans/features";

const MIGRATION = readFileSync("supabase/migrations/20261029000900_multi_site.sql", "utf8");

describe("P5.9 group report shaping", () => {
  it("defaults the report to this month so far, in the garage's dates", () => {
    expect(parseReportRange({}, "2026-10-28")).toEqual({ from: "2026-10-01", to: "2026-10-28" });
  });

  it("keeps a valid range, swaps one back to front and ignores junk", () => {
    expect(parseReportRange({ from: "2026-03-29", to: "2026-04-02" }, "2026-10-28")).toEqual({ from: "2026-03-29", to: "2026-04-02" });
    expect(parseReportRange({ from: "2026-04-02", to: "2026-03-29" }, "2026-10-28")).toEqual({ from: "2026-03-29", to: "2026-04-02" });
    expect(parseReportRange({ from: "2026-02-30", to: "nope" }, "2026-10-28")).toEqual({ from: "2026-10-01", to: "2026-10-28" });
  });

  it("cuts a range to 366 days ending at `to` (what group_report() accepts)", () => {
    const range = parseReportRange({ from: "2020-01-01", to: "2026-10-25" }, "2026-10-28");
    expect(range.to).toBe("2026-10-25");
    expect(range.from).toBe("2025-10-25");
    expect(MIGRATION).toMatch(/p_to - p_from > 365/);
  });

  it("adds up the overview and the report", () => {
    const sites = [
      toOverviewSite({ garage_id: "a", name: "Home", slug: "home", is_home: true, is_selected: true, today_bookings: 3, open_requests: 1, revenue_month_pence: "12000", won_back_bookings: 2, won_back_pence: 9000 }),
      toOverviewSite({ garage_id: "b", name: "North", slug: "north", is_home: false, is_selected: false, today_bookings: 2, open_requests: 0, revenue_month_pence: 5050, won_back_bookings: 0, won_back_pence: 0 }),
    ];
    expect(overviewTotals(sites)).toEqual({ todayBookings: 5, openRequests: 1, revenueMonthPence: 17050, wonBackBookings: 2, wonBackPence: 9000 });
    expect(reportTotals([toReportSite({ garage_id: "a", name: "A", bookings: 4, revenue_pence: 100 }), toReportSite({ garage_id: "b", name: "B", bookings: "6", revenue_pence: "250" })]))
      .toEqual({ bookings: 10, revenuePence: 350 });
  });

  it("treats a garage in no group as a group of one", () => {
    const summary = toGroupSummary({ group_id: null, home_garage_id: "g1", is_home: true, site_count: 1, visible_sites: 1, can_add_sites: true, multi_site: true }, "g1");
    expect(summary).toMatchObject({ groupId: null, homeGarageId: "g1", siteCount: 1, canAddSites: true, multiSite: true });
    expect(toGroupSummary(null, "g2")).toMatchObject({ homeGarageId: "g2", siteCount: 1, canAddSites: false, multiSite: false });
  });

  it("charges for each site beyond the first, with the price a placeholder until set", () => {
    expect(extraSites(1)).toBe(0);
    expect(extraSites(3)).toBe(2);
    expect(extraSites(0)).toBe(0);
    expect(extraSitesLabel(0)).toBe("No extra sites");
    expect(extraSitesLabel(1)).toBe("1 extra site");
    expect(extraSitesLabel(4)).toBe("4 extra sites");
    expect(extraSitePriceLine(null)).toBe("Each extra site: Price to be confirmed");
    expect(extraSitePriceLine(2500)).toBe("Each extra site: £25 a month");
  });

  it("writes a CSV with a BOM, CRLF, a total row and no spreadsheet formulas", () => {
    const csv = groupReportCsv(
      [
        { garageId: "a", name: "Hartley Road", isHome: true, bookings: 4, revenuePence: 12345 },
        { garageId: "b", name: '=HYPERLINK("x") "North"', isHome: false, bookings: 1, revenuePence: 5 },
      ],
      { from: "2026-10-01", to: "2026-10-28" },
    );
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe('"Site","From","To","Bookings","Revenue GBP"');
    expect(lines[1]).toBe('"Hartley Road","2026-10-01","2026-10-28","4","123.45"');
    expect(lines[2]).toBe('"\'=HYPERLINK(""x"") ""North""","2026-10-01","2026-10-28","1","0.05"');
    expect(lines[3]).toBe('"All sites","2026-10-01","2026-10-28","5","123.50"');
    expect(groupReportFileName({ from: "2026-10-01", to: "2026-10-28" })).toBe("Group-report-2026-10-01-to-2026-10-28.csv");
  });
});

describe("P5.9 nav and gating", () => {
  it("adds one Grow line for multi_site, pointing at the feature's route", () => {
    const lines = GROW_NAV_ITEMS.filter((item) => item.feature === "multi_site");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.href).toBe(FEATURES.multi_site.href);
    expect(FEATURES.multi_site.plan).toBe("pro");
  });

  it("keeps the link for Essentials garages, with the Pro badge", () => {
    const locked = defaultAdminNav({ lockedFeatures: new Set(["multi_site"]) });
    const item = locked.find((group) => group.label === "Grow")?.items.find((entry) => entry.href === "/app/group");
    expect(item?.proLocked).toBe(true);
    const open = defaultAdminNav({ lockedFeatures: new Set() }).find((group) => group.label === "Grow")?.items.find((entry) => entry.href === "/app/group");
    expect(open?.proLocked).toBe(false);
  });

  it("gates every group function on the home garage's plan in SQL and never replaces protected functions", () => {
    expect(MIGRATION.match(/raise exception 'PLAN_REQUIRED: multi_site'/g)?.length).toBe(3);
    expect(MIGRATION).not.toMatch(/create or replace function public\.(create_booking|create_booking_at|available_slots|staff_available_slots|create_garage)\b/);
    expect(MIGRATION).toMatch(/create_garage\(caller, p_garage\)/);
  });
});
