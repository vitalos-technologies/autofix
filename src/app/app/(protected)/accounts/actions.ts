"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { AccountDataError, getStatementDetail, searchCustomers, searchVehicles, type CustomerMatch, type VehicleMatch } from "@/lib/accounts/queries";
import { sendStatementEmail } from "@/lib/accounts/statement-email";
import { accountErrorMessage, isMonthStart, parseAccountForm, PERSON_ROLES, type AccountField } from "@/lib/accounts/view";
import { featureProblem } from "@/lib/plans/server";
import { NOT_ALLOWED_MESSAGES, requireSetupContext, roleAllows } from "@/lib/settings/server";
import type { AdminContext } from "@/lib/tenancy/admin";

// Fleet and trade accounts (P5.7). The garage is always the member's selected garage and every
// write goes through its RLS client or the account SQL functions, which check the role (owners and
// managers) and the plan (Pro, `fleet_accounts`) again. Registrations and search terms travel in
// POST bodies only; redirects carry ids and short codes, never a registration.

const FEATURE = "fleet_accounts" as const;
const uuid = z.string().uuid();

export type AccountFormState = {
  seq: number;
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Partial<Record<AccountField, string>>;
};

export type PanelActionState = { seq: number; status: "idle" | "saved" | "error"; message?: string };

function next<T extends { seq: number }>(previous: T, state: Omit<T, "seq">): T {
  return { ...state, seq: previous.seq + 1 } as T;
}

/** Owners and managers of a Pro garage, signed in with two-step verification in this session; else the reason. */
async function writer(returnTo: string): Promise<{ admin: AdminContext; problem: null } | { admin: AdminContext; problem: string }> {
  const admin = await requireSetupContext(returnTo);
  if (!roleAllows(admin, "manage")) return { admin, problem: NOT_ALLOWED_MESSAGES.manage };
  const plan = featureProblem(admin, FEATURE);
  if (plan) return { admin, problem: plan };
  return { admin, problem: null };
}

function refresh(accountId?: string, statementId?: string) {
  revalidatePath("/app/accounts");
  if (accountId) revalidatePath(`/app/accounts/${accountId}`);
  if (statementId) revalidatePath(`/app/accounts/statements/${statementId}`);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Adds an account, or saves one (`accountId` in the form). */
export async function saveAccountAction(previous: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const rawId = formData.get("accountId");
  const id = rawId ? uuid.safeParse(rawId) : null;
  if (id && !id.success) return next(previous, { status: "error", message: "That account could not be found." });
  const accountId = id?.success ? id.data : null;
  const { admin, problem } = await writer(accountId ? `/app/accounts/${accountId}/edit` : "/app/accounts/new");
  if (problem) return next(previous, { status: "error", message: problem });

  const parsed = parseAccountForm(formData);
  if (!parsed.ok) return next(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });

  let savedId = accountId;
  if (accountId) {
    const { data, error } = await admin.client.from("business_accounts").update(parsed.value).eq("garage_id", admin.garage.id).eq("id", accountId).select("id");
    if (error) return next(previous, { status: "error", message: accountErrorMessage(error) });
    if (!data?.length) return next(previous, { status: "error", message: "That account could not be found." });
  } else {
    const { data, error } = await admin.client.from("business_accounts").insert(parsed.value).select("id").single();
    if (error || !data) return next(previous, { status: "error", message: accountErrorMessage(error) });
    savedId = String(data.id);
  }
  await recordAdminAudit(admin.garage.id, {
    actorId: admin.user.id,
    action: accountId ? "account.updated" : "account.created",
    entityType: "business_account",
    entityId: savedId!,
    detail: { kind: parsed.value.kind, billing: parsed.value.billing },
  });
  refresh(savedId!);
  redirect(`/app/accounts/${savedId}?done=${accountId ? "saved" : "created"}`);
}

