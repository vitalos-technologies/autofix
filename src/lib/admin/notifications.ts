import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type AdminNotificationSummary = {
  count: number;
  enquiryCount: number;
  bookingCount: number;
};

/**
 * Attention counts for the selected garage. Takes the admin's RLS garage
 * client, so every query only sees that garage's rows.
 */
export async function getAdminNotificationSummary(client: SupabaseClient | null): Promise<AdminNotificationSummary> {
  if (!client) return { count: 0, enquiryCount: 0, bookingCount: 0 };

  const [enquiryAlerts, unreadThreads, repliedEnquiries, bookingAlerts, bookingDeliveryAlerts] = await Promise.all([
    client.from("enquiries").select("id,status,notification_status").is("deleted_at", null).or("status.eq.new,notification_status.in.(pending,failed)"),
    client.from("enquiry_conversations").select("enquiry_id,enquiries!inner(deleted_at)").is("enquiries.deleted_at", null).gt("unread_count", 0),
    client.from("enquiry_messages").select("enquiry_id").eq("direction", "outbound").eq("message_type", "email").in("delivery_status", ["sent", "delivered"]),
    client.from("bookings").select("id").is("deleted_at", null).or("admin_seen_at.is.null,provider_sync_state.in.(pending,failed)"),
    client.from("booking_notification_events").select("booking_id,bookings!inner(deleted_at)").is("bookings.deleted_at", null).in("status", ["pending", "failed"]),
  ]);

  const repliedIds = new Set((repliedEnquiries.data || []).map((item) => item.enquiry_id));
  const enquiryIds = new Set([
    ...(enquiryAlerts.data || [])
      .filter((item) => item.status !== "new" || !repliedIds.has(item.id) || ["pending", "failed"].includes(item.notification_status))
      .map((item) => item.id),
    ...(unreadThreads.data || []).map((item) => item.enquiry_id),
  ]);
  const bookingIds = new Set([
    ...(bookingAlerts.data || []).map((item) => item.id),
    ...(bookingDeliveryAlerts.data || []).map((item) => item.booking_id),
  ]);

  return {
    count: enquiryIds.size + bookingIds.size,
    enquiryCount: enquiryIds.size,
    bookingCount: bookingIds.size,
  };
}
