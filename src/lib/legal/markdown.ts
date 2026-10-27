/**
 * The small Markdown subset the legal drafts use (docs/autofix/legal/): `#`
 * headings, paragraphs, `- ` lists, `> ` quotes and pipe tables, with
 * `**bold**` inline. Pure and client-safe; rendered by
 * src/components/legal/legal-document.tsx.
 */

export type LegalBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

export type InlineSegment = { text: string; bold: boolean };

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isDivider = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());

export function parseLegalMarkdown(source: string): LegalBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: LegalBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
      index += 1;
      continue;
    }
    if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        const row = (lines[index] ?? "").trim();
        if (!isDivider(row)) rows.push(tableCells(row));
        index += 1;
      }
      const [header = [], ...body] = rows;
      blocks.push({ kind: "table", header, rows: body });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith(">")) {
        quoted.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = (lines[index] ?? "").trim();
      if (!next || /^(#{1,3}\s|[-*]\s|>|\|)/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

/** `**Who we are.** We…` → bold and plain segments. */
export function inlineSegments(text: string): InlineSegment[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("**") && part.endsWith("**") ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false }));
}

/** Every text in the blocks, in order (for tests and hashing). */
export function blockTexts(blocks: LegalBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.kind === "list") return block.items;
    if (block.kind === "table") return [...block.header, ...block.rows.flat()];
    return [block.text];
  });
}

/** Maps every text in the blocks (placeholder filling). */
export function mapBlockTexts(blocks: LegalBlock[], map: (text: string) => string): LegalBlock[] {
  return blocks.map((block) => {
    if (block.kind === "list") return { ...block, items: block.items.map(map) };
    if (block.kind === "table") return { ...block, header: block.header.map(map), rows: block.rows.map((row) => row.map(map)) };
    return { ...block, text: map(block.text) };
  });
}