/** Archives an account (it keeps its cars, bookings and statements) or brings it back. */
export async function archiveAccountAction(formData: FormData) {
  const id = uuid.safeParse(formData.get("accountId"));
  if (!id.success) redirect("/app/accounts");
  const archive = formData.get("archive") === "yes";
  const { admin, problem } = await writer(`/app/accounts/${id.data}`);
  if (problem) redirect(`/app/accounts/${id.data}?error=not_allowed`);
  const { data, error } = await admin.client
    .from("business_accounts")
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq("garage_id", admin.garage.id)
    .eq("id", id.data)
    .select("id");
  if (error || !data?.length) redirect(`/app/accounts/${id.data}?error=${error?.code === "23505" ? "name_taken" : "not_saved"}`);
  await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: archive ? "account.archived" : "account.restored", entityType: "business_account", entityId: id.data });
  refresh(id.data);
  redirect(`/app/accounts/${id.data}?done=${archive ? "archived" : "restored"}`);
}

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

export type VehicleSearchState = { seq: number; status: "idle" | "done" | "error"; message?: string; matches: VehicleMatch[] };

/** Finds the garage's cars by registration (POST body; the term is never in a URL or a log). */
export async function searchAccountVehiclesAction(previous: VehicleSearchState, formData: FormData): Promise<VehicleSearchState> {
  const term = String(formData.get("q") ?? "").slice(0, 20);
  const { admin, problem } = await writer("/app/accounts");
  if (problem) return { seq: previous.seq + 1, status: "error", message: problem, matches: [] };
  try {
    const matches = await searchVehicles(admin.client, admin.garage.id, term);
    return { seq: previous.seq + 1, status: "done", message: matches.length ? undefined : "No cars match. Add it by registration below.", matches };
  } catch (error) {
    if (!(error instanceof AccountDataError)) throw error;
    return { seq: previous.seq + 1, status: "error", message: "Cars could not be searched. Try again.", matches: [] };
  }
}

/** Adds a car to the account: one found by search (`vehicleId`) or by registration (new cars are created). */
export async function addAccountVehicleAction(previous: PanelActionState, formData: FormData): Promise<PanelActionState> {
  const accountId = uuid.safeParse(formData.get("accountId"));
  if (!accountId.success) return next(previous, { status: "error", message: "That account could not be found." });
  const { admin, problem } = await writer(`/app/accounts/${accountId.data}`);
  if (problem) return next(previous, { status: "error", message: problem });

  const vehicleId = formData.get("vehicleId");
  if (vehicleId) {
    const parsed = uuid.safeParse(vehicleId);
    if (!parsed.success) return next(previous, { status: "error", message: "That car could not be found." });
    const { error } = await admin.client.from("business_account_vehicles").insert({ account_id: accountId.data, vehicle_id: parsed.data });
    if (error) {
      return next(previous, {
        status: "error",
        message: error.code === "23505" ? accountErrorMessage({ message: "VEHICLE_ON_OTHER_ACCOUNT" }) : accountErrorMessage(error, "That car could not be added. Try again."),
      });
    }
    await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "account.vehicle_added", entityType: "business_account", entityId: accountId.data, detail: { vehicleId: parsed.data } });
  } else {
    const registration = String(formData.get("registration") ?? "").slice(0, 12);
    const make = String(formData.get("make") ?? "").slice(0, 80);
    const model = String(formData.get("model") ?? "").slice(0, 120);
    const { error } = await admin.client.rpc("add_business_account_vehicle", { p_account_id: accountId.data, p_registration: registration, p_make: make || null, p_model: model || null });
    if (error) return next(previous, { status: "error", message: accountErrorMessage(error, "That car could not be added. Try again.") });
  }
  refresh(accountId.data);
  return next(previous, { status: "saved", message: "Car added to the account." });
}

/** Takes a car off the account (the car and its history stay). */
export async function removeAccountVehicleAction(formData: FormData) {
  const accountId = uuid.safeParse(formData.get("accountId"));
  const linkId = uuid.safeParse(formData.get("linkId"));
  if (!accountId.success || !linkId.success) redirect("/app/accounts");
  const { admin, problem } = await writer(`/app/accounts/${accountId.data}`);
  if (problem) redirect(`/app/accounts/${accountId.data}?error=not_allowed#vehicles`);
  const { error } = await admin.client.from("business_account_vehicles").delete().eq("garage_id", admin.garage.id).eq("account_id", accountId.data).eq("id", linkId.data);
  if (error) redirect(`/app/accounts/${accountId.data}?error=not_saved#vehicles`);
  await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "account.vehicle_removed", entityType: "business_account", entityId: accountId.data });
  refresh(accountId.data);
  redirect(`/app/accounts/${accountId.data}?done=vehicle_removed#vehicles`);
}

