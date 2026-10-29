import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PLACE_FIXTURES } from "@/lib/places/fixtures";
import { describeOpeningHours, mapPlaceDetails, placeAddress, placeOpeningHours, placePhone, placeWebsite } from "@/lib/places/map";
import { cleanPlacesQuery, createGooglePlacesProvider, createMockPlacesProvider, DETAILS_FIELD_MASK, resolvePlacesMode, SEARCH_FIELD_MASK } from "@/lib/places/provider";
import { PlacesLookupError } from "@/lib/places/types";
import { generateInviteToken, hashInviteToken, inviteUrl, isInviteToken } from "@/lib/signup/invite-token";
import { createGaragePayload, parseAccountForm, parseGarageDetails, parseGarageForm, parseInviteForm, parseOpeningHours, parseSlug } from "@/lib/signup/schema";
import { createGarageError } from "@/lib/signup/server";
import { slugAlternatives, slugify, slugProblem } from "@/lib/signup/slug";
import { composeInviteEmail } from "@/lib/team/server";
import { RESERVED_SLUGS } from "@/lib/tenancy/hosts";

const [kingsway, station, millfield] = PLACE_FIXTURES;

describe("booking link slugs", () => {
  it("turns garage names into slugs", () => {
    expect(slugify("Kingsway Autocare")).toBe("kingsway-autocare");
    expect(slugify("  O'Brien’s Motors & MOT Centre ")).toBe("obriens-motors-and-mot-centre");
    expect(slugify("Café Garáge -- 24/7")).toBe("cafe-garage-24-7");
    expect(slugify("A".repeat(60))).toHaveLength(40);
    expect(slugify("Garage name that is exactly long enough to cut-here")).not.toMatch(/-$/);
  });

  it("names the problem with a slug", () => {
    expect(slugProblem("")).toBe("empty");
    expect(slugProblem("ab")).toBe("too_short");
    expect(slugProblem("a".repeat(41))).toBe("too_long");
    expect(slugProblem("Kingsway")).toBe("characters");
    expect(slugProblem("kings_way")).toBe("characters");
    expect(slugProblem("-kingsway")).toBe("hyphens");
    expect(slugProblem("kings--way")).toBe("hyphens");
    expect(slugProblem("kingsway-")).toBe("hyphens");
    expect(slugProblem("admin")).toBe("reserved");
    expect(slugProblem("www")).toBe("reserved");
    expect(slugProblem("kingsway-autocare")).toBeNull();
    expect(slugProblem("a1-motors")).toBeNull();
  });

  it("parses typed slugs case-insensitively", () => {
    expect(parseSlug("  Kingsway-Autocare ")).toEqual({ ok: true, value: "kingsway-autocare" });
    expect(parseSlug("api")).toEqual({ ok: false, errors: { slug: "That link is reserved. Try another." } });
  });

  it("offers well-formed alternatives when a slug is taken", () => {
    expect(slugAlternatives("kingsway-autocare", "Doncaster")).toEqual(["kingsway-autocare-doncaster", "kingsway-autocare-2", "kingsway-autocare-3"]);
    expect(slugAlternatives("a".repeat(40))).toEqual([`${"a".repeat(37)}-2`, `${"a".repeat(37)}-3`]);
    for (const candidate of slugAlternatives("station-road-garage", "Sutton-in-Ashfield")) expect(slugProblem(candidate)).toBeNull();
  });

  it("keeps the database's reserved list equal to RESERVED_SLUGS", () => {
    const sql = readFileSync(resolve(__dirname, "../../supabase/migrations/20261028000400_signup.sql"), "utf8");
    const body = /create function public\.reserved_garage_slugs\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/.exec(sql)?.[1] ?? "";
    const fromSql = [...body.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]).sort();
    expect(fromSql).toEqual([...RESERVED_SLUGS].sort());
  });
});

