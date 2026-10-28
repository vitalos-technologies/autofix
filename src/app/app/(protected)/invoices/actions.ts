"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { invoiceDraftSchema, invoicePaymentSchema, sendInvoiceSchema, friendlyInvoiceError, priceInputToPence } from "@/lib/invoices/schema";
import { createInvoiceCorrection, deleteDraftInvoice, duplicateInvoice, issueInvoice, recordInvoicePayment, saveInvoiceDraft, sendInvoiceEmail, voidInvoice } from "@/lib/invoices/repository";
import { requireFreshAdminSession } from "@/lib/auth/trusted-device-server";
import { getInvoiceAccount } from "@/lib/accounts/queries";
import { requireInvoiceAdmin } from "@/lib/invoices/repository";

export type InvoiceFormState = { error: string };
export async function saveInvoiceDraftAction(_previous: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  await requireFreshAdminSession("/app/invoices");
  let id: string;
  try { const invoiceId = z.union([z.literal(""), z.string().uuid()]).parse(String(formData.get("invoiceId") || "")); const payload = invoiceDraftSchema.parse(JSON.parse(String(formData.get("payload") || "{}"))); const confirmDuplicateSource = formData.get("confirmDuplicateSource") === "true"; id = await saveInvoiceDraft(payload, invoiceId || undefined, confirmDuplicateSource); }
  catch (error) { return { error: friendlyInvoiceError(error) }; }
  refresh(id); redirect(`/app/invoices/${id}?notice=saved`);
}
export async function issueInvoiceAction(formData: FormData) { await requireFreshAdminSession("/app/invoices"); const id = uuid(formData); await issueInvoice(id); refresh(id); redirect(`/app/invoices/${id}?notice=issued`); }
export async function voidInvoiceAction(formData: FormData) { await requireFreshAdminSession("/app/invoices"); const id = uuid(formData); await voidInvoice(id); refresh(id); redirect(`/app/invoices/${id}?notice=voided`); }
export async function deleteDraftInvoiceAction(formData: FormData) { await requireFreshAdminSession("/app/invoices"); const id = uuid(formData); await deleteDraftInvoice(id); refresh(id); redirect("/app/invoices?notice=deleted"); }
export async function duplicateInvoiceAction(formData: FormData) { await requireFreshAdminSession("/app/invoices"); const id = uuid(formData); const draftId = await duplicateInvoice(id); refresh(draftId); redirect(`/app/invoices/${draftId}/edit?notice=duplicated`); }
export async function createInvoiceCorrectionAction(formData: FormData) { await requireFreshAdminSession("/app/invoices"); const id = uuid(formData); const draftId = await createInvoiceCorrection(id); refresh(id); refresh(draftId); redirect(`/app/invoices/${draftId}/edit?notice=corrected`); }
export async function recordInvoicePaymentAction(formData: FormData) {
  await requireFreshAdminSession("/app/invoices");
  const date = String(formData.get("paidAt") || "");
  try {
    const parsed = invoicePaymentSchema.parse({ invoiceId: formData.get("invoiceId"), amountPence: priceInputToPence(String(formData.get("amount") || "")), paidAt: date ? new Date(`${date}T12:00:00Z`).toISOString() : "", method: formData.get("method"), reference: formData.get("reference") || "" });
    await recordInvoicePayment(parsed);
    refresh(parsed.invoiceId);
    redirect(`/app/invoices/${parsed.invoiceId}?notice=payment_recorded`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    redirect(`/app/invoices/${String(formData.get("invoiceId") || "")}?notice=payment_failed`);
  }
}
export async function sendInvoiceAction(formData: FormData) {
  await requireFreshAdminSession("/app/invoices");
  const parsed = sendInvoiceSchema.parse({ invoiceId: formData.get("invoiceId"), recipient: formData.get("recipient"), intent: formData.get("intent") || "new", logicalSendId: formData.get("logicalSendId") });
  // P5.7: an invoice charged to a monthly-billed account goes on the account's statement, not out on its own.
  const { auth } = await requireInvoiceAdmin();
  if ((await getInvoiceAccount(auth.client, auth.garage.id, parsed.invoiceId))?.billing === "monthly") redirect(`/app/invoices/${parsed.invoiceId}?notice=on_statement`);
  const result = await sendInvoiceEmail(parsed.invoiceId, parsed.recipient, parsed.logicalSendId);
  refresh(parsed.invoiceId);
  if (result.outcome === "sent" || result.outcome === "already_sent") redirect(`/app/invoices/${parsed.invoiceId}?notice=sent`);
  if (result.outcome === "failed") redirect(`/app/invoices/${parsed.invoiceId}?notice=email_failed&emailSendId=${parsed.logicalSendId}`);
  if (result.outcome === "in_progress") redirect(`/app/invoices/${parsed.invoiceId}?notice=email_pending&emailSendId=${parsed.logicalSendId}`);
  redirect(`/app/invoices/${parsed.invoiceId}?notice=email_reconcile&emailSendId=${parsed.logicalSendId}`);
}
function uuid(formData: FormData) { return z.string().uuid().parse(formData.get("invoiceId")); }
function refresh(id: string) { revalidatePath("/app"); revalidatePath("/app/invoices"); revalidatePath(`/app/invoices/${id}`); }
