// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContactPage, { metadata } from "@/app/contact/page";
import { marketing } from "@/lib/marketing/content";

function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  return (async () => {
    await user.type(screen.getByLabelText("Your name"), "Priya Shah");
    await user.type(screen.getByLabelText("Email"), "Priya@Example.com");
    await user.type(screen.getByLabelText(/Garage name/), "Shah Motors");
    await user.click(screen.getByRole("radio", { name: "Sales or a demo" }));
    await user.type(screen.getByLabelText("Message"), "We would like a demo for our two sites.");
  })();
}

describe("contact page (/contact on the admin host)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is indexable, with one h1, a main landmark and the marketing header and footer", () => {
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.title).toEqual({ absolute: marketing.contact.metaTitle });
    render(<ContactPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(marketing.contact.heading);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("marks Contact as the current page and sends in-page links back to the home page", () => {
    render(<ContactPage />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Contact" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Plans" })).toHaveAttribute("href", "/#plans");
    const footer = screen.getByRole("navigation", { name: "Footer: Product" });
    expect(within(footer).getByRole("link", { name: "FAQs" })).toHaveAttribute("href", "/#faqs");
  });

  it("labels every field, marks the optional ones and offers the four topics", () => {
    render(<ContactPage />);
    for (const label of ["Your name", "Email", "Message"]) expect(screen.getByLabelText(label)).toBeRequired();
    expect(screen.getByLabelText("Phone (optional)")).toHaveAttribute("type", "tel");
    expect(screen.getByLabelText("Garage name (optional)")).not.toBeRequired();
    const topics = screen.getByRole("group", { name: "What is it about?" });
    expect(within(topics).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["general", "sales", "support", "partnership"]);
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute("type", "submit");
  });

  it("shows what to fix without sending anything, and focuses the first problem", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ContactPage />);
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Enter your name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Choose what your message is about.")).toBeInTheDocument();
    expect(screen.getByText("Write at least 10 characters.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Your name")).toHaveFocus());
    expect(screen.getByLabelText("Your name")).toHaveAttribute("aria-invalid", "true");
  });

  it("posts the form to /api/contact and thanks the sender", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, id: "4e000000-0000-4000-8000-000000000001" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ContactPage />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const thanks = await screen.findByRole("status");
    expect(within(thanks).getByRole("heading", { name: marketing.contact.thanks.heading })).toHaveFocus();
    expect(thanks).toHaveTextContent("priya@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/contact");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Priya Shah",
      email: "Priya@Example.com",
      phone: "",
      garageName: "Shah Motors",
      topic: "sales",
      message: "We would like a demo for our two sites.",
      turnstileToken: "development",
    });

    await user.click(within(thanks).getByRole("button", { name: marketing.contact.thanks.again }));
    expect(screen.getByLabelText("Your name")).toHaveValue("");
  });

  it("keeps what was typed and says why when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, error: { message: "Too many messages from here. Wait an hour and try again." } }), { status: 429 })));
    const user = userEvent.setup();
    render(<ContactPage />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many messages from here.");
    expect(screen.getByLabelText("Your name")).toHaveValue("Priya Shah");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
