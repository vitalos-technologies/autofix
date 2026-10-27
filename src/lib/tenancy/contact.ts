/**
 * Display helpers for a garage's contact details. Pure and client-safe, so the
 * booking wizard and server-rendered emails format numbers the same way.
 * Garage phone numbers are stored in E.164 (`garages.phone`, `garages.whatsapp`).
 */

export type ContactAddress = {
  line1?: string | null;
  line2?: string | null;
  town?: string | null;
  postcode?: string | null;
};

/** `+441302000101` → `01302 000101`; `+447700900123` → `07700 900123`. Other numbers pass through. */
export function formatPhoneForDisplay(value: string | null | undefined): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, "");
  if (/^\+44\d{9,10}$/.test(compact)) {
    const national = `0${compact.slice(3)}`;
    if (national.length === 11) {
      return national.startsWith("02") ? `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}` : `${national.slice(0, 5)} ${national.slice(5)}`;
    }
    return national;
  }
  return value.trim();
}

/** `tel:` link for an E.164 (or national UK) number, or null when there is none. */
export function telHref(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return `tel:${digits}`;
  if (digits.startsWith("0")) return `tel:+44${digits.slice(1)}`;
  return `tel:${digits}`;
}

/** `https://wa.me/<number>` link, or null when the garage has no WhatsApp number. */
export function whatsappHref(value: string | null | undefined): string | null {
  const href = telHref(value);
  return href ? `https://wa.me/${href.slice("tel:".length).replace(/^\+/, "")}` : null;
}

/** Non-empty address lines in display order. */
export function addressLines(address: ContactAddress | null | undefined): string[] {
  if (!address) return [];
  return [address.line1, address.line2, address.town, address.postcode]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
}

/** The address on one line, e.g. "4 Hartley Road, Doncaster, DN1 2AB". */
export function addressLine(address: ContactAddress | null | undefined): string {
  return addressLines(address).join(", ");
}
