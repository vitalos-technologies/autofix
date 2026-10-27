import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// P1.3: business facts come from the request's garage (getGarage(), the admin
// context or GarageProvider), never from a single-business config file.

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx|css|svg)$/.test(entry) ? [path] : [];
  });
}

/** Source text without comments, so history notes about SOB stay allowed. */
function withoutComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = sourceFiles(join(root, "src"));

describe("garage facts instead of single-business config", () => {
  it("has no single-business config modules left", () => {
    for (const path of ["src/config/site.ts", "src/config/settings.ts", "src/config/invoicing.ts", "src/lib/settings/repository.ts"]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  it("never imports the removed config or the email allowlist", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, relative(root, file)).not.toMatch(/config\/(site|settings|invoicing)["']/);
      expect(text, relative(root, file)).not.toMatch(/isAllowedAdminEmail|ADMIN_EMAILS?\b/);
    }
  });

  it("keeps SOB's name, domain and addresses out of shipped code", () => {
    for (const file of files) {
      const code = withoutComments(readFileSync(file, "utf8"));
      expect(code, relative(root, file)).not.toMatch(/SOB Autofix|sobautofix|SOB AUTOFIX|07469273483|DN6 9HF/i);
    }
  });

  it("keeps the admin Autofix-branded", () => {
    const shell = readFileSync(join(root, "src/components/admin/admin-shell.tsx"), "utf8");
    const logo = readFileSync(join(root, "src/components/layout/logo.tsx"), "utf8");
    expect(shell).toContain(">Autofix<");
    expect(logo).toContain("Autofix");
    expect(existsSync(join(root, "src/app/icon.svg"))).toBe(true);
  });
});
