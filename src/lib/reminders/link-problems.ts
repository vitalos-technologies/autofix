// Why a reminder link opened nothing (`/r?link=…`). Pure and client-safe.

export const REMINDER_LINK_PROBLEMS = ["expired", "invalid", "limited", "unavailable"] as const;
export type ReminderLinkProblem = (typeof REMINDER_LINK_PROBLEMS)[number];

export function reminderLinkProblem(value: string | string[] | undefined): ReminderLinkProblem {
  const single = Array.isArray(value) ? value[0] : value;
  return REMINDER_LINK_PROBLEMS.find((problem) => problem === single) ?? "invalid";
}
