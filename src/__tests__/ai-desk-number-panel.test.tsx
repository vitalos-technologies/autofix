// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiDeskNumberPanel } from "@/app/app/(protected)/settings/ai-front-desk/ai-desk-number-panel";
import { aiDeskNumberView, mobileDivertCodes, ukDialString, type AiDeskNumber, type NumberStatus } from "@/lib/phone-numbers/state";

// Settings · AI front desk, "Your AI desk number" (D22): every state a garage can see, the number once it
// is ready, and the UK divert instructions.

const NUMBER = "+441632960123";

function deskNumber(status: NumberStatus, extra: Partial<AiDeskNumber> = {}): AiDeskNumber {
  return {
    status,
    reason: null,
    number: status === "ready" ? NUMBER : null,
    checkedAt: "2026-10-30T11:05:00.000Z",
    readyAt: status === "ready" ? "2026-10-30T11:05:00.000Z" : null,
    ringsGarageFirst: status === "ready" ? false : null,
    ...extra,
  };
}

function panel(number: AiDeskNumber | null, enabled = true) {
  render(<AiDeskNumberPanel number={number} enabled={enabled} timeZone="Europe/London" />);
  return screen.getByRole("region", { name: "Your AI desk number" });
}

describe("Your AI desk number", () => {
  it.each([
    ["waiting_upgrade", "Waiting for upgrade", /upgrading the account with our phone provider \(Twilio\)/],
    ["waiting_bundle", "Waiting for approval", /paperwork approved by our phone provider/],
    ["cap_reached", "On the waiting list", /reached its limit of phone numbers/],
    ["not_configured", "Waiting for Vitalos", /finishing the phone set-up/],
    ["pending", "Setting up", /getting your garage its own number/],
  ] as const)("%s: says so, when it was last checked, and shows no number", (status, label, detail) => {
    const region = panel(deskNumber(status));
    expect(within(region).getByText(label)).toBeInTheDocument();
    expect(within(region).getByRole("status")).toHaveTextContent(detail);
    expect(within(region).queryByRole("link")).not.toBeInTheDocument();
    if (status === "pending") expect(within(region).queryByText(/Last checked/)).not.toBeInTheDocument();
    else expect(within(region).getByText(/Last checked 30 Oct, 11:05\./)).toBeInTheDocument();
  });

  it("failed: says what went wrong in plain words, with the reference for Vitalos", () => {
    const region = panel(deskNumber("failed", { reason: "twilio:21631" }));
    expect(within(region).getByText("Couldn't get a number")).toBeInTheDocument();
    expect(within(region).getByRole("status")).toHaveTextContent("Something went wrong ordering your number. We try again every day.");
    expect(within(region).getByText("twilio:21631")).toBeInTheDocument();
  });

  it("failed for want of numbers: the plain reason", () => {
    const region = panel(deskNumber("failed", { reason: "no_numbers_available" }));
    expect(within(region).getByRole("status")).toHaveTextContent("Our phone provider had no UK numbers free.");
  });

  it("ready: the number to call and copy, and how to divert missed calls to it on a mobile or a landline", () => {
    const region = panel(deskNumber("ready"));
    expect(within(region).getByText("Ready")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "01632 960123" })).toHaveAttribute("href", `tel:${NUMBER}`);
    expect(within(region).getByRole("button", { name: /Copy number/ })).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 3, name: "Send your missed calls here" })).toBeInTheDocument();

    const codes = within(region).getByRole("list", { name: "Divert codes" });
    expect(within(codes).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("No answer**61*01632960123#"),
      expect.stringContaining("Busy**67*01632960123#"),
      expect.stringContaining("Off or no signal**62*01632960123#"),
    ]);
    expect(within(codes).getAllByRole("button", { name: /Copy/ })).toHaveLength(3);
    expect(within(region).getByText("**004*01632960123#")).toBeInTheDocument();
    expect(within(region).getByText("##004#")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 4, name: "On a landline or office phone system" })).toBeInTheDocument();
    expect(region).toHaveTextContent("Ask your phone provider (for example BT, Virgin Media or whoever runs your phone system) to divert calls to 01632 960123 when there's no answer");
    expect(region).toHaveTextContent("Don't divert every call");
    expect(region).not.toHaveTextContent("**21*");
  });

  it("ready on a number that rings the garage first: no divert instructions (diverting would loop)", () => {
    const region = panel(deskNumber("ready", { ringsGarageFirst: true }));
    expect(region).toHaveTextContent("Calls to this number ring your phone first");
    expect(within(region).queryByRole("list", { name: "Divert codes" })).not.toBeInTheDocument();
  });

  it("desk off: nothing is ordered, and a number already bought is kept", () => {
    expect(within(panel(null, false)).getByText("Not ordered")).toBeInTheDocument();
    document.body.innerHTML = "";
    const kept = panel(deskNumber("ready"), false);
    expect(within(kept).getByText("Kept")).toBeInTheDocument();
    expect(kept).toHaveTextContent("The number stays yours.");
  });

  it("switched on with nothing recorded yet: setting up", () => {
    expect(within(panel(null, true)).getByText("Setting up")).toBeInTheDocument();
  });
});

describe("divert codes and wording", () => {
  it("dials UK numbers in national form, and only UK numbers", () => {
    expect(ukDialString("+441302960123")).toBe("01302960123");
    expect(ukDialString("+442079460000")).toBe("02079460000");
    expect(ukDialString("+15005550006")).toBeNull();
    expect(mobileDivertCodes("+15005550006")).toBeNull();
    expect(mobileDivertCodes("+447700900123")).toEqual({
      codes: [
        { key: "no_answer", label: "No answer", code: "**61*07700900123#" },
        { key: "busy", label: "Busy", code: "**67*07700900123#" },
        { key: "unreachable", label: "Off or no signal", code: "**62*07700900123#" },
      ],
      allAtOnce: "**004*07700900123#",
      cancel: "##004#",
    });
  });

  it("gives every state a label and a tone", () => {
    for (const status of ["pending", "waiting_upgrade", "waiting_bundle", "cap_reached", "not_configured", "ready", "failed"] as const) {
      const view = aiDeskNumberView(deskNumber(status), { enabled: true });
      expect(view.label.length).toBeGreaterThan(0);
      expect(["success", "warning", "info", "neutral", "danger"]).toContain(view.tone);
    }
  });
});
