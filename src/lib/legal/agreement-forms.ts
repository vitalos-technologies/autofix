/** Form state for DPA acceptance (client-safe; shared by /app/settings/agreements and sign-up, P4.4). */
export type AcceptAgreementState = {
  status: "idle" | "accepted" | "unconfirmed" | "forbidden" | "stale" | "failed";
  seq: number;
};

export const initialAcceptAgreementState: AcceptAgreementState = { status: "idle", seq: 0 };
