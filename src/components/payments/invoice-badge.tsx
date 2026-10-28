import type { SupabaseClient } from "@supabase/supabase-js";
import { Badge } from "@/components/admin-ui";
import type { PaymentStatus } from "@/lib/payments/amounts";

// Pay-by-link state on the invoice list (P5.4): "Link sent" while a link is open, "Paid online" once
// paid. Read through the member's RLS client; nothing when the garage never sent a link.

export type InvoicePayLink = { status: PaymentStatus };

/** The most telling pay link per invoice: an open one first, else the latest paid one. */
export async function loadInvoicePayLinks(client: SupabaseClient, invoiceIds: string[]): Promise<Map<string, InvoicePayLink>> {
  const links = new Map<string, InvoicePayLink>();
  if (!invoiceIds.length) return links;
  const { data } = await client
    .from("payments")
    .select("invoice_id,status,created_at")
    .eq("kind", "invoice")
    .in("invoice_id", invoiceIds)
    .in("status", ["pending", "paid"])
    .order("created_at", { ascending: false });
  for (const row of (data ?? []) as { invoice_id: string; status: PaymentStatus }[]) {
    const current = links.get(row.invoice_id);
    if (!current || (current.status !== "pending" && row.status === "pending")) links.set(row.invoice_id, { status: row.status });
  }
  return links;
}

export function InvoicePayLinkBadge({ link }: { link?: InvoicePayLink }) {
  if (!link) return null;
  return (
    <Badge tone={link.status === "paid" ? "success" : "info"} size="xs" className="mt-1.5 inline-flex">
      {link.status === "paid" ? "Paid online" : "Link sent"}
    </Badge>
  );
}