// ---------------------------------------------------------------------------
// Drivers and contacts
// ---------------------------------------------------------------------------

export type PeopleSearchState = { seq: number; status: "idle" | "done" | "error"; message?: string; matches: CustomerMatch[] };

/** Finds customers by name or mobile (POST body). */
export async function searchAccountPeopleAction(previous: PeopleSearchState, formData: FormData): Promise<PeopleSearchState> {
  const term = String(formData.get("q") ?? "").slice(0, 80);
  const { admin, problem } = await writer("/app/accounts");
  if (problem) return { seq: previous.seq + 1, status: "error", message: problem, matches: [] };
  try {
    const matches = await searchCustomers(admin.client, admin.garage.id, term);
    return { seq: previous.seq + 1, status: "done", message: matches.length ? undefined : "No customers match that name or mobile.", matches };
  } catch (error) {
    if (!(error instanceof AccountDataError)) throw error;
    return { seq: previous.seq + 1, status: "error", message: "Customers could not be searched. Try again.", matches: [] };
  }
}

export async function addAccountPersonAction(previous: PanelActionState, formData: FormData): Promise<PanelActionState> {
  const accountId = uuid.safeParse(formData.get("accountId"));
  const customerId = uuid.safeParse(formData.get("customerId"));
  const role = z.enum(PERSON_ROLES).safeParse(formData.get("role") ?? "driver");
  if (!accountId.success || !customerId.success || !role.success) return next(previous, { status: "error", message: "That customer could not be found." });
  const { admin, problem } = await writer(`/app/accounts/${accountId.data}`);
  if (problem) return next(previous, { status: "error", message: problem });
  const { error } = await admin.client.from("business_account_customers").insert({ account_id: accountId.data, customer_id: customerId.data, role: role.data });
  if (error) return next(previous, { status: "error", message: error.code === "23505" ? "They are already on this account." : accountErrorMessage(error) });
  await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "account.person_added", entityType: "business_account", entityId: accountId.data, detail: { role: role.data } });
  refresh(accountId.data);
  return next(previous, { status: "saved", message: role.data === "driver" ? "Driver added." : "Contact added." });
}

