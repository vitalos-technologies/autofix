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
    for (const name of [marketing.howItWorks.heading, marketing.features.heading, marketing.band.headline, marketing.garages.headline, marketing.faqs.heading]) {
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
    for (const anchor of ["#how-it-works", "#features", "#faqs"]) {
      expect(hrefs).toContain(anchor);
      expect(document.querySelector(anchor)).not.toBeNull();
    }
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

  it("is the one page on the admin host that may be indexed", () => {
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.title).toEqual({ absolute: marketing.metaTitle });
    expect(robots().rules).toEqual({ userAgent: "*", allow: "/$", disallow: "/" });
  });
});
