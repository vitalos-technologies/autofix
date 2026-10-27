import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DpaAcceptance } from "@/components/legal/dpa-acceptance";
import { loadDpaStatus } from "@/lib/legal/agreements";
import { getAdminContext } from "@/lib/tenancy/admin";

export const metadata: Metadata = { title: "Agreements" };

// Owner only: the garage's Data Processing Agreement with Vitalos (P4.9).
export default async function AgreementsPage() {
  const admin = await getAdminContext();
  if (!admin) redirect("/app/login");
  const isOwner = admin.role === "owner";
  const status = isOwner ? await loadDpaStatus(admin.client, admin.garage.id) : null;

  return (
    <>
      <p className="text-xs font-extrabold tracking-widest text-accent uppercase">Configuration</p>
      <h1 className="mt-2 text-4xl font-extrabold text-[#071127]">Agreements</h1>
      <p className="mt-3 max-w-2xl text-[#586575]">
        The terms under which Vitalos Technologies processes {admin.garage.name}&apos;s customer data for Autofix.
      </p>
      <nav aria-label="Configuration pages" className="mt-6 flex w-fit gap-1 rounded-xl border border-[#D7E0E9] bg-white p-1">
        <Link href="/app/settings" className="rounded-lg px-4 py-2 text-sm font-bold text-[#586575] hover:bg-[#F4F7FA] hover:text-accent">Settings</Link>
        <Link href="/app/configuration/security" className="rounded-lg px-4 py-2 text-sm font-bold text-[#586575] hover:bg-[#F4F7FA] hover:text-accent">Security</Link>
        <Link href="/app/settings/agreements" aria-current="page" className="rounded-lg bg-[#071127] px-4 py-2 text-sm font-bold text-white">Agreements</Link>
      </nav>
      <div className="mt-8 max-w-3xl">
        {status ? (
          <DpaAcceptance garage={admin.garage} status={status} canAccept />
        ) : (
          <p className="rounded-xl border border-[#D7E0E9] bg-white p-4 text-sm text-[#586575]">Only a garage owner can view and accept agreements.</p>
        )}
      </div>
    </>
  );
}
