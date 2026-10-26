// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LayoutDashboard } from "lucide-react";
import {
  AdminTabBar,
  ApprovalCard,
  AutomationRow,
  DiaryGrid,
  DomainStatusSteps,
  EmbedSnippet,
  JobCard,
  KpiCard,
  MessagePreview,
  STATUS_PILLS,
  StatusPill,
  Switch,
  TemplateEditor,
  diaryPlacement,
  domainSteps,
  formatReceived,
  resolveActiveHref,
  type DiaryBooking,
  type ReminderOutcome,
  type ReminderSendStatus,
} from "@/components/admin-ui";
import { bookingStatuses } from "@/lib/booking-engine/types";

const RESOURCES = [
  { id: "bay-1", name: "Bay 1" },
  { id: "bay-2", name: "Bay 2" },
];

function booking(overrides: Partial<DiaryBooking> = {}): DiaryBooking {
  return {
    id: "b1",
    resourceId: "bay-2",
    startsAt: "2026-10-27T09:15:00Z",
    endsAt: "2026-10-27T10:15:00Z",
    status: "confirmed",
    registration: "AB12CDE",
    service: "Diagnostics",
    vehicle: "Focus",
    href: "/app/bookings/b1",
    ...overrides,
  };
}

const REMINDER_STATUSES: (ReminderSendStatus | ReminderOutcome)[] = [
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "failed",
  "cancelled",
  "skipped",
  "booked",
  "no_consent",
];

