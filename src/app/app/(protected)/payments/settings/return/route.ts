import { NextResponse } from "next/server";
import { getPaymentsProvider } from "@/lib/payments";
import { loadPaymentsSetup } from "@/lib/payments/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getAdminContext } from "@/lib/tenancy/admin";

// P5.4: where Stripe's account onboarding sends the owner back (and its "link expired" refresh). Reads
// the connected account's state from Stripe and stores it, then shows Payment settings. The garage is
// the member's selected garage; only its own stored account is refreshed.

const SETTINGS = "/app/payments/settings";

function back(request: Request, query: string) {
  return NextResponse.redirect(new URL(`${SETTINGS}${query}`, request.url), 303);
}

export async function GET(request: Request) {
  const admin = await getAdminContext();
  if (!admin) return NextResponse.redirect(new URL("/app/login", request.url), 303);
  if (admin.role !== "owner") return back(request, "?error=owner_only");
  const provider = getPaymentsProvider();
  const db = createAdminClient();
  if (!provider || !db) return back(request, "?error=unavailable");
  const setup = await loadPaymentsSetup(admin.garage, db);
  if (!setup.hasFeature) return back(request, "?error=plan_required");
  const account = setup.account;
  if (!account || account.provider !== provider.kind || account.status === "disconnected") return back(request, "");
  const state = await provider.getAccount(account.account_ref);
  if (!state) return back(request, "?error=provider");
  const applied = await db.rpc("apply_payment_account", {
    p_garage_id: admin.garage.id,
    p_provider: provider.kind,
    p_account_ref: state.accountRef,
    p_status: state.status,
    p_charges_enabled: state.chargesEnabled,
    p_actor: admin.user.id,
  });
  if (applied.error) return back(request, "?error=save_failed");
  return back(request, state.status === "active" ? "?done=connected" : "?done=pending");
}
