"use client";

import { useState } from "react";
import { focusWithinRing } from "@/components/book/styles";
import type { BookingExtrasOptions } from "@/lib/courtesy/booking-site";
import { cn } from "@/lib/utils";
import { TextField } from "./text-field";

const boxClass = cn("flex cursor-pointer items-start gap-3 rounded-control border border-grey-200 bg-white px-3.5 py-3 font-sans leading-[normal]", focusWithinRing);
const checkClass = "m-0 mt-px size-5 shrink-0 cursor-pointer accent-accent focus-visible:outline-none!";

/**
 * P5.8 on Book 4 (details): "I'd like a courtesy car" (a request the garage confirms; shown only
 * when a car is free for this slot) and "Collect and deliver my car" with the address (shown only
 * when the service offers it). Inside the details form, so they post with Confirm booking.
 */
export function BookingExtrasFields({ offered, errors }: { offered: BookingExtrasOptions; errors?: { postcode?: string; address?: string } }) {
  // React resets the form after each action response (form.reset()), which puts every field back to
  // its default. The defaults follow what the customer chose, so fixing the postcode loses nothing.
  const [courtesy, setCourtesy] = useState(false);
  const [collect, setCollect] = useState(Boolean(errors?.postcode || errors?.address));
  const [address, setAddress] = useState("");
  const [postcode, setPostcode] = useState("");
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
      <legend className="mb-1 p-0 text-[14px] font-semibold text-grey-800">Extras</legend>
      {offered.courtesy ? (
        <label className={boxClass}>
          <input type="checkbox" name="courtesyCar" value="yes" defaultChecked={courtesy} onChange={(event) => setCourtesy(event.target.checked)} className={checkClass} />
          <span className="flex flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold text-navy-950">I&apos;d like a courtesy car</span>
            <span className="text-[13px] leading-[1.45] text-grey-700">One is free that day. The garage confirms it with you; it isn&apos;t booked until they do.</span>
          </span>
        </label>
      ) : null}
      {offered.collection ? (
        <>
          <label className={boxClass}>
            <input
              type="checkbox"
              name="collectionDelivery"
              value="yes"
              defaultChecked={collect}
              onChange={(event) => setCollect(event.target.checked)}
              aria-controls="collection-fields"
              className={checkClass}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-[14.5px] font-semibold text-navy-950">Collect and deliver my car</span>
              <span className="text-[13px] leading-[1.45] text-grey-700">We collect it before the job and bring it back after, inside our local area.</span>
            </span>
          </label>
          <div id="collection-fields" hidden={!collect} className="flex flex-col gap-3">
            <TextField
              id="collection-address"
              name="collectionAddress"
              label="Address to collect from"
              autoComplete="street-address"
              maxLength={300}
              defaultValue={address}
              onChange={(event) => setAddress(event.target.value)}
              error={errors?.address}
              disabled={!collect}
            />
            <TextField
              id="collection-postcode"
              name="collectionPostcode"
              label="Postcode"
              autoComplete="postal-code"
              autoCapitalize="characters"
              maxLength={10}
              defaultValue={postcode}
              onChange={(event) => setPostcode(event.target.value)}
              error={errors?.postcode}
              disabled={!collect}
              className="max-w-[200px]"
            />
          </div>
        </>
      ) : null}
    </fieldset>
  );
}
