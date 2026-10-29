// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AskbridgeWidget } from "@/components/askbridge/askbridge-widget";
import { ASKBRIDGE_DEFAULT_SCRIPT_URL } from "@/lib/askbridge/config";

// The booking page loads Askbridge's own install snippet:
//   <script src="https://askbridge.vitalos.co.uk/widget/v1/askbridge.js" data-site="pk_…" async></script>
// (jsdom never fetches the script.)

const KEY = "pk_0123456789abcdef0123456789abcdef";

afterEach(() => {
  cleanup();
  document.getElementById("askbridge-widget")?.remove();
});

describe("AskbridgeWidget", () => {
  it("adds the loader after the page has loaded, with data-site and async and no other attributes of ours", async () => {
    render(<AskbridgeWidget src={ASKBRIDGE_DEFAULT_SCRIPT_URL} siteKey={KEY} />);
    const script = await waitFor(() => {
      const element = document.getElementById("askbridge-widget");
      expect(element).not.toBeNull();
      return element as HTMLScriptElement;
    });

    expect(script.tagName).toBe("SCRIPT");
    expect(script.getAttribute("src")).toBe(ASKBRIDGE_DEFAULT_SCRIPT_URL);
    // next/script sets the `async` property; browsers reflect it to the attribute (jsdom does not).
    expect(script.async).toBe(true);
    expect(script.getAttribute("data-site")).toBe(KEY);
    // The loader reads data-site (and data-api, which we leave out so it calls its own origin).
    // next/script adds its own data-nscript marker, which Askbridge ignores.
    const dataAttributes = script.getAttributeNames().filter((name) => name.startsWith("data-"));
    expect(dataAttributes.sort()).toEqual(["data-nscript", "data-site"]);
    expect(script.hasAttribute("data-api")).toBe(false);
    expect(script.parentElement).toBe(document.body);
  });
});
