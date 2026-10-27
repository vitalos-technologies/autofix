import { Upload } from "lucide-react";
import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/admin-ui";
import { CUSTOMER_PAGE_SIZE, listCustomers, type CustomerListResult } from "@/lib/customers/queries";
import { getAdminContext } from "@/lib/tenancy/admin";
import { CustomersBrowser } from "./customers-browser";

export const metadata = { title: "Customers & cars" };

export default async function CustomersPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const initial: CustomerListResult = admin
    ? await listCustomers(admin.client, { page: 1, pageSize: CUSTOMER_PAGE_SIZE })
    : { items: [], total: 0, page: 1, pageCount: 1, query: "", error: true };
  const canImport = admin?.role === "owner" || admin?.role === "manager";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Customers & cars"
        title="Customers"
        description="Everyone who has booked with you or been imported, with their cars and reminder consent."
        actions={canImport ? (
          <Link href="/app/customers/import" className={buttonClass("primary")}>
            <Upload size={18} strokeWidth={2} aria-hidden="true" /> Import customers
          </Link>
        ) : null}
      />
      <CustomersBrowser initial={initial} motEnabled={Boolean(admin?.garage.motEnabled)} canImport={canImport} />
    </div>
  );
}
