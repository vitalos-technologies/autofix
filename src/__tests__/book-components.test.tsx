// @vitest-environment jsdom

import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BookingSummaryBar,
  ConfirmationCard,
  ConsentCheckbox,
  DateStrip,
  GarageHeader,
  PlateChip,
  PlateInput,
  REMINDER_CONSENT_COPY,
  REMINDER_CONSENT_COPY_NO_MOT,
  SegmentedControl,
  ServiceOption,
  SlotGrid,
  StepProgress,
  StickyActionBar,
  SymptomChips,
  VehicleCard,
  dayPeriod,
  formatCalendarDate,
  formatDuration,
  formatPlateInput,
  formatRegistrationDisplay,
  formatServicePrice,
  formatSlotLabel,
  formatTime,
  garageInitials,
  type TimeSlot,
} from "@/components/book";

afterEach(() => {
  vi.restoreAllMocks();
});

function ControlledPlate({ initial = "", onValue }: { initial?: string; onValue?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <PlateInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

describe("plate formatting", () => {
  it("upper-cases and spaces current-format plates as they are typed", () => {
    expect(formatPlateInput("ab12cde")).toBe("AB12 CDE");
    expect(formatPlateInput("ab12c")).toBe("AB12 C");
    expect(formatPlateInput(" ab 12 cde ")).toBe("AB12 CDE");
    expect(formatPlateInput("AB12")).toBe("AB12");
    expect(formatPlateInput("AB12 ")).toBe("AB12 ");
  });

  it("keeps other formats as typed, strips symbols and stops at seven characters", () => {
    expect(formatPlateInput("a123 bcd")).toBe("A123 BCD");
    expect(formatPlateInput("abc-123d")).toBe("ABC123D");
    expect(formatPlateInput("ab12cdefg")).toBe("AB12 CDE");
    expect(formatPlateInput("a  b")).toBe("A B");
  });

  it("formats stored registrations for chips", () => {
    expect(formatRegistrationDisplay("AB12CDE")).toBe("AB12 CDE");
    expect(formatRegistrationDisplay("A123BCD")).toBe("A123 BCD");
    expect(formatRegistrationDisplay("ABC123D")).toBe("ABC 123D");
    expect(formatRegistrationDisplay("ab12 cde")).toBe("AB12 CDE");
  });
});

describe("PlateInput", () => {
  it("upper-cases and auto-spaces what the customer types", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<ControlledPlate onValue={onValue} />);
    const input = screen.getByLabelText("Registration");
    await user.type(input, "ab12cde");
    expect(input).toHaveValue("AB12 CDE");
    expect(onValue).toHaveBeenLastCalledWith("AB12 CDE");
  });

  it("is a plain, unnamed text field with autocomplete and spellcheck off", () => {
    render(<ControlledPlate />);
    const input = screen.getByLabelText("Registration");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("type", "text");
    expect(input).not.toHaveAttribute("name");
  });

  it("never writes the registration to the URL", async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const before = window.location.href;
    render(<ControlledPlate />);
    await user.type(screen.getByLabelText("Registration"), "ab12cde{enter}");
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toMatch(/AB12/i);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("links the error message and marks the field invalid", () => {
    render(<PlateInput value="ZZ99" onChange={() => undefined} error="We couldn't find that registration." />);
    const input = screen.getByLabelText("Registration");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("We couldn't find that registration.");
  });

  it("calls onEnter instead of submitting", async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    render(<PlateInput value="AB12 CDE" onChange={() => undefined} onEnter={onEnter} />);
    await user.type(screen.getByLabelText("Registration"), "{enter}");
    expect(onEnter).toHaveBeenCalledOnce();
  });
});

