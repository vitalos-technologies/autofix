import Link from "next/link";
import { CountBadge, focusRing } from "@/components/admin-ui";
import { cn } from "@/lib/utils";

export type MessagesTab = "messages" | "calls";

export const MESSAGES_DESCRIPTION = "Texts, WhatsApp messages and emails with your customers, and the calls you've had.";

/** Messages | Calls, as the Setup sub-nav draws its links (A196). Counts: unread messages, missed calls waiting. */
export function MessagesTabs({ current, unread, missed }: { current: MessagesTab; unread: number; missed: number }) {
  const tabs = [
    { key: "messages" as const, label: "Messages", href: "/app/messages", count: unread, countLabel: `${unread} unread` },
    { key: "calls" as const, label: "Calls", href: "/app/messages/calls", count: missed, countLabel: `${missed} missed ${missed === 1 ? "call" : "calls"} to deal with` },
  ];
  return (
    <nav aria-label="Messages and calls" className="-mx-1 overflow-x-auto px-1 py-1">
      <ul className="m-0 flex w-max list-none gap-1 rounded-control border border-grey-200 bg-white p-1">
        {tabs.map((tab) => {
          const active = tab.key === current;
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-[10px] px-3.5 text-[14px] font-semibold whitespace-nowrap no-underline transition-colors",
                  active ? "bg-navy-950 text-white" : "text-grey-700 hover:bg-grey-100 hover:text-navy-950",
                  focusRing,
                )}
              >
                {tab.label}
                <CountBadge count={tab.count} label={tab.countLabel} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
