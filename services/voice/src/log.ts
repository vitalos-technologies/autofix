// One JSON line per event. Ids, codes, counts and timings only: never a caller number, a registration, a
// transcript, a token or a key (CLAUDE.md rule 3, registration privacy).

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type Logger = { info(event: string, fields?: LogFields): void; warn(event: string, fields?: LogFields): void; error(event: string, fields?: LogFields): void };

function write(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  const line = JSON.stringify({ level, scope: "autofix_voice", event, ...fields, at: new Date().toISOString() });
  if (level === "info") console.info(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}

export const log: Logger = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};

/** A safe code for an error: its name or a status, never its message (which may echo input). */
export function errorCode(error: unknown) {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return `http_${status}`;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
  }
  return "unknown";
}
