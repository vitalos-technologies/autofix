import { AdminLoadingLink } from "@/components/admin/admin-loading-link";

export function InvoiceLoadingLink({ href, children, className = "rounded-lg border border-[#CBD5E1] px-3 py-2 text-xs font-extrabold text-[#1D4ED8]", target, rel, transient = false, loadingTitle = "Loading invoice", loadingDescription = "Please wait while the invoice record opens." }: { href: string; children: React.ReactNode; className?: string; target?: string; rel?: string; transient?: boolean; loadingTitle?: string; loadingDescription?: string }) {
  return <AdminLoadingLink href={href} target={target} rel={rel} transient={transient} className={className} loadingTitle={loadingTitle} loadingDescription={loadingDescription}>{children}</AdminLoadingLink>;
}
