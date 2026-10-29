"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Phone } from "lucide-react";
import { PlateInput, SegmentedControl, StickyActionBar } from "@/components/book";
import { focusRing } from "@/components/book/styles";
import { TurnstileField } from "@/components/forms/turnstile-field";
import {
  CONTACT_MESSAGE_MAX,
  CONTACT_PREFERENCE_OPTIONS,
  checkContactForm,
  contactPreferenceLabel,
  toEnquiryRequest,
  type ContactField,
  type ContactFieldErrors,
  type ContactPreference,
} from "@/lib/enquiries/contact-form";
import { cn } from "@/lib/utils";
import { FormAlert } from "./booking-screen";
import { managePrimaryAction, manageTextLink } from "./manage-ui";
import { TextField } from "./text-field";

const FORM_ID = "contact-form";

const FIELD_IDS: Record<ContactField, string> = {
  name: "contact-name",
  phone: "contact-phone",
  email: "contact-email",
  preferredContact: "contact-preferred",
  message: "contact-message",
  registration: "contact-registration",
};
const FIELD_ORDER: ContactField[] = ["name", "phone", "email", "message", "registration"];

type ContactFormProps = {
  garageName: string;
  /** E.164; offered under the Send button and in the confirmation. */
  phone: string | null;
  /** Formatted for display (`+44 1302 …`), from the server. */
  phoneDisplay: string;
  /** The car from this browser's booking draft, if any (never from the address). */
  initialRegistration?: string;
  /** Show Turnstile (configured for this deployment). */
  humanCheck: boolean;
};

function sendProblem(status: number, garageName: string) {
  if (status === 429) return `Too many messages from here. Please wait a few minutes, or call ${garageName}.`;
  if (status === 403) return "The security check didn't work. Refresh the page and try again.";
  if (status === 400) return "Some details need checking. Check the form and try again.";
  return `We couldn't send your message. Please try again in a minute, or call ${garageName}.`;
}

/**
 * "Contact us" on a garage's booking site: name, phone, email, how to reply, message and an optional
 * registration. Checked here, then posted as JSON to POST /api/enquiries (never a GET form: the
 * registration stays out of every address), which puts it in the garage's Enquiries and emails them.
 */