describe("StatusPill", () => {
  it("has a human label for every booking status", () => {
    const expected: Record<(typeof bookingStatuses)[number], string> = {
      requested: "Needs OK",
      confirmed: "Booked",
      arrived: "Arrived",
      in_progress: "In bay",
      waiting_parts: "Waiting parts",
      ready: "Ready",
      collected: "Collected",
      cancelled: "Cancelled",
      no_show: "No-show",
    };
    for (const status of bookingStatuses) {
      const { unmount } = render(<StatusPill status={status} />);
      expect(screen.getByText(expected[status])).toBeInTheDocument();
      unmount();
    }
  });

  it("has a human label for every reminder status", () => {
    const expected: Record<ReminderSendStatus | ReminderOutcome, string> = {
      scheduled: "Scheduled",
      sending: "Sending",
      sent: "Sent",
      delivered: "Delivered",
      failed: "Failed",
      cancelled: "Cancelled",
      skipped: "Skipped",
      booked: "Booked",
      no_consent: "No consent, won't send",
    };
    for (const status of REMINDER_STATUSES) {
      const { unmount } = render(<StatusPill status={status} />);
      expect(screen.getByText(expected[status])).toBeInTheDocument();
      unmount();
    }
  });

  it("follows the design colour rules", () => {
    expect(STATUS_PILLS.confirmed.tone).toBe("neutral");
    expect(STATUS_PILLS.in_progress.tone).toBe("info");
    expect(STATUS_PILLS.sent.tone).toBe("info");
    expect(STATUS_PILLS.waiting_parts.tone).toBe("warning");
    expect(STATUS_PILLS.ready.tone).toBe("success");
    expect(STATUS_PILLS.booked.tone).toBe("success");
  });

  it("shows the short label but keeps the full one for screen readers", () => {
    render(<StatusPill status="waiting_parts" compact />);
    expect(screen.getByText("Parts")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Waiting parts")).toHaveClass("sr-only");
  });

  it("keeps the colour with a custom label", () => {
    render(<StatusPill status="sent" label="Sent 10 Oct" />);
    expect(screen.getByText("Sent 10 Oct")).toHaveClass("bg-info-bg");
  });
});

describe("DiaryGrid", () => {
  it("positions a 09:15 to 10:15 booking in its row", () => {
    render(<DiaryGrid resources={RESOURCES} bookings={[booking()]} date="2026-10-27" timeZone="Europe/London" />);

    const bay2 = screen.getByRole("group", { name: "Bay 2" });
    const block = within(bay2).getByRole("link", { name: "AB12 CDE, Diagnostics, 09:15 to 10:15, Bay 2, Booked" });
    expect(block).toHaveAttribute("href", "/app/bookings/b1");
    const cell = block.closest("li");
    // 08:00 to 17:00 is 540 minutes: 09:15 is 75 minutes in (13.8889%), an hour is 11.1111%.
    expect(cell).toHaveAttribute("data-start-minute", "75");
    expect(cell).toHaveAttribute("data-length-minutes", "60");
    expect(cell?.style.left).toBe("13.8889%");
    expect(cell?.style.width).toBe("11.1111%");

    expect(within(screen.getByRole("group", { name: "Bay 1" })).queryAllByRole("link")).toHaveLength(0);
    expect(within(block).getByText("Diagnostics")).toBeInTheDocument();
    expect(within(block).getByText("AB12 CDE · Focus")).toBeInTheDocument();
  });

  it("honours a custom start and end hour", () => {
    expect(diaryPlacement("2026-10-27T09:15:00Z", "2026-10-27T10:15:00Z", { date: "2026-10-27", startHour: 9, endHour: 13 })).toMatchObject({
      offset: 15,
      length: 60,
      left: 6.25,
      width: 25,
    });
  });

  it("clips bookings at the edges and drops ones outside the day", () => {
    expect(diaryPlacement("2026-10-27T07:30:00Z", "2026-10-27T08:30:00Z", { date: "2026-10-27" })).toMatchObject({
      offset: 0,
      length: 30,
      clippedStart: true,
    });
    expect(diaryPlacement("2026-10-28T09:00:00Z", "2026-10-28T10:00:00Z", { date: "2026-10-27" })).toBeNull();
    expect(diaryPlacement("2026-10-27T17:30:00Z", "2026-10-27T18:00:00Z", { date: "2026-10-27" })).toBeNull();
  });

  it("draws the now line only when now is on the day shown", () => {
    const { rerender, container } = render(
      <DiaryGrid resources={RESOURCES} bookings={[booking()]} date="2026-10-27" now="2026-10-27T10:45:00Z" />,
    );
    const line = container.querySelector<HTMLElement>("[data-now-line]");
    expect(line).not.toBeNull();
    // 10:45 is 165 of 540 minutes.
    expect(line?.style.left).toBe("30.5556%");
    expect(screen.getByRole("heading", { name: "Today's diary" })).toBeInTheDocument();

    rerender(<DiaryGrid resources={RESOURCES} bookings={[booking()]} date="2026-10-27" now="2026-10-26T10:45:00Z" />);
    expect(container.querySelector("[data-now-line]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Diary, Tue 27 Oct" })).toBeInTheDocument();

    rerender(<DiaryGrid resources={RESOURCES} bookings={[booking()]} date="2026-10-27" />);
    expect(container.querySelector("[data-now-line]")).toBeNull();

    // Today, but after the hours shown.
    rerender(<DiaryGrid resources={RESOURCES} bookings={[booking()]} date="2026-10-27" now="2026-10-27T18:10:00Z" />);
    expect(container.querySelector("[data-now-line]")).toBeNull();
  });

  it("uses the wall clock across the 25 Oct 2026 clock change", () => {
    // Sat 24 Oct is BST (UTC+1): 08:15Z is 09:15 local. Sun 25 Oct is GMT from 02:00: 09:15Z is 09:15.
    const saturday = booking({ id: "sat", startsAt: "2026-10-24T08:15:00Z", endsAt: "2026-10-24T09:15:00Z" });
    const sunday = booking({ id: "sun", startsAt: "2026-10-25T09:15:00Z", endsAt: "2026-10-25T10:15:00Z" });

    const { container, rerender } = render(
      <DiaryGrid resources={RESOURCES} bookings={[saturday, sunday]} date="2026-10-24" now="2026-10-24T09:00:00Z" />,
    );
    let cell = container.querySelector<HTMLElement>('[data-booking-id="sat"]');
    expect(cell?.style.left).toBe("13.8889%");
    expect(container.querySelector('[data-booking-id="sun"]')).toBeNull();
    // 09:00Z on Saturday is 10:00 BST.
    expect(container.querySelector<HTMLElement>("[data-now-line]")?.style.left).toBe("22.2222%");

    rerender(<DiaryGrid resources={RESOURCES} bookings={[saturday, sunday]} date="2026-10-25" now="2026-10-25T10:00:00Z" />);
    cell = container.querySelector<HTMLElement>('[data-booking-id="sun"]');
    expect(cell?.style.left).toBe("13.8889%");
    expect(cell?.style.width).toBe("11.1111%");
    expect(screen.getByRole("link", { name: /09:15 to 10:15/ })).toBeInTheDocument();
    expect(container.querySelector('[data-booking-id="sat"]')).toBeNull();
    // 10:00Z on Sunday is 10:00 GMT.
    expect(container.querySelector<HTMLElement>("[data-now-line]")?.style.left).toBe("22.2222%");
  });

  it("puts bookings with no known resource in an Unassigned row and leaves out cancelled ones", () => {
    render(
      <DiaryGrid
        resources={RESOURCES}
        bookings={[booking({ id: "x", resourceId: null }), booking({ id: "c", resourceId: "bay-1", status: "cancelled" })]}
        date="2026-10-27"
      />,
    );
    expect(within(screen.getByRole("group", { name: "Unassigned" })).getAllByRole("link")).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "Bay 1" })).queryAllByRole("link")).toHaveLength(0);
  });

  it("shows an empty state without resources", () => {
    render(<DiaryGrid resources={[]} bookings={[]} date="2026-10-27" />);
    expect(screen.getByText("No bays or vans set up yet.")).toBeInTheDocument();
  });
});

