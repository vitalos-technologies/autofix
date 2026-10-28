"use client";

import { useActionState, useState } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import { SubmitButton, buttonClass } from "@/components/admin-ui";
import { RatingChip, RATING_TONES } from "@/components/health-checks/rating";
import { formatPounds, HEALTH_CHECK_RATINGS, penceToInput, RATING_SHORT_LABELS, type ChecklistItem, type HealthCheckRating } from "@/lib/health-checks/checklist";
import { cn } from "@/lib/utils";
import { FormMessage, TextAreaField, TextInputField, labelClass } from "../../settings/_components/fields";
import { saveItemAction, type HealthCheckFormState } from "../actions";

const initial: HealthCheckFormState = { seq: 0, status: "idle" };

/**
 * One checklist line on the phone: a 44px+ row (label and its rating) that opens to the
 * red/amber/green/not checked choice, a note, optional recommended work with a price, and the
 * line's photos and videos (`media`, rendered by the page).
 */
export function ItemEditor({ checkId, item, media, uploader }: { checkId: string; item: ChecklistItem; media?: React.ReactNode; uploader?: React.ReactNode }) {
  const [state, action] = useActionState(saveItemAction, initial);
  const [rating, setRating] = useState<HealthCheckRating>(item.rating);
  const id = `item-${item.id}`;
  return (
    <details className={cn("group rounded-[12px] border border-grey-200 border-l-4 bg-white", RATING_TONES[item.rating].border)} data-testid="hc-item">
      <summary
        className={cn(
          "flex min-h-[52px] cursor-pointer list-none items-center gap-3 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden",
          "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-visible:outline-solid",
        )}
      >
        <span className="flex min-w-0 grow flex-col gap-1">
          <span className="text-[15px] font-bold text-navy-950">{item.label}</span>
          {item.recommendedWork && item.pricePence !== null ? (
            <span className="flex items-center gap-1.5 text-[13px] text-grey-700">
              <Wrench size={14} strokeWidth={2} aria-hidden="true" />
              {item.recommendedWork} · {formatPounds(item.pricePence)}
            </span>
          ) : null}
        </span>
        <RatingChip rating={item.rating} short />
        <ChevronDown size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3.5 border-t border-grey-200 px-3.5 pt-3.5 pb-4">
        <form action={action} className="flex flex-col gap-3.5">
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="itemId" value={item.id} />
          <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className={cn(labelClass, "mb-1.5 p-0")}>Rating for {item.label}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {HEALTH_CHECK_RATINGS.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-input border px-3 text-[14px] font-bold",
                    "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid",
                    rating === value ? cn("border-transparent", RATING_TONES[value].chip, "ring-2 ring-navy-950") : "border-grey-300 bg-white text-navy-950 hover:border-grey-600",
                  )}
                >
                  <input type="radio" name="rating" value={value} checked={rating === value} onChange={() => setRating(value)} className="sr-only" />
                  <span aria-hidden="true" className={cn("size-2.5 rounded-full", RATING_TONES[value].dot)} />
                  {RATING_SHORT_LABELS[value]}
                </label>
              ))}
            </div>
            {state.fieldErrors?.rating ? <p className="m-0 text-[13px] font-semibold text-[#b91c1c]">{state.fieldErrors.rating}</p> : null}
          </fieldset>
          <TextAreaField id={`${id}-note`} name="note" label="Note" hint="What you found, in words the customer will understand." defaultValue={item.note ?? ""} maxLength={1000} rows={2} error={state.fieldErrors?.note} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <TextInputField id={`${id}-work`} name="work" label="Recommended work (optional)" defaultValue={item.recommendedWork ?? ""} maxLength={300} error={state.fieldErrors?.work} />
            <TextInputField id={`${id}-price`} name="price" label="Price" prefix="£" inputMode="decimal" defaultValue={penceToInput(item.pricePence)} error={state.fieldErrors?.price} />
          </div>
          <FormMessage state={state} />
          <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")}>Save {item.label}</SubmitButton>
        </form>
        {media}
        {uploader}
      </div>
    </details>
  );
}
