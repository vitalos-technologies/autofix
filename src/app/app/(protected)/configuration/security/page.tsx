import { CheckCircle2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { MfaSecurityPanel } from "./mfa-security-panel";
import { TrustedDevicesPanel } from "./trusted-devices-panel";
import { RecoveryCodesPanel } from "./recovery-codes-panel";
import { createAdminClient } from "@/lib/supabase/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { getCurrentTrustedDevice } from "@/lib/auth/trusted-device-server";
import { getMfaRecoveryCodeSummary } from "@/lib/auth/mfa-recovery-server";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ enabled?: string; removed?: string }> }) {
  const admin = await getAdminContext();
  const { enabled, removed } = await searchParams;
  const { data } = admin ? await admin.client.auth.mfa.listFactors() : { data: null };
  const factor = data?.totp[0];
  const service = createAdminClient();
  const current = admin ? await getCurrentTrustedDevice(admin.user.id, { touch: false }) : null;
  const recoveryCodes = admin && factor ? await getMfaRecoveryCodeSummary(admin.user.id) : { total: 0, remaining: 0 };
  const { data: trustedDevices } = admin && service ? await service.from("admin_trusted_devices").select("id,device_label,created_at,expires_at,last_used_at").eq("user_id", admin.user.id).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }) : { data: [] };
  const devices = (trustedDevices || []).map((device) => ({ ...device, current: device.id === current?.id }));
  return <><p className="text-xs font-extrabold tracking-widest text-accent uppercase">Configuration</p><h1 className="mt-2 text-4xl font-extrabold text-[#0f2747]">Security</h1><p className="mt-3 max-w-2xl text-[#475569]">Manage sign-in protection for your Pitline account.</p><nav aria-label="Configuration pages" className="mt-6 flex w-fit gap-1 rounded-xl border border-[#CBD5E1] bg-white p-1"><Link href="/app/settings" className="rounded-lg px-4 py-2 text-sm font-bold text-[#475569] hover:bg-[#F8FAFC] hover:text-accent">Settings</Link><Link href="/app/configuration/security" aria-current="page" className="rounded-lg bg-[#0f2747] px-4 py-2 text-sm font-bold text-white">Security</Link><Link href="/app/settings/agreements" className="rounded-lg px-4 py-2 text-sm font-bold text-[#475569] hover:bg-[#F8FAFC] hover:text-accent">Agreements</Link></nav>{(enabled === "success" || removed === "success") && <div role="status" className="mt-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-bold text-green-900"><CheckCircle2 size={19} />{enabled === "success" ? "Two-factor authentication is now enabled." : "Two-factor authentication has been removed."}</div>}<div className="mt-8"><div className="mb-5 flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EFF6FF] text-accent"><ShieldCheck size={20} /></span><div><h2 className="text-2xl font-bold text-[#0f2747]">Two-factor authentication</h2><p className="mt-1 text-sm leading-6 text-[#475569]">Add an extra layer of security to your account using an authenticator app.</p></div></div><MfaSecurityPanel factorId={factor?.id} /></div>{factor && <RecoveryCodesPanel remaining={recoveryCodes.remaining} total={recoveryCodes.total} />}<TrustedDevicesPanel devices={devices} /></>;
}
