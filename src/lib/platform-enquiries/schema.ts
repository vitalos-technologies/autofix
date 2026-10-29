import { z } from "zod";

// The contact form on the marketing site (`/contact` on the admin host). Shared by the form (labels,
// client-side checks) and POST /api/contact (the check that counts). Rows land in
// public.platform_enquiries (20261029003000_platform_enquiries.sql); the limits match its constraints.

export const PLATFORM_ENQUIRY_TOPICS = [
  { value: "general", label: "General question" },
  { value: "sales", label: "Sales or a demo" },
  { value: "support", label: "Support" },
  { value: "partnership", label: "Partnership" },
] as const;

export type PlatformEnquiryTopic = (typeof PLATFORM_ENQUIRY_TOPICS)[number]["value"];

const TOPIC_VALUES = PLATFORM_ENQUIRY_TOPICS.map((topic) => topic.value) as [PlatformEnquiryTopic, ...PlatformEnquiryTopic[]];

export function topicLabel(topic: string): string {
  return PLATFORM_ENQUIRY_TOPICS.find((entry) => entry.value === topic)?.label ?? "General question";
}

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 5000;

/** Control characters (tab and newline aside) never belong in a single-line field. */
const SINGLE_LINE = /^[^\p{Cc}]*$/u;
/** Digits, spaces, +, brackets and dashes, with at least 7 digits (UK or international). */
const PHONE = /^\+?[\d\s()-]{7,30}$/;

function optionalText(max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max, message)
    .regex(SINGLE_LINE, message)
    .optional()
    .transform((value) => (value ? value : undefined));
}

export const platformEnquirySchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(100, "Use up to 100 characters.").regex(SINGLE_LINE, "Enter your name."),
  email: z.string().trim().toLowerCase().max(254, "Enter a valid email address.").pipe(z.email("Enter a valid email address.")),
  phone: optionalText(30, "Enter a phone number, or leave it blank.").refine(
    (value) => value === undefined || (PHONE.test(value) && value.replace(/\D/g, "").length >= 7),
    "Enter a phone number, or leave it blank.",
  ),
  garageName: optionalText(120, "Use up to 120 characters."),
  topic: z.enum(TOPIC_VALUES, "Choose what your message is about."),
  message: z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim())
    .pipe(z.string().min(MESSAGE_MIN, `Write at least ${MESSAGE_MIN} characters.`).max(MESSAGE_MAX, `Use up to ${MESSAGE_MAX.toLocaleString("en-GB")} characters.`)),
});

export const platformEnquiryRequestSchema = platformEnquirySchema.extend({
  turnstileToken: z.string().trim().min(1, "Complete the security check.").max(4096),
});

export type PlatformEnquiryInput = z.output<typeof platformEnquirySchema>;
export type PlatformEnquiryRequest = z.output<typeof platformEnquiryRequestSchema>;
export type PlatformEnquiryField = keyof z.input<typeof platformEnquiryRequestSchema>;
export type PlatformEnquiryFieldErrors = Partial<Record<PlatformEnquiryField, string>>;

/** The first message for each field, for the form. */
export function fieldErrors(error: z.ZodError): PlatformEnquiryFieldErrors {
  const errors: PlatformEnquiryFieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in errors)) errors[field as PlatformEnquiryField] = issue.message;
  }
  return errors;
}
