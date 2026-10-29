import type { Metadata } from "next";
import { ArrowDown, ArrowUp, Warehouse } from "lucide-react";
import { Badge, buttonClass, EmptyState, focusRing, PageHeader, Panel, Switch } from "@/components/admin-ui";
import { cn } from "@/lib/utils";
import { canManageSetup, MAX_RESOURCE_NAME, RESOURCE_KIND_LABELS, type ResourceKind } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { inputClass } from "../_components/fields";
import { FlashMessage, ReadOnlyNotice, SetupNav, SetupNotice } from "../_components/setup-nav";
import { deleteResourceAction, moveResourceAction, renameResourceAction, setResourceActiveAction } from "./actions";
import { AddResourceForm } from "./add-resource-form";

export const metadata: Metadata = { title: "Bays & vans" };

const MESSAGES: Record<string, string> = {
  "done:renamed": "Name saved.",
  "done:deleted": "Deleted.",
  "error:not_allowed": "Only the garage's owners and managers can change bays, vans and technicians.",
  "error:not_found": "That could not be found. It may have been changed in another tab.",
  "error:bad_name": `Enter a name of up to ${MAX_RESOURCE_NAME} characters.`,
  "error:in_use": "That one has bookings, so it can't be deleted. Switch it off instead: it keeps its bookings and takes no new ones.",
  "error:save_failed": "That change could not be saved. Try again.",
};

type Resource = { id: string; name: string; kind: ResourceKind; active: boolean; sort: number };
type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };

const KIND_TONES = { bay: "info", mobile: "success", technician: "neutral" } as const;

/** Setup · Bays & vans: what a booking takes up, with on/off switches and diary order. */
export default async function ResourcesSetupPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const query = await searchParams;
  const [resourceResult, serviceResult] = admin
    ? await Promise.all([
        admin.client.from("resources").select("id,name,kind,active,sort").eq("garage_id", admin.garage.id).order("sort").order("name"),
        admin.client.from("services").select("location_mode,resource_kind").eq("garage_id", admin.garage.id).is("deleted_at", null).eq("online_enabled", true),
      ])
    : [null, null];
  const resources = (resourceResult?.data ?? []) as Resource[];
  const services = (serviceResult?.data ?? []) as Array<{ location_mode: string; resource_kind: string }>;
  const canEdit = canManageSetup(admin?.role);
  const activeKinds = new Set(resources.filter((resource) => resource.active).map((resource) => resource.kind));
  const missing = [
    services.some((service) => service.location_mode !== "mobile" && service.resource_kind === "bay") && !activeKinds.has("bay") ? "bay" : null,
    services.some((service) => service.location_mode !== "workshop") && !activeKinds.has("mobile") ? "mobile van" : null,
    services.some((service) => service.location_mode !== "mobile" && service.resource_kind === "technician") && !activeKinds.has("technician") ? "technician" : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Setup"
        title="Bays & vans"
        description="What a booking takes up. Each bay, van or technician that is switched on takes one booking at a time."
      />
      <SetupNav current="resources" />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="manage" /> : null}
      {missing.length ? (
        <SetupNotice tone="warning">
          Some services can&apos;t be booked: no {missing.join(" or ")} is switched on.
        </SetupNotice>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel id="resources" title="Your bays, vans and technicians" padding="flush">
          {resources.length ? (
            <ul className="m-0 list-none p-0">
              {resources.map((resource, index) => (
                <li key={resource.id} className="flex flex-col gap-2 border-t border-[#f1f5f9] py-3 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-[1_1_120px] flex-col gap-1">
                      <span className={cn("text-[15px] font-bold", resource.active ? "text-navy-950" : "text-grey-700")}>{resource.name}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={KIND_TONES[resource.kind]}>{RESOURCE_KIND_LABELS[resource.kind]}</Badge>
                        <span id={`resource-${resource.id}-state`} className="text-[13px] text-grey-600">
                          {resource.active ? "Taking bookings" : "Switched off"}
                        </span>
                      </span>
                    </div>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <form action={setResourceActiveAction} className="flex">
                        <input type="hidden" name="resourceId" value={resource.id} />
                        <input type="hidden" name="active" value={String(!resource.active)} />
                        <Switch
                          type="submit"
                          label={`${resource.name} takes bookings`}
                          checked={resource.active}
                          disabled={!canEdit}
                          describedBy={`resource-${resource.id}-state`}
                        />
                      </form>
                      {canEdit ? (
                        <form action={moveResourceAction} className="flex gap-1.5">
                          <input type="hidden" name="resourceId" value={resource.id} />
                          <button type="submit" name="direction" value="up" disabled={index === 0} aria-label={`Move ${resource.name} up`} className={buttonClass("secondary", "sm", "w-11 px-0")}>
                            <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
                          </button>
                          <button type="submit" name="direction" value="down" disabled={index === resources.length - 1} aria-label={`Move ${resource.name} down`} className={buttonClass("secondary", "sm", "w-11 px-0")}>
                            <ArrowDown size={18} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                  {canEdit ? (
                    <details className="group">
                      <summary className={cn("inline-flex min-h-11 cursor-pointer list-none items-center rounded-input px-1 text-[14px] font-semibold text-accent-text underline underline-offset-2 [&::-webkit-details-marker]:hidden", focusRing)}>
                        Rename or delete <span className="sr-only">{resource.name}</span>
                      </summary>
                      <div className="mt-2 flex flex-col gap-3 rounded-input bg-grey-50 p-3">
                        <form action={renameResourceAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="resourceId" value={resource.id} />
                          <label className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                            <span className="text-[14px] font-semibold text-grey-800">New name for {resource.name}</span>
                            <input name="name" defaultValue={resource.name} maxLength={MAX_RESOURCE_NAME} required autoComplete="off" className={cn(inputClass, "border-grey-300")} />
                          </label>
                          <button type="submit" className={buttonClass("secondary")}>
                            Save name
                          </button>
                        </form>
                        <form action={deleteResourceAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="resourceId" value={resource.id} />
                          <button type="submit" className={buttonClass("secondary", "md", "border-[#b91c1c] text-[#991b1b] hover:border-[#991b1b]")}>
                            Delete {resource.name}
                          </button>
                          <span className="text-[13px] text-grey-600">Only if it has never had a booking.</span>
                        </form>
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Warehouse} title="Nothing here yet" description="Add a bay or a mobile van so customers can book." />
          )}
        </Panel>

        {canEdit ? (
          <Panel id="add-resource" title="Add a bay, van or technician">
            <AddResourceForm />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
