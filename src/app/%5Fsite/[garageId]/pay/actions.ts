"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/booking-flow/server";
import { getPaymentsProvider } from "@/lib/payments";
import { readPayCookie } from "@/lib/payments/pay-session";
import { loadPaymentByToken, loadPaymentsSetup, markPaymentPaid, releaseExpiredDeposits } from "@/lib/payments/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/server";
import { getGarage } from "@/lib/tenancy/garage";
import { garageUrl } from "@/lib/tenancy/urls";

// The /pay page's one action (P5.4). The garage comes from the host and the payment from the httpOnly
// `af_pay` cookie; the form carries nothing. With the mock provider the test payment is applied here;
// with Stripe the customer goes to a Checkout Session on the garage's own account.

export async function payNowAction(): Promise<void> {
  const garage = await getGarage();
  const token = await readPayCookie();
  if (!token) redirect("/pay?link=invalid");
  if (!(await consumeRateLimit(`${garage.id}:${await clientIp()}`, "pay_now", 20, 600))) redirect("/pay?error=limited");

  const payment = await loadPaymentByToken(garage.id, token);
  if (!payment) redirect("/pay?link=invalid");
  if (payment.status !== "pending") redirect("/pay");
  if (Date.parse(payment.expires_at) <= Date.now()) {
    await releaseExpiredDeposits(garage.id);
    redirect("/pay");
  }

  const setup = await loadPaymentsSetup(garage);
  const provider = getPaymentsProvider();
  if (!setup.active || !provider || provider.kind !== payment.provider || !setup.account) redirect("/pay?error=unavailable");

  if (provider.kind === "mock") {
    const paid = await markPaymentPaid({
      garageId: garage.id,
      paymentId: payment.id,
      provider: "mock",
      providerPaymentRef: `mock_pi_${randomBytes(8).toString("hex")}`,
      amountPence: payment.amount_pence,
    });
    redirect(paid.ok ? "/pay?done=1" : "/pay?error=failed");
  }

  const checkout = await provider.createCheckout({
    accountRef: setup.account.account_ref,
    paymentId: payment.id,
    garageId: garage.id,
    amountPence: payment.amount_pence,
    description: payment.description,
    successUrl: garageUrl(garage, "/pay?paid=1"),
    cancelUrl: garageUrl(garage, "/pay?cancelled=1"),
    expiresAt: new Date(payment.expires_at),
  });
  if (checkout.kind !== "redirect") redirect("/pay?error=failed");
  const db = createAdminClient();
  await db?.rpc("set_payment_checkout", { p_garage_id: garage.id, p_payment_id: payment.id, p_checkout_ref: checkout.checkoutRef });
  redirect(checkout.url);
}