describe("Google Places mapping (recorded fixtures)", () => {
  it("maps a full listing", () => {
    expect(mapPlaceDetails(kingsway!)).toEqual({
      id: "ChIJmockKingswayAutocare01",
      name: "Kingsway Autocare",
      phone: "+441632960123",
      website: "https://kingsway-autocare.example/",
      address: { line1: "Unit 4, Kingsway Trade Park, 12 Kingsway", line2: "Balby", town: "Doncaster", postcode: "DN4 5AB" },
      openingHours: [
        { weekday: 1, opens: "08:00", closes: "17:30" },
        { weekday: 2, opens: "08:00", closes: "17:30" },
        { weekday: 3, opens: "08:00", closes: "17:30" },
        { weekday: 4, opens: "08:00", closes: "17:30" },
        { weekday: 5, opens: "08:00", closes: "17:00" },
        { weekday: 6, opens: "09:00", closes: "12:30" },
      ],
      formattedAddress: "Unit 4, Kingsway Trade Park, 12 Kingsway, Doncaster DN4 5AB, UK",
    });
  });

  it("keeps split days and drops overnight periods", () => {
    const hours = placeOpeningHours(station!);
    expect(hours.filter((window) => window.weekday === 1)).toEqual([
      { weekday: 1, opens: "08:30", closes: "12:30" },
      { weekday: 1, opens: "13:30", closes: "17:30" },
    ]);
    expect(hours.some((window) => window.weekday === 6 || window.weekday === 7)).toBe(false);
    expect(describeOpeningHours(hours)).toBe("Mon 08:30–12:30, 13:30–17:30 · Tue–Fri 08:30–17:30");
  });

  it("maps Sunday to ISO weekday 7, refuses overlaps and 24-hour periods", () => {
    expect(placeOpeningHours({ regularOpeningHours: { periods: [
      { open: { day: 0, hour: 10, minute: 0 }, close: { day: 0, hour: 14, minute: 0 } },
      { open: { day: 0, hour: 12, minute: 0 }, close: { day: 0, hour: 15, minute: 0 } },
      { open: { day: 3, hour: 0, minute: 0 } },
    ] } })).toEqual([{ weekday: 7, opens: "10:00", closes: "14:00" }]);
  });

  it("copes with a sparse listing", () => {
    const details = mapPlaceDetails(millfield!);
    expect(details).toMatchObject({ phone: null, website: null, openingHours: [], address: { line1: "Millfield Lane", line2: "Thorne", town: "Doncaster", postcode: "DN8 4ZZ" } });
  });

  it("normalises phones and websites", () => {
    expect(placePhone({ internationalPhoneNumber: "+44 7700 900123" })).toBe("+447700900123");
    expect(placePhone({ nationalPhoneNumber: "01302 555 123" })).toBe("+441302555123");
    expect(placePhone({ internationalPhoneNumber: "+1 415-555-0100" })).toBe("+14155550100");
    expect(placePhone({})).toBeNull();
    expect(placeWebsite("javascript:alert(1)")).toBeNull();
    expect(placeWebsite("http://garage.example/page?utm_source=x&id=2")).toBe("http://garage.example/page?id=2");
    expect(placeAddress([], "1 High Street, Leeds LS1 1AA, UK")).toEqual({ line1: "1 High Street", line2: "", town: "", postcode: "" });
  });
});

