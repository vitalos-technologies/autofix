import type { Metadata } from "next";
import { DraftFlag, LegalDocumentBody } from "@/components/legal/legal-document";
import { renderPrivacyNotice } from "@/lib/legal/documents";
import { addressLine, formatPhoneForDisplay } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../_components/booking-screen";

export const metadata: Metadata = { title: "Privacy notice" };

type PrivacyPageProps = { params: Promise<{ garageId: string }> };

/** The garage's customer privacy notice (docs/autofix/legal/privacy-notice-template.md), linked from Book 4 and every booking page. */
export default async function PrivacyPage({ params }: PrivacyPageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const notice = renderPrivacyNotice(garage);
  const details = [
    { label: "Business", value: garage.name },
    { label: "Legal name", value: garage.legalName?.trim() || null },
    { label: "Company number", value: garage.companyNumber?.trim() || null },
    { label: "Address", value: addressLine(garage.address) || null },
    { label: "Email", value: garage.email?.trim() || null },
    { label: "Phone", value: garage.phone ? formatPhoneForDisplay(garage.phone) : null },
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail.value));

  return (
    <BookingScreen garage={garage} back={{ href: "/", label: "Back to booking" }} subtitle="Privacy notice" withActionBar={false}>
      <article className="flex flex-col gap-4 px-5 pt-5 pb-10">
        <h1 className="m-0 font-display text-[30px] leading-[1.02] font-extrabold text-navy-950">{notice.title}</h1>
        <DraftFlag document={notice} />
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 rounded-control border border-grey-200 bg-white px-3.5 py-3 text-[14px] leading-[1.45]">
          {details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="font-semibold text-grey-600">{detail.label}</dt>
              <dd className="m-0 break-words text-navy-950">{detail.value}</dd>
            </div>
          ))}
        </dl>
        <LegalDocumentBody document={notice} />
        <p className="m-0 text-[13px] text-grey-600">Version {notice.version}</p>
      </article>
    </BookingScreen>
  );
}
