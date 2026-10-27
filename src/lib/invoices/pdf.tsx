import "server-only";
/* eslint-disable jsx-a11y/alt-text -- @react-pdf/renderer Image does not expose an alt prop; adjacent issuer text and PDF metadata identify the brand. */

import React from "react";
import { Document, Image, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { PLATFORM_NAME } from "@/lib/email/brand";
import { formatPhoneForDisplay } from "@/lib/tenancy/contact";
import type { Garage } from "@/lib/tenancy/garage";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { formatPence, invoicePaymentSummary } from "./money";
import { invoiceStatusLabel, type Invoice, type InvoiceStatus } from "./types";

// Invoices are the garage's documents: its name and details come from the
// issuer snapshot taken when the invoice was issued, and its current logo and
// bank details from the garage profile. Autofix appears only in the footer.

/** The garage profile fields an invoice PDF reads. */
export type InvoiceGarage = Pick<Garage, "name" | "slug" | "customDomain" | "logoUrl" | "invoicePayment">;

const LOGO_TIMEOUT_MS = 4_000;
const LOGO_MAX_BYTES = 1_500_000;
const LOGO_TYPES = new Set(["image/png", "image/jpeg"]);

/**
 * The garage's logo as a data URI (PNG or JPEG over https only), or null for
 * the text masthead. Fetched with a timeout and size cap so a slow or missing
 * logo never blocks an invoice.
 */
export async function loadGarageLogo(logoUrl: string | null | undefined, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!logoUrl) return null;
  let url: URL;
  try {
    url = new URL(logoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS), redirect: "follow" });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!response.ok || !LOGO_TYPES.has(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > LOGO_MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** `Invoice-HRM-2026-000001.pdf`, or `Invoice-Draft.pdf`. */
export function invoiceFileName(invoice: Pick<Invoice, "invoice_number">) {
  const reference = (invoice.invoice_number || "Draft").replace(/[^A-Za-z0-9-]/g, "");
  return `Invoice-${reference || "Draft"}.pdf`;
}

const c = {
  navy: "#071127", blue: "#1974E2", paleBlue: "#EAF3FF", white: "#FFFFFF",
  softGrey: "#F4F7FA", border: "#DCE6F2", text: "#111827", secondary: "#5F6B7A", green: "#237A57",
  red: "#A43A44", amber: "#9A6500", muted: "#667586",
} as const;

const s = StyleSheet.create({
  page: { paddingTop: 62, paddingBottom: 78, paddingHorizontal: 38, fontFamily: "Helvetica", fontSize: 9.2, color: c.text, lineHeight: 1.38 },
  masthead: { minHeight: 142, backgroundColor: c.white, borderBottomWidth: 2, borderBottomColor: c.blue, marginHorizontal: -38, marginTop: -62, paddingHorizontal: 38, paddingVertical: 24, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mastBrand: { width: "58%" }, logo: { width: 150, height: 100, objectFit: "contain", objectPosition: "left center" },
  logoFallback: { color: c.navy, fontFamily: "Helvetica-Bold", fontSize: 19, letterSpacing: 0.8 },
  tagline: { marginTop: 5, color: c.blue, fontSize: 8.7, fontFamily: "Helvetica-Bold" },
  identity: { width: "38%", alignItems: "flex-end" }, invoiceTitle: { color: c.navy, fontSize: 27, lineHeight: 1, fontFamily: "Helvetica-Bold", letterSpacing: 1.3 },
  invoiceNumber: { color: c.blue, marginTop: 11, fontSize: 11.5, lineHeight: 1, fontFamily: "Helvetica-Bold" },
  badge: { marginTop: 9, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 9, fontSize: 8.2, fontFamily: "Helvetica-Bold", color: c.white, letterSpacing: 0.4 },
  badgeDraft: { backgroundColor: c.muted }, badgeIssued: { backgroundColor: c.amber }, badgePaid: { backgroundColor: c.green }, badgeVoid: { backgroundColor: c.red },
  continuation: { position: "absolute", top: 17, left: 38, right: 38, height: 38, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  continuationLogo: { width: 55, height: 30, objectFit: "contain", objectPosition: "left center" },
  continuationFallback: { fontSize: 9, fontFamily: "Helvetica-Bold", color: c.navy },
  continuationMeta: { alignItems: "flex-end" }, continuationNumber: { fontFamily: "Helvetica-Bold", color: c.navy, fontSize: 8.5 }, continuationStatus: { color: c.blue, fontFamily: "Helvetica-Bold", fontSize: 7.5, marginTop: 2 },
  summaryStrip: { flexDirection: "row", backgroundColor: c.softGrey, borderBottomWidth: 1, borderBottomColor: c.border, marginHorizontal: -38, paddingHorizontal: 38, paddingVertical: 13 },
  summaryCell: { width: "33.333%", paddingRight: 12 }, label: { fontSize: 7.4, fontFamily: "Helvetica-Bold", color: c.secondary, letterSpacing: 0.8, textTransform: "uppercase" },
  value: { marginTop: 4, fontFamily: "Helvetica-Bold", color: c.navy, fontSize: 10 }, bodyValue: { marginTop: 4, color: c.text },
  details: { flexDirection: "row", marginTop: 16, gap: 25 }, detailColumn: { flexGrow: 1, flexBasis: 0 },
  sectionRule: { marginTop: 5, height: 1, backgroundColor: c.border }, customerName: { marginTop: 9, fontFamily: "Helvetica-Bold", fontSize: 11.2, color: c.navy },
  detailLine: { marginTop: 3, color: c.secondary }, registrationPanel: { alignSelf: "flex-start", marginTop: 9, paddingVertical: 6, paddingHorizontal: 9, backgroundColor: "#EAF3FF", borderLeftWidth: 3, borderLeftColor: c.blue },
  registration: { fontFamily: "Helvetica-Bold", fontSize: 14, color: c.navy, letterSpacing: 0.7 }, vehicleName: { marginTop: 7, fontFamily: "Helvetica-Bold", fontSize: 10.2, color: c.navy }, service: { marginTop: 5, color: c.blue, fontFamily: "Helvetica-Bold" },
  issuer: { marginTop: 13, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border, flexDirection: "row", justifyContent: "space-between" },
  issuerBlock: { width: "48%" }, issuerDetails: { marginTop: 5, color: c.secondary, fontSize: 8.2 },
  table: { marginTop: 12 }, tableHead: { flexDirection: "row", backgroundColor: c.paleBlue, color: c.navy, borderBottomWidth: 1.5, borderBottomColor: c.blue, paddingVertical: 7, paddingHorizontal: 9, fontFamily: "Helvetica-Bold", fontSize: 7.6, letterSpacing: 0.35 },
  row: { flexDirection: "row", paddingVertical: 7, paddingHorizontal: 9, borderBottomWidth: 1, borderBottomColor: c.border, minHeight: 27 }, rowAlt: { backgroundColor: "#FAFCFE" },
  description: { width: "55%", paddingRight: 9 }, qty: { width: "11%", textAlign: "right" }, unit: { width: "17%", textAlign: "right" }, amount: { width: "17%", textAlign: "right", fontFamily: "Helvetica-Bold" },
  settlement: { flexDirection: "row", gap: 25, marginTop: 10, paddingTop: 7, borderTopWidth: 1, borderTopColor: c.border }, settlementLeft: { flexGrow: 1, flexBasis: 0 }, totals: { width: 232 }, totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, color: c.secondary },
  paidMarker: { marginTop: 7, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border, color: c.green, fontFamily: "Helvetica-Bold", textAlign: "right", fontSize: 8 },
  grand: { marginTop: 3, paddingTop: 6, borderTopWidth: 2, borderTopColor: c.blue, fontSize: 14, fontFamily: "Helvetica-Bold", color: c.navy },
  balance: { marginTop: 3, paddingTop: 6, borderTopWidth: 2, borderTopColor: c.blue, fontSize: 14, fontFamily: "Helvetica-Bold", color: c.navy },
  lower: { marginTop: 8 },
  paymentStatus: { marginTop: 7, fontFamily: "Helvetica-Bold", color: c.navy, fontSize: 10 }, paymentGrid: { marginTop: 6, flexDirection: "row", gap: 15 }, paymentItem: { flexGrow: 1, flexBasis: 0 },
  notes: { marginTop: 7, color: c.secondary }, watermark: { position: "absolute", top: 330, left: 115, transform: "rotate(-35deg)", fontSize: 60, fontFamily: "Helvetica-Bold", color: c.border, opacity: 0.28 },
  footer: { position: "absolute", top: 786, left: 38, right: 38, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border, flexDirection: "row", justifyContent: "space-between" },
  footerBrand: { width: "66%", color: c.secondary, fontSize: 7.2 }, footerStrong: { color: c.navy, fontFamily: "Helvetica-Bold" }, footerMeta: { width: "31%", textAlign: "right", color: c.secondary, fontSize: 7.2 },
});

export async function renderInvoicePdf(invoice: Invoice, garage: InvoiceGarage) {
  const logo = await loadGarageLogo(garage.logoUrl);
  return renderToBuffer(<InvoiceDocument invoice={invoice} garage={garage} logo={logo} />);
}

export function InvoiceDocument({ invoice, garage, logo }: { invoice: Invoice; garage: InvoiceGarage; logo: string | null }) {
  const website = new URL(garageBaseUrl(garage)).host;
  const watermark = invoice.status === "draft" ? "DRAFT" : invoice.status === "void" ? "VOID" : null;
  const status = invoiceStatusLabel(invoice.status).toUpperCase();
  const reference = invoice.invoice_number || "DRAFT - NOT ISSUED";
  const displayNumber = invoice.invoice_number || "No invoice number";
  const payment = invoicePaymentSummary(invoice);

  return <Document title={`${invoice.issuer_trading_name} invoice ${displayNumber}`} author={invoice.issuer_legal_name} creationDate={new Date(invoice.created_at)} modificationDate={new Date(invoice.updated_at)}>
    <Page size="A4" style={s.page} wrap>
      {watermark && <Text fixed style={s.watermark}>{watermark}</Text>}
      <ContinuationHeader logo={logo} name={invoice.issuer_trading_name || garage.name} reference={reference} status={status} />
      <Footer invoice={invoice} website={website} reference={reference} status={status} />

      <View style={s.masthead} wrap={false}>
        <View style={s.mastBrand}>{logo ? <Image src={logo} style={s.logo} /> : <Text style={s.logoFallback}>{(invoice.issuer_trading_name || garage.name).toUpperCase()}</Text>}{invoice.issuer_tagline ? <Text style={s.tagline}>{invoice.issuer_tagline}</Text> : null}</View>
        <View style={s.identity}><Text style={s.invoiceTitle}>INVOICE</Text><Text style={s.invoiceNumber}>{reference}</Text><Text style={[s.badge, statusStyle(invoice.status)]}>{status}</Text></View>
      </View>

      <SummaryStrip invoice={invoice} status={status} />
      <View style={s.details} wrap={false}>
        <View style={s.detailColumn}><SectionHeading>Billed to</SectionHeading><Text style={s.customerName}>{invoice.customer_name}</Text>{splitAddress(invoice.customer_address).map((line, index) => <Text key={`${line}-${index}`} style={s.detailLine}>{line}</Text>)}{invoice.customer_email && <Text style={s.detailLine}>{invoice.customer_email}</Text>}{invoice.customer_phone && <Text style={s.detailLine}>{invoice.customer_phone}</Text>}</View>
        <View style={s.detailColumn}><SectionHeading>Vehicle / Service</SectionHeading>{invoice.vehicle_registration && <View style={s.registrationPanel}><Text style={s.registration}>{invoice.vehicle_registration.toUpperCase()}</Text></View>}{vehicleName(invoice) && <Text style={s.vehicleName}>{vehicleName(invoice)}</Text>}{invoice.service_name && <Text style={s.service}>{invoice.service_name}</Text>}{invoice.appointment_start && <Text style={s.detailLine}>{formatDateTime(invoice.appointment_start)}</Text>}{!invoice.vehicle_registration && !vehicleName(invoice) && !invoice.service_name && <Text style={s.detailLine}>No vehicle or service details recorded.</Text>}</View>
      </View>

      <View style={s.issuer} wrap={false}><View style={s.issuerBlock}><Text style={s.label}>From</Text><Text style={s.value}>{invoice.issuer_legal_name}</Text><Text style={s.issuerDetails}>{splitAddress(invoice.issuer_address).join(" · ")}</Text></View><View style={s.issuerBlock}><Text style={s.label}>Contact</Text><Text style={s.issuerDetails}>{joinPresent([formatPhone(invoice.issuer_phone), invoice.issuer_email])}</Text><Text style={s.issuerDetails}>{joinPresent([website, invoice.issuer_company_number ? `Company no. ${invoice.issuer_company_number}` : ""])}</Text></View></View>

      <View style={s.table}>
        <View style={s.tableHead} fixed><Text style={s.description}>DESCRIPTION</Text><Text style={s.qty}>QTY</Text><Text style={s.unit}>UNIT PRICE</Text><Text style={s.amount}>AMOUNT</Text></View>
        {invoice.invoice_items.map((item, index) => <View key={item.id} style={[s.row, index % 2 ? s.rowAlt : {}]} wrap={false}><Text style={s.description}>{item.description}</Text><Text style={s.qty}>{trimQuantity(String(item.quantity))}</Text><Text style={s.unit}>{formatPence(item.unit_price_pence)}</Text><Text style={s.amount}>{formatPence(item.line_total_pence)}</Text></View>)}
      </View>

      <View style={s.settlement} wrap={false}>
        <View style={s.settlementLeft}><PaymentSection invoice={invoice} garage={garage} status={status} />{invoice.notes && <View style={s.lower}><SectionHeading>Notes</SectionHeading><Text style={s.notes}>{invoice.notes}</Text></View>}</View>
        <View style={s.totals}><Total label="Subtotal" value={invoice.subtotal_pence} />{BigInt(invoice.discount_pence) > 0n && <Total label="Discount" value={-BigInt(invoice.discount_pence)} />}<View style={[s.totalRow, s.grand]}><Text>TOTAL GBP</Text><Text>{formatPence(payment.totalPence)}</Text></View><Total label="AMOUNT PAID" value={payment.amountPaidPence} /><View style={[s.totalRow, s.balance]}><Text>BALANCE DUE</Text><Text>{formatPence(payment.balancePence)}</Text></View>{invoice.status === "paid" && <Text style={s.paidMarker}>PAID / SETTLED</Text>}</View>
      </View>
    </Page>
  </Document>;
}

function ContinuationHeader({ logo, name, reference, status }: { logo: string | null; name: string; reference: string; status: string }) {
  return <View fixed style={s.continuation}>{logo ? <Image src={logo} style={s.continuationLogo} /> : <Text style={s.continuationFallback}>{name.toUpperCase()}</Text>}<View style={s.continuationMeta}><Text style={s.continuationNumber}>Invoice {reference}</Text><Text style={s.continuationStatus}>{status}</Text></View></View>;
}

function Footer({ invoice, website, reference, status }: { invoice: Invoice; website: string; reference: string; status: string }) {
  const contact = joinPresent([website, formatPhone(invoice.issuer_phone), invoice.issuer_email, invoice.issuer_company_number ? `Company no. ${invoice.issuer_company_number}` : ""]);
  return <View fixed style={s.footer}><View style={s.footerBrand}><Text style={s.footerStrong}>{joinPresent([invoice.issuer_legal_name, invoice.issuer_tagline])}</Text><Text>{contact}</Text><Text>{`Invoice produced with ${PLATFORM_NAME}`}</Text></View><View style={s.footerMeta}><Text style={s.footerStrong}>{reference} · {status}</Text><Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} /></View></View>;
}

function SummaryStrip({ invoice, status }: { invoice: Invoice; status: string }) {
  const third = invoice.paid_at ? { label: "Paid date", value: formatDate(invoice.paid_at.slice(0, 10)) } : { label: "Status", value: status };
  return <View style={s.summaryStrip} wrap={false}><Pair label="Issue date" value={formatDate(invoice.issue_date)} /><Pair label="Due date" value={formatDate(invoice.due_date)} /><Pair label={third.label} value={third.value} /></View>;
}

function PaymentSection({ invoice, garage, status }: { invoice: Invoice; garage: InvoiceGarage; status: string }) {
  const bank = garage.invoicePayment;
  return <View><SectionHeading>Payment details</SectionHeading>{bank ? <><Text style={s.paymentStatus}>Pay to: {bank.accountName}</Text><Text style={s.notes}>Sort code: {bank.sortCode} · Account no: {bank.accountNumber}</Text></> : null}{invoice.paid_at ? <><Text style={s.paymentStatus}>{status} · {formatDate(invoice.paid_at.slice(0, 10))}</Text>{invoice.payment_method && <Text style={s.notes}>{paymentMethodLabel(invoice.payment_method)}{invoice.payment_reference ? ` · ${invoice.payment_reference}` : ""}</Text>}</> : <>{invoice.due_date && <Text style={s.paymentStatus}>Payment due by {formatDate(invoice.due_date)}.</Text>}{invoice.payment_terms && <Text style={s.notes}>{invoice.payment_terms}</Text>}</>}</View>;
}

function SectionHeading({ children }: { children: React.ReactNode }) { return <><Text style={s.label}>{children}</Text><View style={s.sectionRule} /></>; }
function Pair({ label, value }: { label: string; value: string }) { return <View style={s.summaryCell}><Text style={s.label}>{label}</Text><Text style={s.value}>{value}</Text></View>; }
function Total({ label, value }: { label: string; value: bigint | string | number }) { return <View style={s.totalRow}><Text>{label}</Text><Text>{formatPence(value)}</Text></View>; }
function splitAddress(value: string | null) { return value ? value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean) : []; }
function vehicleName(invoice: Invoice) { return [invoice.vehicle_make, invoice.vehicle_model].filter(Boolean).join(" "); }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(new Date(`${value}T12:00:00Z`)) : "Not set"; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value)); }
function trimQuantity(value: string) { return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1"); }
function formatPhone(value: string | null) { return formatPhoneForDisplay(value); }
function joinPresent(values: Array<string | null | undefined>) { return values.map((value) => value?.trim() ?? "").filter(Boolean).join(" · "); }
function paymentMethodLabel(value: NonNullable<Invoice["payment_method"]>) { return value === "bank_transfer" ? "Bank transfer" : value.charAt(0).toUpperCase() + value.slice(1); }
function statusStyle(status: InvoiceStatus) { return status === "draft" ? s.badgeDraft : status === "issued" ? s.badgeIssued : status === "paid" ? s.badgePaid : s.badgeVoid; }
