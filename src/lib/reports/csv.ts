// CSV for report exports (P5.6). Client-safe and pure.
//
// Spreadsheet formula injection: a text cell that starts with = + - @ (or a tab or carriage
// return, which some spreadsheets strip before reading a formula) is prefixed with an apostrophe,
// so it is shown as text and never run. Numbers we produce ourselves are written as plain numbers.

export type CsvValue = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function safeCsvText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return `"${safeCsvText(value).replaceAll('"', '""')}"`;
}

/** A whole CSV file: UTF-8 byte order mark (so Excel reads the £ sign), CRLF line ends. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [header.map((cell) => csvCell(cell)).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Pence as pounds with two decimals, as a number cell ("1234.5" → 1234.5). */
export function poundsCell(pence: number): number {
  return Math.round(pence) / 100;
}
