import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanSearch } from "@/lib/admin/data";
import type { BookingStatus } from "@/lib/booking-engine/types";
import { toE164UK } from "@/lib/messaging/phone";
import {
  lineBalance,
  statementTotals,
  type AccountBilling,
  type AccountKind,
  type AccountValues,
  type PersonRole,
  type StatementLine,
  type StatementStatus,
} from "./view";

// Fleet and trade account reads (P5.7). Every function takes the caller's RLS client
// (getAdminContext().client) and the selected garage's id, and filters by it explicitly, so
// rows are that garage's only. Reads don't check the plan: a garage back on Essentials still
// sees its accounts and statements (P5.2). Registrations are shown on these pages but never put
// in a URL, and search terms arrive in POST bodies.

type Related<T> = T | T[] | null;
const one = <T,>(value: Related<T>): T | null => (Array.isArray(value) ? (value[0] ?? null) : value);

export class AccountDataError extends Error {
  constructor(what: string) {
    super(`Could not load ${what}`);
    this.name = "AccountDataError";
  }
}

export type AccountRow = AccountValues & { id: string; archived_at: string | null; created_at: string };

const ACCOUNT_COLUMNS =
  "id,name,kind,company_number,billing_email,billing_address,contact_name,contact_phone,contact_email,payment_terms_days,po_required,discount_percent,credit_limit_pence,billing,notes,archived_at,created_at";

