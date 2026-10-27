import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin notifications", () => {
  it("counts new bookings and booking delivery or calendar issues alongside enquiry alerts", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/admin/notifications.ts"), "utf8");
    expect(source).toContain('client.from("bookings")');
    expect(source).toContain("admin_seen_at.is.null");
    expect(source).toContain("status.eq.requested");
    expect(source).not.toContain("provider_sync_state");
    expect(source).toContain('client.from("booking_notification_events")');
    // Unmatched inbound mail belongs to no garage, so it is not a garage notification.
    expect(source).toContain("count: enquiryIds.size + bookingIds.size,");
    expect(source).not.toContain("unmatched_inbound_emails");
    expect(source).not.toContain("createAdminClient");
  });

  it("polls the authenticated count endpoint and sends the live count to both badges", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin-ui/notification-refresher.tsx"), "utf8");
    const layout = readFileSync(join(process.cwd(), "src/app/app/(protected)/layout.tsx"), "utf8");
    expect(source).toContain('endpoint = "/api/admin/notifications/count"');
    expect(source).toContain("window.setInterval");
    expect(source).toContain("router.refresh()");
    // The bell and the Bookings badge are server-rendered; a changed count refreshes them both.
    expect(layout).toContain("unreadCount={notifications.count}");
    expect(layout).toContain("<NotificationRefresher count={notifications.count} />");
  });

  it("shows booking alerts in the notification centre and acknowledges them on open", () => {
    const notifications = readFileSync(join(process.cwd(), "src/app/app/(protected)/notifications/page.tsx"), "utf8");
    const bookingPage = readFileSync(join(process.cwd(), "src/app/app/(protected)/bookings/[id]/page.tsx"), "utf8");
    const actions = readFileSync(join(process.cwd(), "src/app/app/(protected)/bookings/actions.ts"), "utf8");
    expect(notifications).toContain("New booking awaiting review");
    expect(notifications).toContain("Booking email delivery failed");
    expect(notifications).toContain("Waiting for your OK");
    expect(notifications).not.toContain("provider_sync_state");
    expect(bookingPage).toContain("<MarkBookingSeen");
    expect(actions).toContain("export async function markBookingSeenAction");
    expect(actions).toContain("admin_seen_at: new Date().toISOString()");
  });

  it("tracks bookings still awaiting review per garage", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase/migrations/20261026000000_baseline.sql"), "utf8");
    const tenancy = readFileSync(join(process.cwd(), "supabase/migrations/20261026000100_tenancy.sql"), "utf8");
    expect(baseline).toContain("admin_seen_at timestamptz,");
    expect(tenancy).toContain("create index bookings_admin_unseen_idx on public.bookings (garage_id, created_at desc) where admin_seen_at is null;");
  });
});
