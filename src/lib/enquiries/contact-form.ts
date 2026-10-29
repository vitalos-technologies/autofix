import { z } from "zod";
import { toE164UK } from "@/lib/messaging/phone";
import { normalizeRegistration } from "@/lib/vehicle/registration-format";
import type { EnquiryRequestBody } from "./schema";

// The booking site's "Contact us" form (/contact on a garage host; Temitope, 29 Oct 2026). Pure and
// client-safe: the browser checks the fields with this schema, then posts `toEnquiryRequest()` to
// POST /api/enquiries, which checks everything again with `enquiryRequestSchema`. The garage is never
// in the body: the API takes it from the host. The registration only travels in that POST body.

export const CONTACT_PREFERENCES = ["phone", "whatsapp", "email"] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];

export const CONTACT_PREFERENCE_OPTIONS = [
  { value: "phone", label: "Phone call" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
] as const satisfies ReadonlyArray<{ value: ContactPreference; label: string }>;

export const CONTACT_MESSAGE_MIN = 10;
export const CONTACT_MESSAGE_MAX = 3000;

export type ContactFormValues = {
  name: string;
  phone: string;
  email: string;
  preferredContact: ContactPreference;
  message: string;
  /** Optional; as typed or as the plate input shows it (`AB12 CDE`). */
  registration: string;
};

export type ContactField = keyof ContactFormValues;
export type ContactFieldErrors = Partial<Record<ContactField, string>>;

const emailFormat = z.email();

export const contactFormSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your name.").max(100, "Use 100 characters or fewer for your name."),
    phone: z
      .string()
      .trim()
      .min(1, "Enter a phone number so the garage can reach you.")
      .max(30, "Enter a UK phone number, for example 07700 900123.")
      .refine((value) => toE164UK(value, { allowLandline: true }) !== null, "Enter a UK phone number, for example 07700 900123."),
    email: z
      .string()
      .trim()
      .max(254, "Enter an email address like name@example.com.")
      .refine((value) => value === "" || emailFormat.safeParse(value).success, "Enter an email address like name@example.com."),
    preferredContact: z.enum(CONTACT_PREFERENCES),
    message: z
      .string()
      .trim()
      .min(CONTACT_MESSAGE_MIN, `Tell the garage a little more (at least ${CONTACT_MESSAGE_MIN} characters).`)
      .max(CONTACT_MESSAGE_MAX, `Keep the message to ${CONTACT_MESSAGE_MAX} characters or fewer.`),
    registration: z
      .string()
      .transform(normalizeRegistration)
      .refine((value) => value === "" || /^[A-Z0-9]{2,8}$/.test(value), "Enter the registration, for example AB12 CDE, or leave it empty."),
  })
  .superRefine((value, ctx) => {
    if (value.preferredContact === "email" && !value.email) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Enter your email address, or choose another way to be contacted." });
    }
    if (value.preferredContact === "whatsapp" && value.phone && toE164UK(value.phone, { allowLandline: true }) !== null && toE164UK(value.phone) === null) {
      ctx.addIssue({ code: "custom", path: ["phone"], message: "WhatsApp needs a mobile number. Enter a mobile, or choose a phone call." });
    }
  });

export type ContactFormData = z.output<typeof contactFormSchema>;

/** Field errors for the form (the first message per field), or the checked values. */
export function checkContactForm(values: ContactFormValues): { ok: true; data: ContactFormData } | { ok: false; fieldErrors: ContactFieldErrors } {
  const parsed = contactFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: ContactFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as ContactField | undefined;
    if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
  }
  return { ok: false, fieldErrors };
}

/** The `POST /api/enquiries` body: a `general` enquiry. No garage id: the API uses the host's garage. */
export function toEnquiryRequest(data: ContactFormData, turnstileToken?: string): EnquiryRequestBody {
  return {
    type: "general",
    contact: {
      name: data.name,
      phone: data.phone,
      ...(data.email ? { email: data.email } : {}),
      preferredContact: data.preferredContact,
    },
    ...(data.registration ? { vehicle: { registration: data.registration } } : {}),
    description: data.message,
    ...(turnstileToken ? { turnstileToken } : {}),
  };
}

/** How the confirmation says the garage will reply. */
export function contactPreferenceLabel(preference: ContactPreference): string {
  return { phone: "phone", whatsapp: "WhatsApp", email: "email" }[preference];
}
