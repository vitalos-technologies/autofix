# Autofix design system

Source of truth for every screen the UI agent builds. The visual language is SOB Autofix's (navy and electric blue, Barlow Condensed display type, registration-first booking), adjusted for a white-label product that many garages share.

- Live design canvas (editable, comments): https://claude.ai/artifact/UYRN7ayr8LpWS5U59221mP
- Screen sources: `design/screens/*.dc.html`. Inline styles are the spec; `{{accent}}` means the garage's brand colour.
- Static previews you can open in a browser: `design/preview/*.html`
- Screenshots at 2x: `design/screenshots/*.png`. Read these before building a screen.
- Tokens: `design/tokens.css` (copy into `src/app/globals.css` in Phase 2)

All names, cars, prices and figures in the screens are sample data. Never hard-code them.

## What changed from SOB, on purpose

| SOB today | Autofix | Why |
| --- | --- | --- |
| 7-step booking wizard inside a dark hero card | 5 full-screen steps: Vehicle → Service → Time → Details → Confirmed | Fewer taps on a phone; one decision per screen |
| White GB plate input | Yellow UK rear-plate input with a blue UK band | Recognisable at a glance, different from SOB |
| Pill-shaped buttons (`border-radius: 9999px`) | 14px corner buttons, 16 to 18px cards | A distinct look for the platform |
| Fixed SOB blue | `--garage-accent` per garage (default `#155fba`) | White-label: each garage's own colour |
| Buttons inline in the card | Sticky bottom action bar in the thumb zone | One-handed booking |
| Admin dashboard of CMS counts (articles, stock, invoices) | Opens on today's diary by bay, plus "Needs your OK" and reminders | The garage's day comes first |
| Navy sidebar with CMS sections | Navy sidebar with Workshop / Customers / Setup groups | Same look, workshop tasks first |

## Tokens

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--navy-950` | `#071127` | Booking header bar, admin sidebar, dark cards, H1 text. Never a booking-site page background (see Booking site backgrounds) |
| `--navy-900` | `#0c1d3d` | Hover on navy |
| `--navy-line` | `#22385f` | Borders on navy |
| `--garage-accent` | per garage, default `#155fba` | Primary buttons, selected states, progress, links |
| `--blue-700` | `#1446a5` | UK band on the plate; link hover |
| `--plate-yellow` | `#f6c700` | Registration plates everywhere (input and chips) |
| `--plate-ink` | `#111111` | Text on plates |
| `--grey-50` | `#f4f7fa` | App background |
| `--grey-100` | `#eef1f5` | Neutral chips |
| `--grey-200` | `#e4eaf0` | Card borders, dividers |
| `--grey-300` | `#cfd8e3` | Input and secondary button borders |
| `--grey-600` | `#586575` | Secondary text (5.9:1 on white) |
| `--grey-700` | `#3d4a5a` | Body text on light chips |
| `--grey-800` | `#202a36` | Body text |
| `--success-600` / `--success-bg` / `--success-ink` | `#16a34a` / `#e7f6ec` / `#166534` | Ready, booked, confirmed |
| `--warning-bg` / `--warning-ink` | `#fdf1d3` / `#6e4a06` | Waiting parts, pending |
| `--info-bg` / `--info-ink` | `#dbe8fb` / `#0d3b7a` | In bay, sent |
| `--danger-600` | `#dc2626` | Errors, the diary's "now" line |

Accent options shown in Branding: `#155fba` blue, `#0f766e` teal, `#b9451a` orange, `#6d28d9` purple. Custom colours are allowed only if white text on them passes 4.5:1. Validate on save and darken automatically if not.

### Booking site backgrounds

Light pages only (Temitope, 29 Oct 2026). The steps, manage, legal and contact pages sit on `--grey-50` under the navy `GarageHeader` bar. Book 5 · Confirmed is a white page (`#ffffff`) with navy text: no navy page background anywhere on a garage's booking site.

- Text on white: H1 `--navy-950`, body `--grey-800`, secondary `--grey-600` (5.9:1), "Powered by Autofix" `--grey-600` at 11.5px.
- Cards that were light on navy keep a white or `--grey-50` fill and gain a 1px `--grey-200` border so they stay distinct from the page.
- The garage accent stays on primary buttons and links. Secondary buttons are white with a `--grey-300` border and navy text.
- Focus: the accent ring (`focusRing`, 3px, offset 2px) on every control; `focusRingOnDark` (white) is only for controls on navy (the header bar, summary bar, admin sidebar).
- `design/screens/Book-5-Confirmed.dc.html` and its screenshot show the white version; the live design canvas still shows the earlier navy page.

