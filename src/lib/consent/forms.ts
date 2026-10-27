/** Form state for the unsubscribe form (client-safe). */
export type UnsubscribeFormState = {
  status: "idle" | "done" | "invalid_phone" | "rate_limited" | "unavailable";
  /** Bumped on every submission so the form can move focus to the answer. */
  seq: number;
};

export const initialUnsubscribeFormState: UnsubscribeFormState = { status: "idle", seq: 0 };
