import { describe, expect, it } from "vitest";
import { blockTexts, inlineSegments, parseLegalMarkdown } from "@/lib/legal/markdown";
import { DPA_VERSION, dpaTextHash, renderDpa, renderPrivacyNotice, unfilledPlaceholders } from "@/lib/legal/documents";
import { LEGAL_SOURCES } from "@/lib/legal/sources.generated";
import { testGarage } from "./support/garage";

const garage = testGarage();

/** The draft's body (after heading and draft line) as patterns: placeholders match any filled value. */
function templatePatterns(source: string) {
  const [, , ...body] = parseLegalMarkdown(source);
  return blockTexts(body).map((text) => new RegExp(`^${text.replace(/[.*+?^${}()|\\]/g, "\\$&").replace(/\\\[[^\]]+\\\]|\[[^\]]+\]/g, ".+")}$`));
}

describe("parseLegalMarkdown", () => {
  it("reads headings, paragraphs, lists, quotes and tables", () => {
    const blocks = parseLegalMarkdown("# Title\n\nOne\ntwo.\n\n- a\n- b\n\n> quoted\n> more\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "One two." },
      { kind: "list", items: ["a", "b"] },
      { kind: "quote", text: "quoted\nmore" },
      { kind: "table", header: ["A", "B"], rows: [["1", "2"]] },
    ]);
    expect(inlineSegments("**Who we are.** We")).toEqual([{ text: "Who we are.", bold: true }, { text: " We", bold: false }]);
  });
});

describe("renderPrivacyNotice", () => {
  it("fills every placeholder from the garage and names Vitalos as processor", () => {
    const notice = renderPrivacyNotice(garage);
    const texts = blockTexts(notice.blocks);
    expect(notice.title).toBe("Privacy notice for customers of Hartley Road Motors");
    expect(notice.version).toBe("0.1");
    expect(notice.draftNote).toBe("Draft for solicitor review; not legal advice.");
    expect(unfilledPlaceholders([notice.title, ...texts])).toEqual([]);
    expect(texts.join("\n")).not.toMatch(/not provided\]/);
    const whoWeAre = texts.find((text) => text.startsWith("**Who we are.**"));
    expect(whoWeAre).toBe(
      "**Who we are.** Hartley Road Motors Ltd, 4 Hartley Road, Doncaster, DN1 2AB, is responsible for your personal data (\"we\"). Contact us at bookings@hartleyroad.example or 01302 000101. Our booking system, Autofix, is provided by Vitalos Technologies Ltd, which handles your data for us under a contract.",
    );
    expect(texts.at(-1)).toBe("Last updated 27 October 2026.");
    expect(texts.join("\n")).not.toContain("Shown on the garage's booking pages");
  });

  it("keeps every sentence of the draft, only the placeholders change", () => {
    const patterns = templatePatterns(LEGAL_SOURCES.privacyNotice);
    const texts = blockTexts(renderPrivacyNotice(garage).blocks);
    expect(texts).toHaveLength(patterns.length);
    texts.forEach((text, index) => expect(text).toMatch(patterns[index]!));
  });

  it("marks missing details instead of inventing them", () => {
    const notice = renderPrivacyNotice(testGarage({ legalName: null, email: null, phone: null, address: {} }));
    const texts = blockTexts(notice.blocks).join("\n");
    expect(unfilledPlaceholders(blockTexts(notice.blocks))).toEqual([]);
    expect(texts).toContain("Hartley Road Motors, [address not provided], is responsible");
    expect(texts).toContain("Contact us at [contact details not provided].");
  });

  it("uses whichever contact detail the garage has", () => {
    const texts = blockTexts(renderPrivacyNotice(testGarage({ email: null })).blocks).join("\n");
    expect(texts).toContain("Contact us at 01302 000101.");
  });
});

describe("renderDpa", () => {
  it("names the garage as controller and Vitalos as processor, flagged as a draft", () => {
    const dpa = renderDpa(garage);
    const texts = blockTexts(dpa.blocks);
    expect(dpa.version).toBe(DPA_VERSION);
    expect(DPA_VERSION).toBe("0.1");
    expect(dpa.draftNote).toBe("Draft for solicitor review; not legal advice.");
    expect(texts[0]).toBe(
      'Between **Hartley Road Motors Ltd** ("the Garage", controller) and **Vitalos Technologies Ltd** ("Vitalos", processor), for the Autofix service. Not yet accepted.',
    );
    expect(unfilledPlaceholders(texts)).toEqual([]);
  });

  it("records who accepted and when", () => {
    const dpa = renderDpa(garage, { acceptedAt: "2026-10-27T10:00:00Z", acceptedByName: "Ann Owner", acceptedByRole: "owner" });
    expect(blockTexts(dpa.blocks)[0]).toContain("Accepted on 27 October 2026 by Ann Owner, Owner.");
  });

  it("hashes the text the owner sees: stable, and different per legal name", () => {
    expect(dpaTextHash(garage)).toMatch(/^[0-9a-f]{64}$/);
    expect(dpaTextHash(garage)).toBe(dpaTextHash(testGarage()));
    expect(dpaTextHash(garage)).not.toBe(dpaTextHash(testGarage({ legalName: "Other Ltd" })));
  });
});
