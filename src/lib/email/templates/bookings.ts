import "server-only";

import { brandUrl, type EmailBrand } from "@/lib/email/brand";
import { adminUrl } from "@/lib/tenancy/urls";
import { detailCard, detailsText, emailLayout, notice, plainTextFooter, plainTextHeader, type FooterLink, type RenderedEmail, type StatusTone } from "./components";

/** `requested`: an online booking waiting for the garage's OK (it still holds the slot). */
export type BookingEmailType = "confirmed" | "requested" | "rescheduled" | "cancelled";
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
  /** The signed manage link; defaults to the plain `/manage` page (reference + registration). */
  manageUrl?: string;
  /** The signed `/unsubscribe/<token>` link for this customer; the footer then offers "Stop reminders" (P4.9). */
  unsubscribeUrl?: string;
};

/** Customer email footer: the garage's privacy notice, and the customer's own opt-out link when there is one. */
export function customerFooterLinks(brand: EmailBrand, unsubscribeUrl?: string): FooterLink[] {
  return [
    { label: "Privacy notice", url: brandUrl(brand, "/privacy") },
    ...(unsubscribeUrl ? [{ label: "Stop reminders", url: unsubscribeUrl }] : []),
  ];
}

export type InternalBookingEmailInput = BookingEmailInput & {
  /** Empty when the customer gave no email address. */
  customerEmail: string;
  customerPhone?: string;
  notes?: string;
};

function copyFor(type: BookingEmailType, garageName: string) {
  const copy = {
    confirmed: { status: "BOOKING CONFIRMED", title: "You're booked in.", intro: `Your ${garageName} appointment is confirmed.`, tone: "success" as StatusTone },
    requested: { status: "BOOKING REQUESTED", title: "We've got your booking request.", intro: `${garageName} will check it and confirm your appointment shortly. The time is held for you.`, tone: "info" as StatusTone },
    rescheduled: { status: "BOOKING UPDATED", title: "Your appointment has been rescheduled.", intro: "The new appointment date and time are shown below.", tone: "warning" as StatusTone },
    cancelled: { status: "BOOKING CANCELLED", title: "Your appointment has been cancelled.", intro: "Here is a record of the cancelled appointment.", tone: "cancelled" as StatusTone },
  };
  return copy[type];
}

export function renderBookingEmail(input: BookingEmailInput): RenderedEmail {
  const { brand } = input;
  const footerLinks = customerFooterLinks(brand, input.unsubscribeUrl);
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
  const actionUrl = isCancelled ? brandUrl(brand, "/") : input.manageUrl ?? brandUrl(brand, "/manage");
  const actionLabel = isCancelled ? "Book another appointment" : "Manage booking";
  const item = copyFor(input.type, brand.name);
  const preheader = input.type === "confirmed"
    ? `Your ${brand.name} appointment is confirmed for ${input.date} at ${input.startTime}.`
    : input.type === "requested"
      ? `${brand.name} has your booking request for ${input.date} at ${input.startTime}.`
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
      footerLinks,
    }),
    text: [plainTextHeader(brand), "", item.status, "", `Hello ${input.customerName},`, "", item.intro, "", input.previousAppointment && input.type === "rescheduled" ? `Previous appointment: ${input.previousAppointment}\n` : "", detailsText(details), "", `${actionLabel}: ${actionUrl}`, !isCancelled && input.googleCalendarUrl ? `Add to Google Calendar: ${input.googleCalendarUrl}` : "", !isCancelled && input.calendarUrl ? `Add to Calendar: ${input.calendarUrl}` : "", plainTextFooter(brand, footerLinks)].filter((line) => line !== "").join("\n"),
  };
}

/** Staff alert for a booking event, sent to the garage's own address. */
export function renderInternalBookingEmail(input: InternalBookingEmailInput): RenderedEmail {
  const { brand } = input;
  const appointmentStatus = { confirmed: "NEW BOOKING", requested: "NEEDS YOUR OK", rescheduled: "BOOKING RESCHEDULED", cancelled: "BOOKING CANCELLED" }[input.type];
  const title = {
    confirmed: "A customer has made a booking.",
    requested: "A customer has asked for a booking. Accept it or offer another time.",
    rescheduled: "A customer booking has changed.",
    cancelled: "A customer booking has been cancelled.",
  }[input.type];
  const details = [
    { label: "Customer", value: input.customerName },
    { label: "Customer email", value: input.customerEmail || undefined },
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
      tone: input.type === "confirmed" ? "success" : input.type === "cancelled" ? "cancelled" : "warning",
      title,
      intro: `The booking is in your Pitline admin for ${brand.name}. The key details are included below.`,
      contentHtml: detailCard(details),
      cta: { label: "View bookings", url: bookingsUrl },
    }),
    text: [plainTextHeader(brand), "", appointmentStatus, "", title, "", detailsText(details), "", `View bookings: ${bookingsUrl}`, plainTextFooter(brand)].join("\n"),
  };
}
