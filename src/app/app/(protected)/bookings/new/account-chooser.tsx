"use client";

import { useId, useState, type ReactNode } from "react";
import { Panel } from "@/components/admin-ui";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { cn } from "@/lib/utils";

// P5.7: the optional "Account" step of the staff booking form. Choosing a fleet or trade account
// lists its cars and drivers; picking one fills the car and customer fields below. The booking is
// still made by create_booking() through the staff path; the server then charges it to the account
// (set_booking_account()) with the PO number. Only rendered for garages on Pro with accounts.

export type ChooserAccount = {
  id: string;
  name: string;
  poRequired: boolean;
  contact: { name: string | null; phone: string | null; email: string | null };
  vehicles: Array<{ registration: string; make: string | null; model: string | null }>;
  drivers: Array<{ id: string; name: string; phone: string; email: string | null }>;
};

export type AccountFill = {
  registration?: string;
  make?: string;
  model?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
};

const selectClass =
  "h-11 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-invalid:border-[#b91c1c]";
const labelClass = "text-[14px] font-semibold text-grey-800";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children}
      {hint ? <p id={`${id}-hint`} className="m-0 text-[13px] text-grey-600">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="m-0 text-[13px] font-semibold text-[#991b1b]">{error}</p> : null}
    </div>
  );
}

export function AccountChooser({
  accounts,
  initialAccountId,
  onFill,
  errors,
}: {
  accounts: ChooserAccount[];
  initialAccountId?: string | null;
  onFill: (fill: AccountFill) => void;
  errors: { accountId?: string; poNumber?: string };
}) {
  const id = useId();
  const [accountId, setAccountId] = useState(initialAccountId && accounts.some((account) => account.id === initialAccountId) ? initialAccountId : "");
  const [poNumber, setPoNumber] = useState("");
  const account = accounts.find((item) => item.id === accountId) ?? null;

  return (
    <Panel title="Account (optional)">
      <input type="hidden" name="accountId" value={accountId} />
      <Field id={`${id}-account`} label="Charge to a business account" hint="Fleet and trade customers. Their invoices go on the account's statement." error={errors.accountId}>
        <select
          id={`${id}-account`}
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
            const next = accounts.find((item) => item.id === event.target.value);
            if (next && next.contact.phone && !next.drivers.length) {
              onFill({ customerName: next.contact.name ?? next.name, customerPhone: next.contact.phone, customerEmail: next.contact.email ?? "" });
            }
          }}
          aria-describedby={`${id}-account-hint`}
          aria-invalid={errors.accountId ? true : undefined}
          className={selectClass}
        >
          <option value="">No account: a private customer</option>
          {accounts.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </Field>
      {account ? (
        <div className={cn("grid grid-cols-1 gap-3", "sm:grid-cols-2")}>
          <Field id={`${id}-vehicle`} label="Their car" hint={account.vehicles.length ? "Or type another registration below: it joins the account." : "No cars on this account yet: type the registration below."}>
            <select
              id={`${id}-vehicle`}
              defaultValue=""
              onChange={(event) => {
                const vehicle = account.vehicles.find((item) => item.registration === event.target.value);
                if (vehicle) onFill({ registration: vehicle.registration, make: vehicle.make ?? "", model: vehicle.model ?? "" });
              }}
              aria-describedby={`${id}-vehicle-hint`}
              className={selectClass}
            >
              <option value="">Choose a car</option>
              {account.vehicles.map((vehicle) => (
                <option key={vehicle.registration} value={vehicle.registration}>
                  {formatRegistration(vehicle.registration)}{vehicle.make || vehicle.model ? ` · ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${id}-driver`} label="Driver" hint="Fills the customer below. They get the booking texts.">
            <select
              id={`${id}-driver`}
              defaultValue=""
              onChange={(event) => {
                if (event.target.value === "contact") {
                  onFill({ customerName: account.contact.name ?? account.name, customerPhone: account.contact.phone ?? "", customerEmail: account.contact.email ?? "" });
                  return;
                }
                const driver = account.drivers.find((item) => item.id === event.target.value);
                if (driver) onFill({ customerName: driver.name, customerPhone: driver.phone, customerEmail: driver.email ?? "" });
              }}
              aria-describedby={`${id}-driver-hint`}
              className={selectClass}
            >
              <option value="">Choose a driver</option>
              {account.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
              {account.contact.phone ? <option value="contact">{account.contact.name ?? "Account contact"} (contact)</option> : null}
            </select>
          </Field>
          <Field id={`${id}-po`} label={account.poRequired ? "PO number" : "PO number (optional)"} hint={account.poRequired ? "This account needs one on every booking." : undefined} error={errors.poNumber}>
            <input
              id={`${id}-po`}
              name="poNumber"
              value={poNumber}
              onChange={(event) => setPoNumber(event.target.value)}
              maxLength={40}
              autoComplete="off"
              required={account.poRequired}
              aria-invalid={errors.poNumber ? true : undefined}
              aria-describedby={[account.poRequired ? `${id}-po-hint` : null, errors.poNumber ? `${id}-po-error` : null].filter(Boolean).join(" ") || undefined}
              className={selectClass}
            />
          </Field>
        </div>
      ) : null}
    </Panel>
  );
}
