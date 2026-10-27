/*
 * Sample data for the admin component gallery only. The components never hard-code any of this;
 * names, plates and figures are placeholders taken from the design canvas.
 */
import type { AdminGarage, AdminUser, DiaryBooking, DiaryResource } from "@/components/admin-ui";

export const GALLERY_BASE = "/dev/admin-components";
export const TIME_ZONE = "Europe/London";

/** Tuesday 27 Oct 2026 (GMT, two days after the clock change), 10:45 local. */
export const TODAY = "2026-10-27";
export const NOW = "2026-10-27T10:45:00Z";

export const GARAGES: AdminGarage[] = [
  { id: "g-hartley", name: "Hartley Road Motors", initials: "HR", accent: "#155fba", plan: "Growth plan" },
  { id: "g-donvalley", name: "Don Valley Autos", accent: "#0f766e", plan: "Trial" },
  { id: "g-bawtry", name: "Bawtry Mobile Mechanics", accent: "#ffcc00", plan: "Front desk plan" },
];

export const USER: AdminUser = { name: "Dan Morris", email: "dan@hartleyroadmotors.co.uk" };

export const BOOKING_PAGE_URL = "https://hartley-road.autofix.vitalos.co.uk";

export const RESOURCES: DiaryResource[] = [
  { id: "bay-1", name: "Bay 1" },
  { id: "bay-2", name: "Bay 2" },
  { id: "bay-3", name: "Bay 3" },
  { id: "van", name: "Mobile van" },
];

function at(time: string, date = TODAY) {
  return `${date}T${time}:00Z`;
}

function diary(id: string, resourceId: string, from: string, to: string, rest: Omit<DiaryBooking, "id" | "resourceId" | "startsAt" | "endsAt" | "href">): DiaryBooking {
  return { id, resourceId, startsAt: at(from), endsAt: at(to), href: `${GALLERY_BASE}?view=states#job-cards`, ...rest };
}

export const DIARY_BOOKINGS: DiaryBooking[] = [
  diary("d1", "bay-1", "08:30", "10:00", { status: "ready", registration: "CD34EFG", service: "Full service", vehicle: "Astra" }),
  diary("d2", "bay-1", "10:00", "11:00", { status: "in_progress", registration: "AB12CDE", service: "Diagnostics", vehicle: "Focus" }),
  diary("d3", "bay-1", "13:00", "15:00", { status: "confirmed", registration: "EF56GHJ", service: "Brakes front & rear", vehicle: "Golf" }),
  diary("d4", "bay-2", "08:00", "09:00", { status: "ready", registration: "GH67JKL", service: "MOT" }),
  diary("d5", "bay-2", "09:30", "13:30", {
    status: "waiting_parts",
    registration: "JK18LMN",
    service: "Clutch replacement",
    detail: "waiting on parts (ETA 12:00)",
    vehicle: "Qashqai",
  }),
  diary("d6", "bay-2", "14:00", "15:30", { status: "confirmed", registration: "LM69NOP", service: "Interim service", vehicle: "Fiesta" }),
  diary("d7", "bay-3", "11:00", "12:00", { status: "confirmed", registration: "NP20QRS", service: "Diagnostics", vehicle: "Polo" }),
  diary("d8", "bay-3", "12:30", "15:00", { status: "arrived", registration: "QR71STU", service: "Full service + air con", vehicle: "Kuga" }),
  diary("d9", "van", "09:00", "10:00", { status: "ready", registration: "ST22UVW", service: "Battery · DN4" }),
  diary("d10", "van", "14:30", "16:00", { status: "confirmed", registration: "UV17WXY", service: "Mobile diagnostics · DN6" }),
];

export const TEMPLATE_SAMPLE = {
  first_name: "Priya",
  vehicle: "Toyota Yaris",
  reg: "BC23 DEF",
  due_date: "3 Nov",
  link: "book.hartleyroadmotors.co.uk/r/7KQ2",
  garage: "Hartley Road Motors",
};

export const MOT_TEMPLATE =
  "Hi {first_name}, the MOT on your {vehicle} ({reg}) is due on {due_date}. Book a time in 30 seconds: {link}\n\n{garage}.";

export type DueReminder = {
  id: string;
  customer: string;
  registration: string;
  due: string;
  type: string;
  status: "booked" | "sent" | "scheduled" | "no_consent";
  label?: string;
};

export const DUE_REMINDERS: DueReminder[] = [
  { id: "r1", customer: "Priya Shah", registration: "BC23DEF", due: "3 Nov", type: "MOT", status: "booked", label: "Booked 30 Oct" },
  { id: "r2", customer: "Tom Reilly", registration: "DE45FGH", due: "7 Nov", type: "MOT", status: "sent", label: "Sent 10 Oct" },
  { id: "r3", customer: "Amira Hassan", registration: "FG16HJK", due: "12 Nov", type: "Service", status: "scheduled", label: "Sends 29 Oct" },
  { id: "r4", customer: "Leon Clarke", registration: "HJ67KLM", due: "19 Nov", type: "MOT", status: "sent", label: "Sent 22 Oct" },
  { id: "r5", customer: "Mark Evans", registration: "KL19MNP", due: "21 Nov", type: "MOT", status: "no_consent" },
];
