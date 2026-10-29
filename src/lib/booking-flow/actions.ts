"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  createBookingInputSchema,
  getBookingEngine,
  messageChannels,
  type BookingDraft,
  type CreateBookingInput,
  type CreateBookingResult,
  type CustomerChannel,
  type LocationMode,
  type OnlineService,
} from "@/lib/booking-engine";
import {
  clearBookingDraft,
  readBookingSession,
  writeBookingDraft,
  writeJustBooked,
  type BookingFlowMeta,
} from "@/lib/booking-engine/state";
import {
  inServiceArea,
  maskEmail,
  maskMobile,
  normaliseUkPostcode,
  NOTE_MAX_LENGTH,
  offersConsentCopy,
  postcodeDistrict,
  reminderConsentCopy,
  SYMPTOM_VALUES,
  whereLabel,
} from "@/lib/booking-flow/copy";
import { dateKeyInZone } from "@/lib/booking-flow/dates";
import type { DetailsFormState, ServiceFormState, TimeFormState, VehicleFormState } from "@/lib/booking-flow/forms";
import { clientIp, loadBookingServices, passHumanCheck } from "@/lib/booking-flow/server";
import { attributeCampaignBooking } from "@/lib/campaigns/open-link";
import { BOOKING_STEP_PATHS, firstIncompleteStep, serviceLocationModes } from "@/lib/booking-flow/steps";
import { draftVehicleFromLookup, vehicleName, type DraftVehicle } from "@/lib/booking-flow/vehicle";
import { attachBookingExtras, extrasSummary, getBookingExtrasOptions, readBookingExtras } from "@/lib/courtesy/booking-site";
import { toE164UK } from "@/lib/messaging/phone";
import { garageHasFeature } from "@/lib/plans/server";
import { notifyBooking } from "@/lib/booking-engine/notify";
import { writePayCookie } from "@/lib/payments/pay-session";
import { depositQuote, releaseExpiredDeposits, startDeposit } from "@/lib/payments/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { recordPlanBooking } from "@/lib/service-plans/server";
import { getGarage, type Garage } from "@/lib/tenancy/garage";
import { getConfiguredVehicleProvider } from "@/lib/vehicle/configured-provider";
import { withMotVisibility } from "@/lib/vehicle/mot";
import { VehicleLookupError } from "@/lib/vehicle/provider";
import { registrationSchema } from "@/lib/vehicle/registration";

// Server actions for the five booking steps (src/app/%5Fsite/[garageId]). The garage always comes
// from the request host, the draft from the sealed `af_booking` cookie. Redirects carry a step path
// and at most `?date=YYYY-MM-DD`: never the registration or any other customer detail. Nothing here
// logs form values.

