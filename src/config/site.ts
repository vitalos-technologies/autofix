// Single-business facts inherited from SOB Autofix. P1.3 replaces this file
// with a per-request GarageContext (getGarage()).
export type SocialLinksConfig = {
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
  youtube: string | null;
  x: string | null;
};

const socialLinks: SocialLinksConfig = {
  facebook: "https://www.facebook.com/sobautofix",
  instagram: "https://www.instagram.com/sobautofix/",
  tiktok: "https://www.tiktok.com/@sobautofix",
  youtube: null,
  x: null,
};

export const siteConfig = {
  name: "SOB Autofix",
  legalName: "SOB Autofix Limited",
  tagline: "Professional Diagnostics. Not Guesswork.",
  supportingLine: "Automotive Diagnosis, Repair & Sales",
  companyNumber: "16182532",
  phone: "07469273483",
  whatsapp: "07469273483",
  email: "info@sobautofix.com",
  address: {
    building: "Cumbrae",
    street: "Station Road",
    town: "Norton",
    city: "Doncaster",
    postcode: "DN6 9HF",
    country: "United Kingdom",
    countryCode: "GB",
  },
  openingHours: {
    monday: "",
    tuesday: "",
    wednesday: "",
    thursday: "",
    friday: "",
    saturday: "",
    sunday: "",
    bankHolidays: "",
  },
  yearsInBusiness: 4,
  accreditations: ["NABTEB", "Automotive Service Management Certificate"],
  googleMapsUrl: process.env.NEXT_PUBLIC_GOOGLE_MAPS_URL ?? "",
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  socials: socialLinks,
} as const;

export const formatPhone = (phone: string) =>
  phone.length === 11 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;

export const contactLinks = {
  phone: `tel:+44${siteConfig.phone.slice(1)}`,
  whatsapp: `https://wa.me/44${siteConfig.whatsapp.slice(1)}`,
  email: `mailto:${siteConfig.email}`,
};
