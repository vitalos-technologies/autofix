import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationFiles, sqlStatements } from "./support/migrations";

const FILE = "20261030000100_one_month_trial.sql";
const source = readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");
const statements = sqlStatements(source);

describe("one-month free trial migration (DECISIONS D25)", () => {
  it("runs after the plans and multi-site migrations it builds on", () => {
    expect(migrationFiles).toContain(FILE);
    expect(migrationFiles.indexOf(FILE)).toBeGreaterThan(migrationFiles.indexOf("20261029000900_multi_site.sql"));
    expect(migrationFiles.indexOf(FILE)).toBeGreaterThan(migrationFiles.indexOf("20261029003200_pitline_free_links.sql"));
  });

  it("gives new garages one calendar month", () => {
    expect(statements).toContain("alter table public.garages\n  alter column trial_ends_at set default (now() + interval '1 month')");
  });

  it("extends only running, unchosen Pro trials, to one month after sign-up, never shortening one", () => {
    const updates = statements.filter((statement) => statement.startsWith("update"));
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update).toContain("set trial_ends_at = g.created_at + interval '1 month'");
    expect(update).toContain("g.plan = 'pro'");
    expect(update).toContain("g.plan_chosen is null");
    expect(update).toContain("g.trial_ends_at > now()");
    // Never shorter, and a second run matches nothing (the end already equals created_at + 1 month).
    expect(update).toContain("g.created_at + interval '1 month' > g.trial_ends_at");
  });

  it("leaves group sites to follow their home garage through garages_group_plan_sync", () => {
    expect(statements.find((statement) => statement.startsWith("update"))).toMatch(
      /not exists \(\s*select 1 from public\.garage_group_sites site\s*where site\.garage_id = g\.id\s*and site\.home_garage_id <> g\.id\)/,
    );
  });
});

describe("card-first billing migration (DECISIONS D26)", () => {
  const cardFirst = sqlStatements(readFileSync(join(process.cwd(), "supabase", "migrations", "20261030000200_card_first_billing.sql"), "utf8"));

  it("adds card_required, false for every garage that exists today", () => {
    expect(migrationFiles.indexOf("20261030000200_card_first_billing.sql")).toBeGreaterThan(migrationFiles.indexOf(FILE));
    expect(cardFirst).toContain("alter table public.garages\n  add column card_required boolean not null default false");
    expect(cardFirst.filter((statement) => statement.startsWith("update"))).toEqual([]);
  });
});