describe("ServiceOption prices", () => {
  it("formats pence as £x, From £x or Quote", () => {
    expect(formatServicePrice(4500, "fixed")).toBe("£45");
    expect(formatServicePrice(4550, "fixed")).toBe("£45.50");
    expect(formatServicePrice(18950, "from")).toBe("From £189.50");
    expect(formatServicePrice(120000, "from")).toBe("From £1,200");
    expect(formatServicePrice(null, "quote")).toBe("Quote");
    expect(formatServicePrice(4500, "quote")).toBe("Quote");
    expect(formatServicePrice(null, "fixed")).toBe("Quote");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 hr");
    expect(formatDuration(150)).toBe("2.5 hrs");
    expect(formatDuration(75)).toBe("1 hr 15 min");
    expect(formatDuration(null)).toBe("");
  });

  it("renders a real radio inside its label with the price and duration", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <fieldset>
        <legend>Choose a service</legend>
        <ServiceOption name="svc" value="a" label="Diagnostics" description="Warning lights" durationMinutes={60} pricePence={4500} priceMode="fixed" checked={false} onSelect={onSelect} />
        <ServiceOption name="svc" value="b" label="Full service" pricePence={18900} priceMode="from" checked={false} onSelect={onSelect} />
        <ServiceOption name="svc" value="c" label="Brakes" pricePence={null} priceMode="quote" checked={false} onSelect={onSelect} />
      </fieldset>,
    );
    const radio = screen.getByRole("radio", { name: /Diagnostics/ });
    expect(radio.closest("label")).not.toBeNull();
    expect(screen.getByText("£45")).toBeInTheDocument();
    expect(screen.getByText("Warning lights · 1 hr")).toBeInTheDocument();
    expect(screen.getByText("From £189")).toBeInTheDocument();
    expect(screen.getByText("Quote")).toBeInTheDocument();
    await user.click(screen.getByText("Full service"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});

describe("SlotGrid", () => {
  const slots: TimeSlot[] = [
    { starts_at: "2026-10-27T08:30:00Z", free_count: 2 },
    { starts_at: "2026-10-27T10:00:00Z", free_count: 0 },
    { starts_at: "2026-10-27T13:00:00Z", free_count: 1 },
    { starts_at: "2026-10-27T13:45:00Z", free_count: 0 },
    { starts_at: "2026-10-27T17:30:00Z", free_count: 1 },
  ];

  it("groups slots into Morning, Afternoon and Evening in local time", () => {
    render(<SlotGrid slots={slots} selected={null} onSelect={() => undefined} timeZone="Europe/London" />);
    const morning = screen.getByRole("group", { name: "Morning" });
    const afternoon = screen.getByRole("group", { name: "Afternoon" });
    const evening = screen.getByRole("group", { name: "Evening" });
    expect(within(morning).getAllByRole("button").map((button) => button.textContent)).toEqual(["08:30", "10:00 (taken)"]);
    expect(within(afternoon).getAllByRole("button").map((button) => button.textContent)).toEqual(["13:00", "13:45 (taken)"]);
    expect(within(evening).getAllByRole("button").map((button) => button.textContent)).toEqual(["17:30"]);
  });

  it("disables taken slots and never selects them", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SlotGrid slots={slots} selected={null} onSelect={onSelect} />);
    const taken = screen.getByRole("button", { name: "10:00 (taken)" });
    expect(taken).toBeDisabled();
    expect(taken).not.toHaveAttribute("aria-pressed");
    await user.click(taken);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "13:00" }));
    expect(onSelect).toHaveBeenCalledWith("2026-10-27T13:00:00Z");
  });

  it("marks the selected slot even when the timestamp is written differently", () => {
    render(<SlotGrid slots={slots} selected="2026-10-27T08:30:00.000+00:00" onSelect={() => undefined} />);
    expect(screen.getByRole("button", { name: "08:30" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "13:00" })).toHaveAttribute("aria-pressed", "false");
  });

  it("uses the garage clock either side of the October clock change", () => {
    // Friday 23 Oct 2026 is BST (UTC+1); Monday 26 Oct 2026 is GMT.
    expect(formatTime("2026-10-23T11:30:00Z")).toBe("12:30");
    expect(dayPeriod("2026-10-23T11:30:00Z")).toBe("afternoon");
    expect(formatTime("2026-10-26T11:30:00Z")).toBe("11:30");
    expect(dayPeriod("2026-10-26T11:30:00Z")).toBe("morning");
    expect(dayPeriod("2026-10-23T16:30:00Z")).toBe("evening");
    expect(formatSlotLabel("2026-10-27T09:15:00Z")).toBe("Tue 27 Oct, 09:15");
    expect(formatSlotLabel("2026-03-29T09:00:00Z")).toBe("Sun 29 Mar, 10:00");
  });

  it("shows a message when the day has no slots", () => {
    render(<SlotGrid slots={[]} selected={null} onSelect={() => undefined} />);
    expect(screen.getByText("No times left on this day. Try another day.")).toBeInTheDocument();
  });
});

