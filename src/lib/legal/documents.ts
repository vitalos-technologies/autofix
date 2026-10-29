/**
 * The legal drafts (docs/autofix/legal/) filled in for one garage.
 *
 * The text is the reviewed Markdown, embedded by scripts/sync-legal-copy.mjs,
 * never retyped here. Placeholders in square brackets are filled from the
 * garage's profile; a detail the garage has not entered is shown as
 * "[… not provided]" so it is visible rather than invented. The drafts are
 * awaiting solicitor review, so each document keeps its version and a
 * visible draft flag (docs/autofix/legal/README.md).
 */
import { createHash } from "node:crypto";
import type { Garage } from "@/lib/tenancy/garage";
import { addressLine, formatPhoneForDisplay } from "@/lib/tenancy/contact";
import { blockTexts, mapBlockTexts, parseLegalMarkdown, type LegalBlock } from "./markdown";
import { LEGAL_SOURCES } from "./sources.generated";

export type LegalGarage = Pick<Garage, "name" | "legalName" | "companyNumber" | "address" | "email" | "phone">;

export type LegalDocument = {
  /** The heading without the "(draft vX)" suffix. */
  title: string;
  /** e.g. `0.1`, from the draft's heading. */
  version: string;
  /** The draft line ("Draft for solicitor review; not legal advice."), shown as a flag; null once a final version drops it. */
  draftNote: string | null;
  /** Body blocks after the heading and the draft line. */
  blocks: LegalBlock[];
};

/** When the customer privacy notice text last changed ("Last updated [date]"). Bump with the draft's version. */
export const PRIVACY_NOTICE_UPDATED = "2026-10-29";

const DRAFT_HEADING = /\s*\((?:draft )?v([0-9][0-9A-Za-z.-]*)\)\s*$/;
const DRAFT_LINE = /^(Draft for solicitor review; not legal advice\.)\s*/;
const PLACEHOLDER = /\[[^\]\n]+\]/g;

/** "[address not provided]": a gap the garage still has to fill, never guessed. */
export function notProvided(what: string) {
  return `[${what} not provided]`;
}

/** Placeholders left in a filled document, ignoring the "[… not provided]" markers. */
export function unfilledPlaceholders(texts: string[]) {
  return texts.flatMap((text) => text.match(PLACEHOLDER) ?? []).filter((match) => !match.endsWith(" not provided]"));
}

export function documentVersion(source: string) {
  const firstLine = source.split("\n", 1)[0] ?? "";
  const match = DRAFT_HEADING.exec(firstLine);
  if (!match?.[1]) throw new Error("legal draft heading has no version");
  return match[1];
}

/**
 * Splits a draft into heading, version, draft flag and body. Only the first
 * sentence of the draft line is customer-facing; the rest ("Shown on the
 * garage's booking pages.") is a note for reviewers.
 */
function splitDraft(source: string, fillTitle: (text: string) => string): LegalDocument {
  const blocks = parseLegalMarkdown(source);
  const [heading, ...rest] = blocks;
  if (heading?.kind !== "heading") throw new Error("legal draft must start with a heading");
  const version = documentVersion(source);
  let draftNote: string | null = null;
  const body = rest.flatMap((block): LegalBlock[] => {
    if (draftNote === null && block.kind === "paragraph") {
      const match = DRAFT_LINE.exec(block.text);
      if (match) {
        draftNote = match[1]!;
        // The DPA's first paragraph carries the draft line at its end; keep the rest of a paragraph.
        return [];
      }
      const inline = /\s*Draft for solicitor review; not legal advice\.\s*$/.exec(block.text);
      if (inline) {
        draftNote = "Draft for solicitor review; not legal advice.";
        return [{ ...block, text: block.text.slice(0, inline.index).trimEnd() }];
      }
    }
    return [block];
  });
  return { title: fillTitle(heading.text.replace(DRAFT_HEADING, "")), version, draftNote, blocks: body };
}

/** "27 October 2026" (UK long date) from `YYYY-MM-DD` or an ISO instant, in UK time. */
export function formatLegalDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(date);
}

/** The garage's legal name, else its trading name (a sole trader trades under their own or a business name). */
function legalName(garage: Pick<LegalGarage, "name" | "legalName">) {
  return garage.legalName?.trim() || garage.name;
}

function contactPhrase(garage: LegalGarage) {
  const options = [garage.email?.trim() || null, garage.phone ? formatPhoneForDisplay(garage.phone) : null].filter((value): value is string => Boolean(value));
  return options.length ? options.join(" or ") : notProvided("contact details");
}

/** The customer privacy notice for one garage, every placeholder filled or marked. */
export function renderPrivacyNotice(garage: LegalGarage): LegalDocument {
  const address = addressLine(garage.address) || notProvided("address");
  const fill = (text: string) =>
    text
      .replaceAll("[email] or [phone]", contactPhrase(garage))
      .replaceAll("[Garage legal name]", legalName(garage))
      .replaceAll("[Garage name]", garage.name)
      .replaceAll("[address]", address)
      .replaceAll("[email]", garage.email?.trim() || notProvided("email"))
      .replaceAll("[phone]", garage.phone ? formatPhoneForDisplay(garage.phone) : notProvided("phone"))
      .replaceAll("[date]", formatLegalDate(PRIVACY_NOTICE_UPDATED));
  const document = splitDraft(LEGAL_SOURCES.privacyNotice, fill);
  return { ...document, blocks: mapBlockTexts(document.blocks, fill) };
}

export type DpaAcceptance = { acceptedAt: string; acceptedByName: string; acceptedByRole: string };

export const DPA_KIND = "dpa" as const;
export const DPA_VERSION = documentVersion(LEGAL_SOURCES.dpa);

const ACCEPTANCE_LINE = "Accepted on [date] by [name, role].";

function dpaFill(garage: Pick<LegalGarage, "name" | "legalName">) {
  return (text: string) => text.replaceAll("[Garage legal name]", legalName(garage));
}

/**
 * The DPA for one garage. Before acceptance the acceptance line reads "Not
 * yet accepted."; afterwards it names the date and the owner.
 */
export function renderDpa(garage: Pick<LegalGarage, "name" | "legalName">, acceptance: DpaAcceptance | null = null): LegalDocument {
  const fill = dpaFill(garage);
  const acceptanceText = acceptance
    ? `Accepted on ${formatLegalDate(acceptance.acceptedAt)} by ${acceptance.acceptedByName}, ${acceptance.acceptedByRole === "owner" ? "Owner" : acceptance.acceptedByRole}.`
    : "Not yet accepted.";
  const document = splitDraft(LEGAL_SOURCES.dpa, fill);
  return { ...document, blocks: mapBlockTexts(document.blocks, (text) => fill(text).replace(ACCEPTANCE_LINE, acceptanceText)) };
}

/**
 * What `garage_agreements.text_hash` records: hex SHA-256 of the DPA text
 * the owner is shown, with the garage's legal name filled in. The acceptance
 * line keeps its placeholders, because its date and name are the row's own
 * columns.
 */
export function dpaTextHash(garage: Pick<LegalGarage, "name" | "legalName">) {
  const document = splitDraft(LEGAL_SOURCES.dpa, dpaFill(garage));
  const canonical = [document.title, `v${document.version}`, ...blockTexts(mapBlockTexts(document.blocks, dpaFill(garage)))].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
