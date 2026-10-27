/**
 * Sign-up and onboarding (P4.4), end to end on the admin host against the production build and local
 * Supabase (playwright.garage.config.ts, project `signup`).
 *
 * A new owner signs up at /signup, confirms the address from the Supabase confirmation email (read
 * from the local Mailpit/Inbucket API; the service role makes the link only if no mail arrives),
 * finds the garage through the mock Places provider, picks a booking link, enrols TOTP through
 * /app/mfa/enroll, keeps services, accepts the DPA, invites a technician and goes live. The free
 * link `http://<slug>.localhost:<port>/` must then show the garage's booking page, all inside
 * 15 minutes (the time is recorded as a test annotation). The invited technician then joins with a
 * new account. Every sign-up and onboarding page has no axe violations at 390 and 1440.
 */
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { totp } from "../helpers/admin-session";
import { createLocalClient, getLocalSupabaseConfig } from "../helpers/local-supabase";

const port = process.env.PLAYWRIGHT_PORT || "3430";
const adminOrigin = `http://localhost:${port}`;
const mailOrigin = (process.env.MAILPIT_URL || process.env.INBUCKET_URL || "http://127.0.0.1:54324").replace(/\/$/, "");
const service = createLocalClient(getLocalSupabaseConfig().secretKey);
const run = randomUUID().slice(0, 8);
const ownerEmail = `signup-owner-${run}@example.test`;
const technicianEmail = `signup-tech-${run}@example.test`;
const password = "Local-signup-test-9f2e7c4a!";
const slug = `kingsway-${run}`;
const FIFTEEN_MINUTES = 15 * 60_000;

test.describe.configure({ mode: "serial" });

let garageId: string | null = null;
let inviteLink = "";

test.afterAll(async () => {
  if (garageId) await service.from("garages").delete().eq("id", garageId);
  for (const email of [ownerEmail, technicianEmail]) {
    const { data } = await service.auth.admin.listUsers({ perPage: 1000 });
    const user = data?.users.find((candidate) => candidate.email === email);
    if (user) await service.auth.admin.deleteUser(user.id);
  }
});

async function expectAccessible(page: Page) {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await expect(page).toHaveTitle(/\S/);
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    // As in settings.spec.ts: only while SOB's admin shell nests its own <main> (until P3.1) are the
    // three landmark rules that nesting breaks left out, on the admin page that has it.
    const nestedMain = await page.evaluate(() => document.querySelectorAll("main main").length > 0);
    const axe = new AxeBuilder({ page });
    if (nestedMain) axe.disableRules(["landmark-main-is-top-level", "landmark-no-duplicate-main", "landmark-unique"]);
    const results = await axe.analyze();
    expect(results.violations, `axe at ${width}px on ${new URL(page.url()).pathname}`).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `horizontal scroll at ${width}px` }).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