describe("Places provider", () => {
  it("chooses live only with a key, mock outside production, off in production", () => {
    expect(resolvePlacesMode({ GOOGLE_PLACES_API_KEY: "k" })).toBe("live");
    expect(resolvePlacesMode({})).toBe("mock");
    expect(resolvePlacesMode({ VERCEL_ENV: "production" })).toBe("off");
    expect(resolvePlacesMode({ VERCEL_ENV: "production", PLACES_PROVIDER: "mock" })).toBe("off");
    expect(resolvePlacesMode({ PLACES_PROVIDER: "live" })).toBe("off");
    expect(resolvePlacesMode({ PLACES_PROVIDER: "mock", GOOGLE_PLACES_API_KEY: "k" })).toBe("mock");
    expect(resolvePlacesMode({ PLACES_PROVIDER: "off", GOOGLE_PLACES_API_KEY: "k" })).toBe("off");
  });

  it("bounds the search text", () => {
    expect(cleanPlacesQuery("  ab ")).toBeNull();
    expect(cleanPlacesQuery("kingsway   doncaster")).toBe("kingsway doncaster");
    expect(cleanPlacesQuery("x".repeat(500))).toHaveLength(120);
    expect(cleanPlacesQuery(42)).toBeNull();
  });

  it("serves the fixtures in mock mode", async () => {
    const mock = createMockPlacesProvider();
    expect(await mock.search("kingsway doncaster")).toEqual([
      { id: "ChIJmockKingswayAutocare01", name: "Kingsway Autocare", address: "Unit 4, Kingsway Trade Park, 12 Kingsway, Doncaster DN4 5AB, UK" },
      { id: "ChIJmockMillfieldMotors03", name: "Millfield Motors", address: "Millfield Lane, Thorne, Doncaster DN8 4ZZ, UK" },
    ]);
    expect(await mock.search("nothing like it")).toEqual([]);
    await expect(mock.details("ChIJunknownPlace0000")).rejects.toThrow(PlacesLookupError);
  });

  it("calls Places (New) with the key in a header and field masks, never in the URL", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = String(url).includes(":searchText") ? { places: [kingsway] } : kingsway;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const live = createGooglePlacesProvider("secret-key", fetchImpl as typeof fetch);
    expect(await live.search("kingsway")).toHaveLength(1);
    expect((await live.details("ChIJmockKingswayAutocare01")).phone).toBe("+441632960123");
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ textQuery: "kingsway", regionCode: "GB", languageCode: "en-GB", pageSize: 5 });
    expect(calls[0]!.init.headers).toMatchObject({ "X-Goog-Api-Key": "secret-key", "X-Goog-FieldMask": SEARCH_FIELD_MASK });
    expect(calls[1]!.url).toBe("https://places.googleapis.com/v1/places/ChIJmockKingswayAutocare01?languageCode=en-GB&regionCode=GB");
    expect(calls[1]!.init.headers).toMatchObject({ "X-Goog-FieldMask": DETAILS_FIELD_MASK });
    for (const call of calls) expect(call.url).not.toContain("secret-key");
  });

  it("turns HTTP and network failures into codes without the key", async () => {
    const failing = (status: number) => createGooglePlacesProvider("secret-key", (async () => new Response("{}", { status })) as typeof fetch);
    await expect(failing(429).search("kingsway")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(failing(403).search("kingsway")).rejects.toMatchObject({ code: "unavailable" });
    await expect(failing(404).details("ChIJmockKingswayAutocare01")).rejects.toMatchObject({ code: "not_found" });
    const broken = createGooglePlacesProvider("secret-key", (async () => { throw new Error("connect failed secret-key"); }) as typeof fetch);
    const error = await broken.search("kingsway").catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(PlacesLookupError);
    expect(String((error as Error).message)).not.toContain("secret-key");
    await expect(broken.details("not a place id")).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("wizard validation", () => {
  const goodDetails = {
    name: " Kingsway  Autocare ",
    phone: "01632 960123",
    email: "Bookings@Kingsway.example",
    website: "kingsway-autocare.example",
    line1: "12 Kingsway",
    line2: "",
    town: "Doncaster",
    postcode: "dn45ab",
  };

  it("accepts and normalises the account form", () => {
    expect(parseAccountForm({ name: " Sam  Owner ", email: " Sam@Garage.example ", password: "correct horse battery" })).toEqual({
      ok: true,
      value: { name: "Sam Owner", email: "sam@garage.example", password: "correct horse battery" },
    });
  });

  it("refuses weak account details with messages per field", () => {
    const result = parseAccountForm({ name: "S", email: "not-an-email", password: "short" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["email", "name", "password"]);
    const containsEmail = parseAccountForm({ name: "Sam", email: "samowner@garage.example", password: "samowner-is-me-2026" });
    expect(containsEmail.ok).toBe(false);
    expect(parseAccountForm({ name: "Sam", email: "sam@garage.example", password: " padded password " }).ok).toBe(false);
  });

  it("normalises garage details", () => {
    expect(parseGarageDetails(goodDetails)).toEqual({
      ok: true,
      value: {
        name: "Kingsway Autocare",
        phone: "+441632960123",
        email: "bookings@kingsway.example",
        website: "https://kingsway-autocare.example/",
        address: { line1: "12 Kingsway", line2: "", town: "Doncaster", postcode: "DN4 5AB" },
      },
    });
  });

  it("names every missing or wrong garage field", () => {
    const result = parseGarageDetails({ name: "", phone: "12345", email: "nope", website: "not a site", line1: "", town: "", postcode: "XYZ" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["email", "line1", "name", "phone", "postcode", "town", "website"]);
  });

  it("parses opening hours from the wizard and refuses bad ones", () => {
    expect(parseOpeningHours("")).toEqual([]);
    expect(parseOpeningHours(JSON.stringify([{ weekday: 1, opens: "08:00", closes: "17:30" }]))).toEqual([{ weekday: 1, opens: "08:00", closes: "17:30" }]);
    expect(parseOpeningHours("not json")).toBeNull();
    expect(parseOpeningHours(JSON.stringify([{ weekday: 8, opens: "08:00", closes: "17:30" }]))).toBeNull();
    expect(parseOpeningHours(JSON.stringify([{ weekday: 1, opens: "18:00", closes: "17:30" }]))).toBeNull();
    expect(parseOpeningHours(JSON.stringify([{ weekday: 1, opens: "08:00", closes: "12:00" }, { weekday: 1, opens: "11:00", closes: "13:00" }]))).toBeNull();
  });

  it("builds create_garage()'s payload from the final post", () => {
    const hours = [{ weekday: 1, opens: "08:00", closes: "17:30" }];
    const parsed = parseGarageForm({ ...goodDetails, slug: "Kingsway-Autocare", placeId: "ChIJmockKingswayAutocare01", useOpeningHours: "yes", openingHours: JSON.stringify(hours) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(createGaragePayload(parsed.value)).toEqual({
      name: "Kingsway Autocare",
      slug: "kingsway-autocare",
      phone: "+441632960123",
      email: "bookings@kingsway.example",
      website: "https://kingsway-autocare.example/",
      google_place_id: "ChIJmockKingswayAutocare01",
      address: { line1: "12 Kingsway", line2: "", town: "Doncaster", postcode: "DN4 5AB" },
      opening_hours: hours,
    });
    const untouched = parseGarageForm({ ...goodDetails, slug: "kingsway", useOpeningHours: "no", openingHours: JSON.stringify(hours) });
    expect(untouched.ok && untouched.value.openingHours).toEqual([]);
    const badPlace = parseGarageForm({ ...goodDetails, slug: "kingsway", placeId: "../../etc" });
    expect(badPlace.ok).toBe(false);
    const reserved = parseGarageForm({ ...goodDetails, slug: "admin" });
    expect(reserved.ok || reserved.errors.slug).toBe("That link is reserved. Try another.");
  });

  it("parses invites", () => {
    expect(parseInviteForm({ email: " Tech@Garage.example ", role: "front_desk" })).toEqual({ ok: true, value: { email: "tech@garage.example", role: "front_desk" } });
    expect(parseInviteForm({ email: "x", role: "owner" })).toEqual({ ok: false, errors: { email: "Enter their email address.", role: "Choose a role." } });
  });
});

describe("create_garage() errors", () => {
  it("maps database codes and never passes text through", () => {
    expect(createGarageError("SLUG_TAKEN")).toEqual({ ok: false, code: "SLUG_TAKEN" });
    expect(createGarageError("INVALID_GARAGE: phone")).toEqual({ ok: false, code: "INVALID_GARAGE", field: "phone" });
    expect(createGarageError("GARAGE_LIMIT_REACHED")).toEqual({ ok: false, code: "GARAGE_LIMIT_REACHED" });
    expect(createGarageError('duplicate key value violates "secret"')).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(createGarageError(undefined)).toEqual({ ok: false, code: "UNAVAILABLE" });
  });
});

describe("invite links", () => {
  it("are 43-character random tokens stored as SHA-256", () => {
    const token = generateInviteToken();
    expect(isInviteToken(token)).toBe(true);
    expect(generateInviteToken()).not.toBe(token);
    expect(hashInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(isInviteToken("short")).toBe(false);
    expect(isInviteToken(`${token.slice(0, 42)}/`)).toBe(false);
    expect(inviteUrl(token, "https://pitline.co.uk")).toBe(`https://pitline.co.uk/signup/invite/${token}`);
  });

  it("compose an email that names the garage, role and expiry", () => {
    const email = composeInviteEmail({ garageName: "Kingsway <Autocare>", inviterName: "Sam", role: "front_desk", link: "https://pitline.co.uk/signup/invite/x" });
    expect(email.subject).toBe("Join Kingsway <Autocare> on Pitline");
    expect(email.text).toContain("as front desk.");
    expect(email.text).toContain("7 days");
    expect(email.html).toContain("Kingsway &lt;Autocare&gt;");
    expect(composeInviteEmail({ garageName: "G", inviterName: "Sam", role: "manager", link: "l" }).text).toContain("as a manager.");
  });
});
