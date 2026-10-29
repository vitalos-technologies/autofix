"use client";

import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { primaryButton } from "@/components/marketing/styles";
import { TurnstileField } from "@/components/forms/turnstile-field";
import { Notice, TextField, inputClass } from "@/components/onboarding/field";
import {
  fieldErrors,
  MESSAGE_MAX,
  PLATFORM_ENQUIRY_TOPICS,
  platformEnquirySchema,
  type PlatformEnquiryField,
  type PlatformEnquiryFieldErrors,
} from "@/lib/platform-enquiries/schema";
import { cn } from "@/lib/utils";

export type ContactFormCopy = {
  form: { heading: string; submit: string; sending: string; required: string };
  thanks: { heading: string; body: string; again: string; home: string };
};

type Values = { name: string; email: string; phone: string; garageName: string; topic: string; message: string };
const EMPTY: Values = { name: "", email: "", phone: "", garageName: "", topic: "", message: "" };

function Optional() {
  return <span className="font-normal text-grey-600"> (optional)</span>;
}

function FieldError({ id, children }: { id: string; children?: string }) {
  return children ? <p id={id} className="m-0 text-[13px] font-semibold text-[#b91c1c]">{children}</p> : null;
}

/**
 * The contact form (`/contact`). Checked here with the same schema the route uses, then posted as JSON
 * to /api/contact with the Turnstile token. On success the form gives way to a thank-you that takes focus.
 */
