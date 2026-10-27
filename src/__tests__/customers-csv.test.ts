import { describe, expect, it } from "vitest";
import {
  detectColumns,
  detectDelimiter,
  formatUkMobile,
  importBatches,
  isUkRegistration,
  MAX_IMPORT_ROWS,
  normaliseImportMobile,
  parseConsent,
  parseCsv,
  parseCustomerCsv,
  type ImportRow,
} from "@/lib/customers/csv";
import { importDeclaration } from "@/lib/customers/declaration";

// Customer CSV import (P3.11). Numbers are in Ofcom's drama range.

describe("parseCsv", () => {
  it("reads quoted fields with commas, escaped quotes and line breaks", () => {
    const records = parseCsv('Name,Notes\r\n"Smith, Sam","Said ""hi""\nthen left"\r\nAlex,plain\r\n');
    expect(records).toEqual([
      { line: 1, cells: ["Name", "Notes"] },
      { line: 2, cells: ["Smith, Sam", 'Said "hi"\nthen left'] },
      { line: 4, cells: ["Alex", "plain"] },
    ]);
  });

  it("drops a byte-order mark and blank lines and keeps line numbers", () => {
    const records = parseCsv("﻿Name,Mobile\n\n,\nSam,07700900123");
    expect(records).toEqual([
      { line: 1, cells: ["Name", "Mobile"] },
      { line: 4, cells: ["Sam", "07700900123"] },
    ]);
  });

  it("detects semicolon and tab separated files", () => {
    expect(detectDelimiter("Name;Mobile;Reg\nSam;0770;AB12")).toBe(";");
    expect(detectDelimiter("Name\tMobile\nSam\t0770")).toBe("\t");
    expect(detectDelimiter("Name")).toBe(",");
    expect(parseCsv("Name;Mobile\nSam;07700 900123")[1]?.cells).toEqual(["Sam", "07700 900123"]);
  });
});

describe("header detection", () => {
  it.each([
    [["Name", "Mobile", "Email", "Registration", "Consent"], { name: 0, mobile: 1, email: 2, registration: 3, consent: 4 }],
    [["Customer Name", "Phone Number", "E-mail Address", "Reg No.", "Opt-in"], { name: 0, mobile: 1, email: 2, registration: 3, consent: 4 }],
    [["VRM", "Tel", "Full name"], { registration: 0, mobile: 1, name: 2 }],
    [["First name", "Surname", "Mobile phone", "Number plate", "SMS consent"], { firstName: 0, lastName: 1, mobile: 2, registration: 3, consent: 4 }],
    [["CUSTOMER", "MOB", "VEHICLE REG", "Reminders"], { name: 0, mobile: 1, registration: 2, consent: 3 }],
  ])("maps %j", (header, expected) => {
    expect(detectColumns(header)).toEqual(expected);
  });

  it("uses the first matching column when two could match", () => {
    expect(detectColumns(["Mobile", "Phone", "Name"])).toEqual({ mobile: 0, name: 2 });
  });

  it("finds the heading row under a title row", () => {
    const parsed = parseCustomerCsv("Customer export 27/10/2026\nName,Mobile\nSam Driver,07700 900123\n");
    expect(parsed.fatal).toBeNull();
    expect(parsed.rows).toEqual([{ row: 3, name: "Sam Driver", phone: "+447700900123", email: null, registration: null, consent: true }]);
  });

  it("joins first name and surname", () => {
    const parsed = parseCustomerCsv("Forename,Surname,Mobile\nSam,Driver,07700900123");
    expect(parsed.rows[0]?.name).toBe("Sam Driver");
    expect(parsed.columns).toEqual({ firstName: "Forename", lastName: "Surname", mobile: "Mobile" });
  });

  it("explains a file without name and mobile headings", () => {
    expect(parseCustomerCsv("Make,Model\nFord,Focus").fatal).toMatch(/column headings/);
    expect(parseCustomerCsv("").fatal).toMatch(/empty/);
    expect(parseCustomerCsv("Name,Mobile\n").fatal).toMatch(/no customers/);
  });

  it("refuses files with too many rows", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => `C${index},07700900${String(index % 1000).padStart(3, "0")}`);
    expect(parseCustomerCsv(["Name,Mobile", ...rows].join("\n")).fatal).toMatch(/at most 5,000/);
  });
});

describe("mobile normalisation", () => {
  it.each([
    ["07700 900123", "+447700900123"],
    ["+44 7700 900123", "+447700900123"],
    ["+44 (0)7700 900123", "+447700900123"],
    ["447700900123", "+447700900123"],
    ["0044 7700 900123", "+447700900123"],
    // Excel stored the column as a number: the leading 0 is gone.
    ["7700900123", "+447700900123"],
    ["7700900123.0", "+447700900123"],
    ["'07700900123", "+447700900123"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseImportMobile(input)).toEqual({ phone: expected });
  });

  it.each([
    ["", "Mobile number is missing"],
    ["7.7009E+09", "Mobile number was shortened by a spreadsheet (format the column as text)"],
    ["01302 123456", "Not a UK mobile number"],
    ["+33 6 12 34 56 78", "Not a UK mobile number"],
    ["0770090012", "Not a UK mobile number"],
  ])("rejects %j", (input, message) => {
    expect(normaliseImportMobile(input)).toEqual({ error: message });
  });

  it("formats stored mobiles for staff", () => {
    expect(formatUkMobile("+447700900123")).toBe("07700 900123");
    expect(formatUkMobile("+33612345678")).toBe("+33612345678");
    expect(formatUkMobile(null)).toBe("");
  });
});

