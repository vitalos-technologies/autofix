// Structured job logs: one JSON line per event, carrying the job id, kind and
// garage_id (SPEC "Observability"). Callers pass counts and codes only: never
// payloads, phone numbers, registrations, message bodies, tokens or secrets.

import type { JobLogFields, JobLogger } from "./types";

type Level = "info" | "warn" | "error";
export type LogSink = (level: Level, line: string) => void;

const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

/** Values kept in a log line: short strings, numbers, booleans and null. Anything else is dropped. */
function clean(fields: JobLogFields) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

export function createJobLogger(base: JobLogFields = {}, sink: LogSink = consoleSink): JobLogger {
  const write = (level: Level, event: string, fields: JobLogFields = {}) => {
    sink(level, JSON.stringify({ scope: "jobs", level, event, ...clean(base), ...clean(fields) }));
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