export function ContactForm({ copy }: { copy: ContactFormCopy }) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<PlatformEnquiryFieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [turnstile, setTurnstile] = useState("");
  const [turnstileKey, setTurnstileKey] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const onToken = useCallback((token: string) => setTurnstile(token), []);
  const formRef = useRef<HTMLFormElement>(null);
  const thanksRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!attempt) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-invalid], [data-form-message]")?.focus();
  }, [attempt]);

  useEffect(() => {
    if (sentTo) thanksRef.current?.focus();
  }, [sentTo]);

  function update(field: keyof Values, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    const checked = platformEnquirySchema.safeParse(values);
    const found: PlatformEnquiryFieldErrors = checked.success ? {} : fieldErrors(checked.error);
    if (!turnstile) found.turnstileToken = "Complete the security check.";
    if (!checked.success || found.turnstileToken) {
      setErrors(found);
      setAttempt((count) => count + 1);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, turnstileToken: turnstile }),
      });
      const result = (await response.json().catch(() => null)) as { success?: boolean; error?: { message?: string; fields?: PlatformEnquiryFieldErrors } } | null;
      if (response.ok && result?.success) {
        setSentTo(checked.data.email);
        setValues(EMPTY);
        return;
      }
      setErrors(result?.error?.fields ?? {});
      setMessage(result?.error?.message ?? "We couldn't send your message just now. Try again in a few minutes.");
    } catch {
      setMessage("We couldn't reach Autofix. Check your connection and try again.");
    } finally {
      setPending(false);
    }
    // A Turnstile token works once: get a fresh one for the next try.
    setTurnstile("");
    setTurnstileKey((key) => key + 1);
    setAttempt((count) => count + 1);
  }

  if (sentTo) {
    return (
      <div role="status" className="rounded-hero border border-grey-200 bg-white p-6 shadow-[0_20px_44px_-30px_rgba(7,17,39,0.35)] md:p-8" data-testid="contact-thanks">
        <span className="grid size-12 place-items-center rounded-full bg-success-bg text-success-ink" aria-hidden="true">
          <CircleCheck size={26} />
        </span>
        <h2 ref={thanksRef} tabIndex={-1} className="mt-5 font-display text-[34px] leading-[1.05] font-bold text-navy-950 outline-none md:text-[40px]">
          {copy.thanks.heading}
        </h2>
        <p className="mt-3 text-[16px] leading-[1.6] text-grey-700">
          {copy.thanks.body} <strong className="font-semibold break-all text-navy-950">{sentTo}</strong>.
        </p>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <Link href="/" className={primaryButton}>
            {copy.thanks.home} <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={() => {
              setSentTo(null);
              setTurnstile("");
              setTurnstileKey((key) => key + 1);
            }}
            className="inline-flex min-h-[54px] items-center justify-center rounded-control border border-grey-300 bg-white px-6 text-[16px] font-semibold text-navy-950 transition hover:border-blue-700 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            {copy.thanks.again}
          </button>
        </div>
      </div>
    );
  }

  const describe = (field: PlatformEnquiryField, hint?: string) => [hint, errors[field] ? `contact-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;
  const topicError = errors.topic;
  const messageLength = values.message.length;

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      aria-labelledby="contact-form-heading"
      className="flex flex-col gap-5 rounded-hero border border-grey-200 bg-white p-5 shadow-[0_20px_44px_-30px_rgba(7,17,39,0.35)] md:p-8"
      data-testid="contact-form"
    >
      <div>
        <h2 id="contact-form-heading" className="text-[24px] leading-tight font-bold text-navy-950">{copy.form.heading}</h2>
        <p className="mt-1 text-[14px] text-grey-600">{copy.form.required}</p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <TextField id="contact-name" name="name" label="Your name" autoComplete="name" required maxLength={100} value={values.name} onChange={(event) => update("name", event.target.value)} error={errors.name} />
        <TextField id="contact-email" name="email" type="email" label="Email" autoComplete="email" inputMode="email" required maxLength={254} value={values.email} onChange={(event) => update("email", event.target.value)} error={errors.email} />
        <TextField id="contact-phone" name="phone" type="tel" label={<>Phone<Optional /></>} autoComplete="tel" inputMode="tel" maxLength={30} value={values.phone} onChange={(event) => update("phone", event.target.value)} error={errors.phone} />
        <TextField id="contact-garage" name="garageName" label={<>Garage name<Optional /></>} autoComplete="organization" maxLength={120} value={values.garageName} onChange={(event) => update("garageName", event.target.value)} error={errors.garageName} />
      </div>

      <fieldset aria-describedby={topicError ? "contact-topic-error" : undefined} className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[14px] font-semibold text-navy-950">What is it about?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PLATFORM_ENQUIRY_TOPICS.map((topic, index) => (
            <label
              key={topic.value}
              className={cn(
                "flex min-h-12 cursor-pointer items-center gap-3 rounded-input border bg-white px-3.5 text-[16px] font-medium text-navy-950 transition hover:border-blue-700",
                "has-[:checked]:border-blue-700 has-[:checked]:bg-[#eef4fd] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue-700",
                topicError ? "border-[#b91c1c]" : "border-grey-300",
              )}
            >
              <input
                type="radio"
                name="topic"
                value={topic.value}
                checked={values.topic === topic.value}
                onChange={() => update("topic", topic.value)}
                data-invalid={topicError && index === 0 ? true : undefined}
                className="size-5 shrink-0 accent-blue-700 focus-visible:outline-none"
              />
              {topic.label}
            </label>
          ))}
        </div>
        <FieldError id="contact-topic-error">{topicError}</FieldError>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="contact-message" className="text-[14px] font-semibold text-navy-950">Message</label>
        <p id="contact-message-hint" className="m-0 text-[13px] leading-5 text-grey-600">Tell us what you need. Up to {MESSAGE_MAX.toLocaleString("en-GB")} characters.</p>
        <textarea
          id="contact-message"
          name="message"
          required
          rows={6}
          maxLength={MESSAGE_MAX}
          value={values.message}
          onChange={(event) => update("message", event.target.value)}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={describe("message", "contact-message-hint")}
          className={cn(inputClass, "min-h-[150px] py-3 leading-[1.5]")}
        />
        <FieldError id="contact-message-error">{errors.message}</FieldError>
        {messageLength > MESSAGE_MAX - 500 ? <p className="m-0 text-[13px] text-grey-600" aria-live="polite">{(MESSAGE_MAX - messageLength).toLocaleString("en-GB")} characters left</p> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <TurnstileField key={turnstileKey} onToken={onToken} />
        <FieldError id="contact-turnstileToken-error">{errors.turnstileToken}</FieldError>
      </div>

      {message ? (
        <div data-form-message tabIndex={-1} className="outline-none">
          <Notice tone="error" role="alert">{message}</Notice>
        </div>
      ) : null}

      <SubmitButton pending={pending}>{pending ? copy.form.sending : copy.form.submit}</SubmitButton>
    </form>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={cn(primaryButton, "w-full disabled:cursor-wait disabled:opacity-80 disabled:hover:translate-y-0 sm:w-fit")}>
      {children}
      {pending ? null : <ArrowRight size={18} aria-hidden="true" />}
    </button>
  );
}
