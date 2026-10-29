import { type EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { adminBaseUrl } from "@/lib/tenancy/urls";
import { isRecoveryNextPath, RECOVERY_DESTINATION } from "@/lib/auth/recovery-paths";
import { createClient } from "@/lib/supabase/server";

const recoveryDestination = RECOVERY_DESTINATION;

/** Sign-up confirmation (P4.4) continues the wizard; nothing else may be named in `next`. */
function isSignupNextPath(value: string | null): value is string {
  return value === "/signup/garage";
}

function invalidLink() {
  const destination = new URL("/app/login", adminBaseUrl());
  destination.searchParams.set("error", "invalid-link");
  return NextResponse.redirect(destination);
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type Interstitial = { type: "recovery" | "email"; next: string; eyebrow: string; title: string; text: string; button: string; footer: string };

const RECOVERY_INTERSTITIAL: Interstitial = {
  type: "recovery",
  next: recoveryDestination,
  eyebrow: "PASSWORD RECOVERY",
  title: "Continue to reset your password",
  text: "For your security, the recovery link is used only after you confirm below.",
  button: "Continue securely",
  footer: "If you did not request this password reset, close this page.",
};

// Sign-up (P4.4): the confirmation link is used only on a click, so a mail scanner opening it
// cannot use up the token.
const SIGNUP_INTERSTITIAL: Interstitial = {
  type: "email",
  next: "/signup/garage",
  eyebrow: "CONFIRM YOUR EMAIL",
  title: "Confirm your email address",
  text: "Confirm below, then set up your garage and its booking page.",
  button: "Confirm and continue",
  footer: "If you did not sign up for Pitline, close this page.",
};

function confirmationPage(tokenHash: string, page: Interstitial) {
  const token = escapeHtml(tokenHash);
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)} | Pitline</title></head>
<body style="margin:0;background:#F4F7FA;color:#071127;font-family:Arial,Helvetica,sans-serif"><main style="box-sizing:border-box;max-width:560px;margin:64px auto;padding:40px;border:1px solid #DCE6F2;border-radius:16px;background:#fff"><p style="color:#155FBA;font-size:12px;font-weight:700;letter-spacing:.7px">${page.eyebrow}</p><h1 style="font-size:30px;line-height:1.25">${escapeHtml(page.title)}</h1><p style="color:#586575;line-height:1.6">${escapeHtml(page.text)}</p><form method="post" action="/auth/confirm"><input type="hidden" name="token_hash" value="${token}"><input type="hidden" name="type" value="${page.type}"><input type="hidden" name="next" value="${page.next}"><button type="submit" style="width:100%;min-height:48px;margin-top:18px;border:0;border-radius:11px;background:#155FBA;color:#fff;font-size:16px;font-weight:700;cursor:pointer">${escapeHtml(page.button)}</button></form><p style="margin-top:20px;color:#586575;font-size:13px;line-height:1.5">${escapeHtml(page.footer)}</p></main></body></html>`, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      // A basic form POST needs an Origin header for the same-origin check below.
      // strict-origin preserves that header without forwarding the token-bearing URL.
      "Referrer-Policy": "strict-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const code = request.nextUrl.searchParams.get("code");
  const requestedNext = request.nextUrl.searchParams.get("next");
  if (tokenHash && type === "recovery" && isRecoveryNextPath(requestedNext)) return confirmationPage(tokenHash, RECOVERY_INTERSTITIAL);
  if (tokenHash && type === "email" && isSignupNextPath(requestedNext)) return confirmationPage(tokenHash, SIGNUP_INTERSTITIAL);

  const destination = new URL(
    isRecoveryNextPath(requestedNext) ? recoveryDestination : isSignupNextPath(requestedNext) ? requestedNext : "/app",
    adminBaseUrl(),
  );
  const client = await createClient();
  if (code) {
    const { error } = await client?.auth.exchangeCodeForSession(code) ?? { error: new Error("Not configured") };
    if (!error) return NextResponse.redirect(destination);
  }
  if (tokenHash && type && type !== "recovery") {
    const { error } = await client?.auth.verifyOtp({ type, token_hash: tokenHash }) ?? { error: new Error("Not configured") };
    if (!error) return NextResponse.redirect(destination);
  }
  return invalidLink();
}

export async function POST(request: NextRequest) {
  const canonicalOrigin = new URL(adminBaseUrl()).origin;
  if (request.headers.get("origin") !== canonicalOrigin) return invalidLink();
  const formData = await request.formData();
  const tokenHash = formData.get("token_hash");
  const type = formData.get("type");
  const requestedNext = formData.get("next");
  if (typeof tokenHash === "string" && tokenHash && type === "email" && requestedNext === SIGNUP_INTERSTITIAL.next) {
    const client = await createClient();
    const { error } = await client?.auth.verifyOtp({ type: "email", token_hash: tokenHash }) ?? { error: new Error("Not configured") };
    // A used or expired link: /signup/garage offers sign-in (the address may already be confirmed).
    return NextResponse.redirect(new URL(error ? "/signup/garage?link=invalid" : SIGNUP_INTERSTITIAL.next, adminBaseUrl()), 303);
  }
  if (typeof tokenHash !== "string" || !tokenHash || type !== "recovery" || !isRecoveryNextPath(requestedNext)) return invalidLink();

  const client = await createClient();
  const { error } = await client?.auth.verifyOtp({ type: "recovery", token_hash: tokenHash }) ?? { error: new Error("Not configured") };
  if (error) return invalidLink();
  return NextResponse.redirect(new URL(recoveryDestination, adminBaseUrl()));
}
