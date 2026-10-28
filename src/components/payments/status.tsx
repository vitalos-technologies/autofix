import { Badge, type BadgeTone } from "@/components/admin-ui";
import { PAYMENT_ATTENTION_LABELS, PAYMENT_KIND_LABELS, PAYMENT_STATUS_LABELS, type PaymentAttention, type PaymentKind, type PaymentStatus } from "@/lib/payments/amounts";

const TONES: Record<PaymentStatus, BadgeTone> = {
  pending: "warning",
  paid: "success",
  expired: "muted",
  cancelled: "muted",
  failed: "danger",
};

/** A payment's state: "Paid", "Waiting to be paid"; paid with a problem reads "Paid, check it". */
export function PaymentStatusBadge({ status, attention, size = "sm" }: { status: PaymentStatus; attention?: PaymentAttention | null; size?: "xs" | "sm" | "md" }) {
  if (status === "paid" && attention) return <Badge tone="danger" size={size}>Paid, check it</Badge>;
  return <Badge tone={TONES[status]} size={size}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

export function paymentKindLabel(kind: PaymentKind): string {
  return PAYMENT_KIND_LABELS[kind];
}

export function attentionLabel(attention: PaymentAttention | null | undefined): string | null {
  return attention ? PAYMENT_ATTENTION_LABELS[attention] : null;
}

/** Flash messages after a payments action (`?payments=<code>`; codes only, never free text). */
export const PAYMENT_FLASH: Record<string, { tone: "success" | "info" | "warning" | "danger"; text: string }> = {
  link_sent: { tone: "success", text: "Payment link sent to the customer." },
  link_failed: { tone: "warning", text: "The link was made but the message didn't send. Try again in a few minutes." },
  link_opted_out: { tone: "warning", text: "The link was made, but the customer has opted out of texts and has no email address, so nothing was sent. Add an email address and send again, or take payment by phone." },
  link_no_contact: { tone: "warning", text: "The link was made, but the customer has no mobile number or email address, so nothing was sent." },
  waived: { tone: "success", text: "Deposit waived. The booking stands and the customer's confirmation is on its way." },
  cancelled: { tone: "success", text: "Payment link cancelled. It no longer works." },
  not_allowed: { tone: "danger", text: "Owners, managers and front desk can send payment links." },
  plan_required: { tone: "danger", text: "Payments are on Pro. Upgrade in Settings, Plan." },
  unavailable: { tone: "danger", text: "Card payments aren't available right now." },
  payments_not_connected: { tone: "danger", text: "Connect a payment account first, in Payments settings." },
  issued_invoice_not_found: { tone: "danger", text: "Only an issued, unpaid invoice can be paid by link." },
  invalid_payment_amount: { tone: "danger", text: "The balance is under £1, so there is nothing to send." },
  booking_not_no_show: { tone: "danger", text: "Mark the booking as a no-show first." },
  no_show_fee_not_set: { tone: "danger", text: "Set a no-show fee in Payments settings first." },
  already_paid: { tone: "info", text: "The no-show fee has already been paid." },
  pending_payment_not_found: { tone: "info", text: "That payment is no longer waiting to be paid." },
  failed: { tone: "danger", text: "That didn't work. Try again." },
};
