import "server-only";

import type { EmailBrand } from "@/lib/email/brand";
import { adminUrl } from "@/lib/tenancy/urls";
import { detailCard, detailsText, emailLayout, plainTextFooter, plainTextHeader, textToHtml, type RenderedEmail } from "./components";

export type EnquiryTemplateInput = {
  brand: EmailBrand;
  enquiryId: string;
  type: string;
  customerName: string;
  customerEmail?: string;
  phone: string;
  preferredContact: string;
  service?: string;
  vehicle?: string;
  location?: string;
  description: string;
};

function typeLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function renderEnquiryReceived(input: EnquiryTemplateInput): RenderedEmail {
  const { brand } = input;
  const details = [
    { label: "Request reference", value: input.enquiryId },
    { label: "Service", value: input.service || typeLabel(input.type) },
    { label: "Vehicle", value: input.vehicle },
    { label: "Preferred contact", value: typeLabel(input.preferredContact) },
  ];
  const url = brand.baseUrl;
  return {
    html: emailLayout({
      brand,
      preheader: `We've received your ${brand.name} request and will review it shortly.`,
      status: "REQUEST RECEIVED",
      tone: "info",
      title: `Thanks, ${input.customerName}.`,
      intro: "We've received your request. Our team will review the details and respond using your preferred contact method.",
      contentHtml: detailCard(details),
      cta: { label: `Visit ${brand.name}`, url },
    }),
    text: [plainTextHeader(brand), "", "REQUEST RECEIVED", "", `Hello ${input.customerName},`, "", "We've received your request. Our team will review the details and respond using your preferred contact method.", "", detailsText(details), "", `Visit ${brand.name}: ${url}`, plainTextFooter(brand)].join("\n"),
  };
}

/** Staff alert for a new enquiry, sent to the garage's own address. */
export function renderBusinessEnquiryNotification(input: EnquiryTemplateInput): RenderedEmail {
  const { brand } = input;
  const details = [
    { label: "Customer", value: input.customerName },
    { label: "Phone", value: input.phone },
    { label: "Email", value: input.customerEmail },
    { label: "Preferred contact", value: typeLabel(input.preferredContact) },
    { label: "Vehicle", value: input.vehicle },
    { label: "Location", value: input.location },
  ];
  const url = adminUrl(`/app/enquiries/${input.enquiryId}`);
  return {
    html: emailLayout({
      brand,
      preheader: `${typeLabel(input.type)} enquiry from ${input.customerName}.`,
      status: "NEW ENQUIRY",
      tone: "info",
      title: typeLabel(input.type),
      intro: `A new customer request for ${brand.name} is ready to review.`,
      contentHtml: `${detailCard(details)}<div style="margin-top:22px;"><p style="margin:0 0 8px;color:#475569;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">Problem</p><div style="padding:16px 18px;border:1px solid #E2E8F0;border-radius:12px;color:#0f2747;font-size:15px;line-height:23px;overflow-wrap:anywhere;">${textToHtml(input.description)}</div></div>`,
      cta: { label: "View enquiry", url },
    }),
    text: [plainTextHeader(brand), "", "NEW ENQUIRY", "", typeLabel(input.type), "", detailsText(details), "", "Problem:", input.description, "", `View enquiry: ${url}`, plainTextFooter(brand)].join("\n"),
  };
}

export function renderEnquiryReply(input: { brand: EmailBrand; customerName: string; body: string }): RenderedEmail {
  const { brand } = input;
  return {
    html: emailLayout({
      brand,
      preheader: `A reply from ${brand.name} for ${input.customerName}.`,
      status: brand.name.toUpperCase(),
      tone: "info",
      title: `Hello ${input.customerName},`,
      contentHtml: `<div style="color:#0f2747;font-size:16px;line-height:25px;overflow-wrap:anywhere;">${textToHtml(input.body)}</div><div style="margin:26px 0 18px;border-top:1px solid #E2E8F0;"></div><p style="margin:0;color:#475569;font-size:14px;line-height:22px;">Reply directly to this email to continue the conversation.</p>`,
      compact: true,
    }),
    text: [`Hello ${input.customerName},`, "", input.body, "", "Reply directly to this email to continue the conversation.", plainTextFooter(brand)].join("\n"),
  };
}
