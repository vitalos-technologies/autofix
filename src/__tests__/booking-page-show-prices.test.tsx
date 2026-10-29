// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServiceOption } from "@/components/book";
import { garageShowsPrices, publicServicePrice, showPricesFromSettings } from "@/lib/booking-page/show-prices";
import { garageEmailBrand } from "@/lib/email/brand";
import { renderBookingEmail, type BookingEmailType } from "@/lib/email/templates/bookings";
import { testGarage } from "./support/garage";

// "Show prices on my booking page" (Temitope, 29 Oct 2026): settings.showPrices, default on.

describe("settings.showPrices", () => {
  it("shows prices unless the garage turned them off", () => {
    expect(showPricesFromSettings(null)).toBe(true);
    expect(showPricesFromSettings({})).toBe(true);
    expect(showPricesFromSettings({ showPrices: true })).toBe(true);
    expect(showPricesFromSettings({ showPrices: false })).toBe(false);
    // Only a stored boolean false hides them.
    expect(showPricesFromSettings({ showPrices: "false" })).toBe(true);
    expect(showPricesFromSettings({ showPrices: 0 })).toBe(true);
    expect(garageShowsPrices(testGarage())).toBe(true);
    expect(garageShowsPrices(testGarage({ showPrices: false }))).toBe(false);
  });

  it("drops a service's price fields only when prices are hidden", () => {
    const service = { id: "s1", name: "Diagnostics", pricePence: 4500, priceMode: "from", durationMin: 60 };
    expect(publicServicePrice(service, true)).toBe(service);
    expect(publicServicePrice(service, false)).toEqual({ id: "s1", name: "Diagnostics", durationMin: 60 });
    expect(service.pricePence).toBe(4500);
  });
});

describe("ServiceOption with prices hidden", () => {
  it("has no price column at all, for fixed, from and quoted services", () => {
    const { rerender } = render(<ServiceOption name="serviceId" value="a" label="Full service" description="Annual" durationMinutes={180} pricePence={17900} priceMode="from" showPrice={false} />);
    expect(screen.getByRole("radio", { name: /Full service/ })).toBeInTheDocument();
    expect(screen.queryByText(/£|From|Quote|Free/)).not.toBeInTheDocument();
    rerender(<ServiceOption name="serviceId" value="b" label="Brakes" pricePence={null} priceMode="quote" showPrice={false} />);
    expect(screen.queryByText("Quote")).not.toBeInTheDocument();
    rerender(<ServiceOption name="serviceId" value="c" label="MOT" pricePence={5485} priceMode="fixed" />);
    expect(screen.getByText("£54.85")).toBeInTheDocument();
  });
});

describe("booking emails", () => {
  it("never carry a service price, whatever the garage's setting", () => {
    const garage = testGarage({ showPrices: false });
    for (const type of ["confirmed", "requested", "rescheduled", "cancelled"] satisfies BookingEmailType[]) {
      const rendered = renderBookingEmail({
        brand: garageEmailBrand(garage),
        type,
        customerName: "Test Customer",
        reference: "HRM-4821",
        service: "Full service",
        vehicle: "Vauxhall Astra",
        date: "Thursday, 20 August 2026",
        startTime: "09:30",
        timezone: "Europe/London (UK time)",
        location: "Hartley Road Motors workshop",
      });
      expect(rendered.html, type).not.toMatch(/£\d/);
      expect(rendered.text, type).not.toMatch(/£\d/);
    }
  });
});
