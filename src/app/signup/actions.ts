"use server";

import { redirect } from "next/navigation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { parseAccountForm, type AccountField, type FieldErrors } from "@/lib/signup/schema";
import { passSignupHumanCheck, requestIp } from "@/lib/signup/server";
import { createClient } from "@/lib/supabase/server";
import { adminUrl } from "@/lib/tenancy/urls";

export type AccountFormState = {
  seq: number;
  errors: FieldErrors<AccountField>;
  message?: string;
  /** Echoed back so the form keeps what was typed (never the password). */
  values?: { name: string; email: string };
};

/** Where the confirmation email's link lands: /auth/confirm verifies it and continues the wizard. */
const SIGNUP_CONFIRM_PATH = "/auth/confirm?next=/signup/garage";

/**
 * Step 0: create the owner's account (Supabase Auth, email + password). With email confirmation on
 * (production and local) the owner is sent to "check your email"; the link continues at
 * /signup/garage. An address that already has an account gets the same answer (no enumeration).
 */
export async function signUpAction(previous: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const seq = previous.seq + 1;
  const values = { name: String(formData.get("name") ?? "").slice(0, 100), email: String(formData.get("email") ?? "").slice(0, 254) };
  const parsed = parseAccountForm(formData);
  if (!parsed.ok) return { seq, errors: parsed.errors, values };

  const ip = await requestIp();
  if (!(await consumeRateLimit(ip, "signup_ip", 5, 3_600)) || !(await consumeRateLimit(parsed.value.email, "signup_email", 3, 3_600))) {
    return { seq, errors: {}, values, message: "Too many sign-ups from here. Wait an hour and try again." };
  }
  if (!(await passSignupHumanCheck(formData.get("cf-turnstile-response"), ip))) {
    return { seq, errors: {}, values, message: "Please complete the security check and try again." };
  }

  const client = await createClient();
  if (!client) return { seq, errors: {}, values, message: "Sign-up is not available right now. Try again later." };
  const { data, error } = await client.auth.signUp({
    email: parsed.value.email,
    password: parsed.value.password,
    options: { emailRedirectTo: adminUrl(SIGNUP_CONFIRM_PATH), data: { display_name: parsed.value.name } },
  });
  if (error) {
    if (error.code === "weak_password") return { seq, errors: { password: "Choose a stronger password." }, values };
    if (error.code === "over_email_send_rate_limit" || error.status === 429) {
      return { seq, errors: {}, values, message: "Too many sign-ups just now. Wait a few minutes and try again." };
    }
    if (error.code !== "user_already_exists") return { seq, errors: {}, values, message: "Your account could not be created. Try again." };
  }
  // Email confirmation off (some local setups): the session exists already.
  if (data?.session) redirect("/signup/garage");
  redirect("/signup/check-email");
}

export type ContinueState = { seq: number; message?: string };

/** For an owner who confirmed their email but has not created a garage yet: sign in and carry on. */
export async function signInToContinueAction(previous: ContinueState, formData: FormData): Promise<ContinueState> {
  const seq = previous.seq + 1;
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { seq, message: "Enter your email address and password." };
  const ip = await requestIp();
  if (!(await consumeRateLimit(`${email}:${ip}`, "admin_login_source", 8, 300)) || !(await consumeRateLimit(email, "admin_login_account", 30, 900))) {
    return { seq, message: "Sign-in failed. Check your details and try again." };
  }
  const client = await createClient();
  if (!client) return { seq, message: "Sign-in is not available right now." };
  const { error } = await client.auth.signInWithPassword({ email, password: password.slice(0, 1_024) });
  if (error) {
    return { seq, message: error.code === "email_not_confirmed" ? "Confirm your email address first: use the link we sent you." : "Sign-in failed. Check your details and try again." };
  }
  redirect("/signup/garage");
}

/** Signs out from the wizard ("Use another account"). */
export async function signOutOfSignupAction(): Promise<void> {
  const client = await createClient();
  await client?.auth.signOut();
  redirect("/signup");
}
