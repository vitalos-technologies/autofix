import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /** A button or link, e.g. "Add a bay". */
  action?: ReactNode;
  /** `card` draws its own white card; `plain` sits inside a Panel or table. */
  tone?: "card" | "plain";
  /** Heading level for the title; default a paragraph (no heading). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
};

/** What a list or table shows when it has nothing in it yet. */
export function EmptyState({ title, description, icon: Icon, action, tone = "plain", headingLevel, className }: EmptyStateProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-8 text-center font-sans leading-[normal]",
        tone === "card" && "rounded-card border border-grey-200 bg-white",
        className,
      )}
    >
      {Icon ? (
        <span aria-hidden="true" className="mb-1 flex size-11 items-center justify-center rounded-full bg-grey-100 text-grey-700">
          <Icon size={22} strokeWidth={2} />
        </span>
      ) : null}
      <Title className="m-0 font-sans text-[15px] font-bold tracking-normal text-navy-950">{title}</Title>
      {description ? <div className="m-0 max-w-[420px] text-[14px] leading-normal text-grey-600">{description}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2.5">{action}</div> : null}
    </div>
  );
}
