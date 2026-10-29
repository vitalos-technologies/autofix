import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFFERS_CONSENT_COPY, REMINDER_CONSENT_COPY, REMINDER_CONSENT_COPY_NO_MOT } from "@/components/book";
import { offersConsentCopy, reminderConsentCopy } from "@/lib/booking-flow/copy";
import { UNSUBSCRIBE_COPY, UNSUBSCRIBE_LINK_LINE } from "@/lib/consent/copy";
import { parseLegalMarkdown } from "@/lib/legal/markdown";
import { LEGAL_SOURCE_FILES, LEGAL_SOURCES } from "@/lib/legal/sources.generated";

// The customer-facing legal copy must be the reviewed drafts in docs/autofix/legal/, word for word.

const quotes = parseLegalMarkdown(LEGAL_SOURCES.consentWording)
  .filter((block) => block.kind === "quote")
  .map((block) => (block.kind === "quote" ? block.text : ""));

describe("legal sources", () => {
  it.each(Object.entries(LEGAL_SOURCE_FILES))("%s is the current %s (run node scripts/sync-legal-copy.mjs after editing a draft)", (key, path) => {
    expect(LEGAL_SOURCES[key as keyof typeof LEGAL_SOURCES]).toBe(readFileSync(path, "utf8"));
  });

  it("every draft carries a version in its heading", () => {
    for (const source of Object.values(LEGAL_SOURCES)) expect(source.split("\n", 1)[0]).toMatch(/\((draft )?v\d+\.\d+\)$/);
  });
});

describe("Book 4 consent wording", () => {
  it("the checkbox copy is the draft's wording, with and without MOT", () => {
    expect(quotes).toContain(REMINDER_CONSENT_COPY);
    expect(quotes).toContain(REMINDER_CONSENT_COPY_NO_MOT);
    expect(reminderConsentCopy(true)).toBe(REMINDER_CONSENT_COPY);
    expect(reminderConsentCopy(false)).toBe(REMINDER_CONSENT_COPY_NO_MOT);
  });

  it("the offers checkbox copy is the draft's wording, with the garage's name, in its own box", () => {
    expect(quotes).toContain(OFFERS_CONSENT_COPY);
    expect(OFFERS_CONSENT_COPY).toBe("Send me occasional offers from [Garage name]. You can stop these any time.");
    expect(offersConsentCopy("Hartley Road Motors")).toBe("Send me occasional offers from Hartley Road Motors. You can stop these any time.");
    // The details step shows it as a second checkbox, apart from the reminder one.
    const details = readFileSync("src/app/%5Fsite/[garageId]/_components/details-step.tsx", "utf8");
    expect(details).toMatch(/<ConsentCheckbox name="reminderConsent"[^>]*\/>/);
    expect(details).toMatch(/<ConsentCheckbox name="offersConsent"[^>]*>\s*\{offersConsentCopy\(garageName\)\}\s*<\/ConsentCheckbox>/);
  });

  it("the line under Confirm booking matches the draft", () => {
    expect(quotes).toContain("Nothing to pay now. [How we use your details] (links to the privacy notice)");
    const details = readFileSync("src/app/%5Fsite/[garageId]/_components/details-step.tsx", "utf8");
    expect(details).toMatch(/Nothing to pay now\.\{" "\}\s*<Link href="\/privacy"[^>]*>\s*How we use your details\s*<\/Link>/);
  });
});

describe("unsubscribe wording", () => {
  it("each state matches the draft", () => {
    expect(quotes).toContain(`${UNSUBSCRIBE_COPY.done} ${UNSUBSCRIBE_COPY.changedMind} [${UNSUBSCRIBE_COPY.resumeLabel}]`);
    expect(quotes).toContain(UNSUBSCRIBE_COPY.resumed);
    expect(quotes).toContain(UNSUBSCRIBE_COPY.formPrompt);
    expect(quotes).toContain(UNSUBSCRIBE_COPY.formResponse);
    expect(quotes).toContain(UNSUBSCRIBE_LINK_LINE);
  });
});
