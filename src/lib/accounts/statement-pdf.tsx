import "server-only";
/* eslint-disable jsx-a11y/alt-text -- @react-pdf/renderer Image does not expose an alt prop; the garage name is printed beside it. */

import React from "react";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PLATFORM_NAME } from "@/lib/email/brand";
import { loadGarageLogo } from "@/lib/invoices/pdf";
import type { Garage } from "@/lib/tenancy/garage";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import type { StatementDetail } from "./queries";
import { formatPounds, lineBalance, longDate, periodLabel, STATEMENT_STATUS_LABELS } from "./view";

// The account statement as a PDF (P5.7): the garage's document, in the invoice PDF's style.

export type StatementGarage = Pick<Garage, "name" | "legalName" | "logoUrl" | "invoicePayment" | "email" | "phone" | "companyNumber" | "address">;

const c = { navy: "#0f2747", blue: "#2563EB", pale: "#EFF6FF", grey: "#F8FAFC", border: "#E2E8F0", text: "#111827", secondary: "#5F6B7A", green: "#237A57" } as const;

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 60, paddingHorizontal: 38, fontFamily: "Helvetica", fontSize: 9.2, color: c.text, lineHeight: 1.38 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 2, borderBottomColor: c.blue, paddingBottom: 16 },
  logo: { width: 140, height: 80, objectFit: "contain", objectPosition: "left center" },
  brand: { fontFamily: "Helvetica-Bold", fontSize: 18, color: c.navy },
  titleBox: { alignItems: "flex-end" },
  title: { fontFamily: "Helvetica-Bold", fontSize: 24, color: c.navy, letterSpacing: 1.2 },
  reference: { marginTop: 6, fontFamily: "Helvetica-Bold", fontSize: 11, color: c.blue },
  status: { marginTop: 6, fontFamily: "Helvetica-Bold", fontSize: 8.5, color: c.secondary },
  strip: { flexDirection: "row", backgroundColor: c.grey, marginTop: 14, paddingVertical: 10, paddingHorizontal: 10 },
  cell: { width: "25%", paddingRight: 8 },
  label: { fontSize: 7.4, fontFamily: "Helvetica-Bold", color: c.secondary, letterSpacing: 0.8, textTransform: "uppercase" },
  value: { marginTop: 3, fontFamily: "Helvetica-Bold", color: c.navy, fontSize: 10 },
  parties: { flexDirection: "row", gap: 25, marginTop: 16 },
  party: { flexGrow: 1, flexBasis: 0 },
  partyName: { marginTop: 6, fontFamily: "Helvetica-Bold", fontSize: 11, color: c.navy },
  line: { marginTop: 2, color: c.secondary },
  table: { marginTop: 16 },
  th: { flexDirection: "row", backgroundColor: c.pale, borderBottomWidth: 1.5, borderBottomColor: c.blue, paddingVertical: 6, paddingHorizontal: 8, fontFamily: "Helvetica-Bold", fontSize: 7.6, color: c.navy },
  tr: { flexDirection: "row", paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  colInvoice: { width: "22%" },
  colDate: { width: "16%" },
  colVehicle: { width: "26%" },
  colPo: { width: "14%" },
  colAmount: { width: "11%", textAlign: "right" },
  colBalance: { width: "11%", textAlign: "right" },
  totals: { marginTop: 10, marginLeft: "auto", width: 230 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, color: c.secondary },
  grand: { borderTopWidth: 2, borderTopColor: c.blue, marginTop: 3, paddingTop: 6, fontFamily: "Helvetica-Bold", fontSize: 13, color: c.navy },
  pay: { marginTop: 16, padding: 10, backgroundColor: c.grey },
  payTitle: { fontFamily: "Helvetica-Bold", color: c.navy, fontSize: 10 },
  footer: { position: "absolute", bottom: 24, left: 38, right: 38, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 6, flexDirection: "row", justifyContent: "space-between", color: c.secondary, fontSize: 7.2 },
});