const HUMAN_CHECK_MESSAGE = "Please complete the security check, then try again.";

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: FormDataEntryValue | null, max: number): string | undefined {
  const trimmed = text(value).replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function withKey(draft: BookingDraft): BookingDraft {
  return draft.idempotencyKey ? draft : { ...draft, idempotencyKey: randomUUID() };
}

function withoutVehicle(draft: BookingDraft): BookingDraft {
  const next = { ...draft };
  delete next.vehicle;
  // A reminder link (/r/{token}) is about one car: another car is an ordinary booking.
  delete next.reminderSendId;
  delete next.campaignSendId;
  return next;
}

/** The draft with this car. A different registration also forgets the reminder the draft came from. */
function withVehicle(draft: BookingDraft, vehicle: DraftVehicle): BookingDraft {
  const next = draft.vehicle?.registration === vehicle.registration ? { ...draft } : withoutVehicle(draft);
  return { ...next, vehicle };
}

async function servicesOrNull(garage: Garage): Promise<OnlineService[] | null> {
  try {
    return await loadBookingServices(garage);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------
// Step 1 · Vehicle

const LOOKUP_MESSAGES = {
  not_found: "We couldn't find that registration. Check it, or enter the car's details yourself.",
  invalid: "That doesn't look like a UK registration. Check it, or enter the car's details yourself.",
  rate_limited: "Too many lookups just now. Wait a minute and try again, or enter the car's details yourself.",
  unavailable: "We can't look cars up right now. Enter the car's details yourself and carry on.",
} as const;

/**
 * Find my car / Continue / Not your car? on step 1. Intents come from the submit button:
 * `find` looks the registration up, `reset` forgets the car, anything else continues.
 */
export async function vehicleStepAction(previous: VehicleFormState, formData: FormData): Promise<VehicleFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const { draft, meta } = await readBookingSession(garage.id);
  const intent = text(formData.get("intent"));

  if (intent === "reset") {
    await writeBookingDraft(withKey(withoutVehicle(draft)), meta);
    return { seq, status: "idle", vehicle: null };
  }

  const parsed = registrationSchema.safeParse(text(formData.get("registration")));
  if (!parsed.success) {
    return { seq, status: "error", vehicle: null, fieldErrors: { registration: "Enter the car's registration, for example AB12 CDE." } };
  }
  const registration = parsed.data;

  if (text(formData.get("mode")) === "manual") {
    const make = clean(formData.get("make"), 80);
    const model = clean(formData.get("model"), 120);
    if (!make || !model) {
      return {
        seq,
        status: "error",
        vehicle: null,
        suggestManual: true,
        fieldErrors: {
          ...(make ? {} : { make: "Enter the make, for example Ford." }),
          ...(model ? {} : { model: "Enter the model, for example Focus." }),
        },
      };
    }
    const vehicle: DraftVehicle = { registration, make, model, manual: true };
    await writeBookingDraft(withKey(withVehicle(draft, vehicle)), meta);
    redirect(BOOKING_STEP_PATHS.service);
  }

  if (intent !== "find" && draft.vehicle && !draft.vehicle.manual && draft.vehicle.registration === registration) {
    redirect(BOOKING_STEP_PATHS.service);
  }

  const ip = await clientIp();
  // Same buckets as POST /api/vehicle/lookup; a little more room per IP for shared mobile networks.
  if (!(await consumeRateLimit(ip, "vehicle_lookup", 20, 60)) || !(await consumeRateLimit(garage.id, "vehicle_lookup_garage", 600, 600))) {
    return { seq, status: "error", vehicle: null, suggestManual: true, message: LOOKUP_MESSAGES.rate_limited };
  }
  const checkedMeta = await passHumanCheck(formData.get("turnstileToken"), meta, ip);
  if (!checkedMeta) return { seq, status: "error", vehicle: null, message: HUMAN_CHECK_MESSAGE };

  const provider = getConfiguredVehicleProvider();
  if (!provider) return { seq, status: "error", vehicle: null, suggestManual: true, message: LOOKUP_MESSAGES.unavailable };

  let vehicle: DraftVehicle;
  try {
    // MOT facts reach the customer only when this garage shows MOT.
    const details = withMotVisibility(await provider.lookup(registration), garage.motEnabled);
    vehicle = draftVehicleFromLookup(details, registration, garage.motEnabled);
  } catch (error) {
    const code = error instanceof VehicleLookupError ? error.code : "unavailable";
    return { seq, status: "error", vehicle: null, suggestManual: true, message: LOOKUP_MESSAGES[code] };
  }
  if (!vehicle.make) return { seq, status: "error", vehicle: null, suggestManual: true, message: LOOKUP_MESSAGES.not_found };

  await writeBookingDraft(withKey(withVehicle(draft, vehicle)), checkedMeta);
  return { seq, status: "found", vehicle };
}

// --------------------------------------------------------------------------------------------
// Step 2 · Service

export async function serviceStepAction(previous: ServiceFormState, formData: FormData): Promise<ServiceFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const { draft, meta } = await readBookingSession(garage.id);
  if (!draft.vehicle) redirect(BOOKING_STEP_PATHS.vehicle);

  const services = await servicesOrNull(garage);
  if (!services) return { seq, message: "We can't load the services right now. Please try again in a moment." };
  const service = services.find((item) => item.id === text(formData.get("serviceId")));
  if (!service) return { seq, fieldErrors: { serviceId: "Choose what the car needs." } };

  const modes = serviceLocationModes(service);
  const requested = text(formData.get("locationMode")) as LocationMode;
  const locationMode: LocationMode = modes.includes(requested) ? requested : (modes[0] ?? "workshop");

  let postcode: string | undefined;
  if (locationMode === "mobile") {
    const normalised = normaliseUkPostcode(text(formData.get("postcode")));
    if (!normalised) return { seq, fieldErrors: { postcode: "Enter the postcode where the car will be, for example DN1 2AB." } };
    if (!inServiceArea(normalised, garage.serviceArea)) {
      return { seq, fieldErrors: { postcode: `Sorry, our mobile visits don't cover ${postcodeDistrict(normalised)}. Choose the workshop, or call us.` } };
    }
    postcode = normalised;
  }

  const symptoms = [...new Set(formData.getAll("symptom").map((value) => text(value)))].filter((value) => SYMPTOM_VALUES.includes(value)).slice(0, 10);
  const note = clean(formData.get("note"), NOTE_MAX_LENGTH);
  const changed = draft.serviceId !== service.id || draft.locationMode !== locationMode || draft.postcode !== postcode;

  const next: BookingDraft = withKey({ ...draft, serviceId: service.id, locationMode, postcode, symptoms, note });
  if (changed) delete next.startsAt;
  await writeBookingDraft(next, changed ? { ...meta, slotTaken: undefined } : meta);
  redirect(BOOKING_STEP_PATHS.time);
}

// --------------------------------------------------------------------------------------------
// Step 3 · Time

export async function timeStepAction(previous: TimeFormState, formData: FormData): Promise<TimeFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const { draft, meta } = await readBookingSession(garage.id);
  const services = await servicesOrNull(garage);
  if (!services) return { seq, message: "We can't check the diary right now. Please try again in a moment." };
  const missing = firstIncompleteStep(draft, services);
  if (missing === "vehicle" || missing === "service") redirect(BOOKING_STEP_PATHS[missing]);

  const startsAt = text(formData.get("startsAt"));
  const instant = Date.parse(startsAt);
  if (!startsAt || Number.isNaN(instant)) return { seq, message: "Choose a time." };

  const date = dateKeyInZone(new Date(instant), garage.timezone);
  let slot;
  try {
    const slots = await getBookingEngine().getAvailableSlots({
      garageId: garage.id,
      serviceId: draft.serviceId!,
      from: date,
      to: date,
      locationMode: draft.locationMode,
    });
    slot = slots.find((candidate) => Date.parse(candidate.startsAt) === instant);
  } catch {
    return { seq, message: "We can't check the diary right now. Please try again in a moment." };
  }
  if (!slot || slot.freeCount <= 0) {
    refresh();
    return { seq, message: "Sorry, that time has just gone. Choose another time." };
  }

  await writeBookingDraft(withKey({ ...draft, startsAt: slot.startsAt }), { ...meta, slotTaken: undefined });
  redirect(BOOKING_STEP_PATHS.details);
}

