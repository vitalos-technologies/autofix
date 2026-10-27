export type HealthState = "healthy" | "warning" | "degraded";

export type SystemHealthCheck = {
  label: string;
  status: string;
  detail: string;
  state: HealthState;
};

export function createSystemHealthChecks({
  websiteReady,
  databaseReady,
  emailReady,
  bookingReady,
  vehicleLookupReady,
}: {
  websiteReady: boolean;
  databaseReady: boolean;
  emailReady: boolean;
  bookingReady: boolean;
  vehicleLookupReady: boolean;
}): SystemHealthCheck[] {
  return [
    {
      label: "Website",
      status: websiteReady ? "Operational" : "Action required",
      detail: websiteReady ? "Public site URL is valid." : "Check the production site URL.",
      state: websiteReady ? "healthy" : "warning",
    },
    {
      label: "Database",
      status: databaseReady ? "Connected" : "Degraded",
      detail: databaseReady ? "Dashboard data is available." : "Some operational data could not be loaded.",
      state: databaseReady ? "healthy" : "degraded",
    },
    {
      label: "Email",
      status: emailReady ? "Configured" : "Action required",
      detail: emailReady ? "Notification delivery is configured." : "Email delivery configuration is incomplete.",
      state: emailReady ? "healthy" : "warning",
    },
    {
      label: "Booking",
      status: bookingReady ? "Configured" : "Action required",
      detail: bookingReady ? "Online appointment availability is configured." : "Add calendar credentials and verified service mappings.",
      state: bookingReady ? "healthy" : "warning",
    },
    {
      label: "Vehicle lookup",
      status: vehicleLookupReady ? "Connected" : "Action required",
      detail: vehicleLookupReady ? "DVLA lookup is configured." : "Vehicle lookup will use the manual fallback.",
      state: vehicleLookupReady ? "healthy" : "warning",
    },
  ];
}

export function formatRelativeTime(value: string, now = new Date()) {
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - now.getTime()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return formatter.format(days, "day");

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: "Europe/London",
  }).format(date);
}

/** Actions that read as a whole sentence (legal records, P4.9). */
const SENTENCE_ACTIONS: Record<string, string> = {
  "customer.opted_out": "Customer stopped reminders",
  "customer.opted_in": "Customer turned reminders back on",
  "agreement.accepted": "Accepted agreement",
};

const OPT_OUT_SOURCES: Record<string, string> = {
  unsubscribe_link: "via unsubscribe link",
  unsubscribe_form: "via unsubscribe page",
  unsubscribe_page: "via unsubscribe page",
  sms_stop: "by replying STOP",
  staff: "by staff",
};

export function auditActionLabel(action: string, entityType: string) {
  const sentence = SENTENCE_ACTIONS[action];
  if (sentence) return sentence;
  const entity = entityType.replaceAll("_", " ");
  const actions: Record<string, string> = {
    create: "Created",
    update: "Updated",
    publish: "Published",
    unpublish: "Unpublished",
    archive: "Archived",
    delete: "Deleted",
    rollback: "Restored",
    status_change: "Changed status of",
    notification_retry: "Retried notification for",
    upload: "Uploaded",
    sync: "Synced",
    scheduled_publish: "Published scheduled",
  };

  return `${actions[action] || action.replaceAll("_", " ")} ${entity}`;
}

export function auditEntityLabel(entityType: string, detail: unknown) {
  if (detail && typeof detail === "object") {
    const values = detail as Record<string, unknown>;
    if (entityType === "customer" && typeof values.source === "string") return OPT_OUT_SOURCES[values.source] ?? values.source.replaceAll("_", " ");
    if (entityType === "garage_agreement" && typeof values.version === "string") return `${String(values.kind ?? "").toUpperCase()} v${values.version}`.trim();
    if (typeof values.slug === "string") return values.slug.replaceAll("-", " ");
    if (typeof values.status === "string") return values.status.replaceAll("_", " ");
  }

  return entityType.replaceAll("_", " ");
}