describe("SymptomChips", () => {
  function Chips() {
    const [selected, setSelected] = useState<string[]>([]);
    const [note, setNote] = useState("");
    return (
      <SymptomChips
        options={[
          { value: "light", label: "Warning light" },
          { value: "noise", label: "Odd noise" },
        ]}
        selected={selected}
        onChange={setSelected}
        note={note}
        onNoteChange={setNote}
      />
    );
  }

  it("toggles aria-pressed on each chip", async () => {
    const user = userEvent.setup();
    render(<Chips />);
    const light = screen.getByRole("button", { name: "Warning light" });
    const noise = screen.getByRole("button", { name: "Odd noise" });
    expect(light).toHaveAttribute("aria-pressed", "false");
    await user.click(light);
    expect(light).toHaveAttribute("aria-pressed", "true");
    expect(noise).toHaveAttribute("aria-pressed", "false");
    await user.click(noise);
    await user.click(light);
    expect(light).toHaveAttribute("aria-pressed", "false");
    expect(noise).toHaveAttribute("aria-pressed", "true");
  });

  it("reveals and focuses a note field from Add a note", async () => {
    const user = userEvent.setup();
    render(<Chips />);
    const add = screen.getByRole("button", { name: "Add a note" });
    expect(add).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: "Note for the garage" })).not.toBeInTheDocument();
    await user.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    const note = screen.getByRole("textbox", { name: "Note for the garage" });
    expect(note).toHaveFocus();
    await user.type(note, "Squeak when braking");
    expect(note).toHaveValue("Squeak when braking");
  });
});