### Type

| Role | Font | Size / weight / line height |
| --- | --- | --- |
| Booking H1 | Barlow Condensed | 34 to 38px / 800 / 0.98 |
| Confirmation H1 | Barlow Condensed | 44px / 800 / 0.95 |
| Admin H1 | Barlow Condensed | 40px / 800 / 1 |
| KPI numbers | Barlow Condensed | 36 to 40px / 700 |
| Plate text | Barlow Condensed | 36px input, 14 to 17px chips / 700 / letter-spacing 0.05 to 0.08em |
| Body | Inter | 15 to 16px / 400 |
| Labels, buttons | Inter | 14 to 16px / 600 to 700 |
| Eyebrows | Inter | 12px / 600 to 700 / uppercase / letter-spacing 0.06 to 0.1em |
| Code (DNS records) | JetBrains Mono | 13 to 14px / 500 |

Load with `next/font/google` (`Barlow_Condensed`, `Inter`, `JetBrains_Mono`), as SOB does.

### Shape and spacing

- Radius: buttons and inputs 12 to 14px; cards 16px; booking hero cards 18px; chips 999px; plate 10px.
- Touch targets at least 44px tall; primary booking button 54px.
- Spacing scale: 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 28. Phone screen padding 20px; admin page padding 28px.
- Shadows only on the plate input (`0 6px 18px rgba(7,17,39,.12)`) and the selected segmented button.

## Components

| Component | Where | Notes |
| --- | --- | --- |
| `GarageHeader` | Every booking step | Navy bar: garage logo or initials tile in accent, name, subtitle (location, or car + reg once known), call or back button 44px. `tone="light"` on Book 5: no bar, navy name, grey subtitle, grey-bordered buttons with the accent focus ring |
| `StepProgress` | Booking 1 to 4 | "Step n of 5" + step name + 5 segments (accent / `#dfe6ee`) |
| `PlateInput` | Booking 1 | Yellow plate, UK band, uppercase, auto-spacing to `AB12 CDE`, `autocomplete=off`, never written into the URL |
| `PlateChip` | Summaries, admin lists | Small yellow plate |
| `VehicleCard` | Booking 1 | Make + model, year · engine · colour, MOT-due chip (only when the garage has MOT on), mileage chip |
| `ServiceOption` | Booking 2 | Radio card: name, one-line description with duration, price (`£x`, `From £x` or `Quote`) |
| `SegmentedControl` | Booking 2 (workshop/mobile) | Two options; hide when the garage offers one mode |
| `SymptomChips` | Booking 2 | Toggle chips + "Add a note" |
| `DateStrip` | Booking 3 | Horizontal scroll, 58×72 day buttons, selected = navy |
| `SlotGrid` | Booking 3 | 3 columns of 48px buttons, grouped Morning/Afternoon; taken = dashed + struck through and disabled |
| `StickyActionBar` | Booking 1 to 4 | White bar, 54px accent button whose label states the next step or the chosen time |
| `BookingSummaryBar` | Booking 4 | Navy card: plate chip, service, time, Edit |
| `ConsentCheckbox` | Booking 4 | Unticked by default: "Remind me when the MOT and service are due". A second, separate one under it for offers (consent wording v1.0), also unticked: "Send me occasional offers from [Garage name]. You can stop these any time." |
| `ConfirmationCard` | Booking 5 | White card with a `--grey-200` border on the white page: reference in Barlow, 2×2 facts, Add to calendar (accent) / Change or cancel (white, `--grey-300` border, navy text) / WhatsApp (`#15803d`) |
| `BookingStatusChip` | Manage booking | Customer-facing status: 999px chip with a dot, success / warning / info / neutral / danger (same colour pairs as `StatusPill`) |
| `AdminShell` | Admin desktop | Navy sidebar (garage switcher, 3 groups), white top bar (search, booking page link, bell, avatar); stacks on phones |
| `AdminTabBar` | Admin phone | 5 tabs: Today, Diary, New (accent), Customers, More |
| `KpiCard` | Admin | Label, Barlow number, one-line context; the "won back" card is navy |
| `DiaryGrid` | Admin Today and Diary | Rows = resources, columns = 30-minute slots 08:00 to 17:00, blocks coloured by status, red "now" line, scrolls sideways under 820px |
| `JobCard` | Admin phone Today | Time + resource, plate chip + model, service, status pill; the active one shows Add photos / Send quote / Mark ready |
| `ApprovalCard` | "Needs your OK" | Plate, source (online, missed call, AI agent), customer + service + time, Accept + second action |
| `StatusPill` | Everywhere | booked = grey, in bay/sent = info, waiting parts = warning, ready/booked = success |
| `AutomationRow` | Reminders | Name, rule description, channel badge, Edit, switch (`role="switch"`) |
| `MessagePreview` | Reminders | SMS bubble with the rendered template |
| `DnsRecordTable` + `DomainStatusSteps` | Booking page settings | CNAME `book` → `cname.vercel-dns-0.com`; steps: Record found → Securing (HTTPS) → Live |
| `EmbedSnippet` | Booking page settings | Tabs: button link, /book redirect, embed |

