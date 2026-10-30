"use client";

import { useActionState, useId, useState } from "react";
import { Plus, Search } from "lucide-react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { PlateInput } from "@/components/book";
import { PlateChip } from "@/components/book/plate-chip";
import { FormMessage, inputClass, labelClass, TextInputField } from "../../settings/_components/fields";
import {
  addAccountPersonAction,
  addAccountVehicleAction,
  searchAccountPeopleAction,
  searchAccountVehiclesAction,
  type PanelActionState,
  type PeopleSearchState,
  type VehicleSearchState,
} from "../actions";

const idlePanel: PanelActionState = { seq: 0, status: "idle" };
const idleVehicles: VehicleSearchState = { seq: 0, status: "idle", matches: [] };
const idlePeople: PeopleSearchState = { seq: 0, status: "idle", matches: [] };

function formMessage(state: PanelActionState) {
  if (state.status === "idle" || !state.message) return { status: "idle" as const };
  return { status: state.status, message: state.message };
}

/** A search's "nothing found" note (polite) or failure (alert). */
function SearchMessage({ state }: { state: VehicleSearchState | PeopleSearchState }) {
  if (!state.message) return <p role="status" className="sr-only">{state.status === "done" ? `${state.matches.length} found` : ""}</p>;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "m-0 text-[14px] font-semibold text-[#991b1b]" : "m-0 text-[14px] text-grey-700"}>
      {state.message}
    </p>
  );
}

/**
 * Add cars to an account: find one of the garage's cars by registration, or add a registration
 * (a new car is created). Both are POST forms; the registration is never put in the address.
 */
export function AddVehiclesPanel({ accountId }: { accountId: string }) {
  const [search, searchAction] = useActionState(searchAccountVehiclesAction, idleVehicles);
  const [added, addAction] = useActionState(addAccountVehicleAction, idlePanel);
  const [registration, setRegistration] = useState("");
  const id = useId();

  return (
    <div className="flex flex-col gap-4 border-t border-[#f1f5f9] pt-4">
      <FormMessage state={formMessage(added)} />
      <form action={searchAction} className="flex flex-col gap-2" role="search" aria-label="Find a car by registration">
        <label htmlFor={`${id}-q`} className={labelClass}>Find one of your cars</label>
        <div className="flex gap-2">
          <input id={`${id}-q`} name="q" type="search" autoComplete="off" placeholder="Registration" className={`${inputClass} border-grey-300 uppercase`} maxLength={12} />
          <SubmitButton className={buttonClass("secondary", "md", "shrink-0")}>
            <Search size={17} strokeWidth={2} aria-hidden="true" /> Find
          </SubmitButton>
        </div>
      </form>
      <SearchMessage state={search} />
      {search.matches.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Matching cars">
          {search.matches.map((match) => (
            <li key={match.vehicleId} className="flex flex-wrap items-center gap-3 rounded-input border border-grey-200 p-3">
              <PlateChip registration={match.registration} />
              <span className="min-w-0 grow text-[14px] text-grey-800">
                {[match.make, match.model].filter(Boolean).join(" ") || "Car"}
                {match.ownerName ? <span className="text-grey-600"> · {match.ownerName}</span> : null}
                {match.accountName ? <span className="block text-[13px] text-grey-600">On {match.accountName}</span> : null}
              </span>
              {match.accountName ? null : (
                <form action={addAction}>
                  <input type="hidden" name="accountId" value={accountId} />
                  <input type="hidden" name="vehicleId" value={match.vehicleId} />
                  <SubmitButton className={buttonClass("secondary", "sm")}>
                    <Plus size={16} strokeWidth={2.2} aria-hidden="true" /> Add<span className="sr-only"> {match.registration}</span>
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <form action={addAction} className="flex flex-col gap-3 rounded-input border border-grey-200 bg-grey-50 p-3.5">
        <input type="hidden" name="accountId" value={accountId} />
        <PlateInput id={`${id}-reg`} name="registration" label="Or add a registration" value={registration} onChange={setRegistration} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextInputField id={`${id}-make`} name="make" label="Make (optional)" autoComplete="off" maxLength={80} />
          <TextInputField id={`${id}-model`} name="model" label="Model (optional)" autoComplete="off" maxLength={120} />
        </div>
        <SubmitButton className={buttonClass("primary", "md", "self-start")}>
          <Plus size={17} strokeWidth={2.2} aria-hidden="true" /> Add car
        </SubmitButton>
      </form>
    </div>
  );
}

/** Link the garage's customers to the account as drivers or contacts (search by name or mobile, POST). */
export function AddPeoplePanel({ accountId }: { accountId: string }) {
  const [search, searchAction] = useActionState(searchAccountPeopleAction, idlePeople);
  const [added, addAction] = useActionState(addAccountPersonAction, idlePanel);
  const id = useId();
  return (
    <div className="flex flex-col gap-3 border-t border-[#f1f5f9] pt-4">
      <FormMessage state={formMessage(added)} />
      <form action={searchAction} className="flex flex-col gap-2" role="search" aria-label="Find a customer">
        <label htmlFor={`${id}-q`} className={labelClass}>Add a driver or contact</label>
        <div className="flex gap-2">
          <input id={`${id}-q`} name="q" type="search" autoComplete="off" placeholder="Name or mobile" className={`${inputClass} border-grey-300`} maxLength={80} />
          <SubmitButton className={buttonClass("secondary", "md", "shrink-0")}>
            <Search size={17} strokeWidth={2} aria-hidden="true" /> Find
          </SubmitButton>
        </div>
        <p className="m-0 text-[13px] text-grey-600">Drivers are ordinary customers: they get their own booking texts and reminders.</p>
      </form>
      <SearchMessage state={search} />
      {search.matches.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Matching customers">
          {search.matches.map((match) => (
            <li key={match.customerId} className="flex flex-wrap items-center gap-2 rounded-input border border-grey-200 p-3">
              <span className="min-w-0 grow text-[14px] font-semibold text-navy-950">{match.name}</span>
              {(["driver", "contact"] as const).map((role) => (
                <form key={role} action={addAction}>
                  <input type="hidden" name="accountId" value={accountId} />
                  <input type="hidden" name="customerId" value={match.customerId} />
                  <input type="hidden" name="role" value={role} />
                  <SubmitButton className={buttonClass("secondary", "sm")}>
                    {role === "driver" ? "Add as driver" : "Add as contact"}<span className="sr-only">: {match.name}</span>
                  </SubmitButton>
                </form>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