// --------------------------------------------------------------------------------------------
// Step 4 · Details → create the booking

const emailSchema = z.email().max(254);

const ENGINE_MESSAGES: Partial<Record<Exclude<CreateBookingResult, { ok: true }>["code"], string>> = {
  SERVICE_UNAVAILABLE: "That service can't be booked online right now. Choose another service, or call us.",
  OUTSIDE_SERVICE_AREA: "Sorry, our mobile visits don't cover that postcode. Choose the workshop, or call us.",
  RATE_LIMITED: "Too many attempts just now. Wait a minute and try again.",
  TURNSTILE_FAILED: HUMAN_CHECK_MESSAGE,
};
const GENERIC_MESSAGE = "We couldn't confirm your booking just now. Please try again, or call us.";

export async function confirmBookingAction(previous: DetailsFormState, formData: FormData): Promise<DetailsFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const { draft: storedDraft, meta } = await readBookingSession(garage.id);
  const services = await servicesOrNull(garage);
  if (!services) return { seq, message: GENERIC_MESSAGE };
  const missing = firstIncompleteStep(storedDraft, services);
  if (missing) redirect(BOOKING_STEP_PATHS[missing]);

  // Validate what the customer typed.
  const fieldErrors: NonNullable<DetailsFormState["fieldErrors"]> = {};
  const name = clean(formData.get("name"), 120);
  if (!name || name.length < 2) fieldErrors.name = "Enter your full name.";
  const phone = toE164UK(text(formData.get("phone")));
  if (!phone) fieldErrors.phone = "Enter a UK mobile number, for example 07700 900123.";
  const rawEmail = text(formData.get("email")).toLowerCase();
  const email = rawEmail && emailSchema.safeParse(rawEmail).success ? rawEmail : undefined;
  if (rawEmail && !email) fieldErrors.email = "Enter an email address like name@example.com.";
  const requestedChannel = text(formData.get("channel"));
  const channel: CustomerChannel = (messageChannels as readonly string[]).includes(requestedChannel) ? (requestedChannel as CustomerChannel) : "sms";
  if (channel === "email" && !rawEmail) fieldErrors.email = "Add your email address to get updates by email.";
  // P5.8: courtesy car request and collection and delivery, only when this garage offers them now.
  const offeredExtras = await getBookingExtrasOptions(garage, {
    serviceId: storedDraft.serviceId!,
    startsAt: storedDraft.startsAt!,
    durationMin: services.find((item) => item.id === storedDraft.serviceId)?.durationMin ?? 60,
    locationMode: storedDraft.locationMode ?? "workshop",
  });
  const extras = readBookingExtras(formData, offeredExtras, garage.serviceArea, garageHasFeature(garage, "courtesy_cars"));
  if (!extras.ok) Object.assign(fieldErrors, extras.fieldErrors);
  if (Object.keys(fieldErrors).length > 0 || !extras.ok) return { seq, fieldErrors };
  // Consent only when a box was ticked; the wording stored is the wording this garage shows.
  // Reminders and offers are separate boxes and separate consents.
  const reminderConsent = formData.get("reminderConsent") === "yes";
  const offersConsent = formData.get("offersConsent") === "yes";

  const ip = await clientIp();
  if (!(await consumeRateLimit(ip, "booking_create", 20, 600)) || !(await consumeRateLimit(garage.id, "booking_create_garage", 300, 3600))) {
    return { seq, message: ENGINE_MESSAGES.RATE_LIMITED };
  }
  const checkedMeta = await passHumanCheck(formData.get("turnstileToken"), meta, ip);
  if (!checkedMeta) return { seq, message: HUMAN_CHECK_MESSAGE };

  // The key must survive a retry, so a new one is saved before the engine sees it.
  const draft = withKey(storedDraft);
  if (draft !== storedDraft || checkedMeta !== meta) await writeBookingDraft(draft, checkedMeta);

  const service = services.find((item) => item.id === draft.serviceId)!;
  const vehicle = draft.vehicle!;
  const locationMode = draft.locationMode!;
  // P5.4: a Pro garage with payments connected may want a deposit for this service. The booking is
  // still made by create_booking() below (it holds the slot); the deposit is added after it.
  await releaseExpiredDeposits(garage.id);
  const deposit = await depositQuote(garage, service.id);
  const input: CreateBookingInput = {
    serviceId: service.id,
    startsAt: draft.startsAt!,
    locationMode,
    ...(locationMode === "mobile" && draft.postcode ? { postcode: draft.postcode } : {}),
    ...(locationMode === "mobile" && draft.address ? { address: draft.address } : {}),
    symptoms: draft.symptoms ?? [],
    ...(draft.note ? { notes: draft.note } : {}),
    customer: {
      name: name!,
      phone: phone!,
      ...(email ? { email } : {}),
      channel,
      reminderConsent,
      ...(reminderConsent ? { consentText: reminderConsentCopy(garage.motEnabled) } : {}),
      offersConsent,
      ...(offersConsent ? { offersConsentText: offersConsentCopy(garage.name) } : {}),
    },
    vehicle: {
      registration: vehicle.registration,
      ...(vehicle.make ? { make: vehicle.make } : {}),
      ...(vehicle.model ? { model: vehicle.model } : {}),
      ...(vehicle.colour ? { colour: vehicle.colour } : {}),
      ...(vehicle.fuel ? { fuel: vehicle.fuel } : {}),
      ...(vehicle.year ? { year: vehicle.year } : {}),
      ...(vehicle.engine ? { engine: vehicle.engine } : {}),
      ...(garage.motEnabled && vehicle.motExpiry ? { motExpiry: vehicle.motExpiry } : {}),
      ...(typeof vehicle.lastMileage === "number" ? { lastMileage: vehicle.lastMileage } : {}),
    },
    idempotencyKey: draft.idempotencyKey!,
    source: "online",
    ...(draft.reminderSendId ? { reminderSendId: draft.reminderSendId } : {}),
  };
  const parsed = createBookingInputSchema.safeParse(input);
  if (!parsed.success) return { seq, message: GENERIC_MESSAGE };

  let result: CreateBookingResult;
  try {
    result = await getBookingEngine().createBooking(garage.id, parsed.data, deposit ? { deferCreatedNotice: true } : undefined);
  } catch {
    return { seq, message: GENERIC_MESSAGE };
  }

  if (result.ok) {
    const booking = result.booking;
    // P5.5: a booking from a campaign link counts for the campaign (same customer and car; checked in SQL).
    if (draft.campaignSendId) await attributeCampaignBooking(garage.id, draft.campaignSendId, booking.id);
    // Attached after the booking exists, by their own functions: they can never fail the booking.
    const attached = await attachBookingExtras(garage, { id: booking.id, reference: booking.reference }, extras.value);
    const extraLines = extrasSummary(attached);
    // P5.11: a car on a service plan uses its included service (its own function, after create_booking()).
    await recordPlanBooking(garage.id, booking.id);
    let payToken: string | null = null;
    if (deposit) {
      const started = await startDeposit(garage, booking.id, deposit.provider);
      if (started?.status === "pending") payToken = started.token;
      // No deposit after all (or already paid): the confirmation that was held back goes now.
      else if (!started && !result.replayed) await notifyBooking({ type: "created", garageId: garage.id, bookingId: booking.id });
    }
    await clearBookingDraft();
    await writeJustBooked(garage.id, {
      reference: booking.reference,
      status: booking.status,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      serviceName: service.name,
      locationMode,
      where: whereLabel(locationMode, draft.postcode, garage.address.postcode),
      vehicleName: vehicleName(vehicle),
      registration: vehicle.registration,
      channel,
      contactHint: channel === "email" && email ? maskEmail(email) : maskMobile(phone!),
      ...(extraLines.length > 0 ? { extras: extraLines } : {}),
    });
    if (payToken) {
      await writePayCookie(payToken);
      redirect("/pay");
    }
    redirect(`/confirmed/${encodeURIComponent(booking.reference)}`);
  }

  if (result.code === "SLOT_UNAVAILABLE") {
    const alternatives = (result.alternatives ?? []).filter((slot) => slot.freeCount > 0).slice(0, 3);
    const next = { ...draft };
    delete next.startsAt;
    const slotTaken: BookingFlowMeta["slotTaken"] = { startsAt: draft.startsAt!, alternatives };
    await writeBookingDraft(next, { ...checkedMeta, slotTaken });
    const date = dateKeyInZone(alternatives[0]?.startsAt ?? draft.startsAt!, garage.timezone);
    redirect(`${BOOKING_STEP_PATHS.time}?date=${date}`);
  }

  if (result.code === "SERVICE_UNAVAILABLE" || result.code === "OUTSIDE_SERVICE_AREA") {
    return { seq, message: ENGINE_MESSAGES[result.code], editHref: BOOKING_STEP_PATHS.service, editLabel: "Change the service" };
  }
  return { seq, message: ENGINE_MESSAGES[result.code] ?? GENERIC_MESSAGE };
}