export async function removeAccountPersonAction(formData: FormData) {
  const accountId = uuid.safeParse(formData.get("accountId"));
  const linkId = uuid.safeParse(formData.get("linkId"));
  if (!accountId.success || !linkId.success) redirect("/app/accounts");
  const { admin, problem } = await writer(`/app/accounts/${accountId.data}`);
  if (problem) redirect(`/app/accounts/${accountId.data}?error=not_allowed#people`);
  const { error } = await admin.client.from("business_account_customers").delete().eq("garage_id", admin.garage.id).eq("account_id", accountId.data).eq("id", linkId.data);
  if (error) redirect(`/app/accounts/${accountId.data}?error=not_saved#people`);
  refresh(accountId.data);
  redirect(`/app/accounts/${accountId.data}?done=person_removed#people`);
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const STATEMENT_ERRORS: Record<string, string> = {
  NOTHING_TO_BILL: "nothing_to_bill",
  STATEMENT_NOT_DRAFT: "already_issued",
  STATEMENT_NOT_ISSUED: "not_issued",
  PLAN_REQUIRED: "plan_required",
  ACCOUNT_FORBIDDEN: "not_allowed",
  INVOICE_EMAIL_SEND_IN_PROGRESS: "email_in_progress",
};

function statementErrorCode(error: { code?: string | null; message?: string | null } | null) {
  const message = error?.message ?? "";
  const key = Object.keys(STATEMENT_ERRORS).find((code) => message.startsWith(code));
  if (key) return STATEMENT_ERRORS[key]!;
  return error?.code === "42501" ? "not_allowed" : "not_saved";
}

/** Makes (or refreshes) the account's statement for a month, then opens it. */
export async function generateStatementAction(formData: FormData) {
  const accountId = uuid.safeParse(formData.get("accountId"));
  const month = formData.get("month");
  if (!accountId.success) redirect("/app/accounts");
  if (!isMonthStart(month)) redirect(`/app/accounts/${accountId.data}?error=bad_month#statements`);
  const { admin, problem } = await writer(`/app/accounts/${accountId.data}`);
  if (problem) redirect(`/app/accounts/${accountId.data}?error=not_allowed#statements`);
  const { data, error } = await admin.client.rpc("generate_account_statement", { p_account_id: accountId.data, p_period_start: month });
  if (error || !data) redirect(`/app/accounts/${accountId.data}?error=${statementErrorCode(error)}#statements`);
  const statementId = String((data as { id: string }).id);
  refresh(accountId.data, statementId);
  redirect(`/app/accounts/statements/${statementId}?done=generated`);
}

async function statementWriter(formData: FormData) {
  const statementId = uuid.safeParse(formData.get("statementId"));
  if (!statementId.success) redirect("/app/accounts");
  const back = `/app/accounts/statements/${statementId.data}`;
  const { admin, problem } = await writer(back);
  if (problem) redirect(`${back}?error=not_allowed`);
  return { admin, statementId: statementId.data, back };
}

export async function issueStatementAction(formData: FormData) {
  const { admin, statementId, back } = await statementWriter(formData);
  const { data, error } = await admin.client.rpc("issue_account_statement", { p_statement_id: statementId });
  if (error || !data) redirect(`${back}?error=${statementErrorCode(error)}`);
  refresh(String((data as { account_id: string }).account_id), statementId);
  redirect(`${back}?done=issued`);
}

const paidSchema = z.object({
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(["bank_transfer", "card", "cash", "other"]),
  reference: z.string().trim().max(120).optional(),
});

export async function markStatementPaidAction(formData: FormData) {
  const { admin, statementId, back } = await statementWriter(formData);
  const parsed = paidSchema.safeParse({ paidOn: formData.get("paidOn"), method: formData.get("method"), reference: formData.get("reference") ?? undefined });
  if (!parsed.success) redirect(`${back}?error=bad_payment#paid`);
  const { data, error } = await admin.client.rpc("mark_account_statement_paid", {
    p_statement_id: statementId,
    p_paid_at: new Date(`${parsed.data.paidOn}T12:00:00Z`).toISOString(),
    p_method: parsed.data.method,
    p_reference: parsed.data.reference || null,
  });
  if (error || !data) redirect(`${back}?error=${statementErrorCode(error)}#paid`);
  refresh(String((data as { account_id: string }).account_id), statementId);
  redirect(`${back}?done=paid`);
}

/** Emails an issued statement to the account's billing email (or the address typed) through the email channel. */
export async function emailStatementAction(formData: FormData) {
  const { admin, statementId, back } = await statementWriter(formData);
  const recipient = z.string().trim().toLowerCase().pipe(z.email().max(254)).safeParse(formData.get("recipient"));
  if (!recipient.success) redirect(`${back}?error=bad_recipient#email`);
  const detail = await getStatementDetail(admin.client, admin.garage.id, statementId);
  if (!detail) redirect("/app/accounts");
  if (detail.statement.status === "draft") redirect(`${back}?error=not_issued#email`);
  const { data: count } = await admin.client.from("account_statements").select("email_count").eq("garage_id", admin.garage.id).eq("id", statementId).maybeSingle();
  const result = await sendStatementEmail({ garage: admin.garage, detail, recipient: recipient.data, sendNumber: Number(count?.email_count ?? 0) + 1 });
  const { error } = await admin.client.rpc("record_account_statement_email", {
    p_statement_id: statementId,
    p_recipient: recipient.data,
    p_outcome: result.ok ? "sent" : "failed",
    p_provider_id: result.ok ? result.providerMessageId : null,
  });
  refresh(detail.account.id, statementId);
  if (error) redirect(`${back}?error=${statementErrorCode(error)}#email`);
  redirect(`${back}?${result.ok ? "done=emailed" : `error=${result.code === "configuration_required" ? "email_not_configured" : "email_failed"}`}#email`);
}
