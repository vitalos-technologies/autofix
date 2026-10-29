import { z } from "zod";
import { toE164UK } from "@/lib/messaging/phone";
import { normalizeRegistration } from "@/lib/vehicle/registration-format";
import { enquiryTypes } from "@/types/domain";

const vehicleSchema = z.object({
  // Accepts "ab12 cde" as typed; stored upper case without spaces (as vehicles.registration).
  registration: z.string().transform(normalizeRegistration).pipe(z.string().min(2).max(8).regex(/^[A-Z0-9]+$/)),
  make: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  derivative: z.string().max(120).optional(),
  year: z.number().int().min(1885).max(new Date().getFullYear() + 1).optional(),
  colour: z.string().max(40).optional(),
  fuelType: z.string().max(40).optional(),
  transmission: z.string().max(40).optional(),
  engineCapacityCc: z.number().int().positive().max(20000).optional(),
  bodyType: z.string().max(60).optional(),
});

/** An empty optional text field counts as not given. */
const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

/**
 * `POST /api/enquiries` on a garage host: the booking site's contact form (type `general`) and SOB's
 * enquiry types. The garage is the request host's, never a body field (unknown keys are dropped).
 */
export const enquiryRequestSchema = z
  .object({
    type: z.enum(enquiryTypes),
    contact: z.object({
      name: z.string().trim().min(2).max(100),
      email: z.preprocess(blankToUndefined, z.email().max(254).optional()),
      // Stored as E.164 (customers.phone); one customer per phone per garage.
      phone: z.string().trim().min(7).max(30).refine((value) => toE164UK(value, { allowLandline: true }) !== null, "Enter a UK phone number"),
      preferredContact: z.enum(["phone", "whatsapp", "email"]),
    }),
    vehicle: vehicleSchema.optional(),
    serviceSlug: z.string().max(100).regex(/^[a-z0-9-]+$/).optional(),
    description: z.string().trim().min(10).max(3000),
    locationPostcode: z.string().trim().max(12).optional(),
    driveable: z.boolean().optional(),
    // Checked only when Turnstile is configured (both keys), as on the booking steps (DECISIONS A40).
    turnstileToken: z.string().trim().min(1).max(4096).optional(),
  })
  .refine((value) => value.contact.preferredContact !== "email" || Boolean(value.contact.email), {
    path: ["contact", "email"],
    message: "Give an email address to be contacted by email",
  });

export type EnquiryRequest = z.infer<typeof enquiryRequestSchema>;
/** What a client posts (before the schema trims, normalises and drops unknown keys). */
export type EnquiryRequestBody = z.input<typeof enquiryRequestSchema>;

export const attachmentRequestSchema = z.object({
  name: z.string().min(1).max(180),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size: z.number().int().positive().max(8 * 1024 * 1024),
});
