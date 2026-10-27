/**
 * Customer-facing opt-out wording, from docs/autofix/legal/consent-and-messaging-wording.md
 * ("Unsubscribe page"). Pure and client-safe. `[Garage name]` is filled with
 * fillGarageName(); src/__tests__/legal-copy.test.ts checks every string
 * against the draft.
 */

export const UNSUBSCRIBE_COPY = {
  /** After the signed link: the opt-out is already recorded. */
  done: "You won't get any more reminders from [Garage name]. You'll still get messages about bookings you make.",
  changedMind: "Changed your mind?",
  resumeLabel: "Turn reminders back on",
  /** After "Turn reminders back on"; stored as `customers.consent_text`. */
  resumed: "Reminders are back on. [Garage name] will send you reminders again. You can stop them any time.",
  /** The page without a link. */
  formPrompt: "Enter the mobile number we text you on and we'll stop reminders from [Garage name].",
  /** The form's answer, the same whether or not the number is on file. */
  formResponse:
    "If that number is on our list, you won't get any more reminders from [Garage name]. You'll still get messages about bookings you make. You can also reply STOP to any reminder text.",
} as const;

/** The line added to emails and to texts from an alphanumeric sender (which cannot receive STOP, DECISIONS A13). */
export const UNSUBSCRIBE_LINK_LINE = "Stop reminders: {unsubscribe_link}";

export function fillGarageName(template: string, garageName: string) {
  return template.replaceAll("[Garage name]", garageName);
}
