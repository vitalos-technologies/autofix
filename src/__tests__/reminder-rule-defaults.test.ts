// The default reminder rules inserted by seed_garage_defaults() use the
// DEFAULT_TEMPLATES wording, so the template editor's "reset to default" and
// new garages agree. The wording was first seeded by
// 20261028001000_reminders.sql (P3.6) and replaced by the one-text wording in
// 20261028002300_reminder_wording.sql (A184), which also moves rules still on
// the old default. pgTAP 013 and 026 check the rows a garage actually gets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { functionDefinition, migrationFiles } from "./support/migrations";
import { DEFAULT_TEMPLATES, hasOptOut, type TemplateKind } from "@/lib/messaging/templates";

const read = (file: string) => readFileSync(`supabase/migrations/${file}`, "utf8");
const original = read("20261028001000_reminders.sql");
const wording = read("20261028002300_reminder_wording.sql");

/** The body as a Postgres E'' string literal: newlines as \n, quotes doubled. */
function sqlLiteral(body: string) {
  return `E'${body.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("'", "''")}'`;
}

/** The E'' literals of the (kind, template) rows in a seed_default_reminder_rules() definition. */
function seededTemplates(definition: string) {
  const rows = new Map<string, string>();
  for (const match of definition.matchAll(/\(p_garage_id, '(\w+)', (?:true|false), '\{[\d,]*\}', '\w+',\s+(E'(?:[^']|'')*')\)/g)) {
    rows.set(match[1]!, match[2]!);
  }
  return rows;
}

const RULE_KINDS: TemplateKind[] = ["mot", "service", "review", "missed_call"];

describe("default reminder rules", () => {
  it("the latest migration that defines seed_default_reminder_rules() is the wording migration", () => {
    const defining = migrationFiles.filter((file) => /function public\.seed_default_reminder_rules\(/.test(read(file)));
    expect(defining.at(-1)).toBe("20261028002300_reminder_wording.sql");
  });

  it.each(RULE_KINDS)("new garages get the DEFAULT_TEMPLATES body for the %s rule", (kind) => {
    expect(seededTemplates(functionDefinition(wording, "seed_default_reminder_rules")).get(kind)).toBe(sqlLiteral(DEFAULT_TEMPLATES[kind].body));
  });

  it.each(RULE_KINDS)("rules still on the old %s default move to the new one, and only those", (kind) => {
    const old = seededTemplates(functionDefinition(original, "seed_default_reminder_rules")).get(kind)!;
    expect(old).toBeTruthy();
    const upgrade = functionDefinition(wording, "apply_one_text_reminder_wording");
    expect(upgrade).toContain(`('${kind}',\n     ${old},\n     ${sqlLiteral(DEFAULT_TEMPLATES[kind].body)})`);
    expect(upgrade).toMatch(/where existing\.kind = wording\.kind\n {4}and existing\.template = wording\.old_template;/);
    expect(wording).toContain("\nselect public.apply_one_text_reminder_wording();\n");
  });

  it("defaults leave the opt-out line to renderTemplate (not stored in the rule)", () => {
    for (const kind of RULE_KINDS) expect(hasOptOut(DEFAULT_TEMPLATES[kind].body)).toBe(false);
  });
});
