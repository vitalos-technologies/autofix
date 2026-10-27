const dateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });

/** "27 Oct 2026, 14:05" in UK time, or "Never". */
export function formatWhen(value: string | null | undefined, fallback = "Never") {
  return value ? dateTime.format(new Date(value)) : fallback;
}

export function formatDate(value: string | null | undefined, fallback = "–") {
  return value ? date.format(new Date(value)) : fallback;
}

/** "3 h 20 min" style age from now. */
export function formatAge(value: string | null | undefined, now = Date.now()) {
  if (!value) return "None waiting";
  const minutes = Math.max(0, Math.round((now - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}
