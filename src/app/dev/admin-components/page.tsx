import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fontVariables } from "@/app/fonts";
import { AdminShell, DEFAULT_ADMIN_TABS, defaultAdminNav, type AdminNavGroup, type AdminTabItem } from "@/components/admin-ui";
import { galleryNoopAction } from "./actions";
import { BOOKING_PAGE_URL, GALLERY_BASE, GARAGES, USER } from "./sample-data";
import { DomainView, MoreView, RemindersView, StatesView, TodayView } from "./views";

export const metadata: Metadata = {
  title: "Admin components (dev)",
  robots: { index: false, follow: false },
};

const VIEWS = ["today", "reminders", "domain", "more", "states"] as const;
type View = (typeof VIEWS)[number];

function viewHref(view: View, hash = "") {
  return `${view === "today" ? GALLERY_BASE : `${GALLERY_BASE}?view=${view}`}${hash}`;
}

/** The real nav, pointed at the gallery views (sections without a gallery view go to the states view). */
const GALLERY_ROUTES: Record<string, string> = {
  "/app": viewHref("today"),
  "/app/diary": viewHref("states", "#diary"),
  "/app/bookings": viewHref("states", "#job-cards"),
  "/app/invoices": viewHref("states", "#status-pills"),
  "/app/customers": viewHref("states", "#data-table"),
  "/app/reminders": viewHref("reminders"),
  "/app/messages": viewHref("states", "#message-preview"),
  "/app/settings/services": viewHref("states", "#kpis"),
  "/app/settings/booking-page": viewHref("domain"),
  "/app/settings": viewHref("states"),
  "/app/bookings/new": viewHref("states", "#approvals"),
  "/app/more": viewHref("more"),
};

function galleryNav(): AdminNavGroup[] {
  return defaultAdminNav({ newBookings: 2 }).map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, href: GALLERY_ROUTES[item.href] ?? item.href })),
  }));
}

function galleryTabs(): AdminTabItem[] {
  return DEFAULT_ADMIN_TABS.map((tab) => ({ ...tab, href: GALLERY_ROUTES[tab.href] ?? tab.href }));
}

/**
 * Dev-only gallery of the admin components (src/components/admin-ui) composed as the Admin-Dashboard,
 * Admin-Today-Phone, Admin-Reminders and Admin-Domain screens, plus every state. 404 in production
 * unless ENABLE_DEV_COMPONENTS=true. `?view=` picks the screen.
 */
export default async function DevAdminComponentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_COMPONENTS !== "true") notFound();
  const requested = (await searchParams).view;
  const view: View = VIEWS.find((item) => item === requested) ?? "today";
  const nav = galleryNav();
  const activeHref = viewHref(view);

  return (
    <div className={`${fontVariables} font-sans`}>
      <AdminShell
        garages={GARAGES}
        currentGarageId="g-hartley"
        switchGarageAction={galleryNoopAction}
        nav={nav}
        activeHref={activeHref}
        user={USER}
        bookingPageUrl={BOOKING_PAGE_URL}
        unreadCount={3}
        notificationsHref={viewHref("states", "#approvals")}
        searchAction={galleryNoopAction}
        signOutAction={galleryNoopAction}
        accountLinks={[{ label: "Team and security", href: viewHref("states") }]}
        tabs={galleryTabs()}
      >
        {view === "today" ? <TodayView /> : null}
        {view === "reminders" ? <RemindersView /> : null}
        {view === "domain" ? <DomainView /> : null}
        {view === "more" ? <MoreView nav={nav} activeHref={activeHref} /> : null}
        {view === "states" ? <StatesView /> : null}
      </AdminShell>
    </div>
  );
}
