// InPost's rules for presenting pickup points in a custom (non-Geowidget) list.
// InPost permits building one on the ShipX Points resource, but binds how each
// point is labelled, so these strings are contractual, not product copy:
// https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/45744192
//
// Deliberately NOT routed through i18n. They are mandated verbatim strings and
// registered brand names; an i18n key invites a well-meaning translation of
// "Paczkomat®" into "Parcel Locker" on /en, which silently breaches the rules.
// Everything around them (buttons, empty states) stays translatable.
import type { PickupPointSearchResult } from "./pickupPointSearchContracts";

const BRAND_LABELS = {
  locker: "Paczkomat®",
  service_point: "PaczkoPunkt",
} as const satisfies Record<
  NonNullable<PickupPointSearchResult["pointKind"]>,
  string
>;

/** Mandated notice for an Appkomat, which only opens via the InPost app. */
export const INPOST_APP_ASSISTED_NOTICE =
  "Ważne! Swoją paczkę odbierzesz wygodniej z aplikacją InPost";

/**
 * The brand label a point must be presented under, or `null` when its kind is
 * unrecognized. Returning `null` rather than defaulting is deliberate: showing
 * no label is allowed, showing the *wrong* brand is a breach.
 */
export function inpostBrandLabel(point: Pick<PickupPointSearchResult, "pointKind">): string | null {
  return point.pointKind ? BRAND_LABELS[point.pointKind] : null;
}

/** The notice to display for this point, or `null` when none is required. */
export function inpostAppAssistedNotice(
  point: Pick<PickupPointSearchResult, "appAssisted">,
): string | null {
  return point.appAssisted ? INPOST_APP_ASSISTED_NOTICE : null;
}

/**
 * `57` -> `"57 m"`, `312.4` -> `"310 m"`, `18400` -> `"18,4 km"` (pl); `null` when
 * the search had no relative point to measure from.
 *
 * Metres below a kilometre, because this is a walking distance and rounding it
 * to one decimal of a kilometre destroys the useful part: a locker 57 m away
 * would read "0.1 km" and one across the street "0.0 km", which looks like a
 * null rather than the best result in the list. Rounded to 10 m above 100 m so
 * the number does not imply more precision than a geocoded postcode has.
 *
 * `Intl`, not `toFixed`: the latter always emits a dot, so Polish customers
 * would read "18.4 km" instead of "18,4 km".
 */
export function formatDistance(distanceMeters: number | null, locale = "pl"): string | null {
  if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters)) return null;
  if (distanceMeters < 1000) {
    const rounded =
      distanceMeters < 100 ? Math.round(distanceMeters) : Math.round(distanceMeters / 10) * 10;
    return `${rounded} m`;
  }
  const km = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(distanceMeters / 1000);
  return `${km} km`;
}
