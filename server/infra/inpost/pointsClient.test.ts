import { describe, expect, it, vi } from "vitest";
import { createInpostPointsClient } from "./pointsClient.js";

// Mirrors the live ShipX /v1/points item shape (captured from the public API).
const SAMPLE = {
  items: [
    {
      name: "PNET0900",
      display_name: "InPost Paczkomat PNET0900",
      type: "parcel_locker",
      status: "Operating",
      partner_id: 0,
      physical_type_mapped: "004",
      location: { longitude: 20.9238, latitude: 52.24851 },
      location_description: "Przy salonie Perfect Lashes",
      opening_hours: "24/7",
      distance: 312.4,
      address: { line1: "Rosy Bailly 1B", line2: "01-494 Warszawa" },
      address_details: { city: "Warszawa", post_code: "01-494", street: "Rosy Bailly", building_number: "1B" },
    },
    { name: "", address_details: {} }, // malformed -> dropped
  ],
};

function fetchReturning(body: unknown, captured: { url?: string } = {}) {
  return vi.fn(async (url: URL | string) => {
    captured.url = String(url);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function fetchFailing(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: false, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

// Locators MUST be asserted through searchParams, never as a substring:
// `relative_post_code=00-850` *contains* `post_code=00-850`, so a substring
// assertion passes whichever parameter the client actually sends.
function params(url: string | undefined): URLSearchParams {
  return new URL(String(url)).searchParams;
}

describe("InPost ShipX points client", () => {
  it("maps a point and drops malformed entries", async () => {
    const client = createInpostPointsClient({}, fetchReturning(SAMPLE));
    const points = await client.search({ city: "Warszawa" });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      id: "PNET0900",
      name: "InPost Paczkomat PNET0900",
      address: { line1: "Rosy Bailly 1B", postalCode: "01-494", city: "Warszawa", country: "PL" },
      location: { latitude: 52.24851, longitude: 20.9238 },
      openingHours: "24/7",
      distanceMeters: 312.4,
      pointKind: "locker",
      appAssisted: false,
    });
  });

  it("sends relative_point for coordinate (nearest) search and filters to parcel lockers", async () => {
    const captured: { url?: string } = {};
    const client = createInpostPointsClient({}, fetchReturning(SAMPLE, captured));
    await client.search({
      latitude: 52.23,
      longitude: 21.01,
      postalCode: "00-850",
      city: "Warszawa",
      limit: 5,
    });
    const query = params(captured.url);
    expect(query.get("relative_point")).toBe("52.23,21.01");
    expect(query.get("type")).toBe("parcel_locker");
    expect(query.get("per_page")).toBe("5");
    expect(query.has("post_code")).toBe(false);
    expect(query.has("relative_post_code")).toBe(false);
    expect(query.has("city")).toBe(false);
  });

  it("geocodes a postal code via relative_post_code rather than the exact post_code filter", async () => {
    const captured: { url?: string } = {};
    const client = createInpostPointsClient({}, fetchReturning(SAMPLE, captured));
    await client.search({ postalCode: "00-850" });
    const query = params(captured.url);
    // The regression this whole change exists for: `post_code` is an exact
    // point-address filter and returned 0 lockers for 8 of 24 codes probed.
    expect(query.get("relative_post_code")).toBe("00-850");
    expect(query.has("post_code")).toBe(false);
  });

  it("sorts relative searches by distance, and does not constrain them by radius", async () => {
    const captured: { url?: string } = {};
    const client = createInpostPointsClient({}, fetchReturning(SAMPLE, captured));
    await client.search({ postalCode: "00-850" });
    const query = params(captured.url);
    expect(query.get("sort_by")).toBe("distance_to_relative_point");
    expect(query.get("sort_order")).toBe("asc");
    // A radius filter would re-introduce the empty-list failure for rural
    // customers — the very population the exact-post_code bug already punished.
    expect(query.has("max_distance")).toBe(false);
  });

  it("omits the distance sort on a city search, which has no relative point", async () => {
    const captured: { url?: string } = {};
    const client = createInpostPointsClient({}, fetchReturning(SAMPLE, captured));
    await client.search({ city: "Warszawa" });
    const query = params(captured.url);
    expect(query.get("city")).toBe("Warszawa");
    expect(query.has("sort_by")).toBe(false);
    expect(query.has("sort_order")).toBe(false);
  });

  it("uses an exact point query without combining other locators", async () => {
    const captured: { url?: string } = {};
    const client = createInpostPointsClient({}, fetchReturning(SAMPLE, captured));

    await client.search({ query: "waw01a", postalCode: "00-850", city: "Warszawa" });

    const query = params(captured.url);
    expect(query.get("name")).toBe("WAW01A");
    expect(query.has("post_code")).toBe(false);
    expect(query.has("relative_post_code")).toBe(false);
    expect(query.has("city")).toBe(false);
  });

  it("issues exactly one request when the postal search returns results", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => SAMPLE } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createInpostPointsClient({}, fetchImpl);

    await client.search({ postalCode: "34-480", city: "Orawka" });

    expect(urls).toHaveLength(1);
    expect(params(urls[0]).get("relative_post_code")).toBe("34-480");
    expect(params(urls[0]).has("city")).toBe(false);
  });

  it("never issues a second request: locators are alternatives, not a retry chain", async () => {
    // The only caller sends ONE locator per request, so a postal -> city retry
    // could never have a city to fall back to. `relative_post_code` geocodes and
    // found points for 24/24 codes probed; an empty result is the honest answer,
    // not a cue to show a different town's lockers.
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createInpostPointsClient({}, fetchImpl);

    const points = await client.search({ postalCode: "01-914", city: "Warszawa", limit: 3 });

    expect(points).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(params(urls[0]).get("relative_post_code")).toBe("01-914");
    expect(params(urls[0]).has("city")).toBe(false);
  });

  it("does not fall back to city when coordinates found nothing", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createInpostPointsClient({}, fetchImpl);

    await client.search({ latitude: 52.23, longitude: 21.01, city: "Warszawa" });

    expect(urls).toHaveLength(1);
  });

  it("treats an ungeocodable postal code as no points rather than an error", async () => {
    // Live ShipX answers 400 {"key":"post_code_not_found"} for e.g. 99-999.
    // Throwing here would surface as a 5xx to the customer for a mere typo.
    const client = createInpostPointsClient({}, fetchFailing(400, { status: 400, key: "post_code_not_found", error: "Post code not found." }));
    await expect(client.search({ postalCode: "99-999" })).resolves.toEqual([]);
  });

  it("still throws on other client and server errors", async () => {
    const badRequest = createInpostPointsClient({}, fetchFailing(400, { status: 400, key: "validation_failed" }));
    await expect(badRequest.search({ postalCode: "00-850" })).rejects.toThrow("inpost_points_http_400");

    const serverError = createInpostPointsClient({}, fetchFailing(500, {}));
    await expect(serverError.search({ postalCode: "00-850" })).rejects.toThrow("inpost_points_http_500");
  });

  describe("InPost display obligations", () => {
    async function mapOne(overrides: Record<string, unknown>) {
      const client = createInpostPointsClient({}, fetchReturning({ items: [{ ...SAMPLE.items[0], ...overrides }] }));
      const [point] = await client.search({ city: "Warszawa" });
      return point;
    }

    it("normalizes partner_id into the point kind the label is derived from", async () => {
      expect((await mapOne({ partner_id: 0 })).pointKind).toBe("locker");
      expect((await mapOne({ partner_id: 33 })).pointKind).toBe("service_point");
      // Unknown must stay unlabelled: a wrong brand label breaches the rules,
      // a missing one does not.
      expect((await mapOne({ partner_id: 99 })).pointKind).toBeNull();
      expect((await mapOne({ partner_id: undefined })).pointKind).toBeNull();
    });

    it("flags an Appkomat, which the customer must be told needs the app", async () => {
      expect((await mapOne({ physical_type_mapped: "006" })).appAssisted).toBe(true);
      expect((await mapOne({ physical_type_mapped: "004" })).appAssisted).toBe(false);
      expect((await mapOne({ physical_type_mapped: undefined })).appAssisted).toBe(false);
    });

    it("falls back to the same display name the map picker uses", async () => {
      // Drift here means one locker persists two different names depending on
      // whether it was chosen in the list or on the map.
      expect((await mapOne({ display_name: undefined })).name).toBe("Paczkomat PNET0900");
    });

    it("clamps every bounded field, because one long string fails the WHOLE search", async () => {
      // The BFF safeParses the entire points array and returns INVALID_RESPONSE
      // if any element fails, so one chatty location_description would break the
      // picker for every customer near that locker — the same failure class this
      // client exists to fix. toResult guards presence, not length.
      const point = await mapOne({
        opening_hours: "x".repeat(200),
        location_description: "y".repeat(400),
        display_name: "z".repeat(300),
        address: { line1: "w".repeat(300) },
      });
      expect(point.openingHours).toHaveLength(120);
      expect(point.locationDescription).toHaveLength(240);
      expect(point.name).toHaveLength(160);
      expect(point.address.line1).toHaveLength(160);
      // The safeParse round-trip for these bounds lives in
      // pickupPointSearchFactory.test.ts: vendor infra must not import the
      // shipping domain (providerInfraBoundary guards it).
    });
  });

  describe("getById", () => {
    const POINT = SAMPLE.items[0];

    it("fetches a single point by code and normalizes it", async () => {
      const captured: { url?: string } = {};
      const client = createInpostPointsClient({}, fetchReturning(POINT, captured));

      const point = await client.getById("PNET0900");

      expect(captured.url).toContain("/points/PNET0900");
      expect(point).toMatchObject({
        id: "PNET0900",
        address: { postalCode: "01-494", city: "Warszawa", country: "PL" },
      });
    });

    it("returns null for an unknown code (404)", async () => {
      const client = createInpostPointsClient({}, fetchFailing(404, {}));
      expect(await client.getById("NOPE01")).toBeNull();
    });

    it("rejects a non-Operating locker", async () => {
      const client = createInpostPointsClient({}, fetchReturning({ ...POINT, status: "NonOperating" }));
      expect(await client.getById("PNET0900")).toBeNull();
    });

    it("returns null for a blank code without calling the network", async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const client = createInpostPointsClient({}, fetchImpl);
      expect(await client.getById("  ")).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
