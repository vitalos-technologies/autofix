"use client";

import { ChevronLeft, ChevronRight, Search, Upload, Users } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { buttonClass, DataTable, EmptyState, focusRing, Panel, SubmitButton, type DataTableColumn } from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { formatUkMobile } from "@/lib/customers/csv";
import type { CustomerListItem, CustomerListResult } from "@/lib/customers/queries";
import { cn } from "@/lib/utils";
import { searchCustomersAction } from "./actions";
import { ConsentBadge, MotDueBadge } from "./badges";

export type CustomersBrowserProps = {
  initial: CustomerListResult;
  motEnabled: boolean;
  canImport: boolean;
};

function Plates({ customer }: { customer: CustomerListItem }) {
  const plates = customer.vehicles.filter((vehicle) => vehicle.registration);
  if (!plates.length) return <span className="text-[13px] text-grey-600">No car</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {plates.slice(0, 3).map((vehicle) => <PlateChip key={vehicle.id} registration={vehicle.registration!} />)}
      {plates.length > 3 ? <span className="self-center text-[13px] text-grey-600">+{plates.length - 3}</span> : null}
    </span>
  );
}

function CustomerLink({ customer }: { customer: CustomerListItem }) {
  return (
    <Link href={`/app/customers/${customer.id}`} className={cn("inline-flex min-h-11 items-center font-semibold text-navy-950 underline-offset-2 hover:underline", focusRing)}>
      {customer.name}
    </Link>
  );
}

/**
 * Customer list with search and paging. Both submit the same form as a server
 * action (POST), so a searched name, number or registration never reaches the URL.
 */
export function CustomersBrowser({ initial, motEnabled, canImport }: CustomersBrowserProps) {
  const [state, formAction] = useActionState(searchCustomersAction, initial);

  const columns: DataTableColumn<CustomerListItem>[] = [
    { key: "name", header: "Customer", rowHeader: true, cell: (customer) => <CustomerLink customer={customer} /> },
    { key: "mobile", header: "Mobile", cell: (customer) => <span className="whitespace-nowrap">{formatUkMobile(customer.phone)}</span> },
    { key: "cars", header: "Cars", cell: (customer) => <Plates customer={customer} /> },
    ...(motEnabled ? [{ key: "mot", header: "MOT due", cell: (customer: CustomerListItem) => <MotDueBadge motExpiry={customer.motDue} /> }] : []),
    {
      key: "reminders",
      header: "Reminders",
      cell: (customer) => <ConsentBadge reminderConsent={customer.reminderConsent} optedOutAt={customer.optedOutAt} />,
    },
  ];

  const empty = state.query ? (
    <EmptyState icon={Search} title="No customers match" description="Try part of a name, mobile number, email or registration." />
  ) : (
    <EmptyState
      icon={Users}
      title="No customers yet"
      description="Customers appear here after their first booking, or import a list from your old system."
      action={canImport ? (
        <Link href="/app/customers/import" className={buttonClass("primary")}>
          <Upload size={18} strokeWidth={2} aria-hidden="true" /> Import customers
        </Link>
      ) : null}
    />
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div role="search" className="flex flex-wrap items-end gap-2.5">
        <label className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5 text-[14px] font-semibold text-navy-950">
          Search customers
          <input
            key={state.query}
            type="search"
            name="q"
            defaultValue={state.query}
            autoComplete="off"
            placeholder="Name, mobile, email or registration"
            className={cn("min-h-11 rounded-input border border-grey-300 bg-white px-3.5 text-[15px] font-normal text-navy-950", focusRing)}
          />
        </label>
        <SubmitButton name="page" value="1" className={buttonClass("secondary")}>
          <Search size={18} strokeWidth={2} aria-hidden="true" /> Search
        </SubmitButton>
      </div>

      {state.error ? (
        <p role="alert" className="m-0 rounded-input bg-[#fdecec] px-3.5 py-3 text-[14px] text-[#991b1b]">
          Customers could not be loaded. Refresh the page and try again.
        </p>
      ) : null}

      <Panel
        title={state.query ? "Search results" : "All customers"}
        actions={<span aria-live="polite" className="text-[14px] text-grey-600">{state.total.toLocaleString("en-GB")} {state.total === 1 ? "customer" : "customers"}</span>}
      >
        {/* Phones: one card per customer. */}
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 lg:hidden">
          {state.items.map((customer) => (
            <li key={customer.id} className="flex flex-col gap-2 rounded-input border border-grey-200 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <CustomerLink customer={customer} />
                <ConsentBadge reminderConsent={customer.reminderConsent} optedOutAt={customer.optedOutAt} />
              </div>
              <span className="text-[14px] text-grey-700">{formatUkMobile(customer.phone)}</span>
              <Plates customer={customer} />
              {motEnabled && customer.motDue ? (
                <span className="flex items-center gap-2 text-[13px] text-grey-600">MOT <MotDueBadge motExpiry={customer.motDue} /></span>
              ) : null}
            </li>
          ))}
          {!state.items.length ? <li>{empty}</li> : null}
        </ul>
        <div className="hidden lg:block">
          <DataTable caption="Customers" columns={columns} rows={state.items} getRowKey={(customer) => customer.id} empty={empty} minWidth={720} />
        </div>

        {state.pageCount > 1 ? (
          <nav aria-label="Customer pages" className="flex items-center justify-between gap-3 border-t border-grey-200 pt-3.5">
            <SubmitButton name="page" value={String(state.page - 1)} disabled={state.page <= 1} className={buttonClass("secondary", "sm")}>
              <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" /> Previous
            </SubmitButton>
            <span className="text-[14px] text-grey-600">Page {state.page} of {state.pageCount}</span>
            <SubmitButton name="page" value={String(state.page + 1)} disabled={state.page >= state.pageCount} className={buttonClass("secondary", "sm")}>
              Next <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </SubmitButton>
          </nav>
        ) : null}
      </Panel>
    </form>
  );
}
