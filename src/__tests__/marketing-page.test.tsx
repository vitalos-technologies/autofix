// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage, { metadata } from "@/app/page";
import robots from "@/app/robots";
import { marketing } from "@/lib/marketing/content";

describe("marketing page (/ on the admin host)", () => {
  it("has one h1, a main landmark and a heading for every section", () => {
    render(<HomePage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your garage, fully booked.");
    expect(screen.getByRole("main")).toBeInTheDocument();
    for (const name of [marketing.howItWorks.heading, marketing.features.heading, marketing.band.headline, marketing.garages.headline, marketing.plans.heading, marketing.faqs.heading]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("sends Log in to the admin sign-in and the main call to action to sign-up", () => {
    render(<HomePage />);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/app/login");
    expect(within(header).getAllByRole("link", { name: "Set up your garage" }).every((link) => link.getAttribute("href") === "/signup")).toBe(true);
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/app");
    for (const anchor of ["#how-it-works", "#features", "#plans", "#faqs"]) {
      expect(hrefs).toContain(anchor);
      expect(document.querySelector(anchor)).not.toBeNull();
    }
  });

  it("shows two plans with their prices, the Pro trial, and coming soon only on unshipped Pro features", () => {
    render(<HomePage />);
    const essentials = screen.getByRole("article", { name: "Essentials" });
    const pro = screen.getByRole("article", { name: "Pro" });
    expect(within(essentials).getByText("1 month free")).toBeInTheDocument();
    expect(within(essentials).getAllByRole("listitem")).toHaveLength(marketing.plans.essentials.features.length);
    expect(within(pro).getByText("1 month free")).toBeInTheDocument();
    const items = within(pro).getAllByRole("listitem");
    expect(items).toHaveLength(marketing.plans.pro.features.length);
    marketing.plans.pro.features.forEach((feature, index) => {
      const item = items[index]!;
      expect(item).toHaveTextContent(feature.label);
      expect(within(item).queryByText("Coming soon") !== null).toBe(!feature.shipped);
    });
    // Only Pro features that have shipped are claimed as available (P5.3–P5.12: every Pro feature has shipped).
    expect(marketing.plans.pro.features.filter((feature) => feature.shipped).length).toBe(10);
    expect(within(essentials).getByRole("link", { name: "Start with Essentials" })).toHaveAttribute("href", "/signup");
    // Prices set by Temitope on 29 Oct 2026 (excluding VAT, which shows only at checkout: D25).
    expect(essentials).toHaveTextContent("£20 a month");
    expect(pro).toHaveTextContent("£45 a month");
    expect(document.body).not.toHaveTextContent(/VAT/);
  });

  it("answers every FAQ in a native disclosure", () => {
    const { container } = render(<HomePage />);
    expect(container.querySelectorAll("#faqs details")).toHaveLength(marketing.faqs.items.length);
  });

  it("keeps the illustrations out of the tab order", () => {
    render(<HomePage />);
    for (const art of screen.getAllByRole("img")) {
      expect(art.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0);
    }
  });

  it("links to the contact page from the nav, the FAQs and the footer", () => {
    render(<HomePage />);
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/contact");
    expect(within(screen.getByRole("navigation", { name: "Menu" })).getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/contact");
    expect(within(document.querySelector("#faqs") as HTMLElement).getByRole("link", { name: marketing.contact.faqCta.label })).toHaveAttribute("href", "/contact");
    expect(within(screen.getByRole("navigation", { name: "Footer: Company" })).getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/contact");
  });

  it("is indexable, and robots.txt allows only it and the contact page on the admin host", () => {
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.title).toEqual({ absolute: marketing.metaTitle });
    expect(robots().rules).toEqual({ userAgent: "*", allow: ["/$", "/contact$"], disallow: "/" });
  });
});
