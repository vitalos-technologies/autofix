import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, buttonClass, PageHeader, Panel, SubmitButton, Switch, textLinkClass } from "@/components/admin-ui";
import { ProLockedPage, UsageMeter } from "@/components/plans";
import { voiceDeskStatus, workforceConnectionStatus } from "@/lib/ai-front-desk/hand-off";
import { AI_FRONT_DESK_MESSAGES } from "@/lib/ai-front-desk/forms";
import { listAgentTokens, loadAiFrontDeskSettings, loadAiMinutesThisMonth, loadAutofixNumber, voiceServiceConfigured, workforceConnection, type AgentTokenRow } from "@/lib/ai-front-desk/server";
import { garageHasFeature } from "@/lib/plans/server";
import { canChangeGarage, canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { FlashMessage, ReadOnlyNotice, SetupNotice } from "../_components/setup-nav";
import { revokeAgentTokenAction, setAiFrontDeskAction } from "./actions";
import { IssueTokenForm } from "./ai-front-desk-forms";

export const metadata: Metadata = { title: "AI front desk" };

const PATH = "/app/settings/ai-front-desk";

type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };

function when(iso: string | null, timeZone: string) {
  if (!iso) return "Never";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

function MissedCallsStillTextBack() {
  return (
    <SetupNotice>
      Missed calls still get a text back and can leave a voicemail on Essentials.{" "}
      <Link href="/app/messages/calls" className={textLinkClass}>See calls</Link>
    </SetupNotice>
  );
}

function TokenRow({ token, timeZone, canEdit }: { token: AgentTokenRow; timeZone: string; canEdit: boolean }) {
  const live = !token.revokedAt;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-grey-100 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
        <p className="m-0 text-[15px] font-semibold break-words text-navy-950">{token.name}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={token.audience === "workforce" ? "info" : "neutral"} size="xs">{token.audience === "workforce" ? "Workforce" : "Askbridge chat"}</Badge>
          <Badge tone={live ? "success" : "muted"} size="xs">{live ? "Live" : "Revoked"}</Badge>
        </div>
        <p className="m-0 text-[13px] text-grey-700">
          Created {when(token.createdAt, timeZone)} · Last used {when(token.lastUsedAt, timeZone)}
        </p>
      </div>
      {live && canEdit ? (
        <form action={revokeAgentTokenAction}>
          <input type="hidden" name="tokenId" value={token.id} />
          <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-auto")} aria-label={`Revoke token ${token.name}`}>
            Revoke
          </SubmitButton>
        </form>
      ) : null}
    </li>
  );
}

/**
 * Settings · AI front desk (P5.12, D17: Pro; voice desk AV1–AV10). The owner's switch for answering
 * missed calls with Autofix's AI front desk, whether calls are being answered, a test-call guide, this
 * month's AI minutes against the Pro allowance (the same numbers as Settings · Plan), and agent tokens
 * for other Vitalos agents (raw token shown once).
 */
export default async function AiFrontDeskSettingsPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const query = await searchParams;
  const { garage } = admin;
  const isOwner = canChangeGarage(admin.role);
  const canManage = canManageSetup(admin.role);

  if (!garageHasFeature(garage, "ai_front_desk")) {
    const settings = await loadAiFrontDeskSettings(admin.client, garage.id);
    return (
      <div className="flex flex-col gap-5 pb-10">
        <FlashMessage messages={AI_FRONT_DESK_MESSAGES} done={query.done} error={query.error} />
        <ProLockedPage feature="ai_front_desk" title="AI front desk" canUpgrade={admin.role === "owner"} hasExistingData={Boolean(settings?.enabledAt)} />
        <MissedCallsStillTextBack />
      </div>
    );
  }

  const [settings, tokens, minutes, autofixNumber] = await Promise.all([
    loadAiFrontDeskSettings(admin.client, garage.id),
    canManage ? listAgentTokens(admin.client) : Promise.resolve([] as AgentTokenRow[]),
    canManage ? loadAiMinutesThisMonth(admin.client, garage) : Promise.resolve(null),
    loadAutofixNumber(admin.client, garage.id),
  ]);
  const enabled = settings?.enabled ?? false;
  const connection = workforceConnection(tokens ?? []);
  const status = workforceConnectionStatus(connection);
  const overAllowance = Boolean(minutes && minutes.allowance !== null && minutes.used >= minutes.allowance);
  const calls = voiceDeskStatus({ serviceConfigured: voiceServiceConfigured(), enabled, hasNumber: Boolean(autofixNumber), overAllowance });
  const canSwitch = isOwner && admin.mfaVerified;
  const canEditTokens = canManage && admin.mfaVerified;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Setup"
        title="AI front desk"
        description="When nobody can get to the phone, the AI front desk answers, tells callers about your garage and asks for bookings for you to confirm."
      />
      <FlashMessage messages={AI_FRONT_DESK_MESSAGES} done={query.done} error={query.error} />
      {!isOwner ? <ReadOnlyNotice level="owner" /> : null}
      {(isOwner || canManage) && !admin.mfaVerified ? (
        <SetupNotice tone="warning">
          To change these settings, verify your sign-in first.{" "}
          <Link href={`/app/mfa?returnTo=${encodeURIComponent(PATH)}&stepUp=1`} className={textLinkClass}>Verify now</Link>
        </SetupNotice>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel id="switch" title="Answer missed calls with AI" actions={<Badge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</Badge>}>
            <div className="flex flex-col gap-4">
              <form action={setAiFrontDeskAction} className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p id="switch-label" className="m-0 text-[15px] font-semibold text-navy-950">AI front desk</p>
                  <p id="switch-help" className="m-0 text-[14px] leading-snug text-grey-700">
                    {enabled
                      ? "On: missed calls go to the AI front desk. If it can't take the call, the caller gets your voicemail and a text back."
                      : "Off: missed calls get your voicemail and a text back, as now."}
                  </p>
                </div>
                <Switch
                  type="submit"
                  name="enabled"
                  value={enabled ? "off" : "on"}
                  checked={enabled}
                  label="AI front desk"
                  describedBy="switch-help"
                  disabled={!canSwitch}
                />
              </form>
              {enabled && calls.tone === "warning" ? <SetupNotice>{calls.detail}</SetupNotice> : null}
              <p className="m-0 text-[13px] text-grey-700">
                Callers are told first that they are speaking to an automated assistant. The AI never confirms, moves or cancels a booking: everything it books shows as a request in Bookings for you to confirm, and what each call was about shows on the missed call. It always offers a call back from you.
              </p>
            </div>
          </Panel>

          {canManage ? (
            <Panel id="tokens" title="Tokens for other agents" actions={<Badge tone={status.tone}>{status.label}</Badge>}>
              <div className="flex flex-col gap-4">
                <p className="m-0 text-[14px] leading-snug text-grey-700">
                  Calls don&apos;t need a token. Another Vitalos agent (for example on WhatsApp) uses one to look up cars, check free times and ask for bookings at {garage.name}. {status.detail} Revoke a token to cut it off straight away.
                </p>
                <IssueTokenForm canEdit={canEditTokens} />
                {tokens === null ? (
                  <p className="m-0 text-[14px] text-grey-700">Tokens could not be loaded. Try again later.</p>
                ) : tokens.length ? (
                  <ul aria-label="Agent tokens" className="m-0 list-none p-0">
                    {tokens.map((token) => <TokenRow key={token.id} token={token} timeZone={garage.timezone} canEdit={canEditTokens} />)}
                  </ul>
                ) : (
                  <p className="m-0 text-[14px] text-grey-700">No tokens yet.</p>
                )}
              </div>
            </Panel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel id="connection" title="Calls" actions={<Badge tone={calls.tone}>{calls.label}</Badge>}>
            <dl className="m-0 flex flex-col gap-3 text-[14px]">
              <div className="flex flex-col gap-0.5">
                <dt className="font-semibold text-navy-950">Missed calls</dt>
                <dd className="m-0 text-grey-700">{calls.detail}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="font-semibold text-navy-950">Your Autofix number</dt>
                <dd className="m-0 text-grey-700">
                  {autofixNumber ? <a href={telHref(autofixNumber) ?? undefined} className={textLinkClass}>{formatPhoneForDisplay(autofixNumber)}</a> : "Not set up yet"}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel id="test-call" title="Try a test call">
            <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-snug text-grey-800">
              <li>Switch the AI front desk on above.</li>
              <li>From a mobile, call {autofixNumber ? <strong>{formatPhoneForDisplay(autofixNumber)}</strong> : "your Autofix number"}. If your own phone rings first, let it ring out.</li>
              <li>You&apos;ll hear: &ldquo;Hi, you&apos;re through to the automated assistant for {garage.name}.&rdquo; Ask for a time for a service, then book it.</li>
              <li>Hang up. The booking request shows in Bookings for you to confirm, and the call shows under Missed calls with what it was about.</li>
            </ol>
            <p className="mt-3 mb-0 text-[13px] text-grey-700">A test call uses AI minutes like any other call.</p>
          </Panel>

          {canManage ? (
            <Panel id="minutes" title="This month">
              {minutes ? (
                <UsageMeter line={minutes} note="Calls the AI front desk answered. When the allowance is used up, missed calls go back to your voicemail and a text back until next month." />
              ) : (
                <p className="m-0 text-[14px] text-grey-700">Minutes could not be loaded. Try again later.</p>
              )}
              <p className="mt-3 mb-0 text-[13px] text-grey-700">
                <Link href="/app/settings/plan#usage" className={textLinkClass}>See your plan and usage</Link>
              </p>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
