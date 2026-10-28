import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Clock3, Phone } from "lucide-react";
import { formatSlotLabel, formatTime } from "@/components/book/format";
import { focusRing } from "@/components/book/styles";
import { getPaymentsProvider } from "@/lib/payments";
import { formatPounds } from "@/lib/payments/amounts";
import { readPayCookie } from "@/lib/payments/pay-session";
import { loadPaymentByToken, loadPaymentsSetup, releaseExpiredDeposits, syncCheckout, type PayPagePayment } from "@/lib/payments/server";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { requireSiteGarage, type Garage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BookingScreen } from "../_components/booking-screen";
import { payNowAction } from "./actions";
import { PayButton } from "./pay-button";

export const metadata: Metadata = { title: "Pay", robots: { index: false, follow: false, nocache: true } };

type PayPageProps = {
  params: Promise<{ garageId: string }>;
  searchParams: Promise<{ link?: string; error?: string; done?: string; paid?: string; cancelled?: string }>;
};

const ERRORS: Record<string, string> = {
  unavailable: "Online payment isn't available right now. Please contact the garage to pay.",
  failed: "The payment couldn't be started. Nothing has been taken. Please try again.",
  limited: "Too many attempts just now. Wait a minute and try again.",
};

function heading(payment: PayPagePayment) {
  if (payment.kind === "deposit") return "Pay your deposit";
  if (payment.kind === "no_show_fee") return "Missed appointment fee";
  return payment.invoiceNumber ? `Invoice ${payment.invoiceNumber}` : "Pay your invoice";
}

function CallGarage({ garage }: { garage: Pick<Garage, "name" | "phone"> }) {
  const href = telHref(garage.phone);
  if (!href) return null;
  return (
    <a
      href={href}
      className={cn("inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-control border border-grey-300 bg-white px-4 text-[15px] font-bold text-navy-950 no-underline", focusRing)}
    >
      <Phone size={18} strokeWidth={2} aria-hidden="true" />
      Call {formatPhoneForDisplay(garage.phone)}
    </a>
  );
}

