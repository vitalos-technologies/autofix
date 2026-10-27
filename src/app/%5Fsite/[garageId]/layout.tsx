import type { Metadata } from "next";
import { GarageProvider } from "@/components/garage/garage-provider";
import { garageAccentStyle } from "@/lib/branding/accent";
import { publicGarage, requireSiteGarage } from "@/lib/tenancy/garage";

type SiteLayoutProps = { children: React.ReactNode; params: Promise<{ garageId: string }> };

export async function generateMetadata({ params }: Omit<SiteLayoutProps, "children">): Promise<Metadata> {
  const garage = await requireSiteGarage((await params).garageId);
  return {
    title: { default: `Book online | ${garage.name}`, template: `%s | ${garage.name}` },
    description: `Book your car in with ${garage.name} online.`,
    applicationName: garage.name,
    robots: { index: true, follow: true },
  };
}

/** Every page on a garage host: garage context and the garage's accent colour. */
export default async function SiteLayout({ children, params }: SiteLayoutProps) {
  const garage = await requireSiteGarage((await params).garageId);
  return (
    <div data-garage={garage.slug} style={garageAccentStyle(garage.accent)} className="min-h-dvh bg-grey-50">
      <GarageProvider garage={publicGarage(garage)}>
        <main>{children}</main>
      </GarageProvider>
    </div>
  );
}
