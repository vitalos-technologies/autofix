# Consent and messaging wording (draft v0.2)

Draft for solicitor review; not legal advice. Covers PECR (marketing texts and calls) and UK GDPR transparency.

## Book 4 (details step)

Reminder checkbox, unticked by default:

> Remind me when the MOT and service are due. You can stop these any time.

When the garage does not offer MOTs (`garages.mot_enabled` off):

> Remind me when the service is due. You can stop these any time.

Under the confirm button:

> Nothing to pay now. [How we use your details] (links to the privacy notice)

Store: `reminder_consent = true`, `consent_at`, `consent_source = 'booking'`, and the exact wording shown (`consent_text`, which also identifies the wording version).

## Existing customers (soft opt-in route)

Only for customers whose details the garage collected during a booking or sale of a similar service, and who were given a chance to opt out then. Every message must offer an opt-out. Store `consent_source = 'soft_opt_in'` with the date of the original transaction.

Import declaration the garage must tick before reminders are scheduled for imported customers:

> I confirm these customers gave their details to [Garage name] when buying or booking a service, were told they could opt out of reminders, and have not opted out, or have given consent to receive reminders.

## SMS templates (default; garage may edit within the rules)

MOT reminder:

> Hi {first_name}, the MOT on your {vehicle} ({reg}) is due on {due_date}. Book a time: {link}
> {garage}. Reply STOP to opt out.

Service reminder:

> Hi {first_name}, your {vehicle} ({reg}) is due a service. Book a time: {link}
> {garage}. Reply STOP to opt out.

Missed-call text-back (a reply to the caller's enquiry, not marketing):

> Sorry we missed your call. Book online in about a minute: {link} or we'll call you back soon. {garage}

Booking confirmation (service message):

> {garage}: you're booked in for {service} on {date} at {time}. Ref {reference}. Change or cancel: {manage_link}

Rules enforced in code: STOP, UNSUBSCRIBE or END in a reply opts the number out from that garage immediately; reminders only 09:00–19:00 Monday to Saturday; the garage's name appears in every message; the editor blocks removing the opt-out line from reminder templates.

## Unsubscribe page (`/unsubscribe/{token}`, and `/unsubscribe` without a link)

Every reminder email, and every text sent from an alphanumeric sender (which cannot receive STOP), carries a signed link to this page. The link alone opts the customer out of reminders from that garage straight away.

Link line in emails and alphanumeric texts:

> Stop reminders: {unsubscribe_link}

After following the link:

> You won't get any more reminders from [Garage name]. You'll still get messages about bookings you make. Changed your mind? [Turn reminders back on]

After "Turn reminders back on" (records consent with this wording):

> Reminders are back on. [Garage name] will send you reminders again. You can stop them any time.

Without a link, the page asks for the mobile number:

> Enter the mobile number we text you on and we'll stop reminders from [Garage name].

Response to the form (the same whether or not the number is on file):

> If that number is on our list, you won't get any more reminders from [Garage name]. You'll still get messages about bookings you make. You can also reply STOP to any reminder text.

## Voicemail greeting (missed calls)

> Thanks for calling [Garage name]. We can't take your call right now. We'll text you a link to book online. If you'd like to leave a message, speak after the tone. Your message and number are kept so we can call you back.

## Automated assistant disclosure (Front desk plan)

Phone, first sentence:

> Hi, you're through to the automated assistant for [Garage name]. I can check times and book you in, or take a message for the team.

Chat widget header:

> Automated assistant for [Garage name]. A person will follow up if needed.
