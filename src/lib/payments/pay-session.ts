import "server-only";

import { cookies } from "next/headers";
import { isPayTokenShape, PAY_COOKIE, payCookieOptions } from "./tokens";

/** Puts a pay token in the httpOnly `af_pay` cookie (path /pay) so /pay can show the payment. */
export async function writePayCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(PAY_COOKIE, token, payCookieOptions());
}

/** The pay token from `af_pay`, or null. */
export async function readPayCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(PAY_COOKIE)?.value ?? null;
  return isPayTokenShape(value) ? value : null;
}
