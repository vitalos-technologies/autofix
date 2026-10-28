// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value, useRouter: () => ({ refresh: vi.fn() }) }));

import { AdminNavGroups, AdminShell, AdminTabBar, defaultAdminNav, GarageSwitcher } from "@/components/admin-ui";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const garageA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Hartley Road Motors", accent: "#155fba", plan: "Growth plan" };
const garageB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Demo Garage B", accent: "#0f766e" };
const switchGarage = vi.fn(async () => undefined);

describe("admin layout", () => {
  it("renders the Autofix admin shell with the real garage switcher, search, bell and sign-out", () => {
    const layout = read("src/app/app/(protected)/layout.tsx");
    expect(layout).toContain('from "@/components/admin-ui"');
    expect(layout).toContain("<AdminShell");
    expect(layout).toContain("switchGarageAction={switchGarage}");
    expect(layout).toContain('import { switchGarage } from "@/lib/tenancy/switch-garage"');
    expect(layout).toContain("searchAction={searchAdmin}");
    expect(layout).toContain("signOutAction={signOut}");
    expect(layout).toContain("bookingPageUrl={garageBaseUrl(admin.garage)}");
    expect(layout).toContain("getAdminNotificationSummary(admin.client)");
    // Layouts do not re-render on client navigation, so the shell follows the browser path itself.
    expect(layout).not.toContain("activeHref=");
    expect(read("src/components/admin-ui/admin-shell.tsx")).toContain(">Autofix<");
  });

  it("leaves <main> to the admin shell, the booking site layout and standalone pages", () => {
    expect(read("src/app/layout.tsx")).not.toContain("<main");
    expect(read("src/app/%5Fsite/[garageId]/layout.tsx")).toContain("<main>{children}</main>");
    for (const page of ["login", "mfa", "mfa/enroll", "mfa/recover", "forgot-password", "reset-password"]) {
      expect(read(`src/app/app/${page}/page.tsx`), page).toContain('<main className="hero-grid');
    }
    expect(read("src/app/not-found.tsx")).toContain("<main");
    // Inside the shell a page must not add a second main landmark.
    expect(read("src/app/app/(protected)/invoices/[id]/page.tsx")).not.toContain("<main");
  });
});

describe("garage switcher", () => {
  it("shows the garage name alone for single-garage users", () => {
    render(<GarageSwitcher garages={[garageA]} currentGarageId={garageA.id} switchGarageAction={switchGarage} />);
    expect(screen.getByText("Hartley Road Motors")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lists every garage as a submit button named garageId for multi-garage users", () => {
    const { container } = render(<GarageSwitcher garages={[garageA, garageB]} currentGarageId={garageB.id} switchGarageAction={switchGarage} />);
    expect(container.querySelector("summary")).toHaveTextContent("Switch garage. Current: DGDemo Garage B");
    const buttons = within(container.querySelector("form") as HTMLElement).getAllByRole("button");
    expect(buttons.map((button) => [button.getAttribute("name"), button.getAttribute("value")])).toEqual([
      ["garageId", garageA.id],
      ["garageId", garageB.id],
    ]);
    expect(buttons[1]).toHaveAttribute("aria-current", "true");
  });
});

describe("shell navigation", () => {
  beforeEach(() => {
    pathname.value = "/app";
  });

  it("follows the browser path when no activeHref is given", () => {
    pathname.value = "/app/bookings/0f8fad5b-d9cb-469f-a165-70867728950e";
    render(<AdminNavGroups groups={defaultAdminNav()} />);
    expect(screen.getByRole("link", { name: "Bookings" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute("aria-current");
  });

  it("lights the most specific Setup link", () => {
    pathname.value = "/app/settings/hours";
    render(<AdminNavGroups groups={defaultAdminNav()} />);
    expect(screen.getByRole("link", { name: "Opening hours" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });

  it("links every admin section and badges bookings waiting for an OK", () => {
    render(<AdminNavGroups groups={defaultAdminNav({ newBookings: 2, newBookingsLabel: "2 waiting for your OK" })} />);
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/app",
      "/app/diary",
      "/app/bookings",
      "/app/invoices",
      "/app/enquiries",
      "/app/customers",
      "/app/reminders",
      "/app/messages",
      "/app/campaigns",
      "/app/health-checks",
      "/app/reports",
      "/app/settings/services",
      "/app/settings/hours",
      "/app/settings/resources",
      "/app/settings/branding",
      "/app/settings/booking-page",
      "/app/settings/team",
      "/app/settings/ai-front-desk",
      "/app/settings/plan",
      "/app/settings/agreements",
      "/app/settings",
      "/app/configuration/security",
    ]);
    expect(screen.getByRole("link", { name: /Bookings/ })).toHaveTextContent("Bookings2, 2 waiting for your OK");
  });

  it("phone tabs go to Today, Diary, New booking, Customers and More", () => {
    pathname.value = "/app/bookings/new";
    render(<AdminTabBar fixed={false} />);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/app", "/app/diary", "/app/bookings/new", "/app/customers", "/app/more"]);
    expect(screen.getByRole("link", { name: "New booking" })).toHaveAttribute("aria-current", "page");
  });

  it("is one main landmark with skip link, sidebar, search, bell and phone tabs", () => {
    pathname.value = "/app/diary";
    render(
      <AdminShell
        garages={[garageA, garageB]}
        currentGarageId={garageA.id}
        switchGarageAction={switchGarage}
        nav={defaultAdminNav()}
        user={{ name: "Sam Hartley", email: "owner@hartley-road.example" }}
        bookingPageUrl="http://hartley-road.localhost:3000"
        unreadCount={3}
        searchAction={switchGarage}
        signOutAction={switchGarage}
      >
        <p>Page</p>
      </AdminShell>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#admin-main");
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifications, 3 unread" })).toHaveAttribute("href", "/app/notifications");
    expect(screen.getByRole("link", { name: /View booking page/ })).toHaveAttribute("href", "http://hartley-road.localhost:3000");
    for (const nav of screen.getAllByRole("navigation", { name: "Main" })) {
      expect(within(nav).getByRole("link", { name: "Diary" })).toHaveAttribute("aria-current", "page");
    }
  });
});

describe("Pro sections in the nav (P5.2)", () => {
  it("keeps a locked Pro link visible with a Pro badge, and unlocked ones plain", async () => {
    const nav = await import("@/components/admin-ui/admin-nav");
    const { Megaphone } = await import("lucide-react");
    // P5.5 added Campaigns to the Grow group; the probe only adds it when it is not there yet.
    const added = !nav.GROW_NAV_ITEMS.some((item) => item.feature === "campaigns");
    if (added) nav.GROW_NAV_ITEMS.push({ feature: "campaigns", label: "Campaigns", href: "/app/campaigns", icon: Megaphone });
    try {
      const { unmount } = render(<AdminNavGroups groups={defaultAdminNav({ lockedFeatures: new Set(["campaigns"]) })} activeHref="/app" />);
      const link = screen.getByRole("link", { name: /Campaigns/ });
      expect(link).toHaveAttribute("href", "/app/campaigns");
      expect(link).toHaveTextContent("Pro");
      expect(link).toHaveTextContent("not on your plan");
      unmount();
      render(<AdminNavGroups groups={defaultAdminNav({ lockedFeatures: new Set() })} activeHref="/app" />);
      expect(screen.getByRole("link", { name: /Campaigns/ })).not.toHaveTextContent("Pro");
      expect(screen.getByText("Grow")).toBeInTheDocument();
    } finally {
      if (added) nav.GROW_NAV_ITEMS.pop();
    }
  });
});