function Message({ tone, icon, title, children }: { tone: "success" | "info" | "error"; icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-card border px-4 py-3.5",
        tone === "success" && "border-[#bfe5cb] bg-success-bg text-success-ink",
        tone === "info" && "border-[#c7dcf5] bg-[#eef5fd] text-navy-950",
        tone === "error" && "border-[#f3c4c4] bg-[#fdecec] text-[#991b1b]",
      )}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">{icon}</span>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[15px] font-bold">{title}</p>
        {children ? <div className="m-0 text-[14px] leading-normal">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * Pay (P5.4) on the garage host: a deposit right after booking, an invoice or a no-show fee from a
 * pay link. The payment comes from the httpOnly `af_pay` cookie only, so the page shows nothing to
 * another browser, and the address never holds the token or a registration.
 */
export default async function PayPage({ params, searchParams }: PayPageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const query = await searchParams;
  const token = await readPayCookie();
  let payment = token ? await loadPaymentByToken(garage.id, token).catch(() => null) : null;

  // Back from the provider's checkout: apply it now if the webhook has not yet.
  if (payment && query.paid === "1" && payment.status === "pending" && (await syncCheckout(garage.id, payment).catch(() => false))) {
    payment = token ? await loadPaymentByToken(garage.id, token).catch(() => null) : null;
  }
  // A deposit whose hold has run out: release its booking now (the job may not have run yet).
  const now = new Date();
  if (payment && payment.status === "pending" && Date.parse(payment.expires_at) <= now.getTime() && (await releaseExpiredDeposits(garage.id)) > 0) {
    payment = token ? await loadPaymentByToken(garage.id, token).catch(() => null) : null;
  }

  const timeZone = garage.timezone || "Europe/London";
  const subtitle = "Secure payment";

  if (!payment) {
    return (
      <BookingScreen garage={garage} subtitle={subtitle} withActionBar={false}>
        <div className="flex flex-col gap-4 px-5 pt-7 pb-6">
          <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">
            {query.link === "limited" ? "Too many tries" : "This payment link isn't valid"}
          </h1>
          <p className="m-0 text-[15px] leading-normal text-grey-700">
            {query.link === "limited"
              ? "Wait a few minutes, then open the link from your message again."
              : `Open the link from the message ${garage.name} sent you, on this device. If it still doesn't work, contact the garage.`}
          </p>
          <CallGarage garage={garage} />
          <Link href="/" className="inline-flex min-h-11 items-center justify-center text-[14px] font-semibold text-accent underline underline-offset-2">
            Go to the booking page
          </Link>
        </div>
      </BookingScreen>
    );
  }

  const setup = await loadPaymentsSetup(garage);
  const provider = getPaymentsProvider();
  const lapsed = Date.parse(payment.expires_at) <= now.getTime();
  const canPay = payment.status === "pending" && setup.active && provider?.kind === payment.provider && !lapsed;
  const amount = formatPounds(payment.status === "paid" ? (payment.amount_paid_pence ?? payment.amount_pence) : payment.amount_pence);
  const error = query.error ? ERRORS[query.error] : null;

  return (
    <BookingScreen garage={garage} subtitle={subtitle} withActionBar={false}>
      <div className="flex flex-col gap-4 px-5 pt-7 pb-6">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">{heading(payment)}</h1>

        {payment.status === "paid" ? (
          <Message tone="success" icon={<CircleCheck size={22} strokeWidth={2.2} />} title={`Paid ${amount}. Thank you.`}>
            {payment.kind === "deposit"
              ? "Your booking is confirmed. Your confirmation is on its way by message."
              : `${garage.name} has your payment. You can close this page.`}
          </Message>
        ) : null}
        {payment.status === "pending" && query.paid === "1" ? (
          <Message tone="info" icon={<Clock3 size={22} strokeWidth={2.2} />} title="We're confirming your payment">
            This usually takes a few seconds. <Link href="/pay" className="font-semibold underline underline-offset-2">Refresh</Link>
          </Message>
        ) : null}
        {payment.status === "pending" && query.cancelled === "1" ? (
          <Message tone="info" icon={<CircleAlert size={22} strokeWidth={2.2} />} title="Payment not finished">
            Nothing has been taken. You can pay below.
          </Message>
        ) : null}
        {payment.status === "expired" || (payment.status === "pending" && lapsed) ? (
          <Message tone="error" icon={<CircleAlert size={22} strokeWidth={2.2} />} title="This payment link has expired">
            {payment.kind === "deposit"
              ? "The deposit wasn't paid in time, so we couldn't keep the booking. You're welcome to book again."
              : "Ask the garage to send you a new link."}
          </Message>
        ) : null}
        {payment.status === "cancelled" ? (
          <Message tone="info" icon={<CircleAlert size={22} strokeWidth={2.2} />} title="Nothing to pay">
            {garage.name} no longer needs this payment.
          </Message>
        ) : null}
        {error ? <Message tone="error" icon={<CircleAlert size={22} strokeWidth={2.2} />} title={error} /> : null}

        <section aria-label="Payment details" className="flex flex-col gap-3 rounded-card border border-grey-200 bg-white p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[14px] font-semibold text-grey-700">{payment.status === "paid" ? "Paid" : "To pay"}</span>
            <span className="font-display text-[34px] leading-none font-extrabold text-navy-950">{amount}</span>
          </div>
          <dl className="m-0 grid gap-2 border-t border-grey-100 pt-3 text-[14px]">
            <div className="flex justify-between gap-3">
              <dt className="text-grey-600">For</dt>
              <dd className="m-0 text-right font-semibold text-navy-950">{payment.description}</dd>
            </div>
            {payment.booking ? (
              <div className="flex justify-between gap-3">
                <dt className="text-grey-600">{payment.kind === "deposit" ? "Booking" : "Appointment"}</dt>
                <dd className="m-0 text-right text-navy-950">
                  {[payment.booking.serviceName, formatSlotLabel(payment.booking.startsAt, timeZone)].filter(Boolean).join(", ")}
                </dd>
              </div>
            ) : null}
            {payment.kind === "deposit" && canPay ? (
              <div className="flex justify-between gap-3">
                <dt className="text-grey-600">Time held until</dt>
                <dd className="m-0 text-right font-semibold text-navy-950">{formatTime(payment.expires_at, timeZone)}</dd>
              </div>
            ) : null}
          </dl>
        </section>

        {canPay ? (
          <form action={payNowAction} className="flex flex-col gap-3">
            {provider?.kind === "mock" ? (
              <p className="m-0 rounded-card border border-dashed border-grey-300 bg-white px-3 py-2.5 text-[13px] leading-normal text-grey-700">
                Test payment: no card is needed and no money moves.
              </p>
            ) : null}
            <PayButton label={`Pay ${amount}`} />
            <p className="m-0 text-[13px] leading-normal text-grey-600">
              {provider?.kind === "stripe"
                ? `You'll pay ${garage.name} on Stripe's secure page, then come back here.`
                : `You pay ${garage.name} directly.`}
              {payment.kind === "deposit" ? " The deposit comes off your bill." : null}
            </p>
          </form>
        ) : payment.status === "pending" && !lapsed && !error ? (
          <Message tone="info" icon={<CircleAlert size={22} strokeWidth={2.2} />} title="Online payment isn't available right now">
            Please contact {garage.name} to pay.
          </Message>
        ) : null}

        {payment.status === "expired" && payment.kind === "deposit" ? (
          <Link href="/" className={cn("inline-flex h-[54px] items-center justify-center rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline", focusRing)}>
            Book again
          </Link>
        ) : null}
        {payment.status !== "paid" ? <CallGarage garage={garage} /> : null}
      </div>
    </BookingScreen>
  );
}
