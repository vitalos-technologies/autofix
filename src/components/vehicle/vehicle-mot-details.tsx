import { cn } from "@/lib/utils";
import { formatMotDate } from "@/lib/vehicle/mot";
import type { VehicleDetails } from "@/types/domain";

type VehicleMotDetailsProps = {
  vehicle: Pick<VehicleDetails, "motStatus" | "motExpiry">;
  /** The garage's garages.mot_enabled. MOT facts are hidden unless true. */
  motEnabled: boolean;
  tone?: "light" | "dark";
  className?: string;
};

export function VehicleMotDetails({ vehicle, motEnabled, tone = "light", className }: VehicleMotDetailsProps) {
  if (!motEnabled) return null;
  const facts = [
    vehicle.motStatus ? { label: "MOT status", value: vehicle.motStatus } : null,
    vehicle.motExpiry ? { label: "MOT expires", value: formatMotDate(vehicle.motExpiry) } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
  if (!facts.length) return null;

  return (
    <dl data-testid="vehicle-mot-details" className={cn("mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm", className)}>
      {facts.map((fact) => (
        <div key={fact.label} className="flex gap-1.5">
          <dt className={tone === "dark" ? "font-bold text-white" : "font-bold text-[#071127]"}>{fact.label}</dt>
          <dd className={tone === "dark" ? "text-[#C6D2DF]" : "text-[#344256]"}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
