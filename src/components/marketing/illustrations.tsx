import { BellRing, CalendarCheck, Check, MessageSquareText, PhoneMissed } from "lucide-react";
import { cn } from "@/lib/utils";

// Static, decorative product illustrations for the marketing page. Each sits inside an element with
// role="img" and a label, so assistive tech gets one description and nothing inside is focusable.
// Names, cars, times and figures are made up for the illustration.

export function PhoneFrame({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="img" aria-label={label} className={cn("relative w-[272px] rounded-[44px] bg-navy-950 p-[10px] shadow-[0_40px_80px_-30px_rgba(7,17,39,0.55)] md:w-[300px]", className)}>
      <div aria-hidden="true" className="absolute top-[18px] left-1/2 z-10 h-[22px] w-[92px] -translate-x-1/2 rounded-full bg-navy-950" />
      <div aria-hidden="true" className="relative overflow-hidden rounded-[34px] bg-grey-50">
        {children}
      </div>
    </div>
  );
}

export function Plate({ reg, className }: { reg: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-stretch overflow-hidden rounded-[8px] border-2 border-plate-ink/80 bg-plate", className)}>
      <span className="flex w-6 flex-col items-center justify-end bg-plate-band pb-1 text-[8px] leading-none font-bold text-white">UK</span>
      <span className="px-3 py-1.5 font-mono text-[22px] leading-none font-bold tracking-[0.06em] text-plate-ink">{reg}</span>
    </span>
  );
}

