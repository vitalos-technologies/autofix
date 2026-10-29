import "server-only";

import type { EmailBrand } from "@/lib/email/brand";
import { detailCard, detailsText, emailLayout, plainTextFooter, plainTextHeader, textToHtml, type RenderedEmail } from "./components";

export type PlatformEnquiryEmailInput = {
  brand: EmailBrand;
  name: string;
  email: string;
  phone?: string | null;
  garageName?: string | null;
  topic: string;
  message: string;
  receivedAt: string;
  /** Where staff handle it: the super admin's Enquiries page. */
  url: string;
};

/** The alert Vitalos gets for each contact page enquiry (to PLATFORM_ENQUIRY_EMAIL). */
export function renderPlatformEnquiryNotification(input: PlatformEnquiryEmailInput): RenderedEmail {
  const { brand } = input;
  const details = [
    { label: "From", value: input.name },
    { label: "Email", value: input.email },
    { label: "Phone", value: input.phone },
    { label: "Garage", value: input.garageName },
    { label: "Topic", value: input.topic },
    { label: "Received", value: input.receivedAt },
  ];
  return {
    html: emailLayout({
      brand,
      preheader: `${input.topic} from ${input.name}.`,
      status: "NEW ENQUIRY",
      tone: "info",
      title: input.topic,
      intro: `${input.name} sent a message from the contact page. Reply to this email to answer them.`,
      contentHtml: `${detailCard(details)}<div style="margin-top:22px;"><p style="margin:0 0 8px;color:#586575;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">Message</p><div style="padding:16px 18px;border:1px solid #DCE6F2;border-radius:12px;color:#071127;font-size:15px;line-height:23px;overflow-wrap:anywhere;">${textToHtml(input.message)}</div></div>`,
      cta: { label: "Open in the super admin", url: input.url },
    }),
    text: [
      plainTextHeader(brand),
      "",
      "NEW ENQUIRY",
      "",
      input.topic,
      `${input.name} sent a message from the contact page. Reply to this email to answer them.`,
      "",
      detailsText(details),
      "",
      "Message:",
      input.message,
      "",
      `Open in the super admin: ${input.url}`,
      plainTextFooter(brand),
    ].join("\n"),
  };
}
