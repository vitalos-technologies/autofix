import { Fragment } from "react";
import { inlineSegments, type LegalBlock } from "@/lib/legal/markdown";
import type { LegalDocument } from "@/lib/legal/documents";
import { cn } from "@/lib/utils";

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineSegments(text).map((segment, index) =>
        segment.bold ? (
          <strong key={index} className="font-bold text-navy-950">
            {segment.text}
          </strong>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case "heading":
      return block.level <= 2 ? (
        <h2 className="mt-4 mb-0 font-display text-[20px] leading-tight font-extrabold text-navy-950">{block.text}</h2>
      ) : (
        <h3 className="mt-3 mb-0 text-[16px] font-bold text-navy-950">{block.text}</h3>
      );
    case "list":
      return (
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5">
          {block.items.map((item, index) => (
            <li key={index}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="m-0 border-l-4 border-grey-300 pl-3.5">
          <Inline text={block.text} />
        </blockquote>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-control border border-grey-200 bg-white">
          <table className="w-full border-collapse text-left text-[14px] leading-[1.45]">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col" className="border-b border-grey-200 bg-grey-50 px-3 py-2.5 align-top font-bold text-navy-950">
                    <Inline text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-grey-200 last:border-b-0">
                  {row.map((cell, index) => (
                    <td key={index} className="px-3 py-2.5 align-top">
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return (
        <p className="m-0">
          <Inline text={block.text} />
        </p>
      );
  }
}

/** "Draft v0.1 · pending solicitor review": shown on every legal page until the drafts are final (docs/autofix/legal/README.md). */
export function DraftFlag({ document, className }: { document: Pick<LegalDocument, "version" | "draftNote">; className?: string }) {
  if (!document.draftNote) return null;
  return (
    <p
      className={cn("m-0 rounded-control border border-grey-200 bg-warning-bg px-3.5 py-2.5 text-[13.5px] leading-[1.45] font-semibold text-warning-ink", className)}
    >
      Draft v{document.version}, pending solicitor review. {document.draftNote}
    </p>
  );
}

/** A legal draft (privacy notice, DPA) rendered from its Markdown blocks. */
export function LegalDocumentBody({ document, className }: { document: LegalDocument; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 text-[15px] leading-[1.55] text-grey-700", className)}>
      {document.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