## Screens to routes

| Screen | File | Route (after host rewrite) |
| --- | --- | --- |
| Book 1 · Vehicle | `Book-1-Vehicle` | `/_site/[garageId]` → `/` on the garage host |
| Book 2 · Service | `Book-2-Service` | `/service` |
| Book 3 · Time | `Book-3-Time` | `/time` |
| Book 4 · Details | `Book-4-Details` | `/details` |
| Book 5 · Confirmed | `Book-5-Confirmed` | `/confirmed/[reference]` |
| Admin · Dashboard | `Admin-Dashboard` | `autofix.vitalos.co.uk/app` |
| Admin · Today (phone) | `Admin-Today-Phone` | same route, phone layout |
| Admin · Reminders | `Admin-Reminders` | `/app/reminders` |
| Admin · Booking page & domain | `Admin-Domain` | `/app/settings/booking-page` |

Booking state between steps lives in a signed, httpOnly cookie or server session, never in the query string (registration privacy rule).

Screens not drawn yet (build them in the same language, then add them to the canvas): Diary (week view), Bookings list + booking detail, Customers & cars, Services & prices, Opening hours & bays, Messages & calls, Settings, sign-up/onboarding, super admin.

Built but not yet in the canvas (Messages & calls, A196–A205, in the admin language): Messages & calls · Messages (`/app/messages`: Messages | Calls sub-nav with counts, a Conversations panel of rows (name, channel badge, Opted out tag, two-line preview with "You:" for the garage's, time, unread count, chevron) and a "From numbers we don't know" panel beside it from 1024px), Messages & calls · Conversation (`/app/messages/[customerId]`: All messages back link, name with channel badge and masked number, Call and Customer details buttons; a Conversation panel with day pills, the customer's bubbles left in grey and the garage's right in navy with an uppercase label (MOT reminder, Booking update, Missed-call text-back), time · channel · delivery status, New badges and centred STOP/START system lines; a Reply panel with the reason above a disabled box when replying isn't possible, the character / text count and a 54px Send reply), Messages & calls · Calls (`/app/messages/calls`: a Recent calls panel of cards: Missed / Answered badge, time, length, Texted back, caller, Play voicemail, Call back, Mark handled or Handled).

Built but not yet in the canvas (P2.9, in the Book 1–5 language): Manage · Find your booking (`/manage` without a session: reference field, plate input, generic not-found alert), Manage · Your booking (`/manage`: status chip, booking card with plate chip and masked mobile, Change the time / Cancel booking / Add to calendar / Call / WhatsApp, and the requested, too-close, with-the-garage, time-passed, collected and cancelled notices), Manage · Pick a new time (`/manage/reschedule`: Book 3's strip and grid, current time struck through), Manage · Cancel this booking? (`/manage/cancel`: summary bar, optional reason, red 54px action).

Built but not yet in the canvas (29 Oct 2026, in the Book 1–5 language): Contact us (`/contact`, linked from every booking page's footer and from Book 2's "Not sure what it needs? Ask the garage a question": header with back, "Contact us" H1 and intro, Full name, Phone number, Email (optional, or "for the reply" when Email is chosen), "How should they get back to you?" as Book 4's outline segmented control (Phone call / WhatsApp / Email), Your message (textarea), Registration (optional) as the yellow plate, Turnstile when configured, privacy line, "Prefer to talk? Call" link, 54px Send message in the sticky bar; then "Message sent" with the green tick, Book a car in and "Urgent? Call").

Built but not yet in the canvas (P3.1–P3.3, in the Admin-Dashboard / Admin-Today-Phone language): Admin · More (`/app/more`, phone tab: garage switcher, every section as light nav rows, Notifications / Trash / Sign out), Admin · Diary week (`/app/diary`: Previous / This / Next week; from 768px a bays × days table with status-coloured blocks, today tinted, closed days grey; on phones one list of JobCards per day), Admin · Diary day (`/app/diary?day=`: the DiaryGrid for one day with day navigation), Admin · Bookings (`/app/bookings`: posted search box, From/To dates, status chips with the Needs-your-OK count, bulk trash bar, DataTable from 1024px and cards below, Newer/Older paging), Admin · Booking (`/app/bookings/[id]`: reference eyebrow + customer H1, status pill and Email customer; Status panel with the next steps as buttons and Cancel / No-show behind a disclosure with a reason; The job facts; Move this booking with Book 3's day strip and slot grid; Customer and car; History with Add a note and the timeline), Admin · New booking (`/app/bookings/new`: On the phone / Walk-in segmented control, plate input, service select, day strip + slot grid, customer fields, unticked reminders consent, 54px Book in for <time>), Admin · Not found (inside the shell). The SOB pages still in use (Invoices, Enquiries, Notifications, Settings, Security, Trash) render inside the new shell and keep their own layouts until they are rebuilt.

Built but not yet in the canvas (P3.4, in the Admin-Domain / Admin-Reminders language, `src/components/admin-ui` + `src/app/app/(protected)/settings/_components`): a Setup sub-nav (Services & prices · Opening hours · Bays & vans · Branding & MOT; scrolls inside its box on phones); Setup · Services & prices (`/app/settings/services`: rows with duration · price · where, Bookable online / Staff only / Needs your OK / MOT badges, Edit, move up/down, Archive; Archived list with Restore); Setup · Add / Edit service (`/new`, `/[id]`: three panels, price-mode and location segmented radios, `£` price, minutes, checkboxes, and an "On the booking page" preview card beside the form); Setup · Opening hours (`/app/settings/hours`: a row per weekday with Opens/Closes time inputs, add/remove sets for split days, live overlap error; Closures list with Remove and an Add a closure form; Booking rules panel); Setup · Bays & vans (`/app/settings/resources`: rows with kind badge, `role="switch"`, move up/down, Rename or delete disclosure; Add a bay, van or technician panel); Setup · Branding & MOT (`/app/settings/branding`: logo tile + upload, the four swatches + Custom colour with picker and hex field, the contrast check panel showing requested → saved colour, the booking-step preview beside the page (under the picker on phones), and the Offer MOTs switch). Each has a read-only state for members who may not change it.

Built but not yet in the canvas (P3.10, in the Admin-Reminders / Admin-Dashboard language): Reminders · rule editor (`/app/reminders?edit=<kind>`: replaces the Message preview aside; placeholder chips for that kind only, the live character / text counter with real-length sample details, inline errors for placeholders the sender can't fill and warnings, the days field, the "Send by" select, the preview, Save / Cancel and "Send me a test"; read-only "View" for technicians and front desk), Reminders · review-request confirmation (highlighted panel above the figures: the A54 consent note, "Switch on review requests" / "Keep them off"), Today · missed-call card (in "Needs your OK", navy on phones: "Missed call · 08:12", Texted back badge, caller name or masked number, Play voicemail (0:42) → native audio player, Call back + Mark handled), New booking · Outside opening hours (checkbox with hint under the time grid; when ticked a date-and-time field, 5-minute steps, in the garage's time).

## Rules

1. Phone first. Build at 390px, then widen. No horizontal page scroll; wide tables scroll inside their own box.
2. Accessible as drawn: real `<button>`, `<a>`, `<label>`; `aria-pressed` on toggles; `role="switch"` + `aria-checked` on switches; icon buttons get `aria-label`. Text contrast 4.5:1.
3. Icons: `lucide-react` (already in SOB), 18 to 22px, stroke 2.
4. No emoji, gradients or decorative shadows.
5. Garage brand appears only on customer screens and the admin garage switcher. The admin itself is Autofix-branded.
6. Lighthouse mobile at least 90 for performance and 100 for accessibility on booking routes (SOB's `lighthouserc.json` thresholds carry over).
