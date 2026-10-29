import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationFiles, sqlStatements } from "./support/migrations";

const FILE = "20261029003000_pitline_free_links.sql";
const source = readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");
const statements = sqlStatements(source);

describe("Pitline free-link migration (DECISIONS D23)", () => {
  it("runs after every earlier migration", () => {
    expect(migrationFiles).toContain(FILE);
    expect(migrationFiles.indexOf(FILE)).toBeGreaterThan(migrationFiles.indexOf("20261029002000_ai_voice_desk.sql"));
  });

  it("rewrites only free-link rows ending in the old root, and never onto a live hostname", () => {
    const updates = statements.filter((statement) => statement.startsWith("update"));
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update).toMatch(/^update public\.garage_domains d\n/);
    expect(update).toContain("where d.kind = 'subdomain'");
    // An exact suffix (with its leading dot), not a LIKE pattern: lookalikes such as xautofix.vitalos.co.uk stay.
    expect(update).toContain("right(d.hostname, char_length('.autofix.vitalos.co.uk')) = '.autofix.vitalos.co.uk'");
    expect(update).not.toMatch(/\blike\b/i);
    expect(update).toContain("left(d.hostname, -char_length('.autofix.vitalos.co.uk')) || '.pitline.co.uk'");
    expect(update).toMatch(/and not exists \([\s\S]*other\.deleted_at is null[\s\S]*other\.hostname = /);
  });

  it("touches nothing else but the garages comment", () => {
    const others = statements.filter((statement) => !statement.startsWith("update"));
    expect(others).toEqual(["comment on table public.garages is 'One row per tenant. The slug gives the free link <slug>.pitline.co.uk.'"]);
  });

  it("documents a rollback that mirrors the update", () => {
    expect(source).toContain("-- Rollback (manual, the same statement the other way round):");
    expect(source).toContain("--      set hostname = left(d.hostname, -char_length('.pitline.co.uk')) || '.autofix.vitalos.co.uk'");
    expect(source).toContain("--    where d.kind = 'subdomain'");
  });
});