/** The confirmation email's token_hash, from Mailpit (or the service role when no mail server answers). */
async function confirmationTokenHash(email: string): Promise<{ tokenHash: string; via: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const search = await fetch(`${mailOrigin}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
      if (search.ok) {
        const found = (await search.json()) as { messages?: Array<{ ID: string }> };
        const id = found.messages?.[0]?.ID;
        if (id) {
          const message = (await (await fetch(`${mailOrigin}/api/v1/message/${id}`)).json()) as { HTML?: string; Subject?: string };
          expect(message.Subject).toBe("Confirm your Autofix account");
          const tokenHash = /token_hash=([0-9a-f]+)/.exec(message.HTML ?? "")?.[1];
          if (tokenHash) return { tokenHash, via: "mailpit" };
        }
      }
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`No confirmation email and no link: ${error?.message}`);
  return { tokenHash: data.properties.hashed_token, via: "service role" };
}

test("a new garage is live on its free link in under 15 minutes", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const started = Date.now();
  await page.setViewportSize({ width: 390, height: 844 });

  // 0. Account.
  await page.goto(`${adminOrigin}/signup`);
  await expect(page.getByRole("heading", { level: 1, name: "Put your garage online", exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Enter your name.")).toBeVisible();
  await expect(page.getByLabel("Your name")).toBeFocused();
  await page.getByLabel("Your name").fill("Sam Owner");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/signup\/check-email$/);
  await expect(page.getByRole("heading", { level: 1, name: "Check your email", exact: true })).toBeVisible();
  await expectAccessible(page);

  // Confirm the address (the link page needs a click, so mail scanners cannot use it up).
  const { tokenHash, via } = await confirmationTokenHash(ownerEmail);
  test.info().annotations.push({ type: "confirmation", description: `confirmation link read via ${via}` });
  await page.goto(`${adminOrigin}/auth/confirm?token_hash=${tokenHash}&type=email&next=/signup/garage`);
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await page.waitForURL(/\/signup\/garage$/);

  // 1. Find the garage (mock Places fixtures) and check the details.
  await expect(page.getByRole("heading", { level: 1, name: "Find your garage", exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue to your booking link" }).click();
  await expect(page.getByText("Enter your garage's name.")).toBeVisible();
  await page.getByLabel("Garage name and town").fill("Kingsway Doncaster");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /Kingsway Autocare/ }).click();
  await expect(page.getByText("Details filled in from Google. Check them below.")).toBeVisible();
  await expect(page.getByLabel("Garage name", { exact: true })).toHaveValue("Kingsway Autocare");
  await expect(page.getByLabel("Phone number")).toHaveValue("01632 960123");
  await expect(page.getByLabel("Postcode")).toHaveValue("DN4 5AB");
  await expect(page.getByLabel("Use my opening hours from Google")).toBeChecked();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue to your booking link" }).click();

  // 2. Booking link: a reserved one is refused, then a free one.
  await expect(page.getByRole("heading", { level: 1, name: "Choose your booking link", exact: true })).toBeVisible();
  await page.getByLabel("Booking link name").fill("admin");
  await expect(page.getByText("That link is reserved. Try another.")).toBeVisible();
  await page.getByLabel("Booking link name").fill(slug);
  await expect(page.getByText("This link is free.")).toBeVisible();
  await expect(page.getByTestId("link-preview")).toHaveText(`http://${slug}.localhost:${port}`);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create my garage" }).click();

  // 3. Security: through the existing /app/mfa/enroll flow and back.
  await page.waitForURL(/\/app\/onboarding\/security$/);
  const { data: created } = await service.from("garages").select("id,status,mot_enabled").eq("slug", slug).single();
  garageId = (created as { id: string }).id;
  expect(created).toMatchObject({ status: "onboarding" });
  await expect(page.getByRole("heading", { level: 1, name: "Secure your account", exact: true })).toBeVisible();
  await expectAccessible(page);
  // Later steps are closed until MFA is done.
  await page.goto(`${adminOrigin}/app/onboarding/services`);
  await page.waitForURL(/\/app\/onboarding\/security$/);
  await page.getByRole("link", { name: "Set up two-step verification" }).click();
  await page.waitForURL(/\/app\/mfa\/enroll\?returnTo=/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await page.getByText("Can't scan the QR code?").click();
  const secret = (await page.locator("details code").first().textContent())?.trim() ?? "";
  await page.getByLabel("Six-digit verification code").fill(totp(secret, Math.floor(Date.now() / 30_000)));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/app\/onboarding\/security$/);
  await expect(page.getByText("Two-step verification is on for this account.")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Continue to services" }).click();

  // 4. Services and MOT.
  await page.waitForURL(/\/app\/onboarding\/services$/);
  await expect(page.getByRole("heading", { level: 1, name: "Services and MOT", exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Yes, we're an MOT test centre").check();
  await page.getByRole("checkbox", { name: /^Brakes/ }).uncheck();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 5. DPA.
  await page.waitForURL(/\/app\/onboarding\/agreement$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your data agreement", exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("checkbox", { name: /I have read this Data Processing Agreement/ }).check();
  await page.getByRole("button", { name: "Accept agreement" }).click();
  await page.getByRole("link", { name: "Continue to your team" }).click();

  // 6. Team: invite a technician, then go live.
  await page.waitForURL(/\/app\/onboarding\/team$/);
  await expect(page.getByRole("heading", { level: 1, name: "Invite your team", exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Their email").fill(technicianEmail);
  await page.getByLabel("Role").selectOption("technician");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`Invite sent to ${technicianEmail} as technician.`)).toBeVisible();
  inviteLink = (await page.getByTestId("invite-link").textContent())?.trim() ?? "";
  expect(inviteLink).toMatch(new RegExp(`^${adminOrigin}/signup/invite/[A-Za-z0-9_-]{43}$`));
  await expect(page.locator("li").filter({ hasText: technicianEmail })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Finish and go live" }).click();

  // Done.
  await page.waitForURL(/\/app\/onboarding\/done$/);
  await expect(page.getByRole("heading", { level: 1, name: "You're live", exact: true })).toBeVisible();
  await expect(page.getByTestId("booking-link")).toHaveText(`http://${slug}.localhost:${port}`);
  await expectAccessible(page);

  // The free link serves the garage's booking page.
  const customer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const site = await customer.newPage();
  await site.goto(`http://${slug}.localhost:${port}/`);
  await expect(site.getByText("Kingsway Autocare").first()).toBeVisible();
  await expect(site.getByLabel("Registration")).toBeVisible();
  const elapsed = Date.now() - started;
  await customer.close();

  test.info().annotations.push({ type: "time-to-live", description: `${(elapsed / 1000).toFixed(1)} s from /signup to the live booking page` });
  console.log(`signup: garage live on its free link in ${(elapsed / 1000).toFixed(1)} s`);
  expect(elapsed).toBeLessThan(FIFTEEN_MINUTES);

  // Settings · Team shows the owner and the pending invite.
  await page.goto(`${adminOrigin}/app/settings/team`);
  await expect(page.getByRole("heading", { level: 1, name: "Team", exact: true })).toBeVisible();
  await expect(page.locator("#members")).toContainText("Sam Owner (you)");
  await expect(page.locator("#invites")).toContainText(technicianEmail);
  await expectAccessible(page);

  const { data: live } = await service.from("garages").select("status,mot_enabled").eq("id", garageId).single();
  expect(live).toEqual({ status: "active", mot_enabled: true });
  const { data: brakes } = await service.from("services").select("deleted_at").eq("garage_id", garageId).eq("name", "Brakes").single();
  expect((brakes as { deleted_at: string | null }).deleted_at).not.toBeNull();
  const { data: hours } = await service.from("opening_hours").select("weekday").eq("garage_id", garageId);
  expect((hours ?? []).length).toBe(6);
});

test("the invited technician joins with a new account", async ({ browser }) => {
  test.skip(!inviteLink, "needs the invite from the sign-up test");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(inviteLink);
  await page.waitForURL(/\/signup\/invite$/);
  await expect(page.getByRole("heading", { level: 1, name: "Join Kingsway Autocare", exact: true })).toBeVisible();
  await expect(page.getByText(technicianEmail)).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Your name").fill("Taylor Tech");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account and join" }).click();
  await page.waitForURL(/\/app(\/mfa\/enroll)?(\?.*)?$/);
  const { data: member } = await service.from("garage_members").select("role").eq("garage_id", garageId!).neq("role", "owner").single();
  expect(member).toEqual({ role: "technician" });

  // The link works once.
  const again = await browser.newContext();
  const second = await again.newPage();
  await second.goto(inviteLink);
  await expect(second.getByRole("heading", { level: 1, name: "This invite has been used", exact: true })).toBeVisible();
  await again.close();
  await context.close();
});
