// Token-free InPost parcel-locker point lookup via the public ShipX Points API
// (GET https://api-shipx-pl.easypack24.net/v1/points). The read endpoint is
// publicly accessible without auth (verified) and returns name, address,
// coordinates, opening hours, and a distance when relative_point is supplied.
//
// Two uses:
//   - `search(...)` powers the token-free list fallback picker.
//   - `getById(code)` authoritatively confirms a single locker chosen client-side
//     (e.g. from the official InPost Geowidget map) — it exists AND is Operating —
//     and returns its canonical address, so a browser-supplied locker code is
//     validated server-side rather than trusted.
export const INPOST_SHIPX_POINTS_BASE_URL = "https://api-shipx-pl.easypack24.net/v1";

// Infra-local point shape (vendor infra must not import the shipping domain).
// The BFF composition root maps this onto the domain PickupPointSearchResult.
export interface InpostPickupPoint {
  id: string;
  name: string;
  address: { line1: string; postalCode: string; city: string; country: "PL" };
  location: { latitude: number; longitude: number } | null;
  locationDescription: string | null;
  openingHours: string | null;
  distanceMeters: number | null;
  /** Normalized `partner_id`: 0 -> locker, 33 -> service_point, unknown -> null. */
  pointKind: "locker" | "service_point" | null;
  /** `physical_type_mapped: "006"` — an Appkomat, which requires an app to open. */
  appAssisted: boolean;
}

// InPost's display rules bind on partner_id; anything else must stay unlabelled
// rather than be guessed, because a wrong brand label breaches them.
const PARTNER_ID_LOCKER = 0;
const PARTNER_ID_SERVICE_POINT = 33;
const PHYSICAL_TYPE_APPKOMAT = "006";
// pickupPointSearchResultSchema bounds these, the BFF safeParses the WHOLE
// points array, and one failure returns INVALID_RESPONSE for the entire search.
// So a single overlong vendor string — one locker with a chatty
// location_description — would deterministically break the picker for every
// customer near it. `toResult` only guards presence, not length, so clamp every
// bounded field here at the vendor boundary. Keep in step with the contract.
const OPENING_HOURS_MAX = 120;
const LOCATION_DESCRIPTION_MAX = 240;
const NAME_MAX = 160;
const LINE1_MAX = 160;

export interface InpostPointsSearchInput {
  latitude?: number;
  longitude?: number;
  postalCode?: string;
  city?: string;
  query?: string;
  limit?: number;
}

export interface InpostPointsClientConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