describe("registration and consent cells", () => {
  it.each(["AB12CDE", "A123BCD", "ABC123D", "K1", "1ABC", "ABZ1234", "AB51ABC"])("accepts %s", (registration) => {
    expect(isUkRegistration(registration)).toBe(true);
  });

  it.each(["", "A", "ABCDEFGH", "12345678", "AB12CDEF", "AB1C2D"])("rejects %j", (registration) => {
    expect(isUkRegistration(registration)).toBe(false);
  });

  it.each([["yes", true], ["Y", true], ["TRUE", true], ["1", true], ["x", true], ["Opted in", true], ["no", false], ["", false], ["0", false], ["opt-out", false], ["maybe", null]])(
    "consent %j → %s",
    (value, expected) => {
      expect(parseConsent(value)).toBe(expected);
    },
  );
});

describe("parseCustomerCsv", () => {
  const csv = [
    "Name,Mobile,Email,Registration,Consent",
    "Sam Driver,07700 900123,SAM@Example.com,ab12 cde,yes", // 2 ok
    "Sam Driver,07700900123,,XY65ZZZ,yes", // 3 same customer, second car
    "Sam Again,+447700900123,,AB12CDE,no", // 4 duplicate of row 2
    ",07700 900124,,,yes", // 5 no name
    "Bad Mobile,01302 123456,,,yes", // 6 landline
    "Bad Reg,07700 900125,,NOTAREG1,yes", // 7 bad registration
    "Bad Consent,07700 900126,,,perhaps", // 8 unreadable consent
    "Other Owner,07700 900127,,AB12 CDE,yes", // 9 same car as row 2, other mobile
    "Bad Email,07700 900128,not-an-email,,no", // 10 warning only
    "Excel Mangled,7700900129,,,Y", // 11 leading zero lost
  ].join("\n");

  const parsed = parseCustomerCsv(csv);

  it("keeps valid rows, normalised", () => {
    expect(parsed.fatal).toBeNull();
    expect(parsed.totalRows).toBe(10);
    expect(parsed.rows).toEqual<ImportRow[]>([
      { row: 2, name: "Sam Driver", phone: "+447700900123", email: "sam@example.com", registration: "AB12CDE", consent: true },
      { row: 3, name: "Sam Driver", phone: "+447700900123", email: null, registration: "XY65ZZZ", consent: true },
      { row: 10, name: "Bad Email", phone: "+447700900128", email: null, registration: null, consent: false },
      { row: 11, name: "Excel Mangled", phone: "+447700900129", email: null, registration: null, consent: true },
    ]);
  });

  it("reports each bad row by line and field, without the value", () => {
    expect(parsed.errors).toEqual([
      { row: 5, field: "name", message: "Name is missing" },
      { row: 6, field: "mobile", message: "Not a UK mobile number" },
      { row: 7, field: "registration", message: "Not a UK registration" },
      { row: 8, field: "consent", message: "Consent should be yes or no" },
      { row: 9, field: "registration", message: "Same registration as row 2 with a different mobile" },
    ]);
    expect(JSON.stringify(parsed.errors)).not.toMatch(/0770|NOTAREG|AB12/);
  });

  it("skips duplicates within the file and warns about dropped emails", () => {
    expect(parsed.duplicates).toEqual([{ row: 4, firstRow: 2 }]);
    expect(parsed.warnings).toEqual([{ row: 10, field: "email", message: "Email address is not valid and was left out" }]);
  });

  it("treats every row as consenting when the file has no consent column", () => {
    const withoutConsent = parseCustomerCsv("Name,Mobile\nSam,07700900123");
    expect(withoutConsent.hasConsentColumn).toBe(false);
    expect(withoutConsent.rows[0]?.consent).toBe(true);
  });
});

describe("importBatches", () => {
  const row = (index: number, phone = `+4477009${String(index).padStart(5, "0")}`): ImportRow => ({
    row: index + 2, name: `C${index}`, phone, email: null, registration: null, consent: true,
  });

  it("splits into batches and keeps a mobile's rows together", () => {
    const rows = [row(0), row(1), row(2, "+447700900000"), row(3)];
    const batches = importBatches(rows, 2);
    expect(batches.map((batch) => batch.map((item) => item.row))).toEqual([[2, 4], [3, 5]]);
  });

  it("makes two batches of 500 from 1,000 rows", () => {
    const batches = importBatches(Array.from({ length: 1000 }, (_, index) => row(index)));
    expect(batches.map((batch) => batch.length)).toEqual([500, 500]);
  });
});

describe("importDeclaration", () => {
  it("is the legal wording with the garage's name", () => {
    expect(importDeclaration("Hartley Road Garage")).toBe(
      "I confirm these customers gave their details to Hartley Road Garage when buying or booking a service, were told they could opt out of reminders, and have not opted out, or have given consent to receive reminders.",
    );
  });
});