describe("Switch", () => {
  it("toggles aria-checked and reports the new state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="MOT due reminders" onCheckedChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "MOT due reminders" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(onChange).toHaveBeenLastCalledWith(true);
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stays on the state it is given when controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="Review requests" checked onCheckedChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Review requests" });
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("posts the next state from an AutomationRow form", () => {
    render(
      <AutomationRow name="MOT due" description="28 and 7 days before expiry" channel="sms" enabled ruleId="r1" toggleAction="/api/rules" editHref="/app/reminders/mot" />,
    );
    const toggle = screen.getByRole("switch", { name: "MOT due" });
    expect(toggle).toHaveAttribute("type", "submit");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("28 and 7 days before expiry");
    const form = toggle.closest("form");
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveFormValues({ ruleId: "r1", enabled: "false" });
    expect(screen.getByRole("link", { name: "Edit MOT due" })).toHaveAttribute("href", "/app/reminders/mot");
    expect(screen.getByText("SMS")).toBeInTheDocument();
  });
});

describe("TemplateEditor", () => {
  const sample = { first_name: "Priya", vehicle: "Toyota Yaris", reg: "BC23 DEF", due_date: "3 Nov", link: "book.example.co.uk/r/7KQ2", garage: "Hartley Road Motors" };

  it("inserts a placeholder at the caret and updates the counter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TemplateEditor label="MOT message" defaultValue="Hi , your MOT is due." sampleValues={sample} onChange={onChange} />);
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "MOT message" });

    // "Hi , your MOT is due. Reply STOP to opt out." is 44 characters.
    expect(field).toHaveAccessibleDescription(/44 of 160 characters · 1 text/);

    field.focus();
    field.setSelectionRange(3, 3);
    await user.click(screen.getByRole("button", { name: "{first_name}" }));

    expect(field.value).toBe("Hi {first_name}, your MOT is due.");
    expect(onChange).toHaveBeenLastCalledWith("Hi {first_name}, your MOT is due.");
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(15);
    // Counted with the sample name: "Priya" adds 5.
    expect(field).toHaveAccessibleDescription(/49 of 160 characters · 1 text/);
  });

  it("replaces a selection and warns when the message needs two texts", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor defaultValue={`Hello NAME. ${"x".repeat(140)}`} sampleValues={sample} />);
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    field.setSelectionRange(6, 10);
    await user.click(screen.getByRole("button", { name: "{garage}" }));
    expect(field.value.startsWith("Hello {garage}.")).toBe(true);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/This sends as 2 texts/);
    expect(field).toHaveAccessibleDescription(/characters · 2 texts/);
  });

  it("previews the rendered message with the opt-out line", () => {
    render(<MessagePreview template="Hi {first_name}, book: {link}" values={sample} senderName="HartleyRd" />);
    expect(screen.getByText("HartleyRd · Text message")).toBeInTheDocument();
    expect(screen.getByText("book.example.co.uk/r/7KQ2")).toHaveClass("underline");
    expect(screen.getByText(/Reply STOP to opt out\./)).toBeInTheDocument();
  });
});

