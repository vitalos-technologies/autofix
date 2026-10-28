import "server-only";

import { bookingLocation, type BookingNotificationContext } from "@/lib/bookings/notification-context";
import { composeBookingNotifications, type BookingNotificationEvent, type ComposedBookingNotifications } from "@/lib/bookings/notifications";
import type { Garage } from "@/lib/tenancy/garage";
import { garageEmailBrand } from "./brand";
import { renderPasswordChanged, renderPasswordReset } from "./templates/auth";
import { renderBusinessEnquiryNotification, renderEnquiryReceived, renderEnquiryReply, type EnquiryTemplateInput } from "./templates/enquiries";
import { renderInvoiceEmail } from "./templates/invoice";

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
  plan: "essentials",
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

  const bookings = bookingNotificationPreviews(garage);

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
    // Booking mail comes from the real notification composer (src/lib/bookings/notifications.ts).
    "booking-confirmed": rendered(bookings.confirmed.customerEmail),
    "booking-requested": rendered(bookings.requested.customerEmail),
    "booking-rescheduled": rendered(bookings.rescheduled.customerEmail),
    "booking-cancelled": rendered(bookings.cancelled.customerEmail),
    "booking-staff-alert": rendered(bookings.confirmed.staffEmail),
    "booking-staff-request": rendered(bookings.requested.staffEmail),
    "invoice-unpaid": renderInvoiceEmail({ ...invoice, status: "issued" }),
    "invoice-paid": renderInvoiceEmail({ ...invoice, status: "paid", paymentDate: "13 August 2026 at 14:20", paymentMethod: "Card" }),
  };
}

function rendered(message: { html: string; text: string } | null) {
  if (!message) throw new Error("preview booking message missing");
  return { html: message.html, text: message.text };
}

const PREVIEW_NOW = new Date("2026-08-13T09:00:00.000Z");

/** A booking at the preview garage. Sample data only: an Ofcom drama number and an example.com address. */
export function previewBookingContext(garage: Garage = previewGarage, overrides: { status?: BookingNotificationContext["booking"]["status"]; calendarSequence?: number } = {}): BookingNotificationContext {
  return {
    garage,
    booking: {
      id: "6b0f7a52-3c1e-4d8e-9a77-2f5c1d0e4b21",
      reference: `${garage.bookingPrefix}-4821`,
      status: overrides.status ?? "confirmed",
      startsAt: "2026-08-20T09:30:00.000Z",
      endsAt: "2026-08-20T11:00:00.000Z",
      locationMode: "workshop",
      location: bookingLocation(garage, { locationMode: "workshop", address: null, postcode: null }),
      notes: "The warning light appears intermittently after a long drive.",
      symptoms: ["Warning light"],
      cancellationReason: null,
      updatedAt: PREVIEW_NOW.toISOString(),
    },
    service: { name: "Vehicle diagnostics and intermittent electrical fault investigation" },
    customer: { id: "0f2b9c64-8e51-4a3d-b1f7-5d6e7a8b9c01", name: "Alexandra Montgomery-Smythe", email: "alexandra@example.com", phone: "+447700900123", channel: "sms", optedOutAt: null },
    vehicle: { registration: "AB12CDE", make: "Vauxhall", model: "Astra Elite Nav Turbo" },
    manageToken: "PREVIEW0token0for0local0email0previews00000",
    calendarSequence: overrides.calendarSequence ?? 0,
  };
}

/** Every booking notification (emails, .ics and text message) for the preview garage. */
export function bookingNotificationPreviews(garage: Garage = previewGarage): Record<"confirmed" | "requested" | "rescheduled" | "cancelled", ComposedBookingNotifications> {
  const compose = (event: BookingNotificationEvent, context: BookingNotificationContext, previousStartsAt?: string) => composeBookingNotifications(context, event, { previousStartsAt, now: PREVIEW_NOW });
  return {
    confirmed: compose("created", previewBookingContext(garage)),
    requested: compose("created", previewBookingContext(garage, { status: "requested" })),
    rescheduled: compose("rescheduled", previewBookingContext(garage, { calendarSequence: 1 }), "2026-08-18T08:00:00.000Z"),
    cancelled: compose("cancelled", previewBookingContext(garage, { status: "cancelled", calendarSequence: 2 })),
  };
}

/** Platform (account) mail previews. */
export function platformEmailPreviewFixtures() {
  return {
    "password-reset": renderPasswordReset({ actionUrl: "https://example.supabase.co/auth/v1/verify?token=preview&type=recovery" }),
    "password-changed": renderPasswordChanged(),
  };
}
