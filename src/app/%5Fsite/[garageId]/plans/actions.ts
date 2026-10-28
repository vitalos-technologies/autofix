"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIp, passHumanCheck } from "@/lib/booking-flow/server";
import { toE164UK } from "@/lib/messaging/phone";
import { consumeRateLimit } from "@/lib/rate-limit";
import { confirmMockMandate, loadSignup, startSignup } from "@/lib/service-plans/server";
import { readPlanSession, writePlanSession } from "@/lib/service-plans/signup-session";
import { getGarage } from "@/lib/tenancy/garage";
import { registrationSchema } from "@/lib/vehicle/registration";

// Service plan sign-up on the garage host (P5.11). The garage comes from the request host, the plan
// id from the form (checked in SQL to be this garage's active plan), and the sign-up in progress from
// the sealed httpOnly `af_plan` cookie. Redirects go to /plans/confirm or the provider's hosted page:
// never with a registration, phone number or subscription id. Nothing here logs form values.

export type PlanSignupState = {
  seq: number;
  message?: string;
  fieldErrors?: Partial<Record<"name" | "phone" | "email" | "registration" | "authorise", string>>;
};

const emailSchema = z.email().max(254);
const uuid = z.string().uuid();

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: FormDataEntryValue | null, max: number): string | null {
  const trimmed = text(value).replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
}

const MESSAGES: Record<string, string> = {
  PLAN_REQUIRED: "Service plans aren't available at this garage right now.",
  PLAN_NOT_AVAILABLE: "That plan isn't open to new members any more. Choose another plan.",
  PAYMENTS_NOT_READY: "Direct Debits can't be set up here right now. Please contact the garage.",
  ALREADY_ON_PLAN: "That car is already on a plan with us. Contact the garage to change it.",
  INVALID_SIGNUP: "Check your details and try again.",
  provider: "We couldn't start the Direct Debit just now. Nothing has been set up. Please try again.",
  failed: "We couldn't start your sign-up just now. Please try again, or contact the garage.",
};

export async function startPlanSignupAction(previous: PlanSignupState, formData: FormData): Promise<PlanSignupState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const planId = uuid.safeParse(text(formData.get("planId")));
  if (!planId.success) return { seq, message: MESSAGES.PLAN_NOT_AVAILABLE };

  const fieldErrors: NonNullable<PlanSignupState["fieldErrors"]> = {};
  const name = clean(formData.get("name"), 120);
  if (!name || name.length < 2) fieldErrors.name = "Enter your full name.";
  const phone = toE164UK(text(formData.get("phone")));
  if (!phone) fieldErrors.phone = "Enter a UK mobile number, for example 07700 900123.";
  const rawEmail = text(formData.get("email")).toLowerCase();
  const email = rawEmail && emailSchema.safeParse(rawEmail).success ? rawEmail : null;
  if (rawEmail && !email) fieldErrors.email = "Enter an email address like name@example.com.";
  const requested = text(formData.get("channel"));
  const channel = requested === "whatsapp" || requested === "email" ? requested : "sms";
  if (channel === "email" && !email) fieldErrors.email = "Add your email address to get messages by email.";
  const registration = registrationSchema.safeParse(text(formData.get("registration")));
  if (!registration.success) fieldErrors.registration = "Enter the car's registration, for example AB12 CDE.";
  if (formData.get("authorise") !== "yes") fieldErrors.authorise = "Confirm you can authorise Direct Debits from the account.";
  if (Object.keys(fieldErrors).length > 0) return { seq, fieldErrors };

  const ip = await clientIp();
  if (!(await consumeRateLimit(ip, "plan_signup", 10, 600)) || !(await consumeRateLimit(garage.id, "plan_signup_garage", 200, 3600))) {
    return { seq, message: "Too many attempts just now. Wait a few minutes and try again." };
  }
  if (!(await passHumanCheck(formData.get("turnstileToken"), {}, ip))) return { seq, message: "Please complete the security check, then try again." };

  const started = await startSignup(garage, {
    planId: planId.data,
    customer: { name: name!, phone: phone!, email, channel },
    vehicle: { registration: registration.data!, make: clean(formData.get("make"), 80), model: clean(formData.get("model"), 120) },
  });
  if (!started.ok) return { seq, message: MESSAGES[started.code] ?? MESSAGES.failed };
  await writePlanSession(garage.id, started.subscriptionId);
  redirect(started.next.kind === "redirect" ? started.next.url : "/plans/confirm");
}

/** The mock provider's "set up Direct Debit" on /plans/confirm (no bank details, no money). */
export async function confirmMockMandateAction(): Promise<void> {
  const garage = await getGarage();
  const subscriptionId = await readPlanSession(garage.id);
  if (!subscriptionId) redirect("/plans/confirm");
  if (!(await consumeRateLimit(`${garage.id}:${await clientIp()}`, "plan_confirm", 20, 600))) redirect("/plans/confirm?error=limited");
  const signup = await loadSignup(garage.id, subscriptionId);
  if (!signup || signup.status !== "pending_mandate" || signup.provider !== "mock") redirect("/plans/confirm");
  const applied = await confirmMockMandate(garage.id, subscriptionId);
  redirect(applied.ok ? "/plans/confirm" : "/plans/confirm?error=failed");
}