export function createInpostPointsClient(config: InpostPointsClientConfig = {}, fetchImpl: typeof fetch = fetch) {
  const baseUrl = (config.baseUrl ?? INPOST_SHIPX_POINTS_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 8000;

  return {
    // Locators are alternatives, and the caller picks exactly one: a postal code
    // is geocoded by `relative_post_code` (which found points for 24/24 codes
    // probed), coordinates and a locker name are exact by construction. There is
    // deliberately no postal-code -> city retry: the only caller sends one
    // locator per request, so a retry could never have a city to fall back to,
    // and an empty result here is the honest answer rather than a different
    // town's lockers.
    async search(input: InpostPointsSearchInput): Promise<InpostPickupPoint[]> {
      return requestPoints({ ...input, limit: clampLimit(input.limit) }, { baseUrl, timeoutMs, fetchImpl });
    },

    // Authoritative single-locker lookup: GET /v1/points/{name}. Returns the
    // normalized point only when it exists and is Operating (a NonOperating or
    // unknown-status locker resolves to null so it is rejected at validation).
    async getById(code: string): Promise<InpostPickupPoint | null> {
      const name = code.trim();
      if (!name) return null;
      const url = new URL(`${baseUrl}/points/${encodeURIComponent(name)}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: unknown;
      try {
        const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`inpost_points_http_${response.status}`);
        body = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const record = asRecord(body);
      const status = text(record.status);
      // Accept when status is absent (defensive) but reject any explicit non-Operating.
      if (status && status.toLowerCase() !== "operating") return null;
      return toResult(record);
    },
  };
}

async function requestPoints(
  input: InpostPointsSearchInput,
  options: { baseUrl: string; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<InpostPickupPoint[]> {
  const limit = clampLimit(input.limit);
  const url = new URL(`${options.baseUrl}/points`);
  url.searchParams.set("type", "parcel_locker");
  url.searchParams.set("status", "Operating");
  url.searchParams.set("per_page", String(limit));
  // Locators are mutually exclusive, most precise first. Both relative locators
  // make ShipX geocode and return a `distance`, so they get an explicit
  // distance sort — the list UI's whole premise is "row 1 is nearest". A
  // relative sort on a plain `city=` query is meaningless, so it is omitted.
  if (hasCoordinates(input)) {
    url.searchParams.set("relative_point", `${input.latitude},${input.longitude}`);
    setDistanceSort(url);
  } else if (input.query) {
    url.searchParams.set("name", input.query.trim().toUpperCase());
  } else if (input.postalCode) {
    // NOT `post_code`: that is an exact point-address filter and misses every
    // code no locker happens to sit on (0 results for 8 of 24 codes probed).
    // `relative_post_code` geocodes the code server-side at InPost instead.
    url.searchParams.set("relative_post_code", input.postalCode.trim());
    setDistanceSort(url);
  } else if (input.city) {
    url.searchParams.set("city", input.city.trim());
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let body: unknown;
  try {
    const response = await options.fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      // A code InPost cannot geocode is a 400 `post_code_not_found`, not an
      // empty list. Treat it as "no points" so a typo shows the empty state
      // instead of a 500 (withObservedRoute escalates a throw to 5xx). With
      // geocoding and no distance filter a valid code effectively never
      // returns zero, so "unknown code" and "nothing nearby" share one state.
      if (response.status === 400 && (await isPostCodeNotFound(response))) return [];
      throw new Error(`inpost_points_http_${response.status}`);
    }
    body = await response.json();
  } finally {
    clearTimeout(timer);
  }

  const items = Array.isArray((body as { items?: unknown })?.items) ? (body as { items: unknown[] }).items : [];
  return items.map(toResult).filter((point): point is InpostPickupPoint => point !== null).slice(0, limit);
}

function hasCoordinates(input: InpostPointsSearchInput): boolean {
  return typeof input.latitude === "number" && typeof input.longitude === "number";
}

function setDistanceSort(url: URL): void {
  url.searchParams.set("sort_by", "distance_to_relative_point");
  url.searchParams.set("sort_order", "asc");
}

async function isPostCodeNotFound(response: Response): Promise<boolean> {
  try {
    return asRecord(await response.json()).key === "post_code_not_found";
  } catch {
    return false;
  }
}

function toResult(raw: unknown): InpostPickupPoint | null {
  const item = asRecord(raw);
  const id = text(item.name);
  const details = asRecord(item.address_details);
  const address = asRecord(item.address);
  const line1 = text(address.line1) || joinStreet(details);
  const city = text(details.city);
  const postCode = text(details.post_code);
  if (!id || !line1 || !city || !postCode) return null;
  const location = asRecord(item.location);
  const lat = num(location.latitude);
  const lng = num(location.longitude);
  return {
    id,
    // Must match inpostGeowidgetPoint.ts: the same locker has to persist the
    // same name whether it was picked from this list or on the map.
    name: clamp(text(item.display_name) || `Paczkomat ${id}`, NAME_MAX),
    address: { line1: clamp(line1, LINE1_MAX), postalCode: postCode, city, country: "PL" },
    location: lat !== null && lng !== null ? { latitude: lat, longitude: lng } : null,
    locationDescription: clampNullable(nullableText(item.location_description), LOCATION_DESCRIPTION_MAX),
    openingHours: clampNullable(nullableText(item.opening_hours), OPENING_HOURS_MAX),
    distanceMeters: num(item.distance),
    pointKind: toPointKind(item.partner_id),
    appAssisted: text(item.physical_type_mapped) === PHYSICAL_TYPE_APPKOMAT,
  };
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function clampNullable(value: string | null, max: number): string | null {
  return value === null ? null : clamp(value, max);
}

function toPointKind(rawPartnerId: unknown): InpostPickupPoint["pointKind"] {
  if (rawPartnerId === PARTNER_ID_LOCKER) return "locker";
  if (rawPartnerId === PARTNER_ID_SERVICE_POINT) return "service_point";
  return null;
}

function joinStreet(details: Record<string, unknown>): string {
  return [text(details.street), text(details.building_number)].filter(Boolean).join(" ").trim();
}

function clampLimit(limit: number | undefined): number {
  return Number.isInteger(limit) && limit! >= 1 && limit! <= 50 ? limit! : 10;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function nullableText(value: unknown): string | null {
  return text(value) || null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
