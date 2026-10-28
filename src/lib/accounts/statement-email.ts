import "server-only";

import { garageEmailBrand, type EmailGarage } from "@/lib/email/brand";
import { isValidEmailAddress } from "@/lib/email/identity";
import { detailCard, detailsText, emailLayout, escapeHtml, notice, plainTextFooter, plainTextHeader, type RenderedEmail } from "@/lib/email/templates/components";
import { getChannel, type MessageChannel, type SendResult } from "@/lib/messaging/channel";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import type { StatementDetail } from "./queries";
import { formatPounds, lineBalance, longDate, periodLabel } from "./view";

// The monthly statement email (P5.7) to the account's billing email, through the existing email
// channel (getChannel("email"): mock unless MESSAGING_MODE=live, then Resend). A statement is a
// business document asked for by the account, like an invoice, so no marketing consent applies;
// it is only ever sent when a member presses "Email statement" (never by the job).

export type StatementEmailGarage = EmailGarage & { id: string; invoicePayment?: { accountName: string; sortCode: string; accountNumber: string } | null };

export function renderStatementEmail(garage: StatementEmailGarage, detail: StatementDetail): RenderedEmail {
  const brand = garageEmailBrand(garage);
  const { statement, account, lines, totals } = detail;
  const period = periodLabel(statement.periodStart);
  const paid = statement.status === "paid";
  const details = [
    { label: "Statement", value: statement.reference },
    { label: "Account", value: account.name },
    { label: "Period", value: period },
    { label: "Invoices", value: String(totals.count) },
    { label: "Issued", value: statement.issueDate ? longDate(statement.issueDate) : null },
    { label: "Due by", value: paid ? null : statement.dueDate ? longDate(statement.dueDate) : null },
    { label: "Status", value: paid ? "Paid" : "Unpaid" },
  ];
  const bank = garage.invoicePayment;
  const bankDetails = bank ? `Pay to ${bank.accountName}, sort code ${bank.sortCode}, account ${bank.accountNumber}. Please quote ${statement.reference}.` : `Please quote ${statement.reference} with your payment.`;
  const rows = lines
    .map((line) => {
      const reg = line.registration ? formatRegistration(line.registration) : "";
      return `<tr>
        <td style="padding:8px 10px;border-top:1px solid #DCE6F2;font-size:13px;line-height:18px;color:#071127;">${escapeHtml(line.invoiceNumber ?? "")}<br><span style="color:#586575;">${escapeHtml(line.issueDate ? longDate(line.issueDate) : "")}</span></td>
        <td style="padding:8px 10px;border-top:1px solid #DCE6F2;font-size:13px;line-height:18px;color:#071127;">${escapeHtml(reg)}${line.poNumber ? `<br><span style="color:#586575;">PO ${escapeHtml(line.poNumber)}</span>` : ""}</td>
        <td style="padding:8px 10px;border-top:1px solid #DCE6F2;font-size:13px;line-height:18px;color:#071127;text-align:right;white-space:nowrap;">${escapeHtml(formatPounds(line.totalPence))}</td>
      </tr>`;
    })
    .join("");
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;border:1px solid #DCE6F2;border-radius:12px;border-collapse:separate;overflow:hidden;">
    <tr><th align="left" style="padding:8px 10px;background:#F4F7FA;font-size:12px;color:#586575;">Invoice</th><th align="left" style="padding:8px 10px;background:#F4F7FA;font-size:12px;color:#586575;">Vehicle</th><th align="right" style="padding:8px 10px;background:#F4F7FA;font-size:12px;color:#586575;">Amount</th></tr>
    ${rows}
    <tr><td colspan="2" style="padding:10px;border-top:2px solid #071127;font-size:14px;font-weight:700;color:#071127;">Total</td><td style="padding:10px;border-top:2px solid #071127;font-size:14px;font-weight:700;color:#071127;text-align:right;white-space:nowrap;">${escapeHtml(formatPounds(totals.total))}</td></tr>
    <tr><td colspan="2" style="padding:10px;font-size:14px;font-weight:700;color:#071127;">Balance due</td><td style="padding:10px;font-size:14px;font-weight:700;color:#071127;text-align:right;white-space:nowrap;">${escapeHtml(formatPounds(totals.balance))}</td></tr>
  </table>`;
  const html = emailLayout({
    brand,
    preheader: `${account.name}: statement for ${period}, ${formatPounds(totals.balance)} due.`,
    status: paid ? "STATEMENT · PAID" : "STATEMENT",
    tone: paid ? "success" : "info",
    title: `Statement for ${period}`,
    intro: `Hello ${account.contact_name || account.name}. Here is your account statement from ${brand.name} for ${period}.`,
    contentHtml: `<p style="margin:0 0 22px;color:#071127;font-size:30px;font-weight:700;line-height:36px;">${escapeHtml(formatPounds(totals.balance))}</p>${detailCard(details)}${table}${paid ? "" : notice("How to pay", bankDetails, brand)}`,
  });
  const text = [
    plainTextHeader(brand),
    "",
    paid ? "STATEMENT · PAID" : "STATEMENT",
    "",
    `Statement for ${period}`,
    `Balance due: ${formatPounds(totals.balance)}`,
    "",
    `Hello ${account.contact_name || account.name},`,
    "",
    `Here is your account statement from ${brand.name} for ${period}.`,
    "",
    detailsText(details),
    "",
    ...lines.map((line) => `${line.invoiceNumber ?? ""}  ${line.issueDate ?? ""}  ${line.registration ? formatRegistration(line.registration) : ""}${line.poNumber ? `  PO ${line.poNumber}` : ""}  ${formatPounds(line.totalPence)}${lineBalance(line) === 0 ? " (paid)" : ""}`),
    `Total: ${formatPounds(totals.total)}`,
    `Balance due: ${formatPounds(totals.balance)}`,
    "",
    paid ? "" : bankDetails,
    "If you have any questions, reply to this email.",
    plainTextFooter(brand),
  ].join("\n");
  return { html, text };
}

/** Sends the statement to `recipient`. `sendNumber` makes each deliberate send its own idempotency key. */
export async function sendStatementEmail(input: {
  garage: StatementEmailGarage;
  detail: StatementDetail;
  recipient: string;
  sendNumber: number;
  channel?: MessageChannel;
}): Promise<SendResult> {
  if (!isValidEmailAddress(input.recipient)) return { ok: false, code: "invalid_recipient", retryable: false };
  const rendered = renderStatementEmail(input.garage, input.detail);
  const channel = input.channel ?? getChannel("email");
  return channel.send({
    garageId: input.garage.id,
    to: input.recipient,
    subject: `Statement ${input.detail.statement.reference} from ${input.garage.name}`,
    body: rendered.text,
    html: rendered.html,
    idempotencyKey: `account_statement:${input.detail.statement.id}:${input.sendNumber}`,
  });
}
