// UK geographic area codes (D22): a garage's AI desk number is looked for in its own area first, e.g. a
// Doncaster garage on 01302 gets an 01302 number when Twilio has one. Pure.
//
// The UK plan (after the trunk 0): 02x is a two-digit code (020 London, 023, 024, 028, 029); 011x and 01x1 are
// three digits (0113 Leeds, 0114 Sheffield, 0121 Birmingham, 0161 Manchester…); every other 01 code is four
// digits (01302 Doncaster). A handful of five-digit codes (e.g. 017687 Keswick) share their first four digits
// with a wider area, so the four-digit code still finds a local number. Mobiles, 03 and anything else have no
// area: any UK local number will do.

import { toE164UK } from "@/lib/messaging/phone";

/** The national digits of the area code (`1302`, `114`, `20`), or null when the number has no geographic area. */
export function ukAreaCode(phone: string | null | undefined): string | null {
  const e164 = toE164UK(phone ?? null, { allowLandline: true });
  if (!e164) return null;
  const national = e164.slice(3);
  if (national.startsWith("2")) return national.slice(0, 2);
  if (!national.startsWith("1")) return null;
  if (national[1] === "1" || national[2] === "1") return national.slice(0, 3);
  return national.slice(0, 4);
}

/** Twilio's `Contains` pattern for numbers starting with the area code, e.g. `+441302`. */
export function areaCodePattern(areaCode: string): string {
  return `+44${areaCode}`;
}
