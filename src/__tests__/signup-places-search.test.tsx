// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  searchPlacesAction: vi.fn(async () => ({ ok: true as const, results: [] })),
}));

vi.mock("@/app/signup/garage/actions", () => ({
  searchPlacesAction: actions.searchPlacesAction,
  placeDetailsAction: vi.fn(),
  checkSlugAction: vi.fn(async () => ({ status: "available" })),
  createGarageAction: vi.fn(async (state: unknown) => state),
}));

import { GarageWizard } from "@/app/signup/garage/garage-wizard";

describe("sign-up Places search", () => {
  it("sends what is in the box even when it was typed before React hydrated", async () => {
    render(<GarageWizard placesEnabled linkTemplate="https://__slug__.autofix.vitalos.co.uk" ownerEmail="owner@example.test" />);
    // Text typed before hydration is in the DOM without a React change event (CI run 40503141361 sent "").
    const box = screen.getByLabelText("Garage name and town") as HTMLInputElement;
    box.value = "Kingsway Doncaster";
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(actions.searchPlacesAction).toHaveBeenCalledWith("Kingsway Doncaster"));
  });
});
