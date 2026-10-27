"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_SEARCH_FIELD } from "@/components/admin-ui/admin-search";
import { cleanSearch } from "@/lib/admin/data";
import {
  ADMIN_SEARCH_COOKIE,
  ADMIN_SEARCH_COOKIE_OPTIONS,
  asBookingReference,
  bookingListHref,
  parseBookingListParams,
} from "@/lib/admin/search";
import { getAdminContext } from "@/lib/tenancy/admin";

/**
 * The admin search box (top bar, phone header, bookings list). POST only. An exact booking
 * reference opens that booking; anything else lists matching bookings. The term travels in an
 * httpOnly cookie, so a registration never lands in the address bar or the history. The list's own
 * filters (status, dates) ride along in the query string; they are not personal data.
 */
export async function searchAdmin(formData: FormData): Promise<void> {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");

  const term = cleanSearch(String(formData.get(ADMIN_SEARCH_FIELD) ?? ""));
  const filters = parseBookingListParams({
    status: String(formData.get("status") ?? ""),
    from: String(formData.get("from") ?? ""),
    to: String(formData.get("to") ?? ""),
  });
  const store = await cookies();

  if (!term) {
    store.set(ADMIN_SEARCH_COOKIE, "", { ...ADMIN_SEARCH_COOKIE_OPTIONS, maxAge: 0 });
    redirect(bookingListHref({ ...filters, searched: false }));
  }

  const reference = asBookingReference(term);
  if (reference) {
    // RLS client: only the selected garage's bookings can match.
    const { data } = await admin.client.from("bookings").select("id").eq("reference", reference).is("deleted_at", null).maybeSingle();
    if (data?.id) redirect(`/app/bookings/${data.id}`);
  }

  store.set(ADMIN_SEARCH_COOKIE, term, ADMIN_SEARCH_COOKIE_OPTIONS);
  redirect(bookingListHref({ ...filters, searched: true }));
}
