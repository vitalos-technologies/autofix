// The one map from feature to plan (D17). Client-safe: the Plan page, the nav's Pro badges and the
// locked cards read it, and the server checks (`hasFeature`, `requireFeature`) use it. The SQL
// helper `plan_feature_plan()` (migration 20261029000100_plans.sql) holds the same list; a unit
// test compares the two, so a feature added here must be added there too.

export const PLANS = ["essentials", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_NAMES: Record<Plan, string> = { essentials: "Essentials", pro: "Pro" };
export const PLAN_TAGLINES: Record<Plan, string> = { essentials: "Run the garage", pro: "Grow the garage" };

export type FeatureDefinition = {
  plan: Plan;
  /** Short name for the comparison table and locked cards. */
  label: string;
  /** One line on what it does, as a garage would say it. */
  description: string;
  /** Admin route that holds the feature, for the nav badge and "See it" links. */
  href?: string;
};

export const FEATURES = {
  booking_page: { plan: "essentials", label: "Booking page", description: "Phone-first booking on your free link or your own domain." },
  custom_domain: { plan: "essentials", label: "Your own domain", description: "book.yourgarage.co.uk with its own certificate." },
  vehicle_lookup: { plan: "essentials", label: "Reg lookup and MOT dates", description: "Customers type their reg and the car fills in." },
  approvals: { plan: "essentials", label: "Approvals, no double bookings", description: "Accept requests; every bay is checked at the moment of booking." },
  diary: { plan: "essentials", label: "Today and Diary", description: "Your day by bay, from the desk or your phone." },
  customers: { plan: "essentials", label: "Customers and cars", description: "Every customer, car and booking in one place." },
  import: { plan: "essentials", label: "Import", description: "Bring your customers with you from a spreadsheet." },
  reminders: { plan: "essentials", label: "MOT and service reminders", description: "Only to customers who said yes." },
  review_requests: { plan: "essentials", label: "Review requests", description: "Ask happy customers for a review after collection." },
  missed_calls: { plan: "essentials", label: "Missed-call text-back and voicemail", description: "Callers get a text with your booking link." },
  inbox: { plan: "essentials", label: "Messages inbox", description: "SMS, WhatsApp and email in one inbox." },
  invoices: { plan: "essentials", label: "Invoices and quotes", description: "Quote, invoice and email from the admin." },
  team: { plan: "essentials", label: "Team roles and two-step sign-in", description: "Owners, managers, technicians and front desk." },
  askbridge: { plan: "essentials", label: "Askbridge chat widget", description: "Answers customers' questions on your booking page." },
  basic_reports: { plan: "essentials", label: "Basic figures", description: "Today's numbers and work won back by reminders." },
  sms_allowance: { plan: "essentials", label: "Monthly SMS allowance", description: "Texts included each month; extra texts at cost." },

  health_checks: {
    plan: "pro",
    label: "Digital health checks",
    description: "Red, amber, green checks with photos and video; customers approve extra work online.",
    href: "/app/health-checks",
  },
  payments: { plan: "pro", label: "Deposits and pay-by-link", description: "Deposits at booking, pay-by-link invoices and no-show fees.", href: "/app/payments" },
  service_plans: { plan: "pro", label: "Customer service plans", description: "Monthly plans paid by Direct Debit, applied at booking.", href: "/app/service-plans" },
  campaigns: { plan: "pro", label: "Campaigns", description: "Seasonal and win-back texts to opted-in customers, by car age or MOT month.", href: "/app/campaigns" },
  ai_front_desk: { plan: "pro", label: "AI front desk", description: "Answers calls and WhatsApp and books customers in, with monthly minutes.", href: "/app/settings/ai-front-desk" },
  accounting_sync: { plan: "pro", label: "Accounting sync", description: "Invoices and payments sync to Xero, QuickBooks or Sage.", href: "/app/settings/accounting" },
  advanced_reports: { plan: "pro", label: "Reports and exports", description: "Revenue by service and technician, bay use, hours sold vs worked, reminder ROI.", href: "/app/reports" },
  fleet_accounts: { plan: "pro", label: "Fleet and trade accounts", description: "Business customers with many cars and a monthly statement.", href: "/app/accounts" },
  courtesy_cars: { plan: "pro", label: "Courtesy cars and collection", description: "Book courtesy cars and collection or delivery slots with the job.", href: "/app/courtesy-cars" },
  multi_site: { plan: "pro", label: "Several sites, one login", description: "Group overview and reports across your sites (each extra site charged).", href: "/app/group" },
  priority_support: { plan: "pro", label: "Larger SMS allowance and priority support", description: "More texts each month and a faster reply from Vitalos." },
} as const satisfies Record<string, FeatureDefinition>;

export type Feature = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];
export const PRO_FEATURES = FEATURE_KEYS.filter((key) => FEATURES[key].plan === "pro");
export const ESSENTIALS_FEATURES = FEATURE_KEYS.filter((key) => FEATURES[key].plan === "essentials");

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && Object.hasOwn(FEATURES, value);
}

export function featurePlan(feature: Feature): Plan {
  return FEATURES[feature].plan;
}

/** The Pro feature whose admin route holds this path (`/app/campaigns/new` → `campaigns`), if any. */
export function proFeatureForPath(pathname: string): Feature | null {
  for (const key of PRO_FEATURES) {
    const href = (FEATURES[key] as FeatureDefinition).href;
    if (href && (pathname === href || pathname.startsWith(`${href}/`))) return key;
  }
  return null;
}
