import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = join(process.cwd(), "supabase", "migrations");

/** Every migration file name, in the order Supabase applies them. */
export const migrationFiles = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

/** SOB Autofix's schema squashed at commit 35496ff (P1.6). */
export const baselineMigration = readFileSync(join(directory, "20261026000000_baseline.sql"), "utf8");

/** Garages, garage_id on every tenant table and garage-scoped RLS (P1.4, P1.5). */
export const tenancyMigration = readFileSync(join(directory, "20261026000100_tenancy.sql"), "utf8");

/** Scheduling engine: resources, services, bookings with no_overlap, available_slots(), create_booking() (P2.1-P2.3). */
export const schedulingMigration = readFileSync(join(directory, "20261027000100_scheduling.sql"), "utf8");

/** All migrations concatenated, for checks that must hold across the whole history. */
export const allMigrations = migrationFiles.map((file) => readFileSync(join(directory, file), "utf8")).join("\n");

/** The SQL statements of a migration without comment lines, split on semicolons outside dollar-quoted bodies. */
export function sqlStatements(source: string) {
  const sql = source.replace(/^[ \t]*--[^\n]*$/gm, "");
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  const dollarTag = /\$[a-z_]*\$/iy;
  for (let index = 0; index < sql.length; index += 1) {
    dollarTag.lastIndex = index;
    const tag = sql[index] === "$" ? dollarTag.exec(sql)?.[0] : undefined;
    if (tag && (quote === null || quote === tag)) {
      quote = quote === null ? tag : null;
      current += tag;
      index += tag.length - 1;
      continue;
    }
    const character = sql[index];
    if (character === ";" && quote === null) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** The full text of one function definition in a migration. */
export function functionDefinition(sql: string, name: string) {
  const start = sql.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`));
  if (start < 0) throw new Error(`Function ${name} is not defined in this migration`);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end < 0 ? undefined : end + 4);
}
