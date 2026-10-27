// The default reminder rules inserted by seed_garage_defaults() (migration
// 20261028001000_reminders.sql, P3.6) use the DEFAULT_TEMPLATES wording, so the
// template editor's "reset to default" and new garages agree. pgTAP 013 checks
// the rows a garage actually gets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, hasOptOut, type TemplateKind } from "@/lib/messaging/templates";

const migration = readFileSync("supabase/migrations/20261028001000_reminders.sql", "utf8");

/** The body as a Postgres E'' string literal: newlines as \n, quotes doubled. */
function sqlLiteral(body: string) {
  return `E'${body.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("'", "''")}'`;
}

const RULE_KINDS: TemplateKind[] = ["mot", "service", "review", "missed_call"];

describe("default reminder rules", () => {
  it.each(RULE_KINDS)("the %s rule uses the DEFAULT_TEMPLATES body", (kind) => {
    expect(migration).toContain(`(p_garage_id, '${kind}', `);
    expect(migration).toContain(sqlLiteral(DEFAULT_TEMPLATES[kind].body));
  });

  it("defaults leave the opt-out line to renderTemplate (not stored in the rule)", () => {
    for (const kind of RULE_KINDS) expect(hasOptOut(DEFAULT_TEMPLATES[kind].body)).toBe(false);
  });
});
