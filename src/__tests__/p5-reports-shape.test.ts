import { describe, expect, it } from "vitest";
import { csvCell, safeCsvText, toCsv } from "@/lib/reports/csv";
import { smsSegmentCostPence } from "@/lib/reports/config";
import {
  efficiency,
  formatMinutes,
  formatShare,
  hoursCsv,
  hoursFromRows,
  isReportKind,
  reminderRoiCsv,
  reminderRoiFromRows,
  reportFileName,
  revenueCsv,
  revenueRowsFromService,
  revenueRowsFromTechnician,
  roiTotals,
  utilisationByResource,
  utilisationByWeek,
  utilisationCsv,
  utilisationFromRows,
} from "@/lib/reports/shape";

describe("P5.6 CSV safety", () => {
  it("prefixes formula starts with an apostrophe", () => {
    for (const value of ["=HYPERLINK(\"x\")", "+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(safeCsvText(value).startsWith("'")).toBe(true);
    }
    expect(safeCsvText("Brakes")).toBe("Brakes");
  });

  it("quotes text, doubles quotes and leaves our numbers plain", () => {
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell("=1+1")).toBe('"\'=1+1"');
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("writes a BOM and CRLF lines", () => {
    expect(toCsv(["A"], [["b"]])).toBe('﻿"A"\r\n"b"\r\n');
  });
});

describe("P5.6 report shaping", () => {
  const service = revenueRowsFromService([
    { service_id: "s1", service_name: "=cmd|' /C calc'!A0", bookings: 2, invoiced_pence: "9600", estimated_pence: 5000, total_pence: "14600" },
    { service_id: "s2", service_name: "Full service", bookings: 1, invoiced_pence: 0, estimated_pence: 15000, total_pence: 15000 },
  ]);

  it("reads bigint strings and builds a revenue CSV with a total row, injection-safe", () => {
    expect(service[0]).toMatchObject({ invoicedPence: 9600, totalPence: 14600 });
    const csv = revenueCsv(service, "Service");
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe('"Service","Bookings","Invoiced GBP","Estimated GBP (no invoice yet)","Total GBP"');
    expect(lines[1]).toBe(`"'=cmd|' /C calc'!A0",2,96,50,146`);
    expect(lines.at(-1)).toBe('"Total",3,96,200,296');
  });

  it("names the unassigned technician row", () => {
    const rows = revenueRowsFromTechnician([
      { technician_id: "u1", technician_name: "Tia Tech", bookings: 1, invoiced_pence: 0, estimated_pence: 100, total_pence: 100 },
      { technician_id: null, technician_name: null, bookings: 1, invoiced_pence: 0, estimated_pence: 100, total_pence: 100 },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Tia Tech", "Unassigned"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  const days = utilisationFromRows([
    { resource_id: "a", resource_name: "Bay A", resource_kind: "bay", day: "2026-10-24", open_minutes: 540, booked_minutes: 0 },
    { resource_id: "a", resource_name: "Bay A", resource_kind: "bay", day: "2026-10-25", open_minutes: 300, booked_minutes: 240 },
    { resource_id: "a", resource_name: "Bay A", resource_kind: "bay", day: "2026-10-26", open_minutes: 540, booked_minutes: 270 },
    { resource_id: "b", resource_name: "Bay B", resource_kind: "bay", day: "2026-10-25", open_minutes: 300, booked_minutes: 0 },
  ]);

  it("sums utilisation per bay and per ISO week (the 25-hour Sunday stays in its week)", () => {
    expect(utilisationByResource(days)).toEqual([
      { resourceId: "a", resourceName: "Bay A", resourceKind: "bay", openMinutes: 1380, bookedMinutes: 510 },
      { resourceId: "b", resourceName: "Bay B", resourceKind: "bay", openMinutes: 300, bookedMinutes: 0 },
    ]);
    expect(utilisationByWeek(days)).toEqual([
      { monday: "2026-10-19", openMinutes: 1140, bookedMinutes: 240 },
      { monday: "2026-10-26", openMinutes: 540, bookedMinutes: 270 },
    ]);
    expect(formatShare(240, 300)).toBe("80%");
    expect(formatShare(0, 0)).toBe("No open hours");
    expect(formatShare(1, 1000)).toBe("Under 1%");
    expect(formatShare(0, 1000)).toBe("0%");
    expect(utilisationCsv(days).split("\r\n")[2]).toBe('"2026-10-25","Bay A","bay",5,4,80');
  });

  it("hours: sold vs worked and minutes wording", () => {
    const rows = hoursFromRows([{ technician_id: "u1", technician_name: "Tia Tech", jobs: 2, measured_jobs: 1, sold_minutes: 120, worked_minutes: 150 }]);
    expect(efficiency(rows[0]!)).toBe("80%");
    expect(efficiency({ soldMinutes: 60, workedMinutes: 0 })).toBe("Not measured");
    expect(formatMinutes(150)).toBe("2 h 30 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(0)).toBe("0 h");
    expect(hoursCsv(rows).split("\r\n")[1]).toBe('"Tia Tech",2,1,2,2.5,80');
  });

  it("reminder ROI: SMS cost only when the per-segment cost is set; campaigns only when available", () => {
    const rows = reminderRoiFromRows([
      { kind: "mot", sent: 2, booked: 1, pence: "5000", sms_segments: "3" },
      { kind: "service", sent: 1, booked: 0, pence: 0, sms_segments: 0 },
    ]);
    expect(roiTotals(rows, null)).toEqual({ sent: 3, booked: 1, pence: 5000, smsSegments: 3, smsCostPence: null });
    expect(roiTotals(rows, 3.5).smsCostPence).toBe(11);
    const withoutCost = reminderRoiCsv(rows, { available: false, sent: 0, booked: 0, pence: 0 }, null);
    expect(withoutCost.split("\r\n")[0]).not.toContain("SMS cost");
    expect(withoutCost).not.toContain("Campaigns");
    const withCost = reminderRoiCsv(rows, { available: true, sent: 10, booked: 2, pence: 9000 }, 4);
    expect(withCost.split("\r\n")[0]).toContain("SMS cost GBP");
    expect(withCost).toContain('"Campaigns",10,2,90,,');
    expect(withCost).toContain('"MOT reminders",2,1,50,3,0.12');
  });

  it("file names hold the report and dates only", () => {
    expect(reportFileName("bay-utilisation", { from: "2026-10-01", to: "2026-10-31" })).toBe("pitline-bay-utilisation-2026-10-01-to-2026-10-31.csv");
    expect(isReportKind("hours")).toBe(true);
    expect(isReportKind("../etc")).toBe(false);
  });

  it("reads the SMS segment cost placeholder", () => {
    expect(smsSegmentCostPence({})).toBeNull();
    expect(smsSegmentCostPence({ SMS_SEGMENT_COST_PENCE: " " })).toBeNull();
    expect(smsSegmentCostPence({ SMS_SEGMENT_COST_PENCE: "3.5" })).toBe(3.5);
    expect(smsSegmentCostPence({ SMS_SEGMENT_COST_PENCE: "-1" })).toBeNull();
    expect(smsSegmentCostPence({ SMS_SEGMENT_COST_PENCE: "abc" })).toBeNull();
  });
});