describe("DomainStatusSteps", () => {
  function states() {
    return screen.getAllByRole("listitem").map((item) => item.getAttribute("data-state"));
  }

  it("maps each garage_domains status to the three steps", () => {
    const { rerender } = render(<DomainStatusSteps status="pending_dns" />);
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(screen.getByText("Looking for the record…")).toBeInTheDocument();

    rerender(<DomainStatusSteps status="verifying" />);
    expect(states()).toEqual(["done", "current", "upcoming"]);
    expect(screen.getByText("Record found")).toBeInTheDocument();
    expect(screen.getByText("Securing (HTTPS)…").closest("li")).toHaveAttribute("aria-current", "step");

    rerender(<DomainStatusSteps status="active" />);
    expect(states()).toEqual(["done", "done", "done"]);
    expect(screen.getByText("Live")).toBeInTheDocument();

    rerender(<DomainStatusSteps status="failed" error="The record points somewhere else." hostname="book.example.co.uk" />);
    expect(states()).toEqual(["failed", "upcoming", "upcoming"]);
    expect(screen.getByText(/We couldn't connect book.example.co.uk\./)).toBeInTheDocument();
    expect(screen.getByText(/The record points somewhere else\./)).toBeInTheDocument();
  });

  it("marks the step that failed when it is known", () => {
    expect(domainSteps("failed", 2).map((step) => step.state)).toEqual(["done", "failed", "upcoming"]);
  });
});

describe("EmbedSnippet", () => {
  it("is a keyboard-operable tablist", async () => {
    const user = userEvent.setup();
    render(<EmbedSnippet bookingUrl="https://book.example.co.uk" accent="#155fba" garageName="Hartley Road Motors" />);
    const tabs = within(screen.getByRole("tablist", { name: "Ways to add it" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(['"Book online" button', "/book redirect", "Embed in a page"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveTextContent('<a href="https://book.example.co.uk"');

    await user.tab();
    expect(tabs[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "/book redirect" })).toHaveTextContent("From: /book To: https://book.example.co.uk");

    await user.keyboard("{End}");
    expect(tabs[2]).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Embed in a page" })).toHaveTextContent('title="Book online with Hartley Road Motors"');

    await user.keyboard("{ArrowRight}");
    expect(tabs[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tabs[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    // Tab leaves the tablist for the panel's copy button.
    await user.tab();
    expect(screen.getByRole("button", { name: /Copy "Book online" button code/ })).toHaveFocus();
  });
});

describe("navigation", () => {
  it("matches the active page to the most specific href", () => {
    const hrefs = ["/app", "/app/bookings", "/app/settings", "/app/settings/services"];
    expect(resolveActiveHref(hrefs, "/app")).toBe("/app");
    expect(resolveActiveHref(hrefs, "/app/bookings/123")).toBe("/app/bookings");
    expect(resolveActiveHref(hrefs, "/app/settings/services")).toBe("/app/settings/services");
    expect(resolveActiveHref(hrefs, "/app/settings/hours")).toBe("/app/settings");
    expect(resolveActiveHref(hrefs, "/app/unknown")).toBeNull();
    expect(resolveActiveHref(hrefs, "/app/")).toBe("/app");
  });

  it("does not treat a different query string as the same page", () => {
    const hrefs = ["/x", "/x?view=a", "/x?view=b#part"];
    expect(resolveActiveHref(hrefs, "/x?view=c")).toBeNull();
    expect(resolveActiveHref(hrefs, "/x?view=b")).toBe("/x?view=b#part");
    expect(resolveActiveHref(hrefs, "/x?view=a")).toBe("/x?view=a");
    expect(resolveActiveHref(hrefs, "/x#top")).toBe("/x");
  });

  it("marks the current tab", () => {
    render(<AdminTabBar activeHref="/app/diary" fixed={false} />);
    expect(screen.getByRole("link", { name: "Diary" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "New booking" })).toHaveAttribute("href", "/app/bookings/new");
  });

  it("accepts custom tabs", () => {
    render(<AdminTabBar activeHref="/x" fixed={false} tabs={[{ label: "Home", href: "/x", icon: LayoutDashboard }]} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });
});

describe("cards", () => {
  it("ApprovalCard posts the booking id with Accept and words the source", () => {
    render(
      <ApprovalCard
        bookingId="bk_1"
        registration="WX15YZA"
        source="missed_call"
        receivedAt="2026-10-27T08:12:00Z"
        now="2026-10-27T10:00:00Z"
        customerName="James P."
        service="Mobile visit, DN5"
        detail="Won't start"
        acceptAction="/api/accept"
        secondary={{ href: "tel:+441302000000" }}
      />,
    );
    expect(screen.getByText("From missed call · 08:12")).toBeInTheDocument();
    const accept = screen.getByRole("button", { name: "Accept for WX15 YZA, James P." });
    expect(accept.closest("form")).toHaveFormValues({ bookingId: "bk_1" });
    expect(screen.getByRole("link", { name: "Call back for WX15 YZA, James P." })).toHaveAttribute("href", "tel:+441302000000");
  });

  it("words when a request came in", () => {
    expect(formatReceived("2026-10-26T21:40:00Z", "2026-10-27T09:00:00Z")).toBe("21:40 last night");
    expect(formatReceived("2026-10-27T08:12:00Z", "2026-10-27T09:00:00Z")).toBe("08:12");
    expect(formatReceived("2026-10-25T10:00:00Z", "2026-10-27T09:00:00Z")).toBe("Sun 25, 10:00");
  });

  it("JobCard shows the actions only when active", () => {
    const props = {
      bookingId: "b1",
      startsAt: "2026-10-27T10:00:00Z",
      resourceName: "Bay 1",
      registration: "AB12CDE",
      vehicle: "Focus",
      service: "Diagnostics",
      detail: "warning light",
      status: "in_progress" as const,
      actions: [
        { label: "Add photos", href: "/app/bookings/b1/photos" },
        { label: "Mark ready", action: "/api/ready", variant: "success" as const },
      ],
    };
    const { rerender } = render(<JobCard {...props} />);
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics · warning light")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark ready/ })).toBeNull();

    rerender(<JobCard {...props} active />);
    expect(screen.getByRole("link", { name: "Add photos for AB12 CDE" })).toHaveAttribute("href", "/app/bookings/b1/photos");
    expect(screen.getByRole("button", { name: "Mark ready for AB12 CDE" }).closest("form")).toHaveFormValues({ bookingId: "b1" });
  });

  it("KpiCard ties the label to the number", () => {
    render(<KpiCard label="Won back by reminders" value="£1,940" trend={{ label: "38 bookings this month" }} tone="navy" />);
    expect(screen.getByRole("term")).toHaveTextContent("Won back by reminders");
    expect(screen.getAllByRole("definition")[0]).toHaveTextContent("£1,940");
    expect(screen.getByText("38 bookings this month")).toHaveClass("text-[#8ff0b0]");
  });
});
