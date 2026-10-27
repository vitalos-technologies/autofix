import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { maskMobile } from "@/lib/booking-flow/copy";
import {
  countUnread,
  messageText,
  shapeConversations,
  type Conversation,
  type ConversationCustomer,
  type MessageRow,
} from "@/lib/messages/view";

// Reads for Messages & calls (`/app/messages`). Every function takes the member's RLS garage
// client (getAdminContext().client, x-garage-id) and filters on the garage id as a second guard;
// none uses the service role. Customers' numbers stay server-side apart from masked forms.

const ROW_SELECT = "id,customer_id,channel,direction,body,status,created_at,read_at,error_code,redacted_at,reminder_send_id,booking_id,call_id";
const THREAD_SELECT = `${ROW_SELECT},reminder_sends(kind),bookings(reference)`;
const CUSTOMER_SELECT = "id,name,phone,email,channel,opted_out_at,anonymised_at";

export const CONVERSATION_SCAN = 1000;
export const THREAD_LIMIT = 200;

export type InboxData = {
  conversations: Conversation[];
  /** Texts from numbers that aren't customers yet (masked; no thread or reply). */
  unknown: Array<{ id: string; maskedNumber: string; preview: string; at: string }>;
  unreadTotal: number;
};

/**
 * One conversation per customer from the garage's latest messages (up to 1,000 rows scanned),
 * newest first, with unread counts. `null` when messages can't be read.
 */
export async function loadInbox(client: SupabaseClient, garageId: string): Promise<InboxData | null> {
  const [recent, unread] = await Promise.all([
    client.from("messages").select(`${ROW_SELECT},from_address`).eq("garage_id", garageId).order("created_at", { ascending: false }).limit(CONVERSATION_SCAN),
    client
      .from("messages")
      .select("customer_id")
      .eq("garage_id", garageId)
      .eq("direction", "inbound")
      .is("read_at", null)
      .limit(5000),
  ]);
  if (recent.error || unread.error) return null;
  const rows = (recent.data ?? []) as MessageRow[];
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter((id): id is string => Boolean(id)))];
  let customers: ConversationCustomer[] = [];
  if (customerIds.length > 0) {
    const { data, error } = await client.from("customers").select(CUSTOMER_SELECT).eq("garage_id", garageId).in("id", customerIds);
    if (error) return null;
    customers = (data ?? []) as ConversationCustomer[];
  }
  const counts = countUnread((unread.data ?? []) as Array<{ customer_id: string | null }>);
  const conversations = shapeConversations(rows, customers, counts);
  const unknown = rows
    .filter((row) => !row.customer_id && row.direction === "inbound" && row.from_address)
    .slice(0, 20)
    .map((row) => ({ id: row.id, maskedNumber: maskMobile(row.from_address as string), preview: messageText(row), at: row.created_at }));
  return { conversations, unknown, unreadTotal: conversations.reduce((total, item) => total + item.unread, 0) };
}

export type Thread = { customer: ConversationCustomer; rows: MessageRow[]; truncated: boolean };

/** A customer of the garage and their latest 200 messages, oldest first. `null` when not found. */
export async function loadThread(client: SupabaseClient, garageId: string, customerId: string): Promise<Thread | null> {
  const [customer, messages] = await Promise.all([
    client.from("customers").select(CUSTOMER_SELECT).eq("garage_id", garageId).eq("id", customerId).maybeSingle(),
    client.from("messages").select(THREAD_SELECT).eq("garage_id", garageId).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(THREAD_LIMIT + 1),
  ]);
  if (customer.error || messages.error || !customer.data) return null;
  const rows = ((messages.data ?? []) as unknown as MessageRow[]).slice(0, THREAD_LIMIT).reverse();
  return { customer: customer.data as ConversationCustomer, rows, truncated: (messages.data ?? []).length > THREAD_LIMIT };
}

/** The garage has a provisioned two-way messaging number (A55: only rows with provider_sid route). */
export async function hasMessagingNumber(client: SupabaseClient, garageId: string): Promise<boolean> {
  const { count, error } = await client
    .from("garage_phone_numbers")
    .select("id", { count: "exact", head: true })
    .eq("garage_id", garageId)
    .eq("purpose", "messaging")
    .not("provider_sid", "is", null);
  return !error && (count ?? 0) > 0;
}

/** Marks the customer's unread inbound messages read, as the member (RLS: column grant + policy). */
export async function markThreadRead(client: SupabaseClient, garageId: string, customerId: string, userId: string, now = new Date()): Promise<number> {
  const { data, error } = await client
    .from("messages")
    .update({ read_at: now.toISOString(), read_by: userId })
    .eq("garage_id", garageId)
    .eq("customer_id", customerId)
    .eq("direction", "inbound")
    .is("read_at", null)
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}

/** How many customers' messages nobody has opened yet (for the Messages tab's count). 0 when unreadable. */
export async function countUnreadMessages(client: SupabaseClient, garageId: string): Promise<number> {
  const { count, error } = await client
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("garage_id", garageId)
    .eq("direction", "inbound")
    .not("customer_id", "is", null)
    .is("read_at", null);
  return error ? 0 : count ?? 0;
}