function accountFromRow(row: Record<string, unknown>): AccountRow {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as AccountKind,
    company_number: (row.company_number as string | null) ?? null,
    billing_email: (row.billing_email as string | null) ?? null,
    billing_address: (row.billing_address as string | null) ?? null,
    contact_name: (row.contact_name as string | null) ?? null,
    contact_phone: (row.contact_phone as string | null) ?? null,
    contact_email: (row.contact_email as string | null) ?? null,
    payment_terms_days: Number(row.payment_terms_days ?? 30),
    po_required: Boolean(row.po_required),
    discount_percent: row.discount_percent === null || row.discount_percent === undefined ? null : Number(row.discount_percent),
    credit_limit_pence: row.credit_limit_pence === null || row.credit_limit_pence === undefined ? null : Number(row.credit_limit_pence),
    billing: row.billing as AccountBilling,
    notes: (row.notes as string | null) ?? null,
    archived_at: (row.archived_at as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Invoices charged to accounts
// ---------------------------------------------------------------------------

type InvoiceLinkRow = {
  account_id: string;
  invoice_id: string;
  po_number: string | null;
  statement_id: string | null;
  invoices: Related<{
    id: string;
    invoice_number: string | null;
    status: StatementLine["status"];
    issue_date: string | null;
    total_pence: number | string;
    customer_name: string;
    vehicle_registration: string | null;
    service_name: string | null;
    deleted_at: string | null;
    booking_id: string | null;
    invoice_payments: Array<{ amount_pence: number | string }> | null;
  }>;
};

const INVOICE_LINK_SELECT =
  "account_id,invoice_id,po_number,statement_id,invoices(id,invoice_number,status,issue_date,total_pence,customer_name,vehicle_registration,service_name,deleted_at,booking_id,invoice_payments(amount_pence))";

export type AccountInvoiceLine = StatementLine & { accountId: string; statementId: string | null; bookingId: string | null };

function invoiceLine(row: InvoiceLinkRow): AccountInvoiceLine | null {
  const invoice = one(row.invoices);
  if (!invoice || invoice.deleted_at) return null;
  const paid = (invoice.invoice_payments ?? []).reduce((sum, payment) => sum + Number(payment.amount_pence), 0);
  return {
    accountId: row.account_id,
    statementId: row.statement_id,
    bookingId: invoice.booking_id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.issue_date,
    status: invoice.status,
    registration: invoice.vehicle_registration,
    driver: invoice.customer_name,
    serviceName: invoice.service_name,
    poNumber: row.po_number,
    totalPence: Number(invoice.total_pence),
    paidPence: invoice.status === "paid" && paid === 0 ? Number(invoice.total_pence) : paid,
  };
}

async function loadInvoiceLines(client: SupabaseClient, garageId: string, filter: { accountId?: string; statementId?: string }) {
  let query = client.from("business_account_invoices").select(INVOICE_LINK_SELECT).eq("garage_id", garageId);
  if (filter.accountId) query = query.eq("account_id", filter.accountId);
  if (filter.statementId) query = query.eq("statement_id", filter.statementId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1000);
  if (error) throw new AccountDataError("account invoices");
  return ((data ?? []) as unknown as InvoiceLinkRow[]).map(invoiceLine).filter((line): line is AccountInvoiceLine => line !== null);
}

/** What the account owes: issued invoices' unpaid balances. */
function owedPence(lines: readonly AccountInvoiceLine[]) {
  return lines.filter((line) => line.status === "issued").reduce((sum, line) => sum + lineBalance(line), 0);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type AccountSummary = {
  id: string;
  name: string;
  kind: AccountKind;
  billing: AccountBilling;
  archived: boolean;
  vehicleCount: number;
  owedPence: number;
  creditLimitPence: number | null;
  unbilledCount: number;
};

/** Every account of the garage (active first, then archived), with its car count and what it owes. */
export async function listAccounts(client: SupabaseClient, garageId: string): Promise<AccountSummary[]> {
  const [accounts, vehicles, lines] = await Promise.all([
    client.from("business_accounts").select("id,name,kind,billing,archived_at,credit_limit_pence").eq("garage_id", garageId).order("name").limit(500),
    client.from("business_account_vehicles").select("account_id").eq("garage_id", garageId).limit(5000),
    loadInvoiceLines(client, garageId, {}),
  ]);
  if (accounts.error || vehicles.error) throw new AccountDataError("accounts");
  const carCounts = new Map<string, number>();
  for (const row of (vehicles.data ?? []) as Array<{ account_id: string }>) carCounts.set(row.account_id, (carCounts.get(row.account_id) ?? 0) + 1);
  return ((accounts.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => {
      const id = String(row.id);
      const mine = lines.filter((line) => line.accountId === id);
      return {
        id,
        name: String(row.name),
        kind: row.kind as AccountKind,
        billing: row.billing as AccountBilling,
        archived: Boolean(row.archived_at),
        vehicleCount: carCounts.get(id) ?? 0,
        owedPence: owedPence(mine),
        creditLimitPence: row.credit_limit_pence === null || row.credit_limit_pence === undefined ? null : Number(row.credit_limit_pence),
        unbilledCount: mine.filter((line) => !line.statementId && (line.status === "issued" || line.status === "paid")).length,
      };
    })
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type AccountVehicle = { linkId: string; vehicleId: string; registration: string | null; make: string | null; model: string | null; motExpiry: string | null; driverName: string | null };
export type AccountPerson = { linkId: string; customerId: string; name: string; phone: string | null; email: string | null; role: PersonRole };
export type AccountBooking = {
  bookingId: string;
  reference: string;
  startsAt: string;
  status: BookingStatus;
  serviceName: string | null;
  registration: string | null;
  driverName: string | null;
  poNumber: string | null;
  invoiced: boolean;
};
export type AccountStatementSummary = {
  id: string;
  reference: string;
  periodStart: string;
  status: StatementStatus;
  invoiceCount: number;
  totalPence: number;
  dueDate: string | null;
  emailedAt: string | null;
};

export type AccountDetail = {
  account: AccountRow;
  vehicles: AccountVehicle[];
  people: AccountPerson[];
  bookings: AccountBooking[];
  /** Invoices charged to the account that are on no statement yet (drafts included). */
  unbilled: AccountInvoiceLine[];
  /** Account bookings that are finished or under way and have no invoice yet. */
  toInvoice: AccountBooking[];
  statements: AccountStatementSummary[];
  owedPence: number;
};

type VehicleLinkRow = {
  id: string;
  vehicle_id: string;
  vehicles: Related<{ registration: string | null; make: string | null; model: string | null; mot_expiry: string | null; customers: Related<{ name: string | null }> }>;
};
type PersonLinkRow = { id: string; customer_id: string; role: PersonRole; customers: Related<{ name: string; phone: string | null; email: string | null; anonymised_at: string | null }> };
type BookingLinkRow = {
  booking_id: string;
  po_number: string | null;
  bookings: Related<{
    id: string;
    reference: string;
    starts_at: string;
    status: BookingStatus;
    deleted_at: string | null;
    services: Related<{ name: string }>;
    vehicles: Related<{ registration: string | null }>;
    customers: Related<{ name: string }>;
  }>;
};

function statementSummary(row: Record<string, unknown>): AccountStatementSummary {
  return {
    id: String(row.id),
    reference: String(row.reference),
    periodStart: String(row.period_start),
    status: row.status as StatementStatus,
    invoiceCount: Number(row.invoice_count ?? 0),
    totalPence: Number(row.total_pence ?? 0),
    dueDate: (row.due_date as string | null) ?? null,
    emailedAt: (row.emailed_at as string | null) ?? null,
  };
}

const STATEMENT_COLUMNS = "id,reference,period_start,status,invoice_count,total_pence,due_date,emailed_at";
const WORK_DONE: ReadonlySet<BookingStatus> = new Set(["arrived", "in_progress", "waiting_parts", "ready", "collected"]);

/** One account with its cars, people, recent bookings, unbilled work and statements; null when it isn't the garage's. */
export async function getAccountDetail(client: SupabaseClient, garageId: string, accountId: string): Promise<AccountDetail | null> {
  const { data: accountData, error: accountError } = await client.from("business_accounts").select(ACCOUNT_COLUMNS).eq("garage_id", garageId).eq("id", accountId).maybeSingle();
  if (accountError) throw new AccountDataError("the account");
  if (!accountData) return null;

  const [vehicles, people, bookings, statements, lines] = await Promise.all([
    client
      .from("business_account_vehicles")
      .select("id,vehicle_id,vehicles(registration,make,model,mot_expiry,customers(name))")
      .eq("garage_id", garageId)
      .eq("account_id", accountId)
      .order("created_at")
      .limit(500),
    client.from("business_account_customers").select("id,customer_id,role,customers(name,phone,email,anonymised_at)").eq("garage_id", garageId).eq("account_id", accountId).order("created_at").limit(500),
    client
      .from("business_account_bookings")
      .select("booking_id,po_number,bookings(id,reference,starts_at,status,deleted_at,services(name),vehicles(registration),customers(name))")
      .eq("garage_id", garageId)
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(100),
    client.from("account_statements").select(STATEMENT_COLUMNS).eq("garage_id", garageId).eq("account_id", accountId).order("period_start", { ascending: false }).limit(24),
    loadInvoiceLines(client, garageId, { accountId }),
  ]);
  if (vehicles.error || people.error || bookings.error || statements.error) throw new AccountDataError("the account's details");

  const invoicedBookings = new Set(lines.filter((line) => line.status !== "void").map((line) => line.bookingId).filter(Boolean) as string[]);
  const accountBookings: AccountBooking[] = ((bookings.data ?? []) as unknown as BookingLinkRow[])
    .map((row) => {
      const booking = one(row.bookings);
      if (!booking || booking.deleted_at) return null;
      return {
        bookingId: booking.id,
        reference: booking.reference,
        startsAt: booking.starts_at,
        status: booking.status,
        serviceName: one(booking.services)?.name ?? null,
        registration: one(booking.vehicles)?.registration ?? null,
        driverName: one(booking.customers)?.name ?? null,
        poNumber: row.po_number,
        invoiced: invoicedBookings.has(booking.id),
      };
    })
    .filter((booking): booking is AccountBooking => booking !== null)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));

  return {
    account: accountFromRow(accountData as Record<string, unknown>),
    vehicles: ((vehicles.data ?? []) as unknown as VehicleLinkRow[])
      .map((row) => {
        const vehicle = one(row.vehicles);
        return {
          linkId: row.id,
          vehicleId: row.vehicle_id,
          registration: vehicle?.registration ?? null,
          make: vehicle?.make ?? null,
          model: vehicle?.model ?? null,
          motExpiry: vehicle?.mot_expiry ?? null,
          driverName: one(vehicle?.customers ?? null)?.name ?? null,
        };
      })
      .sort((a, b) => (a.registration ?? "").localeCompare(b.registration ?? "")),
    people: ((people.data ?? []) as unknown as PersonLinkRow[])
      .map((row) => {
        const customer = one(row.customers);
        if (!customer || customer.anonymised_at) return null;
        return { linkId: row.id, customerId: row.customer_id, name: customer.name, phone: customer.phone, email: customer.email, role: row.role };
      })
      .filter((person): person is AccountPerson => person !== null),
    bookings: accountBookings.slice(0, 20),
    unbilled: lines.filter((line) => !line.statementId && line.status !== "void"),
    toInvoice: accountBookings.filter((booking) => !booking.invoiced && WORK_DONE.has(booking.status)),
    statements: ((statements.data ?? []) as Array<Record<string, unknown>>).map(statementSummary),
    owedPence: owedPence(lines),
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type StatementDetail = {
  statement: AccountStatementSummary & {
    periodEnd: string;
    issueDate: string | null;
    paidAt: string | null;
    paymentMethod: string | null;
    paymentReference: string | null;
    emailedTo: string | null;
    emailStatus: "sent" | "failed" | null;
  };
  account: AccountRow;
  lines: AccountInvoiceLine[];
  totals: ReturnType<typeof statementTotals>;
};

/** A statement with its account and invoice lines; null when it isn't the garage's. */
export async function getStatementDetail(client: SupabaseClient, garageId: string, statementId: string): Promise<StatementDetail | null> {
  const { data, error } = await client
    .from("account_statements")
    .select(`${STATEMENT_COLUMNS},account_id,period_end,issue_date,paid_at,payment_method,payment_reference,emailed_to,email_status`)
    .eq("garage_id", garageId)
    .eq("id", statementId)
    .maybeSingle();
  if (error) throw new AccountDataError("the statement");
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const [account, lines] = await Promise.all([
    client.from("business_accounts").select(ACCOUNT_COLUMNS).eq("garage_id", garageId).eq("id", String(row.account_id)).maybeSingle(),
    loadInvoiceLines(client, garageId, { statementId }),
  ]);
  if (account.error || !account.data) throw new AccountDataError("the statement's account");
  const sorted = lines.sort((a, b) => (a.issueDate ?? "").localeCompare(b.issueDate ?? "") || (a.invoiceNumber ?? "").localeCompare(b.invoiceNumber ?? ""));
  return {
    statement: {
      ...statementSummary(row),
      periodEnd: String(row.period_end),
      issueDate: (row.issue_date as string | null) ?? null,
      paidAt: (row.paid_at as string | null) ?? null,
      paymentMethod: (row.payment_method as string | null) ?? null,
      paymentReference: (row.payment_reference as string | null) ?? null,
      emailedTo: (row.emailed_to as string | null) ?? null,
      emailStatus: (row.email_status as "sent" | "failed" | null) ?? null,
    },
    account: accountFromRow(account.data as Record<string, unknown>),
    lines: sorted,
    totals: statementTotals(sorted),
  };
}

// ---------------------------------------------------------------------------
// Bookings and invoices
// ---------------------------------------------------------------------------

export type BookingAccount = { accountId: string; name: string; poNumber: string | null; billing: AccountBilling; paymentTermsDays: number; discountPercent: number | null };

/** The account a booking is charged to, if any (null on any read problem: the booking page never fails on it). */
export async function getBookingAccount(client: SupabaseClient, garageId: string, bookingId: string): Promise<BookingAccount | null> {
  try {
    return await readBookingAccount(client, garageId, bookingId);
  } catch {
    return null;
  }
}

async function readBookingAccount(client: SupabaseClient, garageId: string, bookingId: string): Promise<BookingAccount | null> {
  const { data, error } = await client
    .from("business_account_bookings")
    .select("account_id,po_number,business_accounts(name,billing,payment_terms_days,discount_percent)")
    .eq("garage_id", garageId)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (error || !data) return null;
  const account = one((data as { business_accounts: Related<{ name: string; billing: AccountBilling; payment_terms_days: number; discount_percent: number | string | null }> }).business_accounts);
  if (!account) return null;
  return {
    accountId: String(data.account_id),
    name: account.name,
    poNumber: (data.po_number as string | null) ?? null,
    billing: account.billing,
    paymentTermsDays: Number(account.payment_terms_days ?? 30),
    discountPercent: account.discount_percent === null || account.discount_percent === undefined ? null : Number(account.discount_percent),
  };
}

export type InvoiceAccount = {
  accountId: string;
  accountName: string;
  billing: AccountBilling;
  poNumber: string | null;
  billToName: string;
  billToEmail: string | null;
  billToAddress: string | null;
  statementId: string | null;
  statementReference: string | null;
};

/** The account an invoice is charged to (bill-to snapshot and PO), if any (null on any read problem). */
export async function getInvoiceAccount(client: SupabaseClient, garageId: string, invoiceId: string): Promise<InvoiceAccount | null> {
  try {
    return await readInvoiceAccount(client, garageId, invoiceId);
  } catch {
    return null;
  }
}

async function readInvoiceAccount(client: SupabaseClient, garageId: string, invoiceId: string): Promise<InvoiceAccount | null> {
  const { data, error } = await client
    .from("business_account_invoices")
    .select("account_id,po_number,bill_to_name,bill_to_email,bill_to_address,statement_id,business_accounts(name,billing),account_statements(reference)")
    .eq("garage_id", garageId)
    .eq("invoice_id", invoiceId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as {
    account_id: string;
    po_number: string | null;
    bill_to_name: string;
    bill_to_email: string | null;
    bill_to_address: string | null;
    statement_id: string | null;
    business_accounts: Related<{ name: string; billing: AccountBilling }>;
    account_statements: Related<{ reference: string }>;
  };
  const account = one(row.business_accounts);
  return {
    accountId: row.account_id,
    accountName: account?.name ?? row.bill_to_name,
    billing: account?.billing ?? "monthly",
    poNumber: row.po_number,
    billToName: row.bill_to_name,
    billToEmail: row.bill_to_email,
    billToAddress: row.bill_to_address,
    statementId: row.statement_id,
    statementReference: one(row.account_statements)?.reference ?? null,
  };
}

// ---------------------------------------------------------------------------
// For the staff booking form
// ---------------------------------------------------------------------------

export type BookingFormAccount = {
  id: string;
  name: string;
  poRequired: boolean;
  contact: { name: string | null; phone: string | null; email: string | null };
  vehicles: Array<{ registration: string; make: string | null; model: string | null }>;
  drivers: Array<{ id: string; name: string; phone: string; email: string | null }>;
};

/** Active accounts with their cars and drivers, for the "Account" choice on /app/bookings/new. */
export async function listBookingFormAccounts(client: SupabaseClient, garageId: string): Promise<BookingFormAccount[]> {
  const [accounts, vehicles, people] = await Promise.all([
    client.from("business_accounts").select("id,name,po_required,contact_name,contact_phone,contact_email").eq("garage_id", garageId).is("archived_at", null).order("name").limit(500),
    client.from("business_account_vehicles").select("account_id,vehicles(registration,make,model)").eq("garage_id", garageId).limit(5000),
    client.from("business_account_customers").select("account_id,customers(id,name,phone,email,anonymised_at)").eq("garage_id", garageId).limit(5000),
  ]);
  if (accounts.error || vehicles.error || people.error) return [];
  return ((accounts.data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const id = String(row.id);
    return {
      id,
      name: String(row.name),
      poRequired: Boolean(row.po_required),
      contact: { name: (row.contact_name as string | null) ?? null, phone: (row.contact_phone as string | null) ?? null, email: (row.contact_email as string | null) ?? null },
      vehicles: ((vehicles.data ?? []) as unknown as Array<{ account_id: string; vehicles: Related<{ registration: string | null; make: string | null; model: string | null }> }>)
        .filter((link) => link.account_id === id)
        .map((link) => one(link.vehicles))
        .filter((vehicle): vehicle is { registration: string; make: string | null; model: string | null } => Boolean(vehicle?.registration))
        .sort((a, b) => a.registration.localeCompare(b.registration)),
      drivers: ((people.data ?? []) as unknown as Array<{ account_id: string; customers: Related<{ id: string; name: string; phone: string | null; email: string | null; anonymised_at: string | null }> }>)
        .filter((link) => link.account_id === id)
        .map((link) => one(link.customers))
        .filter((customer): customer is { id: string; name: string; phone: string; email: string | null; anonymised_at: string | null } => Boolean(customer && customer.phone && !customer.anonymised_at))
        .map((customer) => ({ id: customer.id, name: customer.name, phone: customer.phone, email: customer.email })),
    };
  });
}

// ---------------------------------------------------------------------------
// Searches (POST bodies only)
// ---------------------------------------------------------------------------

export type VehicleMatch = { vehicleId: string; registration: string; make: string | null; model: string | null; ownerName: string | null; accountName: string | null };

/** The garage's cars whose registration contains the term (letters and digits only), up to 10. */
export async function searchVehicles(client: SupabaseClient, garageId: string, term: string): Promise<VehicleMatch[]> {
  const compact = term.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (compact.length < 2) return [];
  const { data, error } = await client
    .from("vehicles")
    .select("id,registration,make,model,customers(name),business_account_vehicles(business_accounts(name))")
    .eq("garage_id", garageId)
    .ilike("registration", `%${compact}%`)
    .order("registration")
    .limit(10);
  if (error) throw new AccountDataError("cars");
  return ((data ?? []) as unknown as Array<{
    id: string;
    registration: string | null;
    make: string | null;
    model: string | null;
    customers: Related<{ name: string }>;
    business_account_vehicles: Related<{ business_accounts: Related<{ name: string }> }>;
  }>)
    .filter((row) => row.registration)
    .map((row) => ({
      vehicleId: row.id,
      registration: row.registration!,
      make: row.make,
      model: row.model,
      ownerName: one(row.customers)?.name ?? null,
      accountName: one(one(row.business_account_vehicles)?.business_accounts ?? null)?.name ?? null,
    }));
}

export type CustomerMatch = { customerId: string; name: string; phone: string | null; email: string | null };

/** The garage's customers by name or mobile, up to 10 (anonymised customers left out). */
export async function searchCustomers(client: SupabaseClient, garageId: string, term: string): Promise<CustomerMatch[]> {
  const search = cleanSearch(term);
  if (search.length < 2) return [];
  const phone = /\d{6,}/.test(search.replace(/\s+/g, "")) ? toE164UK(search, { allowLandline: true }) : null;
  let query = client.from("customers").select("id,name,phone,email").eq("garage_id", garageId).is("anonymised_at", null);
  query = phone ? query.eq("phone", phone) : query.ilike("name", `%${search}%`);
  const { data, error } = await query.order("name").limit(10);
  if (error) throw new AccountDataError("customers");
  return ((data ?? []) as Array<{ id: string; name: string; phone: string | null; email: string | null }>).map((row) => ({
    customerId: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
  }));
}
