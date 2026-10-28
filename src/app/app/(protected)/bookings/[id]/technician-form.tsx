"use client";

import { useActionState, useId } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { cn } from "@/lib/utils";
import { assignTechnicianAction, type TechnicianState } from "../technician-actions";

const idle: TechnicianState = { status: "idle", message: "" };

const ROLE_NAMES: Record<string, string> = { owner: "Owner", manager: "Manager", technician: "Technician", front_desk: "Front desk" };

/** P5.6: choose who did the job, for revenue and hours by technician in Reports. */
export function TechnicianForm({
  bookingId,
  current,
  team,
}: {
  bookingId: string;
  current: { technicianId: string | null; technicianName: string } | null;
  team: { userId: string; name: string; role: string }[];
}) {
  const [state, action] = useActionState(assignTechnicianAction, idle);
  const fieldId = useId();
  const messageId = useId();
  const formerMember = current && !team.some((member) => member.userId === current.technicianId);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="bookingId" value={bookingId} />
      <label htmlFor={fieldId} className="text-[14px] font-semibold text-grey-800">
        Who did the job
      </label>
      <div className="flex flex-wrap items-center gap-2.5">
        <select
          id={fieldId}
          name="technicianId"
          defaultValue={current?.technicianId ?? ""}
          aria-describedby={messageId}
          className="h-11 min-w-0 flex-[1_1_220px] rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
        >
          <option value="">Nobody yet</option>
          {formerMember && current?.technicianId ? <option value={current.technicianId}>{current.technicianName} (left the team)</option> : null}
          {team.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name} ({ROLE_NAMES[member.role] ?? member.role})
            </option>
          ))}
        </select>
        <SubmitButton className={buttonClass("secondary")}>Save</SubmitButton>
      </div>
      <p
        id={messageId}
        role={state.status === "error" ? "alert" : "status"}
        className={cn("m-0 text-[14px] font-semibold", state.status === "error" ? "text-[#991b1b]" : "text-success-ink")}
      >
        {state.message || <span className="font-normal text-grey-600">Used for revenue and hours by technician in Reports.</span>}
      </p>
    </form>
  );
}
