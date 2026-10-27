import "server-only";

import { brandUrl, type EmailBrand } from "@/lib/email/brand";
import { adminUrl } from "@/lib/tenancy/urls";
import { detailCard, detailsText, emailLayout, notice, plainTextFooter, plainTextHeader, type RenderedEmail, type StatusTone } from "./components";

export type BookingEmailType = "confirmed" | "rescheduled" | "cancelled";
export type BookingEmailInput = {
  brand: EmailBrand;
  type: BookingEmailType;
  customerName: string;
  reference: string;
  service: string;
  vehicle: string;
  date: string;
  startTime: string;
  endTime?: string;
  duration?: string;
  timezone: string;
  location: string;
  previousAppointment?: string;
  googleCalendarUrl?: string;
  calendarUrl?: string;
};

export type InternalBookingEmailInput = BookingEmailInput & {
  customerEmail: string;
  customerPhone?: string;
  notes?: string;
};

function copyFor(type: BookingEmailType, garageName: string) {
  const copy = {
    confirmed: { status: "BOOKING CONFIRMED", title: "You're booked in.", intro: `Your ${garageName} appointment is confirmed.`, tone: "success" as StatusTone },
    rescheduled: { status: "BOOKING UPDATED", title: "Your appointment has been rescheduled.", intro: "The new appointment date and time are shown below.", tone: "warning" as StatusTone },
    cancelled: { status: "BOOKING CANCELLED", title: "Your appointment has been cancelled.", intro: "Here is a record of the cancelled appointment.", tone: "cancelled" as StatusTone },
  };
  return copy[type];
}

export function renderBookingEmail(input: BookingEmailInput): RenderedEmail {
  const { brand } = input;
  const details = [
    { label: "Customer", value: input.customerName },
    { label: "Vehicle", value: input.vehicle },
    { label: "Service", value: input.service },
    { label: "Date", value: input.date },
    { label: "Start time", value: input.startTime },
    { label: "Expected end", value: [input.endTime, input.duration].filter(Boolean).join(" · ") },
    { label: "Timezone", value: input.timezone },
    { label: "Location", value: input.location },
    { label: "Booking reference", value: input.reference },
  ];
  const isCancelled = input.type === "cancelled";
  const actionUrl = brandUrl(brand, isCancelled ? "/" : "/manage-booking");
  const actionLabel = isCancelled ? "Book another appointment" : "Manage booking";
  const item = copyFor(input.type, brand.name);
  const preheader = input.type === "confirmed"
    ? `Your ${brand.name} appointment is confirmed for ${input.date} at ${input.startTime}.`
    : input.type === "rescheduled"
      ? `Your ${brand.name} appointment has a new date and time.`
      : `Your ${brand.name} appointment has been cancelled.`;
  return {
    html: emailLayout({
      brand,
      preheader,
      status: item.status,
      tone: item.tone,
      title: item.title,
      intro: `Hello ${input.customerName}. ${item.intro}`,
      contentHtml: `${input.previousAppointment && input.type === "rescheduled" ? notice("Previous appointment", input.previousAppointment, brand) : ""}${detailCard(details)}`,
      cta: { label: actionLabel, url: actionUrl },
      secondaryCtas: isCancelled ? undefined : [
        ...(input.googleCalendarUrl ? [{ label: "Add to Google Calendar", url: input.googleCalendarUrl }] : []),
        ...(input.calendarUrl ? [{ label: "Add to Calendar", url: input.calendarUrl }] : []),
      ],
      afterCta: isCancelled ? "When you're ready, you can arrange another appointment online." : "Need to make a change? Use Manage Booking to review, reschedule or cancel your appointment.",
    }),
    text: [plainTextHeader(brand), "", item.status, "", `Hello ${input.customerName},`, "", item.intro, "", input.previousAppointment && input.type === "rescheduled" ? `Previous appointment: ${input.previousAppointment}\n` : "", detailsText(details), "", `${actionLabel}: ${actionUrl}`, !isCancelled && input.googleCalendarUrl ? `Add to Google Calendar: ${input.googleCalendarUrl}` : "", !isCancelled && input.calendarUrl ? `Add to Calendar: ${input.calendarUrl}` : "", plainTextFooter(brand)].filter((line) => line !== "").join("\n"),
  };
}

/** Staff alert for a booking event, sent to the garage's own address. */
export function renderInternalBookingEmail(input: InternalBookingEmailInput): RenderedEmail {
  const { brand } = input;
  const appointmentStatus = input.type === "confirmed" ? "NEW BOOKING" : input.type === "rescheduled" ? "BOOKING RESCHEDULED" : "BOOKING CANCELLED";
  const title = input.type === "confirmed" ? "A customer has made a booking." : input.type === "rescheduled" ? "A customer booking has changed." : "A customer booking has been cancelled.";
  const details = [
    { label: "Customer", value: input.customerName },
    { label: "Customer email", value: input.customerEmail },
    { label: "Customer phone", value: input.customerPhone },
    { label: "Vehicle", value: input.vehicle },
    { label: "Service", value: input.service },
    { label: "Date", value: input.date },
    { label: "Time", value: [input.startTime, input.endTime].filter(Boolean).join("–") },
    { label: "Location", value: input.location },
    { label: "Booking reference", value: input.reference },
    { label: "Customer notes", value: input.notes },
  ];
  const bookingsUrl = adminUrl("/app/bookings");
  return {
    html: emailLayout({
      brand,
      preheader: `${appointmentStatus}: ${input.reference} for ${input.customerName}.`,
      status: appointmentStatus,
      tone: input.type === "confirmed" ? "success" : input.type === "rescheduled" ? "warning" : "cancelled",
      title,
      intro: `The booking is in your Autofix admin for ${brand.name}. The key details are included below.`,
      contentHtml: detailCard(details),
      cta: { label: "View bookings", url: bookingsUrl },
    }),
    text: [plainTextHeader(brand), "", appointmentStatus, "", title, "", detailsText(details), "", `View bookings: ${bookingsUrl}`, plainTextFooter(brand)].join("\n"),
  };
}
