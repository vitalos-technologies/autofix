// Customer CSV import: parsing, header detection and row validation.
//
// Pure and client-safe (no env, no Node APIs), so the same code checks the
// file in the preview and again in the import action. Problems name the row
// and the field but never repeat a phone number or registration from the file.

import { z } from "zod";
import { toE164UK } from "@/lib/messaging/phone";
import { normalizeRegistration } from "@/lib/vehicle/registration-format";

export const IMPORT_FIELDS = ["name", "firstName", "lastName", "mobile", "email", "registration", "consent"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Largest file the import accepts. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Most data rows in one file. */
export const MAX_IMPORT_ROWS = 5000;

// Header cells are compared lower case with everything but letters and digits removed.
const HEADER_ALIASES: Record<ImportField, string[]> = {
  name: ["name", "fullname", "customer", "customername", "contactname", "contact", "client", "clientname", "owner", "ownername"],
  firstName: ["firstname", "forename", "givenname", "first"],
  lastName: ["lastname", "surname", "familyname", "last"],
  mobile: [
    "mobile", "mobileno", "mobilenumber", "mobilephone", "mob", "phone", "phoneno", "phonenumber", "telephone",
    "telephonenumber", "tel", "cell", "cellphone", "contactnumber", "smsnumber",
  ],
  email: ["email", "emailaddress", "mail", "emails"],
  registration: [
    "registration", "reg", "regno", "regnumber", "registrationnumber", "registrationno", "vrm", "numberplate",
    "plate", "vehiclereg", "vehicleregistration", "carreg", "carregistration", "registrationmark",
  ],
  consent: [
    "consent", "reminders", "reminderconsent", "remindersconsent", "marketing", "marketingconsent", "optin", "optedin",
    "smsconsent", "contactconsent", "sendreminders", "reminder",
  ],
};

const ALIAS_LOOKUP = new Map<string, ImportField>(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [alias, field as ImportField])),
);

export function normaliseHeader(cell: string) {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type ColumnMap = Partial<Record<ImportField, number>>;

/** Maps header cells to fields; the first matching column wins. */
export function detectColumns(header: readonly string[]): ColumnMap {
  const columns: ColumnMap = {};
  header.forEach((cell, index) => {
    const field = ALIAS_LOOKUP.get(normaliseHeader(cell));
    if (field && columns[field] === undefined) columns[field] = index;
  });
  return columns;
}

function hasRequiredColumns(columns: ColumnMap) {
  return columns.mobile !== undefined && (columns.name !== undefined || columns.firstName !== undefined || columns.lastName !== undefined);
}

/** Picks the delimiter that splits the first line into the most cells. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const counts = ([",", ";", "\t"] as const).map((delimiter) => ({
    delimiter,
    count: firstLine.split(delimiter).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0] && counts[0].count > 0 ? counts[0].delimiter : ",";
}

/**
 * RFC 4180 CSV: quoted fields with "" escapes, embedded delimiters and line
 * breaks, CRLF/LF/CR endings and a UTF-8 byte-order mark. Returns every record
 * with its 1-based line number; blank lines are dropped.
 */
export function parseCsv(input: string, delimiter = detectDelimiter(input.replace(/^﻿/, ""))) {
  const text = input.replace(/^﻿/, "");
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== "")) records.push({ line: recordLine, cells });
    cells = [];
    cell = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      cell += char;
    }
  }
  if (cell !== "" || cells.length) endRecord();
  return records;
}

// UK registrations: current (AB12 CDE), prefix (A123 BCD), suffix (ABC 123D),
// dateless and Northern Irish (ABZ 1234, 1234 AB).
const UK_REGISTRATION = [
  /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/,
  /^[A-Z][0-9]{1,3}[A-Z]{3}$/,
  /^[A-Z]{3}[0-9]{1,3}[A-Z]$/,
  /^[A-Z]{1,3}[0-9]{1,4}$/,
  /^[0-9]{1,4}[A-Z]{1,3}$/,
];

/** True for a normalised registration in one of the UK formats. */
export function isUkRegistration(normalised: string) {
  return normalised.length >= 2 && normalised.length <= 7 && UK_REGISTRATION.some((pattern) => pattern.test(normalised));
}

const YES = new Set(["yes", "y", "true", "t", "1", "x", "ok", "optedin", "optin", "agreed", "consented"]);
const NO = new Set(["", "no", "n", "false", "f", "0", "optedout", "optout", "none"]);

/** Consent cell: yes/no words, or null when it cannot be read. */
export function parseConsent(value: string): boolean | null {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (YES.has(key)) return true;
  if (NO.has(key)) return false;
  return null;
}

const emailSchema = z.string().email().max(254);

/**
 * A spreadsheet can store a mobile as a number: the leading 0 goes
 * (7700900123), and some exports add ".0" or show scientific notation
 * (7.7009E+09), which has lost digits and cannot be recovered.
 */