/** Book 1: the vehicle step of a garage's booking page. */
export function BookingScreen() {
  return (
    <div className="min-h-[560px] pb-6 md:min-h-[600px]">
      <div className="bg-navy-950 px-5 pt-12 pb-5 text-white">
        <p className="font-display text-[22px] leading-none font-bold">Kingsway Autocare</p>
        <div className="mt-4 flex gap-1.5">
          {[0, 1, 2, 3, 4].map((step) => (
            <span key={step} className={cn("h-1.5 flex-1 rounded-full", step === 0 ? "bg-brand-orange" : "bg-white/25")} />
          ))}
        </div>
      </div>
      <div className="px-5 pt-5">
        <p className="font-display text-[28px] leading-[1.05] font-bold text-navy-950">What are we booking in?</p>
        <p className="mt-1.5 text-[13px] leading-5 text-grey-600">Enter your registration and we&apos;ll find the car.</p>
        <Plate reg="AB12 CDE" className="mt-4" />
        <div className="mt-4 rounded-[16px] border border-grey-200 bg-white p-4 shadow-[0_6px_16px_-10px_rgba(7,17,39,0.25)]">
          <p className="text-[15px] font-semibold text-navy-950">Ford Focus</p>
          <p className="text-[13px] text-grey-600">1.0 petrol · 2018 · Blue</p>
          <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-[12px] font-semibold text-success-ink">
            <Check size={13} strokeWidth={3} /> MOT due 14 Mar
          </p>
        </div>
        <div className="mt-4 space-y-2">
          {[
            ["Full service", "£189"],
            ["MOT", "£54.85"],
            ["Diagnostics", "from £45"],
          ].map(([name, price], index) => (
            <div key={name} className={cn("flex items-center justify-between rounded-[12px] border bg-white px-3.5 py-3 text-[14px]", index === 1 ? "border-2 border-blue-700" : "border-grey-200")}>
              <span className="font-semibold text-navy-950">{name}</span>
              <span className="text-grey-700">{price}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-[14px] bg-blue-700 py-3.5 text-center text-[15px] font-semibold text-white">Choose a time</div>
      </div>
    </div>
  );
}

/** Today in the admin, on a phone. */
export function TodayScreen() {
  return (
    <div className="min-h-[540px] bg-grey-50 px-4 pt-12 pb-6 md:min-h-[580px]">
      <p className="text-[12px] font-semibold tracking-[0.08em] text-grey-600 uppercase">Tuesday</p>
      <p className="font-display text-[30px] leading-none font-bold text-navy-950">Today</p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {[
          ["9", "Booked in"],
          ["3", "In workshop"],
          ["2", "To collect"],
        ].map(([n, label]) => (
          <div key={label} className="rounded-[12px] border border-grey-200 bg-white px-2.5 py-2.5">
            <p className="font-display text-[24px] leading-none font-bold text-navy-950">{n}</p>
            <p className="mt-1 text-[11px] leading-4 text-grey-600">{label}</p>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[13px] font-semibold text-navy-950">Needs your OK</p>
      <div className="mt-2 rounded-[14px] bg-navy-950 p-3.5 text-white">
        <p className="text-[14px] font-semibold">Full service · Thu 10:00</p>
        <p className="text-[12px] text-white/75">Requested online · Bay 1</p>
        <div className="mt-3 flex gap-2">
          <span className="flex-1 rounded-[10px] bg-brand-orange py-2 text-center text-[13px] font-semibold text-navy-950">Accept</span>
          <span className="flex-1 rounded-[10px] border border-white/30 py-2 text-center text-[13px] font-semibold">Another time</span>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-3 rounded-[14px] border border-grey-200 bg-white p-3.5">
        <span className="grid size-9 place-items-center rounded-full bg-warning-bg text-warning-ink">
          <PhoneMissed size={17} />
        </span>
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold text-navy-950">Missed call · 11:42</span>
          <span className="block text-[12px] text-grey-600">Texted back with your booking link</span>
        </span>
      </div>
      <p className="mt-5 text-[13px] font-semibold text-navy-950">Bay 2</p>
      <div className="mt-2 space-y-2">
        {[
          ["08:30", "MOT · Vauxhall Astra", "bg-[#e6eefb] text-blue-700"],
          ["10:15", "Brakes · Ford Fiesta", "bg-success-bg text-success-ink"],
        ].map(([time, job, tone]) => (
          <div key={time} className="flex items-center gap-3 rounded-[12px] border border-grey-200 bg-white px-3 py-2.5">
            <span className="w-11 font-mono text-[12px] text-grey-600">{time}</span>
            <span className={cn("flex-1 truncate rounded-[8px] px-2 py-1 text-[12px] font-semibold", tone)}>{job}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Small floating cards beside the hero phone. */
export function FloatingCard({ kind }: { kind: "booked" | "reminder" }) {
  const booked = kind === "booked";
  return (
    <div aria-hidden="true" className="flex w-[232px] items-start gap-3 rounded-[16px] border border-grey-200 bg-white p-3.5 shadow-[0_20px_40px_-20px_rgba(7,17,39,0.35)]">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", booked ? "bg-success-bg text-success-ink" : "bg-[#ffedd5] text-[#9a3412]")}>
        {booked ? <CalendarCheck size={17} /> : <BellRing size={17} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] leading-5 font-semibold text-navy-950">{booked ? "Booked in" : "Reminder sent"}</span>
        <span className="block text-[12px] leading-4 text-grey-600">{booked ? "MOT · Tue 9:15 · Bay 2" : "MOT due in 28 days"}</span>
      </span>
    </div>
  );
}

/** Feature card panels. */
export function FeatureArt({ kind }: { kind: "booking" | "diary" | "reminders" | "calls" }) {
  if (kind === "booking") {
    return (
      <div className="w-[260px] rounded-[16px] border border-grey-200 bg-white p-4 shadow-[0_16px_32px_-20px_rgba(7,17,39,0.35)]">
        <p className="text-[13px] font-semibold text-navy-950">Wednesday 28 October</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {["08:30", "09:15", "10:00", "11:30", "13:45", "15:00"].map((time, index) => (
            <span
              key={time}
              className={cn(
                "rounded-[10px] border py-2 text-center font-mono text-[12px]",
                index === 1 ? "border-blue-700 bg-blue-700 font-semibold text-white" : index === 3 ? "border-grey-200 bg-grey-100 text-grey-600 line-through" : "border-grey-200 text-navy-950",
              )}
            >
              {time}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-grey-600">Only times with a free bay are shown.</p>
      </div>
    );
  }
  if (kind === "diary") {
    return (
      <div className="w-[280px] rounded-[16px] border border-grey-200 bg-white p-4 shadow-[0_16px_32px_-20px_rgba(7,17,39,0.35)]">
        {[
          ["Bay 1", [["w-[42%]", "bg-[#e6eefb]"], ["w-[30%]", "bg-success-bg"]]],
          ["Bay 2", [["w-[24%]", "bg-[#fff6cc]"], ["w-[50%]", "bg-[#e6eefb]"]]],
          ["Van", [["w-[36%]", "bg-success-bg"]]],
        ].map(([bay, blocks]) => (
          <div key={bay as string} className="flex items-center gap-3 py-1.5">
            <span className="w-11 text-[12px] font-semibold text-navy-950">{bay as string}</span>
            <span className="flex h-7 flex-1 gap-1.5 rounded-[8px] bg-grey-50 p-1">
              {(blocks as string[][]).map(([width, tone], index) => (
                <span key={index} className={cn("rounded-[6px]", width, tone)} />
              ))}
            </span>
          </div>
        ))}
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-grey-600">
          <span className="h-px flex-1 bg-danger" /> now
        </div>
      </div>
    );
  }
  if (kind === "reminders") {
    return (
      <div className="w-[270px] space-y-3">
        <div className="rounded-[16px] rounded-bl-[6px] bg-white p-3.5 text-[13px] leading-5 text-navy-950 shadow-[0_16px_32px_-20px_rgba(7,17,39,0.35)]">
          Kingsway Autocare: Hi Sam, MOT due 14 Mar. Book: kingsway.pitline…/r/… Reply STOP to opt out.
        </div>
        <div className="ml-auto w-fit rounded-[14px] bg-navy-950 px-4 py-3 text-white">
          <p className="text-[11px] tracking-[0.06em] text-white/75 uppercase">Won back this month</p>
          <p className="font-display text-[28px] leading-none font-bold text-brand-orange">£1,240</p>
        </div>
      </div>
    );
  }
  return (
    <div className="w-[270px] space-y-3">
      <div className="flex items-center gap-3 rounded-[16px] border border-grey-200 bg-white p-3.5 shadow-[0_16px_32px_-20px_rgba(7,17,39,0.35)]">
        <span className="grid size-9 place-items-center rounded-full bg-warning-bg text-warning-ink">
          <PhoneMissed size={17} />
        </span>
        <span>
          <span className="block text-[14px] font-semibold text-navy-950">Missed call · 11:42</span>
          <span className="block text-[12px] text-grey-600">Voicemail 0:18</span>
        </span>
      </div>
      <div className="ml-6 flex items-start gap-2 rounded-[16px] rounded-tl-[6px] bg-blue-700 p-3.5 text-[13px] leading-5 text-white">
        <MessageSquareText size={16} className="mt-0.5 shrink-0" />
        Sorry we missed you. Book online at kingsway.pitline… or we&apos;ll call you back.
      </div>
    </div>
  );
}