describe("DateStrip", () => {
  it("selects a day and marks it pressed; disabled days cannot be chosen", async () => {
    const user = userEvent.setup();
    function Strip() {
      const [selected, setSelected] = useState<string | null>("2026-10-26");
      return (
        <DateStrip
          days={[{ date: "2026-10-26" }, { date: "2026-10-27" }, { date: "2026-11-01", disabled: true }]}
          selected={selected}
          onSelect={setSelected}
        />
      );
    }
    render(<Strip />);
    const monday = screen.getByRole("button", { name: "Monday 26 October" });
    const tuesday = screen.getByRole("button", { name: "Tuesday 27 October" });
    const sunday = screen.getByRole("button", { name: "Sunday 1 November, no times left" });
    expect(monday).toHaveAttribute("aria-pressed", "true");
    await user.click(tuesday);
    expect(tuesday).toHaveAttribute("aria-pressed", "true");
    expect(monday).toHaveAttribute("aria-pressed", "false");
    expect(sunday).toBeDisabled();
    expect(within(tuesday).getByText("Tue")).toBeInTheDocument();
    expect(within(tuesday).getByText("27")).toBeInTheDocument();
  });

  it("moves focus between days with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<DateStrip days={[{ date: "2026-10-26" }, { date: "2026-10-27" }]} selected={null} onSelect={() => undefined} />);
    screen.getByRole("button", { name: "Monday 26 October" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Tuesday 27 October" })).toHaveFocus();
  });
});

describe("ConsentCheckbox", () => {
  it("is a real, unticked checkbox with the design copy by default", () => {
    render(<ConsentCheckbox name="reminder_consent" />);
    const box = screen.getByRole("checkbox", { name: REMINDER_CONSENT_COPY });
    expect(box).not.toBeChecked();
    expect(box).toHaveAttribute("name", "reminder_consent");
  });

  it("drops MOT from the copy when the garage has MOT off, and accepts custom copy", () => {
    const { rerender } = render(<ConsentCheckbox motEnabled={false} />);
    expect(screen.getByRole("checkbox", { name: REMINDER_CONSENT_COPY_NO_MOT })).not.toBeChecked();
    rerender(<ConsentCheckbox>Send me service reminders</ConsentCheckbox>);
    expect(screen.getByRole("checkbox", { name: "Send me service reminders" })).toBeInTheDocument();
  });

  it("reports changes when controlled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<ConsentCheckbox checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("checkbox"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe("VehicleCard", () => {
  const car = {
    make: "Ford",
    model: "Focus",
    year: 2018,
    engine: "1.0 petrol",
    colour: "Blue",
    motExpiry: "2027-03-14",
    lastMileage: 48210,
    now: new Date("2026-10-26T09:00:00Z"),
  };

  it("shows the MOT chip only when the garage has MOT on", () => {
    const { rerender } = render(<VehicleCard {...car} motEnabled />);
    expect(screen.getByText("MOT due 14 Mar 2027")).toBeInTheDocument();
    rerender(<VehicleCard {...car} motEnabled={false} />);
    expect(screen.queryByText(/MOT/)).not.toBeInTheDocument();
    expect(screen.getByText("Last mileage 48,210")).toBeInTheDocument();
  });

  it("shows make, model and the year · engine · colour line", () => {
    render(<VehicleCard {...car} motEnabled={false} selected />);
    expect(screen.getByText("Ford Focus")).toBeInTheDocument();
    expect(screen.getByText("2018 · 1.0 petrol · Blue")).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("flags an expired MOT", () => {
    render(<VehicleCard {...car} motExpiry="2026-09-30" motEnabled />);
    expect(screen.getByText("MOT expired 30 Sep 2026")).toBeInTheDocument();
    expect(formatCalendarDate("2027-03-14")).toBe("14 Mar 2027");
  });
});

describe("header, progress and summary", () => {
  it("GarageHeader shows initials, a labelled call link, or a labelled back link", () => {
    const { rerender } = render(<GarageHeader name="Hartley Road Motors" subtitle="Doncaster" phone="+441302000000" />);
    expect(screen.getByText("HR")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call Hartley Road Motors" })).toHaveAttribute("href", "tel:+441302000000");
    rerender(<GarageHeader name="Hartley Road Motors" back={{ href: "/", label: "Back to vehicle" }} />);
    expect(screen.getByRole("link", { name: "Back to vehicle" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: /Call/ })).not.toBeInTheDocument();
    expect(garageInitials("Kwik-Fit")).toBe("KW");
  });

  it("GarageHeader puts a labelled Contact button beside a solid, labelled Call button", () => {
    const { rerender } = render(<GarageHeader name="Hartley Road Motors" subtitle="Doncaster" phone="+441302000000" contactHref="/contact" />);
    const contact = screen.getByRole("link", { name: "Contact Hartley Road Motors" });
    const call = screen.getByRole("link", { name: "Call Hartley Road Motors" });
    expect(contact).toHaveAttribute("href", "/contact");
    expect(contact).toHaveTextContent("Contact");
    expect(call).toHaveAttribute("href", "tel:+441302000000");
    expect(call).toHaveTextContent("Call");
    // Call is the solid accent button; both are 46px tall and sit together.
    expect(call).toHaveClass("bg-accent", "text-accent-ink", "h-[46px]");
    expect(contact).toHaveClass("h-[46px]");
    expect(call.parentElement).toBe(contact.parentElement);
    expect(contact.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // No phone: Contact only. With a back button (steps 2 to 4): neither.
    rerender(<GarageHeader name="Hartley Road Motors" contactHref="/contact" />);
    expect(screen.getByRole("link", { name: "Contact Hartley Road Motors" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Call/ })).not.toBeInTheDocument();
    rerender(<GarageHeader name="Hartley Road Motors" phone="+441302000000" contactHref="/contact" back={{ href: "/", label: "Back to vehicle" }} />);
    expect(screen.queryByRole("link", { name: /^Contact/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Call/ })).not.toBeInTheDocument();
  });

  it("GarageHeader's light tone (white confirmation page) has no navy strip and navy text", () => {
    render(<GarageHeader tone="light" name="Hartley Road Motors" phone="+441302000000" />);
    const header = screen.getByRole("banner");
    expect(header).not.toHaveClass("bg-navy-950");
    expect(screen.getByText("Hartley Road Motors")).toHaveClass("text-navy-950");
    // The call button keeps a visible focus ring on white (the garage accent, not white).
    expect(screen.getByRole("link", { name: "Call Hartley Road Motors" }).className).toContain("focus-visible:outline-accent");
  });

  it("StepProgress exposes progressbar semantics", () => {
    render(<StepProgress step={2} />);
    const bar = screen.getByRole("progressbar", { name: "Booking progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "5");
    expect(bar).toHaveAttribute("aria-valuetext", "Step 2 of 5: Service");
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
  });

  it("SegmentedControl is a labelled group of aria-pressed buttons", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Where?"
        options={[
          { value: "workshop", label: "At the workshop" },
          { value: "mobile", label: "Mobile visit" },
        ]}
        value="workshop"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "Where?" });
    expect(within(group).getByRole("button", { name: "At the workshop" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "Mobile visit" }));
    expect(onChange).toHaveBeenCalledWith("mobile");
  });

  it("BookingSummaryBar and PlateChip format the registration and time", () => {
    render(
      <>
        <BookingSummaryBar registration="AB12CDE" service="Diagnostics" mode="Workshop" start="2026-10-27T09:15:00Z" editHref="/time" />
        <PlateChip registration="a123bcd" />
      </>,
    );
    expect(screen.getByText("AB12 CDE")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics · Workshop")).toBeInTheDocument();
    expect(screen.getByText("Tue 27 Oct · 09:15")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit booking" })).toHaveAttribute("href", "/time");
    expect(screen.getByText("A123 BCD")).toBeInTheDocument();
  });

  it("StickyActionBar renders a link or a busy button", () => {
    const { rerender } = render(<StickyActionBar label="Continue" href="/service" footnote="Powered by Autofix" />);
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/service");
    expect(screen.getByText("Powered by Autofix")).toBeInTheDocument();
    rerender(<StickyActionBar label="Confirm booking" type="submit" busy />);
    const button = screen.getByRole("button", { name: "Confirm booking" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("ConfirmationCard shows the reference, facts and only the actions it is given", () => {
    render(
      <ConfirmationCard
        reference="ABC-1234"
        when="Tue 27 Oct, 09:15"
        vehicle="Ford Focus · AB12 CDE"
        service="Diagnostics"
        location="Workshop, DN1"
        calendarHref="/api/bookings/ics"
        manageHref="/manage"
      />,
    );
    expect(screen.getByText("ABC-1234")).toBeInTheDocument();
    expect(screen.getByText("When").nextElementSibling).toHaveTextContent("Tue 27 Oct, 09:15");
    expect(screen.getByRole("link", { name: "Add to calendar" })).toHaveAttribute("href", "/api/bookings/ics");
    expect(screen.getByRole("link", { name: "Change or cancel" })).toHaveAttribute("href", "/manage");
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("ConfirmationCard is a bordered light card with light actions for the white page", () => {
    render(<ConfirmationCard reference="ABC-1234" when="Tue 27 Oct, 09:15" vehicle="Ford Focus" service="Diagnostics" location="Workshop, DN1" manageHref="/manage" />);
    const card = screen.getByText("ABC-1234").closest("div.rounded-hero");
    expect(card).toHaveClass("border", "border-grey-200", "bg-white");
    const manage = screen.getByRole("link", { name: "Change or cancel" });
    expect(manage).toHaveClass("text-navy-950", "border-grey-300");
    expect(manage.className).toContain("focus-visible:outline-accent");
    expect(manage.className).not.toContain("outline-white");
  });
});