export function normaliseImportMobile(value: string): { phone: string } | { error: string } {
  const trimmed = value.trim().replace(/^'/, "");
  if (!trimmed) return { error: "Mobile number is missing" };
  if (/^\d(\.\d+)?e\+?\d+$/i.test(trimmed)) return { error: "Mobile number was shortened by a spreadsheet (format the column as text)" };
  const phone = toE164UK(trimmed.replace(/\.0+$/, ""));
  return phone ? { phone } : { error: "Not a UK mobile number" };
}

export type ImportRow = {
  /** Line in the file (the header is usually line 1). */
  row: number;
  name: string;
  /** E.164 */
  phone: string;
  email: string | null;
  /** Normalised (upper case, no spaces), or null when the row has no car. */
  registration: string | null;
  consent: boolean;
};

export type ImportIssueField = "name" | "mobile" | "email" | "registration" | "consent" | "row";
export type ImportIssue = { row: number; field: ImportIssueField; message: string };

export type ParsedImport = {
  /** Whole-file problem (no header, too big, no rows); nothing can be imported. */
  fatal: string | null;
  /** Header cell used for each field. */
  columns: Partial<Record<ImportField, string>>;
  hasConsentColumn: boolean;
  /** Data rows in the file. */
  totalRows: number;
  rows: ImportRow[];
  /** Rows that cannot be imported. */
  errors: ImportIssue[];
  /** Imported, with something dropped (e.g. an invalid email). */
  warnings: ImportIssue[];
  /** Rows that repeat an earlier row (same mobile and registration); skipped. */
  duplicates: Array<{ row: number; firstRow: number }>;
};

function emptyParse(fatal: string): ParsedImport {
  return { fatal, columns: {}, hasConsentColumn: false, totalRows: 0, rows: [], errors: [], warnings: [], duplicates: [] };
}

/** Parses and validates a customer CSV. */
export function parseCustomerCsv(text: string): ParsedImport {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return emptyParse("The file is larger than 2 MB. Split it into smaller files.");
  const records = parseCsv(text);
  if (!records.length) return emptyParse("The file is empty.");

  // Some exports put a title above the headings: look at the first five lines.
  const headerIndex = records.slice(0, 5).findIndex((record) => hasRequiredColumns(detectColumns(record.cells)));
  if (headerIndex < 0) {
    return emptyParse("We couldn't find the column headings. The first row needs at least a name and a mobile column.");
  }
  const header = records[headerIndex]!;
  const map = detectColumns(header.cells);
  const columns: ParsedImport["columns"] = {};
  for (const field of IMPORT_FIELDS) {
    const index = map[field];
    if (index !== undefined) columns[field] = header.cells[index]!.trim();
  }

  const dataRecords = records.slice(headerIndex + 1);
  if (!dataRecords.length) return { ...emptyParse("The file has headings but no customers."), columns };
  if (dataRecords.length > MAX_IMPORT_ROWS) {
    return { ...emptyParse(`The file has ${dataRecords.length.toLocaleString("en-GB")} rows; import at most ${MAX_IMPORT_ROWS.toLocaleString("en-GB")} at a time.`), columns };
  }

  const result: ParsedImport = {
    fatal: null,
    columns,
    hasConsentColumn: map.consent !== undefined,
    totalRows: dataRecords.length,
    rows: [],
    errors: [],
    warnings: [],
    duplicates: [],
  };
  const cell = (cells: string[], field: ImportField) => {
    const index = map[field];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };
  const seenRows = new Map<string, number>();
  const registrationOwners = new Map<string, { phone: string; row: number }>();

  for (const { line, cells } of dataRecords) {
    const rowErrors: ImportIssue[] = [];
    const name = (cell(cells, "name") || [cell(cells, "firstName"), cell(cells, "lastName")].filter(Boolean).join(" "))
      .replace(/\s+/g, " ")
      .trim();
    if (!name) rowErrors.push({ row: line, field: "name", message: "Name is missing" });
    else if (name.length > 120) rowErrors.push({ row: line, field: "name", message: "Name is longer than 120 characters" });

    const mobile = normaliseImportMobile(cell(cells, "mobile"));
    if ("error" in mobile) rowErrors.push({ row: line, field: "mobile", message: mobile.error });

    const rawRegistration = cell(cells, "registration");
    const registration = rawRegistration ? normalizeRegistration(rawRegistration) : "";
    if (rawRegistration && !isUkRegistration(registration)) {
      rowErrors.push({ row: line, field: "registration", message: "Not a UK registration" });
    }

    let consent = true;
    if (map.consent !== undefined) {
      const parsed = parseConsent(cell(cells, "consent"));
      if (parsed === null) rowErrors.push({ row: line, field: "consent", message: "Consent should be yes or no" });
      else consent = parsed;
    }

    if (rowErrors.length || "error" in mobile) {
      result.errors.push(...rowErrors);
      continue;
    }

    const rawEmail = cell(cells, "email").toLowerCase();
    let email: string | null = null;
    if (rawEmail) {
      if (emailSchema.safeParse(rawEmail).success) email = rawEmail;
      else result.warnings.push({ row: line, field: "email", message: "Email address is not valid and was left out" });
    }

    const key = `${mobile.phone}|${registration}`;
    const firstRow = seenRows.get(key);
    if (firstRow !== undefined) {
      result.duplicates.push({ row: line, firstRow });
      continue;
    }
    if (registration) {
      const owner = registrationOwners.get(registration);
      if (owner && owner.phone !== mobile.phone) {
        result.errors.push({ row: line, field: "registration", message: `Same registration as row ${owner.row} with a different mobile` });
        continue;
      }
      registrationOwners.set(registration, { phone: mobile.phone, row: line });
    }
    seenRows.set(key, line);
    result.rows.push({ row: line, name, phone: mobile.phone, email, registration: registration || null, consent });
  }
  return result;
}

/** Rows grouped into batches of at most `size`, keeping each mobile's rows together. */
export function importBatches(rows: readonly ImportRow[], size = 500): ImportRow[][] {
  const byPhone = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const group = byPhone.get(row.phone);
    if (group) group.push(row);
    else byPhone.set(row.phone, [row]);
  }
  const batches: ImportRow[][] = [];
  let current: ImportRow[] = [];
  for (const group of byPhone.values()) {
    if (current.length && current.length + group.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** `+447700900123` as `07700 900123` for staff screens; anything else unchanged. */
export function formatUkMobile(phone: string | null | undefined) {
  if (!phone) return "";
  return /^\+447\d{9}$/.test(phone) ? `0${phone.slice(3, 7)} ${phone.slice(7)}` : phone;
}
