import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { focusRing } from "./styles";

export type DnsRecord = {
  /** `CNAME`, `A`, `TXT`… */
  type: string;
  /** Host / name, e.g. `book` (relative to the domain) or `@`. */
  name: string;
  /** Points to, e.g. `cname.vercel-dns-0.com`. */
  value: string;
  ttl?: string;
};

export type DnsRecordTableProps = {
  records: DnsRecord[];
  /** Screen reader name for the table. */
  caption?: string;
  className?: string;
};

const mono = "font-mono text-[14px] font-medium text-navy-950";

/**
 * The DNS records a garage adds at its domain provider, in JetBrains Mono with a copy button per
 * value. A table from 640px (scrolls inside its box if narrow); stacked cards on phones.
 */
export function DnsRecordTable({ records, caption = "DNS records to add", className }: DnsRecordTableProps) {
  const showTtl = records.some((record) => record.ttl);
  return (
    <div className={cn("font-sans leading-[normal]", className)}>
      {/* Phones: one card per record. */}
      <ul aria-label={caption} className="m-0 flex list-none flex-col gap-2 p-0 sm:hidden">
        {records.map((record) => (
          <li key={`${record.type}-${record.name}-${record.value}`} className="rounded-input bg-[#f7f9fb] p-3.5">
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">
              <dt className="text-[12px] font-bold tracking-[0.05em] text-grey-600 uppercase">Type</dt>
              <dd className={cn("m-0", mono)}>{record.type}</dd>
              <dt className="text-[12px] font-bold tracking-[0.05em] text-grey-600 uppercase">Name</dt>
              <dd className={cn("m-0 break-all", mono)}>{record.name}</dd>
              <dt className="text-[12px] font-bold tracking-[0.05em] text-grey-600 uppercase">Value</dt>
              <dd className={cn("m-0 break-all", mono)}>{record.value}</dd>
              {record.ttl ? (
                <>
                  <dt className="text-[12px] font-bold tracking-[0.05em] text-grey-600 uppercase">TTL</dt>
                  <dd className={cn("m-0", mono)}>{record.ttl}</dd>
                </>
              ) : null}
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={record.name} label="Copy name" srSuffix={record.name} size="sm" />
              <CopyButton value={record.value} label="Copy value" srSuffix={record.value} size="sm" />
            </div>
          </li>
        ))}
      </ul>

      {/* From 640px: the drawn table. */}
      <div role="region" aria-label={caption} tabIndex={0} className={cn("hidden overflow-x-auto rounded-input bg-[#f7f9fb] sm:block", focusRing)}>
        <table className="w-full min-w-[560px] border-collapse text-[14px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-left text-[12px] tracking-[0.05em] text-grey-600 uppercase">
              <th scope="col" className="px-3.5 py-2.5 font-bold">
                Type
              </th>
              <th scope="col" className="px-3.5 py-2.5 font-bold">
                Name / Host
              </th>
              <th scope="col" className="px-3.5 py-2.5 font-bold">
                Value / Points to
              </th>
              {showTtl ? (
                <th scope="col" className="px-3.5 py-2.5 font-bold">
                  TTL
                </th>
              ) : null}
              <th scope="col" className="px-3.5 py-2.5">
                <span className="sr-only">Copy</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={`${record.type}-${record.name}-${record.value}`} className="border-t border-grey-200">
                <td className={cn("px-3.5 py-2", mono)}>{record.type}</td>
                <td className={cn("px-3.5 py-2 break-all", mono)}>{record.name}</td>
                <td className={cn("px-3.5 py-2 break-all", mono)}>{record.value}</td>
                {showTtl ? <td className={cn("px-3.5 py-2", mono)}>{record.ttl ?? ""}</td> : null}
                <td className="px-3.5 py-2 text-right">
                  <CopyButton value={record.value} srSuffix={`value ${record.value}`} size="sm" className="rounded-[9px] text-[13px]" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
