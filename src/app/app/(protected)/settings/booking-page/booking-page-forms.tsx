"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { CheckboxField, FormMessage, TextAreaField, TextInputField } from "../_components/fields";
import { checkDomainAction, connectDomainAction, saveAskbridgeAction, saveEmbedOriginsAction } from "./actions";

/** Focus the first field with an error after a failed save. */
function useFocusOnError(state: SetupFormState, fields: Record<string, string>) {
  const handled = useRef(state.seq);
  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const field = Object.keys(fields).find((key) => state.fieldErrors?.[key]);
    if (field) document.getElementById(fields[field] ?? "")?.focus();
  }, [state, fields]);
}

const CONNECT_FIELDS = { hostname: "domain-hostname" };

/** Step 2 before a domain is added: the web address and Connect. */
export function ConnectDomainForm({ canEdit }: { canEdit: boolean }) {
  const [state, formAction] = useActionState<SetupFormState<"hostname">, FormData>(connectDomainAction, initialSetupFormState);
  // Controlled: React resets uncontrolled fields after every action, which would lose the address on an error.
  const [hostname, setHostname] = useState("");
  useFocusOnError(state, CONNECT_FIELDS);
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2.5">
        <TextInputField
          id="domain-hostname"
          name="hostname"
          label="Web address"
          hint="A subdomain of your own website, for example book.yourgarage.co.uk."
          placeholder="book.yourgarage.co.uk"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          maxLength={253}
          value={hostname}
          onChange={(event) => setHostname(event.target.value)}
          disabled={!canEdit}
          error={state.fieldErrors?.hostname}
          className="min-w-0 flex-[1_1_300px]"
        />
        <SubmitButton disabled={!canEdit} className={buttonClass("primary", "md", "w-full sm:w-auto")}>
          Connect
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

/** "Check now" (pending/verifying) or "Try again" (failed): the same check the background job runs. */
export function CheckDomainForm({ retry, canEdit, waitMinutes }: { retry: boolean; canEdit: boolean; waitMinutes: number }) {
  const [state, formAction] = useActionState<SetupFormState, FormData>(checkDomainAction, initialSetupFormState);
  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <input type="hidden" name="intent" value={retry ? "retry" : "check"} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton disabled={!canEdit} className={buttonClass(retry ? "primary" : "secondary", "md", "w-full sm:w-auto")}>
          <RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
          {retry ? "Try again" : "Check now"}
        </SubmitButton>
        {!retry && waitMinutes > 0 ? (
          <p className="m-0 text-[13px] text-grey-600">
            Checked a moment ago. You can check again in {waitMinutes} minute{waitMinutes === 1 ? "" : "s"}.
          </p>
        ) : null}
      </div>
      <FormMessage state={state} />
    </form>
  );
}

const ORIGIN_FIELDS = { origins: "embed-origins" };

/** Sites allowed to show the booking page in an iframe (CSP frame-ancestors). */
export function EmbedOriginsForm({ origins, canEdit }: { origins: string[]; canEdit: boolean }) {
  const [state, formAction] = useActionState<SetupFormState<"origins">, FormData>(saveEmbedOriginsAction, initialSetupFormState);
  const [value, setValue] = useState(origins.join("\n"));
  useFocusOnError(state, ORIGIN_FIELDS);
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <TextAreaField
        id="embed-origins"
        name="origins"
        label="Websites that may show your booking page"
        hint="Only needed for “Embed in a page”. One address per line, starting https://, for example https://www.yourgarage.co.uk. Other websites can't show it inside their pages."
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={3}
        spellCheck={false}
        autoCapitalize="none"
        disabled={!canEdit}
        error={state.fieldErrors?.origins}
        className="font-mono text-[14px]"
      />
      <FormMessage state={state} />
      <SubmitButton disabled={!canEdit} className={buttonClass("secondary", "md", "w-full sm:w-fit")}>
        Save websites
      </SubmitButton>
    </form>
  );
}

const ASKBRIDGE_FIELDS = { widgetId: "askbridge-widget-id" };

/** Askbridge chat on the booking page: widget id and on/off. */
export function AskbridgeForm({ enabled, widgetId, canEdit }: { enabled: boolean; widgetId: string | null; canEdit: boolean }) {
  const [state, formAction] = useActionState<SetupFormState<"widgetId">, FormData>(saveAskbridgeAction, initialSetupFormState);
  const [id, setId] = useState(widgetId ?? "");
  const [on, setOn] = useState(enabled);
  useFocusOnError(state, ASKBRIDGE_FIELDS);
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <TextInputField
        id="askbridge-widget-id"
        name="widgetId"
        label="Askbridge widget ID"
        hint="From your Askbridge account, under Install."
        value={id}
        onChange={(event) => setId(event.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={64}
        disabled={!canEdit}
        error={state.fieldErrors?.widgetId}
      />
      <CheckboxField id="askbridge-enabled" name="enabled" label="Show the chat on my booking page" checked={on} onChange={(event) => setOn(event.target.checked)} disabled={!canEdit} />
      <FormMessage state={state} />
      <SubmitButton disabled={!canEdit} className={buttonClass("secondary", "md", "w-full sm:w-fit")}>
        Save chat
      </SubmitButton>
    </form>
  );
}
