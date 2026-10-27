import { describe, expect, it } from "vitest";
import { domainSteps } from "@/components/admin-ui/domain-status-steps";
import {
  checkAvailableInMs,
  DOMAIN_CHECK_INTERVAL_MS as VIEW_INTERVAL,
  dnsRecordsForDisplay,
  failedStepFor,
  isDomainInProgress,
  parseStoredVerification,
} from "@/lib/booking-page/domain-view";
import { qrMatrix, qrPng, qrSvg } from "@/lib/booking-page/qr";
import { createMockDomainsClient, type DomainConfig } from "@/lib/vercel/domains";
import { DOMAIN_CHECK_INTERVAL_MS, nextDomainStatus, startDomainConnection } from "@/lib/vercel/domains-check";

const CNAME = "cname.vercel-dns-0.com";

describe("DNS records to show", () => {
  it("maps the records startDomainConnection returns, CNAME first", async () => {
    const client = createMockDomainsClient();
    const connection = await startDomainConnection("book.pendinggarage.co.uk", { client, cnameTarget: CNAME });
    const stored = parseStoredVerification({ records: [...connection.records].reverse(), pendingSince: "2026-10-27T09:00:00.000Z" });
    expect(stored.pendingSince).toBe("2026-10-27T09:00:00.000Z");
    expect(dnsRecordsForDisplay({ hostname: connection.hostname, records: stored.records }, CNAME)).toEqual([
      { type: "CNAME", name: "book", value: CNAME },
      { type: "TXT", name: "_vercel", value: expect.stringMatching(/^vc-domain-verify=book\.pendinggarage\.co\.uk,/) },
    ]);
  });

  it("falls back to the CNAME when nothing was stored (added while Vercel was rate limited)", () => {
    expect(dnsRecordsForDisplay({ hostname: "book.hartleyroadmotors.co.uk", records: [] }, CNAME)).toEqual([{ type: "CNAME", name: "book", value: CNAME }]);
  });

  it("drops malformed stored records", () => {
    expect(parseStoredVerification({ records: [{ type: "A", name: "@", host: "x.example", value: "1.2.3.4" }, { type: "TXT" }, "nope"], pendingSince: "soon" })).toEqual({ records: [], pendingSince: null });
    expect(parseStoredVerification(null)).toEqual({ records: [], pendingSince: null });
  });
});

describe("status steps from Vercel responses", () => {
  const config = (overrides: Partial<DomainConfig>): DomainConfig => ({ misconfigured: true, configuredBy: null, recommendedCname: CNAME, recommendedIPv4: [], acceptedChallenges: [], ...overrides });

  it("no record yet → looking for the record", () => {
    const status = nextDomainStatus({ verified: true, config: config({}) });
    expect(status).toBe("pending_dns");
    expect(domainSteps(status).map((step) => step.state)).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("CNAME seen, certificate pending → record found, securing", () => {
    const status = nextDomainStatus({ verified: true, config: config({ configuredBy: "CNAME" }) });
    expect(status).toBe("verifying");
    expect(domainSteps(status).map((step) => step.label)).toEqual(["Record found", "Securing (HTTPS)…", "Live"]);
  });

  it("verified and configured → live", () => {
    const status = nextDomainStatus({ verified: true, config: config({ misconfigured: false, configuredBy: "CNAME" }) });
    expect(status).toBe("active");
    expect(domainSteps(status).every((step) => step.state === "done")).toBe(true);
  });

  it("ownership not proven keeps it short of live", () => {
    expect(nextDomainStatus({ verified: false, config: config({ misconfigured: false, configuredBy: "CNAME" }) })).toBe("verifying");
  });

  it("places a failure on the right step", () => {
    expect(failedStepFor("book.x.co.uk points to us, but we couldn't secure it with HTTPS after 48 hours.")).toBe(2);
    expect(failedStepFor("We couldn't find a CNAME record for book.x.co.uk")).toBe(1);
    expect(failedStepFor(null)).toBe(1);
    expect(domainSteps("failed", 2).map((step) => step.state)).toEqual(["done", "failed", "upcoming"]);
  });

  it("throttles Check now like domains.check", () => {
    expect(VIEW_INTERVAL).toBe(DOMAIN_CHECK_INTERVAL_MS);
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(checkAvailableInMs(null, now)).toBe(0);
    expect(checkAvailableInMs("2026-10-27T09:58:00Z", now)).toBe(3 * 60 * 1000);
    expect(checkAvailableInMs("2026-10-27T09:50:00Z", now)).toBe(0);
    expect(isDomainInProgress("verifying")).toBe(true);
    expect(isDomainInProgress("active")).toBe(false);
  });
});

describe("QR code", () => {
  const link = "https://hartley-road.autofix.vitalos.co.uk/";

  it("encodes with a 4-module quiet zone and finder patterns in three corners", () => {
    const { size, modules } = qrMatrix(link);
    expect(size).toBeGreaterThanOrEqual(21 + 8);
    const at = (x: number, y: number) => modules[y]?.[x];
    expect(at(0, 0)).toBe(false);
    // Finder patterns: dark outer ring, light ring, dark 3x3 centre.
    for (const [cx, cy] of [[7, 7], [size - 8, 7], [7, size - 8]] as const) {
      expect([at(cx, cy), at(cx - 3, cy - 3), at(cx - 2, cy - 2), at(cx + 3, cy + 3)]).toEqual([true, true, false, true]);
    }
    expect(qrMatrix(link)).toEqual(qrMatrix(link));
  });

  it("draws a standalone SVG with a title and no scripts", () => {
    const svg = qrSvg(link, { title: "Book <online> & go" });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("<title>Book &lt;online&gt; &amp; go</title>");
    expect(svg).toMatch(/<path fill="#071127" d="M\d/);
    expect(svg).not.toMatch(/script|href/i);
    expect(qrSvg(link, { foreground: "red" })).toContain('fill="#071127"');
  });

  it("writes a valid greyscale PNG", () => {
    const png = qrPng(link, 10);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(Buffer.from(png.subarray(12, 16)).toString("ascii")).toBe("IHDR");
    const width = view.getUint32(16);
    expect(width).toBe(qrMatrix(link).size * 10);
    expect(view.getUint32(20)).toBe(width);
    expect(Buffer.from(png.subarray(png.length - 8, png.length - 4)).toString("ascii")).toBe("IEND");
  });
});
