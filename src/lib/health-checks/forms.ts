// Form parsing for the admin health check editor (P5.3). Client-safe and pure (unit tested).

import { HEALTH_CHECK_RATINGS, HEALTH_CHECK_SECTIONS, LIMITS, parsePriceInput, type HealthCheckRating, type HealthCheckSection } from "./checklist";

export type ItemField = "rating" | "note" | "work" | "price" | "label" | "section";

export type ItemWrite = { rating: HealthCheckRating; note: string | null; recommended_work: string | null; price_pence: number | null };

export type Parsed<T> = { ok: true; value: T } | { ok: false; fieldErrors: Partial<Record<ItemField | "summary" | "mileage", string>> };

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

/** One checklist line: rating, note, and recommended work with its price (both or neither). */
export function parseItemForm(formData: FormData): Parsed<ItemWrite> {
  const errors: Partial<Record<ItemField, string>> = {};
  const rating = text(formData.get("rating"));
  if (!(HEALTH_CHECK_RATINGS as readonly string[]).includes(rating)) errors.rating = "Choose red, amber, green or not checked.";
  const note = text(formData.get("note"));
  if (note.length > LIMITS.note) errors.note = `Keep the note under ${LIMITS.note} characters.`;
  const work = text(formData.get("work"));
  if (work.length > LIMITS.work) errors.work = `Keep the work description under ${LIMITS.work} characters.`;
  const priceInput = text(formData.get("price"));
  let price: number | null = null;
  if (priceInput) {
    price = parsePriceInput(priceInput);
    if (price === null) errors.price = "Enter a price in pounds, for example 89.50.";
  }
  if (work && !priceInput) errors.price = "Add a price for the recommended work.";
  if (!work && priceInput && !errors.price) errors.work = "Say what the work is, or clear the price.";
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      rating: rating as HealthCheckRating,
      note: note || null,
      recommended_work: work || null,
      price_pence: work ? price : null,
    },
  };
}

/** A line the technician adds (section and label). */
export function parseNewItemForm(formData: FormData): Parsed<{ section: HealthCheckSection; label: string }> {
  const errors: Partial<Record<ItemField, string>> = {};
  const section = text(formData.get("section"));
  const label = text(formData.get("label"));
  if (!(HEALTH_CHECK_SECTIONS as readonly string[]).includes(section)) errors.section = "Choose a section.";
  if (!label) errors.label = "Say what you checked.";
  else if (label.length > LIMITS.label) errors.label = `Keep it under ${LIMITS.label} characters.`;
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { section: section as HealthCheckSection, label } };
}

/** The note to the customer and the mileage. */
export function parseSummaryForm(formData: FormData): Parsed<{ summary: string | null; mileage: number | null }> {
  const errors: Partial<Record<"summary" | "mileage", string>> = {};
  const summary = text(formData.get("summary"));
  if (summary.length > LIMITS.summary) errors.summary = `Keep it under ${LIMITS.summary} characters.`;
  const mileageInput = text(formData.get("mileage")).replaceAll(",", "");
  let mileage: number | null = null;
  if (mileageInput) {
    if (!/^\d{1,7}$/.test(mileageInput) || Number(mileageInput) > LIMITS.maxMileage) errors.mileage = "Enter the mileage as a whole number.";
    else mileage = Number(mileageInput);
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { summary: summary || null, mileage } };
}
