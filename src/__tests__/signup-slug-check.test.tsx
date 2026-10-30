// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The booking-link step checks the slug once typing pauses, not on every keystroke: server actions
// run one at a time per client, so a check per key queued them all and held "Create my garage"
// disabled long after the last key.

type Check = { slug: string; status: "available" | "taken"; message: string; alternatives: string[] };

const actions = vi.hoisted(() => ({
  checkSlugAction: vi.fn(async (slug: string): Promise<Check> =>
    slug === "taken-garage"
      ? { slug, status: "taken", message: "That link is taken. Try another.", alternatives: ["taken-garage-2"] }
      : { slug, status: "available", message: "This link is free.", alternatives: [] }),
}));

vi.mock("@/app/signup/garage/actions", () => ({
  searchPlacesAction: vi.fn(),
  placeDetailsAction: vi.fn(),
  checkSlugAction: actions.checkSlugAction,
  createGarageAction: vi.fn(async (state: unknown) => state),
}));

import { GarageWizard } from "@/app/signup/garage/garage-wizard";

const TEST_PLANS = [
  { id: "essentials" as const, name: "Essentials", price: "£20 a month", detail: "Run the garage." },
  { id: "pro" as const, name: "Pro", price: "£45 a month", detail: "Grow the garage." },
];

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}

async function openLinkStep() {
  render(<GarageWizard placesEnabled={false} linkTemplate="https://__slug__.pitline.co.uk" ownerEmail="owner@example.test" plans={TEST_PLANS} cardFirst={false} />);
  fill("Garage name", "Kingsway Autocare");
  fill("Phone number", "01302 123456");
  fill("Address line 1", "1 Kingsway");
  fill("Town or city", "Doncaster");
  fill("Postcode", "DN4 5AB");
  fireEvent.click(screen.getByRole("button", { name: "Continue to your booking link" }));
  await screen.findByRole("heading", { level: 1, name: "Choose your booking link" });
}

describe("sign-up booking link check", () => {
  beforeEach(() => actions.checkSlugAction.mockClear());

  it("checks the suggested link straight away when the step opens", async () => {
    await openLinkStep();
    expect(actions.checkSlugAction).toHaveBeenCalledTimes(1);
    expect(actions.checkSlugAction).toHaveBeenLastCalledWith("kingsway-autocare", "Doncaster");
    await screen.findByText("This link is free.");
  });

  it("checks once, for the last value, after typing pauses", async () => {
    await openLinkStep();
    await screen.findByText("This link is free.");
    actions.checkSlugAction.mockClear();

    // Typing from a short value: nothing is checked while the keys come quickly.
    for (const value of ["k", "ki", "kin", "king", "kings", "kingsw", "kingsway"]) fill("Booking link name", value);
    expect(actions.checkSlugAction).not.toHaveBeenCalled();
    expect(screen.getByText("Checking…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create my garage" }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(actions.checkSlugAction).toHaveBeenCalledTimes(1));
    expect(actions.checkSlugAction).toHaveBeenLastCalledWith("kingsway", "Doncaster");
    await screen.findByText("This link is free.");
    expect((screen.getByRole("button", { name: "Create my garage" }) as HTMLButtonElement).disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(actions.checkSlugAction).toHaveBeenCalledTimes(1);
  });

  it("checks a change after a quiet spell (a paste) at once, then waits for the next pause", async () => {
    await openLinkStep();
    await screen.findByText("This link is free.");
    await new Promise((resolve) => setTimeout(resolve, 350));
    actions.checkSlugAction.mockClear();

    fill("Booking link name", "kingsway-motors");
    expect(actions.checkSlugAction).toHaveBeenCalledTimes(1);
    expect(actions.checkSlugAction).toHaveBeenLastCalledWith("kingsway-motors", "Doncaster");
    fill("Booking link name", "kingsway-motor");
    fill("Booking link name", "kingsway-moto");
    expect(actions.checkSlugAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(actions.checkSlugAction).toHaveBeenCalledTimes(2));
    expect(actions.checkSlugAction).toHaveBeenLastCalledWith("kingsway-moto", "Doncaster");
    await screen.findByText("This link is free.");
  });

  it("does not check a link shorter than three characters", async () => {
    await openLinkStep();
    await screen.findByText("This link is free.");
    actions.checkSlugAction.mockClear();
    fill("Booking link name", "ki");
    fill("Booking link name", "k");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(actions.checkSlugAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking…")).toBeNull();
  });

  it("checks a suggested alternative as soon as it is picked", async () => {
    await openLinkStep();
    await screen.findByText("This link is free.");
    fill("Booking link name", "taken-garage");
    const alternative = await screen.findByRole("button", { name: "taken-garage-2" });
    actions.checkSlugAction.mockClear();
    fireEvent.click(alternative);
    expect(actions.checkSlugAction).toHaveBeenCalledTimes(1);
    expect(actions.checkSlugAction).toHaveBeenLastCalledWith("taken-garage-2", "Doncaster");
    await screen.findByText("This link is free.");
  });
});
