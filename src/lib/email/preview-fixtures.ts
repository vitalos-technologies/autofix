import "server-only";

import { addressLine } from "@/lib/tenancy/contact";
import { garageEmailBrand } from "./brand";
import { renderPasswordChanged, renderPasswordReset } from "./templates/auth";
import { renderBookingEmail, renderInternalBookingEmail } from "./templates/bookings";
import { renderBusinessEnquiryNotification, renderEnquiryReceived, renderEnquiryReply, type EnquiryTemplateInput } from "./templates/enquiries";
import { renderInvoiceEmail } from "./templates/invoice";
import type { Garage } from "@/lib/tenancy/garage";

/** Sample garage for local previews only (the seed's demo garage). Never used to send mail. */
export const previewGarage: Garage = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "hartley-road",
  name: "Hartley Road Motors",
  legalName: "Hartley Road Motors Ltd",
  companyNumber: "00000000",
  phone: "+441302000101",
  whatsapp: "+447700900101",
  email: "bookings@hartleyroad.example",
  address: { line1: "4 Hartley Road", town: "Doncaster", postcode: "DN1 2AB" },
  timezone: "Europe/London",
  logoUrl: null,
  accent: "#0f766e",
  plan: "growth",
  motEnabled: true,
  bookingPrefix: "HRM",
  slotStepMin: 15,
  approveOnline: false,
  serviceArea: [],
  cancellationCutoffH: 24,
  smsSender: "HartleyRd",
  status: "active",
  customDomain: null,
  tagline: "Servicing, MOT and repairs",
  invoicePayment: null,
};

export function emailPreviewFixtures(garage: Garage = previewGarage) {
  const brand = garageEmailBrand(garage);
  const enquiry: EnquiryTemplateInput = {
    brand,
    enquiryId: "8db05a20-006b-4b50-b10c-83b091ee54ad",
    type: "vehicle_diagnostics",
    customerName: "Alexandra Montgomery-Smythe",
    customerEmail: "alexandra@example.com",
    phone: "07700 900123",
    preferredContact: "email",
    service: "Vehicle diagnostics and intermittent electrical fault investigation",
    vehicle: "AB12 CDE · Vauxhall Astra Elite Nav Turbo",
    location: "DN1 2AB",
    description: "The warning light appears intermittently after a long drive. Please check the charging system and stored fault codes.\nThe vehicle remains driveable.",
  };

  const booking = {
    brand,
    customerName: "Alexandra Montgomery-Smythe",
    reference: `${garage.bookingPrefix}-4821`,
    service: "Vehicle diagnostics and intermittent electrical fault investigation",
    vehicle: "AB12 CDE · Vauxhall Astra Elite Nav Turbo",
    date: "Thursday, 20 August 2026",
    startTime: "10:30",
    endTime: "12:00",
    duration: "90 minutes",
    timezone: "Europe/London (UK time)",
    location: [`${garage.name} workshop`, addressLine(garage.address)].filter(Boolean).join(", "),
    previousAppointment: "Tuesday, 18 August 2026 at 09:00–10:30",
    googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE",
    calendarUrl: `${brand.baseUrl}/api/bookings/calendar/${garage.bookingPrefix}-4821?signature=preview`,
  };

  const invoice = {
    brand,
    customerName: "Alexandra Montgomery-Smythe",
    invoiceNumber: `${garage.bookingPrefix}-2026-000123`,
    amount: "£185.00",
    issueDate: "13 August 2026",
    dueDate: "20 August 2026",
    vehicle: "AB12 CDE · Vauxhall Astra Elite Nav Turbo",
  };

  return {
    "enquiry-received": renderEnquiryReceived(enquiry),
    "enquiry-business-notification": renderBusinessEnquiryNotification(enquiry),
    "enquiry-reply": renderEnquiryReply({ brand, customerName: enquiry.customerName, body: `${enquiry.description}\n\nWe can inspect this on Thursday.` }),
    "booking-confirmed": renderBookingEmail({ ...booking, type: "confirmed" }),
    "booking-rescheduled": renderBookingEmail({ ...booking, type: "rescheduled" }),
    "booking-cancelled": renderBookingEmail({ ...booking, type: "cancelled" }),
    "booking-staff-alert": renderInternalBookingEmail({ ...booking, type: "confirmed", customerEmail: "alexandra@example.com", customerPhone: "07700 900123" }),
    "invoice-unpaid": renderInvoiceEmail({ ...invoice, status: "issued" }),
    "invoice-paid": renderInvoiceEmail({ ...invoice, status: "paid", paymentDate: "13 August 2026 at 14:20", paymentMethod: "Card" }),
  };
}

/** Platform (account) mail previews. */
export function platformEmailPreviewFixtures() {
  return {
    "password-reset": renderPasswordReset({ actionUrl: "https://example.supabase.co/auth/v1/verify?token=preview&type=recovery" }),
    "password-changed": renderPasswordChanged(),
  };
}
