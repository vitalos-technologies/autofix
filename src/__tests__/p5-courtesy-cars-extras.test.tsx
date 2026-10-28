// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BookingExtrasFields } from "@/app/%5Fsite/[garageId]/_components/booking-extras";

describe("booking extras on the details step (P5.8)", () => {
  it("shows only what was offered", () => {
    const { rerender } = render(<BookingExtrasFields offered={{ courtesy: true, collection: false }} />);
    expect(screen.getByRole("checkbox", { name: /I'd like a courtesy car/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Collect and deliver/ })).not.toBeInTheDocument();
    rerender(<BookingExtrasFields offered={{ courtesy: false, collection: true }} />);
    expect(screen.queryByRole("checkbox", { name: /courtesy car/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Collect and deliver/ })).toBeInTheDocument();
  });

  it("keeps the customer's choices through the form reset React does after an action", async () => {
    const user = userEvent.setup();
    render(
      <form data-testid="form">
        <BookingExtrasFields offered={{ courtesy: true, collection: true }} />
      </form>,
    );
    expect(screen.getByLabelText("Address to collect from")).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I'd like a courtesy car/ }));
    await user.click(screen.getByRole("checkbox", { name: /Collect and deliver/ }));
    await user.type(screen.getByLabelText("Address to collect from"), "1 High Street");
    await user.type(screen.getByLabelText("Postcode"), "S1 1AA");

    (screen.getByTestId("form") as HTMLFormElement).reset();

    expect(screen.getByRole("checkbox", { name: /I'd like a courtesy car/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Collect and deliver/ })).toBeChecked();
    expect(screen.getByLabelText("Address to collect from")).toHaveValue("1 High Street");
    expect(screen.getByLabelText("Postcode")).toHaveValue("S1 1AA");
    const data = new FormData(screen.getByTestId("form") as HTMLFormElement);
    expect(data.get("courtesyCar")).toBe("yes");
    expect(data.get("collectionDelivery")).toBe("yes");
    expect(data.get("collectionPostcode")).toBe("S1 1AA");
  });
});
