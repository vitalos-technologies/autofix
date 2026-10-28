// Copy for the Autofix marketing page on the admin host (`/`). Kept as data, like the Answerd site's
// content module, so wording changes don't touch layout. Every claim here is something the product does
// today: no prices, no customer numbers, no testimonials until Temitope supplies real ones.

export const marketing = {
  name: "Autofix",
  by: "by Vitalos",
  metaTitle: "Autofix · Online booking for independent garages",
  description:
    "Give your garage a booking page customers finish on their phone, a diary that never double-books a bay, and MOT and service reminders that bring cars back.",

  nav: [
    { label: "How it works", href: "#how-it-works" },
    { label: "Features", href: "#features" },
    { label: "Plans", href: "#plans" },
    { label: "FAQs", href: "#faqs" },
  ],
  login: { label: "Log in", href: "/app/login" },
  start: { label: "Set up your garage", href: "/signup" },

  hero: {
    badge: "Built for independent garages",
    headline: "Your garage,",
    highlight: "fully booked.",
    subline:
      "A booking page customers finish on their phone in under a minute, a diary that never double-books a bay, and reminders that bring cars back for their MOT and service.",
    secondary: { label: "See how it works", href: "#how-it-works" },
    notes: ["Live on your free link in minutes", "Your own domain when you're ready", "Works on any phone"],
  },

  trustLabel: "What every garage gets",
  trust: [
    { icon: "globe", label: "Your own booking domain", detail: "book.yourgarage.co.uk, or a free Autofix link" },
    { icon: "shield", label: "No double bookings", detail: "Every bay is checked at the moment of booking" },
    { icon: "bell", label: "MOT and service reminders", detail: "Only to customers who said yes" },
    { icon: "phone", label: "Missed calls texted back", detail: "With a link to book, within a minute" },
  ],

  howItWorks: {
    id: "how-it-works",
    heading: "How it works",
    intro: "Three steps from sign-up to a diary that fills itself.",
    steps: [
      { title: "Set up in minutes", body: "Add your services and prices, opening hours, bays and vans. Turn MOTs on if you test." },
      { title: "Share your booking link", body: "Put it on your website, Google profile and socials. Start on a free link, move to your own domain later." },
      { title: "Run the day from Today", body: "Bookings land in your diary by bay. Accept, move or check cars in from your phone or the desk." },
    ],
  },

  features: {
    id: "features",
    heading: "Everything the front desk does, without the phone tag",
    items: [
      {
        key: "booking",
        title: "A booking page customers finish",
        body: "They type their reg, we fill in the car. They only see times when a bay or van is free, then confirm in a few taps.",
      },
      {
        key: "diary",
        title: "Your day, by bay",
        body: "Today shows what's booked in, what's in the workshop and what's ready to collect. Requests that need your OK sit at the top.",
      },
      {
        key: "reminders",
        title: "Reminders that win work back",
        body: "MOT reminders 28 and 7 days before expiry, service reminders before the next one is due. Every booking they bring in is counted as won back.",
      },
      {
        key: "calls",
        title: "Missed calls, answered",
        body: "Can't get to the phone? The caller gets a text with your booking link, and you see the call and any voicemail in the admin.",
      },
    ],
  },

  band: {
    id: "on-your-phone",
    headline: "Run the garage from your phone",
    line: "The admin works at the desk and in the workshop: check today's jobs, accept requests and text a customer back between cars.",
  },

  garages: {
    id: "for-garages",
    headline: "Made for the independent garage",
    points: [
      "MOT on or off per garage, with MOT due dates on each car",
      "Bays, mobile vans and technicians, each with their own diary",
      "Bring your customers with you: import a spreadsheet, keep their consent",
      "Privacy notice, consent wording and unsubscribe links handled for you",
      "Two-step sign-in for staff accounts",
    ],
    note: "Customers never need an app or an account: they book in the browser on their own phone.",
  },

  // Two plans (DECISIONS D17). Essentials is what ships today; Pro lists the features being built, marked
  // "Coming soon" until each one ships. No prices until Temitope sets them.
  plans: {
    id: "plans",
    heading: "Two plans",
    intro: "Essentials runs the garage. Pro grows it. Prices are coming soon.",
    essentials: {
      name: "Essentials",
      tagline: "Run the garage",
      status: "Available now",
      features: [
        "Booking page on a free link or your own domain",
        "Registration lookup with MOT due dates",
        "No double bookings, and your OK on jobs you want to check",
        "Today and the diary, by bay and van",
        "Customers and cars, with spreadsheet import",
        "MOT, service and review reminders to customers who said yes",
        "Missed calls texted back, with voicemail",
        "One inbox for texts, WhatsApp and email",
        "Invoices and quotes",
        "Team roles and two-step sign-in",
      ],
    },
    pro: {
      name: "Pro",
      tagline: "Grow the garage",
      status: "Coming soon",
      lead: "Everything in Essentials, plus:",
      features: [
        "Digital health checks with photos, approved online",
        "Deposits, pay-by-link invoices and no-show fees",
        "Service plans paid by monthly Direct Debit",
        "Campaigns to customers who opted in",
        "AI front desk for calls and WhatsApp",
        "Xero, QuickBooks and Sage sync",
        "Advanced reports and exports",
        "Fleet and trade accounts",
        "Courtesy cars, collection and delivery",
        "Several sites under one login",
      ],
      note: "Pro features are being built now. Each one switches on as soon as it's ready.",
    },
    cta: { label: "Start with Essentials", href: "/signup" },
  },

  faqs: {
    id: "faqs",
    heading: "Questions garages ask",
    items: [
      {
        q: "How long does it take to get started?",
        a: "Minutes. Sign up, add your garage details, services and opening hours, and your booking page is live on a free yourgarage.autofix.vitalos.co.uk link straight away.",
      },
      {
        q: "Can customers book on our own website address?",
        a: "Yes. Add one DNS record (for example book.yourgarage.co.uk) and Autofix connects it, with its own security certificate. We show you exactly what to add.",
      },
      {
        q: "Do customers need to download an app?",
        a: "No. They book in the browser on their phone or computer. Their registration fills in the car, and they get a confirmation by email and text.",
      },
      {
        q: "Can two customers book the same slot?",
        a: "No. Each booking is checked against your bays and vans at the moment it's made, so the same bay can't be booked twice.",
      },
      {
        q: "Will customers get messages they didn't ask for?",
        a: "No. Reminders only go to customers who ticked the box, never outside 09:00 to 19:00 Monday to Saturday, and a STOP reply or the unsubscribe link stops them at once.",
      },
      {
        q: "How much does it cost?",
        a: "There are two plans, Essentials and Pro. Prices are being finalised. You can set up your garage and try your booking page now.",
      },
      {
        q: "We don't do MOTs. Does that matter?",
        a: "Not at all. MOT is a switch: leave it off and MOT services, dates and reminders never appear.",
      },
    ],
  },

  footer: {
    columns: [
      {
        title: "Product",
        links: [
          { label: "How it works", href: "#how-it-works" },
          { label: "Features", href: "#features" },
          { label: "Plans", href: "#plans" },
          { label: "FAQs", href: "#faqs" },
        ],
      },
      {
        title: "Garages",
        links: [
          { label: "Set up your garage", href: "/signup" },
          { label: "Log in", href: "/app/login" },
        ],
      },
      {
        title: "Company",
        links: [{ label: "Vitalos Technologies", href: "https://vitalos.co.uk" }],
      },
    ],
    company: "Vitalos Technologies Ltd",
  },
} as const;
