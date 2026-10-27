import type { Metadata } from "next";
import { AskbridgeWidget } from "@/components/askbridge/askbridge-widget";
import { GarageProvider } from "@/components/garage/garage-provider";
import { askbridgeScriptUrl } from "@/lib/askbridge/config";
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

/** Every page on a garage host: garage context, the garage's accent colour and, when on, the Askbridge chat. */
export default async function SiteLayout({ children, params }: SiteLayoutProps) {
  const garage = await requireSiteGarage((await params).garageId);
  // Askbridge (P4.6): only when the owner turned it on and the platform has a widget script.
  const widgetScript = garage.askbridgeWidgetId ? askbridgeScriptUrl() : null;
  return (
    <div data-garage={garage.slug} style={garageAccentStyle(garage.accent)} className="min-h-dvh bg-grey-50">
      <GarageProvider garage={publicGarage(garage)}>
        <main>{children}</main>
      </GarageProvider>
      {widgetScript && garage.askbridgeWidgetId ? (
        <AskbridgeWidget src={widgetScript.toString()} widgetId={garage.askbridgeWidgetId} garageName={garage.name} accent={garage.accent} />
      ) : null}
    </div>
  );
}
