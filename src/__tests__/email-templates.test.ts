import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { garageEmailBrand, platformEmailBrand } from "@/lib/email/brand";
import { bookingNotificationPreviews, emailPreviewFixtures, platformEmailPreviewFixtures, previewGarage } from "@/lib/email/preview-fixtures";
import { renderEnquiryReply } from "@/lib/email/templates/enquiries";
import { otherTestGarage, testGarage } from "./support/garage";

const garage = testGarage();
// Production links (garage hosts), set before the fixtures render.
vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "autofix.vitalos.co.uk");
const fixtures = emailPreviewFixtures(garage);
const platformFixtures = platformEmailPreviewFixtures();

describe("garage-branded transactional email templates", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "autofix.vitalos.co.uk");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "autofix.vitalos.co.uk");
  });

  it.each(Object.entries(fixtures))("renders %s with the garage's name and contact details", (name, rendered) => {
    expect(rendered.html.length, name).toBeGreaterThan(1_000);
    expect(rendered.text.length, name).toBeGreaterThan(80);
    expect(rendered.html, name).toContain("Hartley Road Motors Ltd");
    expect(rendered.html, name).toContain("01302 000101");
    expect(rendered.html, name).toContain("bookings@hartleyroad.example");
    expect(rendered.html, name).toContain("4 Hartley Road, Doncaster, DN1 2AB");
    expect(rendered.html, name).toContain("Sent by Autofix on behalf of Hartley Road Motors");
    expect(rendered.text, name).toContain("Sent by Autofix on behalf of Hartley Road Motors");
    expect(`${rendered.html}\n${rendered.text}`, name).not.toMatch(/SOB|sobautofix|Professional Diagnostics/i);
    expect(Buffer.byteLength(rendered.html), name).toBeLessThan(100_000);
  });

  it("uses the garage's accent for actions and its logo only when it is an https URL", () => {
    expect(fixtures["booking-confirmed"].html).toContain("background:#0f766e");
    expect(fixtures["booking-confirmed"].html).not.toContain("<img");
    const withLogo = emailPreviewFixtures(testGarage({ logoUrl: "https://cdn.example.test/hartley.png" }));
    expect(withLogo["booking-confirmed"].html).toContain('<img src="https://cdn.example.test/hartley.png"');
    expect(withLogo["booking-confirmed"].html).toContain('alt="Hartley Road Motors"');
    expect(emailPreviewFixtures(testGarage({ logoUrl: "http://insecure.example.test/logo.png" }))["booking-confirmed"].html).not.toContain("<img");
  });

  it("darkens a low-contrast accent so white button text stays readable", () => {
    expect(garageEmailBrand(testGarage({ accent: "#f6c700" })).accent).not.toBe("#f6c700");
  });

  it("brands each garage's mail with that garage only", () => {
    const other = emailPreviewFixtures(otherTestGarage());
    for (const [name, rendered] of Object.entries(other)) {
      expect(rendered.html, name).toContain("Demo Garage B");
      expect(rendered.html, name).not.toContain("Hartley Road");
    }
  });

  it("links customers to the garage's own booking host", () => {
    expect(fixtures["booking-confirmed"].html).toContain('href="https://hartley-road.autofix.vitalos.co.uk/manage?token=');
    const custom = emailPreviewFixtures(testGarage({ customDomain: "book.hartleyroad.co.uk" }));
    expect(custom["booking-confirmed"].html).toContain('href="https://book.hartleyroad.co.uk/manage?token=');
    expect(custom["enquiry-received"].html).toContain('href="https://book.hartleyroad.co.uk"');
  });

  it("keeps account mail platform-branded", () => {
    for (const [name, rendered] of Object.entries(platformFixtures)) {
      expect(rendered.html, name).toContain("Autofix");
      expect(rendered.html, name).not.toContain("on behalf of");
      expect(`${rendered.html}\n${rendered.text}`, name).not.toMatch(/SOB|sobautofix/i);
    }
  });

  it("escapes generated content and preserves line breaks", () => {
    const dangerous = `<script>alert(1)</script>\n<img src=x onerror=alert(1)>`;
    const rendered = renderEnquiryReply({ brand: garageEmailBrand(garage), customerName: dangerous, body: dangerous });
    expect(rendered.html).not.toContain("<script>alert(1)</script>");
    expect(rendered.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a garage name that contains markup", () => {
    const rendered = renderEnquiryReply({ brand: garageEmailBrand(testGarage({ name: "<b>Bad</b> Motors" })), customerName: "Sam", body: "Hello" });
    expect(rendered.html).not.toContain("<b>Bad</b>");
    expect(rendered.html).toContain("&lt;b&gt;Bad&lt;/b&gt; Motors");
  });

  it("uses the right actions and visible statuses", () => {
    expect(fixtures["enquiry-business-notification"].html).toContain("View enquiry");
    expect(fixtures["booking-confirmed"].html).toContain("Manage booking");
    expect(fixtures["booking-cancelled"].html).toContain("Book another appointment");
    expect(fixtures["booking-cancelled"].html).not.toContain(">Manage booking<");
    expect(fixtures["invoice-unpaid"].html).toContain("PDF invoice attached");
    expect(fixtures["invoice-paid"].html).toContain("PAID / SETTLED");
    expect(platformEmailBrand().name).toBe("Autofix");
  });

  it("uses the Supabase token hash with the server-side recovery callback", () => {
    const recovery = readFileSync(resolve("supabase/templates/recovery.html"), "utf8");
    expect(recovery).toContain(
      'href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/app/reset-password"',
    );
    expect(recovery).not.toContain("{{ .ConfirmationURL }}");
    expect(recovery).not.toMatch(/password\s*[:=]/i);
    const passwordChanged = readFileSync(resolve("supabase/templates/password_changed_notification.html"), "utf8");
    for (const template of [recovery, passwordChanged]) {
      expect(template).toContain("Autofix by Vitalos");
      expect(template).not.toMatch(/SOB|sobautofix|07469|Norton/i);
    }
  });

  it("can write safe local preview files without sending email", () => {
    const output = process.env.EMAIL_PREVIEW_DIR;
    if (!output) return;
    mkdirSync(output, { recursive: true });
    // `pnpm email:preview`: the seeded demo garage (Hartley Road Motors), through the real booking notification composer.
    for (const [name, rendered] of Object.entries({ ...emailPreviewFixtures(previewGarage), ...platformFixtures })) writeFileSync(join(output, `${name}.html`), rendered.html);
    for (const [kind, composed] of Object.entries(bookingNotificationPreviews(previewGarage))) {
      if (composed.calendar) writeFileSync(join(output, `booking-${kind}.ics`), composed.calendar);
      if (composed.textMessage) writeFileSync(join(output, `booking-${kind}-${composed.textMessage.channel}.txt`), `${composed.textMessage.body}\n`);
    }
  });
});