export function ContactForm({ garageName, phone, phoneDisplay, initialRegistration = "", humanCheck }: ContactFormProps) {
  const [name, setName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [preferredContact, setPreferredContact] = useState<ContactPreference>("phone");
  const [message, setMessage] = useState("");
  const [registration, setRegistration] = useState(initialRegistration);
  const [token, setToken] = useState("");
  const [fieldErrors, setFieldErrors] = useState<ContactFieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentBy, setSentBy] = useState<ContactPreference | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sentHeading = useRef<HTMLHeadingElement>(null);

  // After a failed check, move focus to the first field to fix.
  useEffect(() => {
    if (attempt === 0) return;
    const first = FIELD_ORDER.find((field) => fieldErrors[field]);
    if (first) document.getElementById(FIELD_IDS[first])?.focus();
  }, [attempt, fieldErrors]);

  useEffect(() => {
    if (sentBy) sentHeading.current?.focus();
  }, [sentBy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setProblem(null);
    const checked = checkContactForm({ name, phone: phoneNumber, email, preferredContact, message, registration });
    if (!checked.ok) {
      setFieldErrors(checked.fieldErrors);
      setAttempt((value) => value + 1);
      return;
    }
    setFieldErrors({});
    if (humanCheck && !token) {
      setProblem("Please complete the security check above, then send your message.");
      return;
    }
    setSending(true);
    try {
      const response = await fetch("/api/enquiries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toEnquiryRequest(checked.data, token || undefined)),
        cache: "no-store",
      });
      if (response.status === 201) {
        setSentBy(checked.data.preferredContact);
        return;
      }
      setProblem(sendProblem(response.status, garageName));
    } catch {
      setProblem(sendProblem(0, garageName));
    } finally {
      setSending(false);
    }
  }

  const callHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : null;

  if (sentBy) {
    return (
      <div className="flex flex-col items-center gap-5 px-6 pt-9 pb-10 text-center">
        <span aria-hidden="true" className="flex size-[72px] items-center justify-center rounded-full bg-success text-white outline-[8px] outline-[rgba(22,163,74,0.18)] outline-solid">
          <Check size={34} strokeWidth={3} />
        </span>
        <div className="flex flex-col gap-2" role="status">
          <h1 ref={sentHeading} tabIndex={-1} className="m-0 font-display text-[38px] leading-[0.98] font-extrabold text-navy-950 outline-none">
            Message sent
          </h1>
          <p className="m-0 text-[15px] leading-normal text-grey-600">
            {garageName} has your message and will get back to you by {contactPreferenceLabel(sentBy)}.
          </p>
        </div>
        <Link href="/" className={managePrimaryAction}>
          Book a car in
        </Link>
        {callHref ? (
          <p className="m-0 text-[14px] text-grey-600">
            Urgent?{" "}
            <a href={callHref} className={manageTextLink}>
              Call {phoneDisplay}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  const messageError = fieldErrors.message;
  return (
    <>
      <form id={FORM_ID} method="post" noValidate onSubmit={submit} className="flex flex-col gap-4 px-5 pt-5 pb-6" aria-describedby="contact-intro">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Contact us</h1>
          <p id="contact-intro" className="m-0 text-[15px] leading-normal text-grey-600">
            Ask {garageName} a question or tell them what your car needs. They&apos;ll get back to you the way you choose.
          </p>
        </div>

        <TextField
          id={FIELD_IDS.name}
          label="Full name"
          autoComplete="name"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldErrors.name}
        />
        <TextField
          id={FIELD_IDS.phone}
          label="Phone number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="07700 900000"
          hint={preferredContact === "whatsapp" ? "A mobile, for WhatsApp." : undefined}
          maxLength={30}
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value)}
          error={fieldErrors.phone}
        />
        <TextField
          id={FIELD_IDS.email}
          label="Email"
          labelNote={preferredContact === "email" ? "(for the reply)" : "(optional)"}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.email}
        />

        <SegmentedControl
          label="How should they get back to you?"
          variant="outline"
          options={CONTACT_PREFERENCE_OPTIONS}
          value={preferredContact}
          onChange={setPreferredContact}
        />

        <div className="flex flex-col gap-1.5 font-sans leading-[normal]">
          <label htmlFor={FIELD_IDS.message} className="text-[14px] font-semibold text-grey-800">
            Your message
          </label>
          <textarea
            id={FIELD_IDS.message}
            rows={5}
            maxLength={CONTACT_MESSAGE_MAX}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={messageError ? true : undefined}
            aria-describedby={messageError ? `${FIELD_IDS.message}-error` : `${FIELD_IDS.message}-hint`}
            className={cn(
              "min-h-32 w-full resize-y rounded-input border bg-white px-3.5 py-3 text-[16px] leading-normal text-navy-950 placeholder:text-[#6a7686]",
              "focus:ring-1 focus:outline-none focus-visible:outline-none",
              messageError ? "border-danger ring-1 ring-danger focus:ring-2 focus:ring-danger" : "border-grey-300 focus:border-accent focus:ring-accent",
            )}
          />
          {messageError ? (
            <p id={`${FIELD_IDS.message}-error`} className="m-0 text-[13px] font-semibold text-[#b91c1c]">
              {messageError}
            </p>
          ) : (
            <p id={`${FIELD_IDS.message}-hint`} className="m-0 text-[13px] text-grey-600">
              For example, what the car is doing or what you&apos;d like to know.
            </p>
          )}
        </div>

        <PlateInput
          id={FIELD_IDS.registration}
          label="Registration (optional)"
          hint="Only if it's about a car. It's never put in a link."
          placeholder="AB12 CDE"
          value={registration}
          onChange={setRegistration}
          error={fieldErrors.registration}
        />

        {humanCheck ? <TurnstileField onToken={setToken} /> : null}

        {problem ? <FormAlert>{problem}</FormAlert> : null}

        <p className="m-0 text-[13px] leading-[1.45] text-grey-600">
          Your message goes to {garageName}.{" "}
          <Link href="/privacy" className={cn("text-grey-700 underline underline-offset-2 hover:text-navy-950", focusRing)}>
            How we use your details
          </Link>
        </p>

        {callHref ? (
          <p className="m-0 flex flex-wrap items-center gap-x-1 text-[14px] text-grey-600">
            Prefer to talk?
            <a href={callHref} className={manageTextLink}>
              <Phone size={16} strokeWidth={2} aria-hidden="true" className="mr-1.5" />
              Call {phoneDisplay}
            </a>
          </p>
        ) : null}
      </form>
      <StickyActionBar type="submit" form={FORM_ID} label={sending ? "Sending" : "Send message"} showArrow={false} busy={sending} />
    </>
  );
}
