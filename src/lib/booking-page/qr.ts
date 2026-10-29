/**
 * QR codes for a garage's booking link (P4.3), rendered here: no external QR service sees the link.
 * `uqr` encodes; we draw the SVG (one path, crisp at any size) and a greyscale PNG (Node `zlib`).
 */
import { deflateSync } from "node:zlib";
import { encode } from "uqr";

export type QrMatrix = { size: number; modules: boolean[][] };

/** Medium error correction: still scans when printed small or a bit scuffed. Quiet zone 4 modules. */
export function qrMatrix(text: string): QrMatrix {
  const result = encode(text, { ecc: "M", border: 4 });
  return { size: result.size, modules: result.data };
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A standalone SVG document; `title` names it for screen readers when shown inline. */
export function qrSvg(text: string, options: { title?: string; foreground?: string } = {}): string {
  const { size, modules } = qrMatrix(text);
  let path = "";
  modules.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x += 1;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  const title = options.title ? `<title>${escapeXml(options.title)}</title>` : "";
  const fill = /^#[0-9a-f]{6}$/i.test(options.foreground ?? "") ? options.foreground : "#0f2747";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">${title}<rect width="${size}" height="${size}" fill="#ffffff"/><path fill="${fill}" d="${path}"/></svg>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit greyscale PNG, `scale` pixels per module (default 12: ~500 px for a booking link). */
export function qrPng(text: string, scale = 12): Uint8Array {
  const { size, modules } = qrMatrix(text);
  const pixels = size * scale;
  const raw = new Uint8Array((pixels + 1) * pixels);
  for (let y = 0; y < pixels; y += 1) {
    const rowStart = y * (pixels + 1);
    raw[rowStart] = 0; // filter: none
    const row = modules[Math.floor(y / scale)] ?? [];
    for (let x = 0; x < pixels; x += 1) raw[rowStart + 1 + x] = row[Math.floor(x / scale)] ? 0 : 255;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, pixels);
  view.setUint32(4, pixels);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
