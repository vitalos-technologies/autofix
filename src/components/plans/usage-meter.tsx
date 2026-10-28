import type { UsageLine } from "@/lib/plans/usage";

const NAMES = { sms_segments: { title: "Texts this month", unit: "texts" }, ai_minutes: { title: "AI front desk minutes this month", unit: "minutes" } } as const;

function number(value: number) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);
}

/**
 * One usage line on the Plan page: used against the allowance, as a meter. The message never stops at
 * the allowance; what goes over is billed at cost, and the meter says so. While the allowance is still
 * a placeholder the line shows the count only.
 */
export function UsageMeter({ line, note }: { line: UsageLine; note?: string }) {
  const name = NAMES[line.metric];
  const over = line.overage !== null && line.overage > 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-[15px] font-bold text-navy-950">{name.title}</h3>
        <p className="m-0 text-[14px] text-grey-700">
          <span className="font-bold text-navy-950">{number(line.used)}</span>
          {line.allowance === null ? ` ${name.unit} · allowance to be confirmed` : ` of ${number(line.allowance)} ${name.unit}`}
        </p>
      </div>
      {line.percent !== null && line.allowance !== null ? (
        <meter
          className="h-2.5 w-full"
          min={0}
          max={100}
          low={80}
          high={99}
          optimum={0}
          value={line.percent}
          aria-label={`${name.title}: ${number(line.used)} of ${number(line.allowance)} ${name.unit}`}
        />
      ) : null}
      {over ? (
        <p className="m-0 text-[13.5px] font-semibold text-warning-ink">
          {number(line.overage as number)} {name.unit} over the allowance. Nothing was stopped; the extra is billed at cost.
        </p>
      ) : null}
      {note ? <p className="m-0 text-[13px] text-grey-700">{note}</p> : null}
    </div>
  );
}
