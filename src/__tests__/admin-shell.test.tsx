// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const switchGarage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tenancy/switch-garage", () => ({ switchGarage }));

import { GarageSwitcher } from "@/components/admin/garage-switcher";

const garageA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Hartley Road Motors" };
const garageB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Demo Garage B" };

describe("admin shell", () => {
  it("keeps the header available while admin pages scroll and is Autofix-branded", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin/admin-shell.tsx"), "utf8");
    expect(source).toContain('<header className="sticky top-0 z-30');
    expect(source).toContain(">Autofix<");
    expect(source).not.toContain("SOB Autofix");
    expect(source).toContain("Search admin sections");
    expect(source).toContain("<GarageSwitcher");
    // "View booking page" opens the selected garage's own booking host.
    expect(source).toContain("href={garage.bookingUrl}");
  });

  it("shows the garage name alone for single-garage users", () => {
    render(<GarageSwitcher garage={garageA} memberships={[{ garageId: garageA.id, name: garageA.name, role: "owner" }]} />);
    expect(screen.getByText("Hartley Road Motors")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("offers a labelled select and submit button to multi-garage users", () => {
    render(<GarageSwitcher garage={garageB} memberships={[
      { garageId: garageA.id, name: garageA.name, role: "owner" },
      { garageId: garageB.id, name: garageB.name, role: "manager" },
    ]} />);
    const select = screen.getByRole("combobox", { name: "Garage" }) as HTMLSelectElement;
    expect(select.name).toBe("garageId");
    expect(select.value).toBe(garageB.id);
    expect([...select.options].map((option) => option.textContent)).toEqual(["Hartley Road Motors", "Demo Garage B"]);
    expect(screen.getByRole("button", { name: "Switch garage" })).toHaveAttribute("type", "submit");
  });
});