function addressLines(value: string | null | undefined) {
  return (value ?? "").split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

function garageAddress(garage: StatementGarage) {
  const address = garage.address ?? {};
  return [address.line1, address.line2, address.town, address.postcode].filter(Boolean) as string[];
}

export function StatementDocument({ detail, garage, logo }: { detail: StatementDetail; garage: StatementGarage; logo: string | null }) {
  const { statement, account, lines, totals } = detail;
  const status = STATEMENT_STATUS_LABELS[statement.status].toUpperCase();
  const bank = garage.invoicePayment;
  return (
    <Document title={`${garage.name} statement ${statement.reference}`} author={garage.legalName || garage.name}>
      <Page size="A4" style={s.page} wrap>
        <View style={s.head}>
          <View>{logo ? <Image src={logo} style={s.logo} /> : <Text style={s.brand}>{garage.name.toUpperCase()}</Text>}</View>
          <View style={s.titleBox}>
            <Text style={s.title}>STATEMENT</Text>
            <Text style={s.reference}>{statement.reference}</Text>
            <Text style={s.status}>{status}</Text>
          </View>
        </View>

        <View style={s.strip}>
          <View style={s.cell}><Text style={s.label}>Period</Text><Text style={s.value}>{periodLabel(statement.periodStart)}</Text></View>
          <View style={s.cell}><Text style={s.label}>Issued</Text><Text style={s.value}>{statement.issueDate ? longDate(statement.issueDate) : "Draft"}</Text></View>
          <View style={s.cell}><Text style={s.label}>Due by</Text><Text style={s.value}>{statement.dueDate ? longDate(statement.dueDate) : `${account.payment_terms_days} days from issue`}</Text></View>
          <View style={s.cell}><Text style={s.label}>Balance due</Text><Text style={s.value}>{formatPounds(totals.balance)}</Text></View>
        </View>

        <View style={s.parties}>
          <View style={s.party}>
            <Text style={s.label}>Account</Text>
            <Text style={s.partyName}>{account.name}</Text>
            {addressLines(account.billing_address).map((line, index) => <Text key={`${line}-${index}`} style={s.line}>{line}</Text>)}
            {account.billing_email ? <Text style={s.line}>{account.billing_email}</Text> : null}
            {account.company_number ? <Text style={s.line}>Company no. {account.company_number}</Text> : null}
          </View>
          <View style={s.party}>
            <Text style={s.label}>From</Text>
            <Text style={s.partyName}>{garage.legalName || garage.name}</Text>
            {garageAddress(garage).map((line, index) => <Text key={`${line}-${index}`} style={s.line}>{line}</Text>)}
            {[garage.phone, garage.email].filter(Boolean).length ? <Text style={s.line}>{[garage.phone, garage.email].filter(Boolean).join(" · ")}</Text> : null}
            {garage.companyNumber ? <Text style={s.line}>Company no. {garage.companyNumber}</Text> : null}
          </View>
        </View>

        <View style={s.table}>
          <View style={s.th} fixed>
            <Text style={s.colInvoice}>INVOICE</Text>
            <Text style={s.colDate}>DATE</Text>
            <Text style={s.colVehicle}>VEHICLE / DRIVER</Text>
            <Text style={s.colPo}>PO</Text>
            <Text style={s.colAmount}>AMOUNT</Text>
            <Text style={s.colBalance}>BALANCE</Text>
          </View>
          {lines.map((line) => (
            <View key={line.invoiceId} style={s.tr} wrap={false}>
              <Text style={s.colInvoice}>{line.invoiceNumber ?? "Draft"}</Text>
              <Text style={s.colDate}>{line.issueDate ? longDate(line.issueDate) : ""}</Text>
              <Text style={s.colVehicle}>{[line.registration ? formatRegistration(line.registration) : null, line.driver].filter(Boolean).join(" · ")}</Text>
              <Text style={s.colPo}>{line.poNumber ?? ""}</Text>
              <Text style={s.colAmount}>{formatPounds(line.totalPence)}</Text>
              <Text style={s.colBalance}>{formatPounds(lineBalance(line))}</Text>
            </View>
          ))}
        </View>

        <View style={s.totals} wrap={false}>
          <View style={s.totalRow}><Text>Invoices</Text><Text>{totals.count}</Text></View>
          <View style={s.totalRow}><Text>Total</Text><Text>{formatPounds(totals.total)}</Text></View>
          <View style={s.totalRow}><Text>Paid</Text><Text>{formatPounds(totals.paid)}</Text></View>
          <View style={[s.totalRow, s.grand]}><Text>BALANCE DUE</Text><Text>{formatPounds(totals.balance)}</Text></View>
        </View>

        {statement.status !== "paid" ? (
          <View style={s.pay} wrap={false}>
            <Text style={s.payTitle}>How to pay</Text>
            {bank ? <Text style={s.line}>Pay to {bank.accountName} · Sort code {bank.sortCode} · Account no. {bank.accountNumber}</Text> : null}
            <Text style={s.line}>Please quote {statement.reference}. Payment terms: {account.payment_terms_days} days.</Text>
          </View>
        ) : (
          <View style={s.pay} wrap={false}>
            <Text style={[s.payTitle, { color: c.green }]}>PAID{statement.paidAt ? ` · ${longDate(statement.paidAt)}` : ""}</Text>
          </View>
        )}

        <View style={s.footer} fixed>
          <Text>{`${garage.legalName || garage.name} · Statement produced with ${PLATFORM_NAME}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `${statement.reference} · Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderStatementPdf(detail: StatementDetail, garage: StatementGarage) {
  const logo = await loadGarageLogo(garage.logoUrl);
  return renderToBuffer(<StatementDocument detail={detail} garage={garage} logo={logo} />);
}
