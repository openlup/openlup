// Provider-neutral carrier → customer tracking-URL registry.
//
// Fulfilment providers (OmniPack, DHL direct, future 3PLs) report a shipment's
// carrier in their own vocabulary: an explicit carrier kind ("inpost"), a
// carrier API code ("SHIPX" — InPost's ShipX platform), or only a service code
// ("INPOST_LOCKER_STANDARD" / "inpost_locker_standard"). This module owns the
// two provider-neutral steps every consumer needs:
//
//   1. normalizeCarrierKind — collapse that evidence to a canonical lowercase
//      carrier kind (the same vocabulary `selectedDelivery.carrierKind` uses).
//   2. carrierTrackingUrl — build the public tracking page URL for a carrier
//      kind + tracking number.
//
// Carriers without a registered URL map to a null URL on purpose: a missing
// link (the email falls back to the bare tracking number) beats a wrong link.
// This registry maps carrier → URL only; fulfilment STATUS vocabulary stays in
// the status canon (config/fulfillment-status-map.json) — do not add status
// mappings here.

const TRACKING_URL_BUILDERS: Record<string, (trackingNumber: string) => string> = {
  inpost: (nr) => `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(nr)}`,
  dpd: (nr) => `https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${encodeURIComponent(nr)}`,
  dhl: (nr) => `https://www.dhl.com/pl-pl/home/tracking.html?tracking-id=${encodeURIComponent(nr)}`,
};

// Carrier API platforms that identify a carrier without naming it directly.
const CARRIER_CODE_ALIASES: Record<string, string> = {
  shipx: "inpost",
};

export interface CarrierTrackingEvidence {
  /** Canonical carrier kind when the source already carries one (e.g. selectedDelivery.carrierKind). */
  carrierKind?: string | null;
  /** Provider-reported carrier/platform code, e.g. "SHIPX". */
  carrier?: string | null;
  /** Provider-reported service code, e.g. "INPOST_LOCKER_STANDARD" or "inpost_locker_standard". */
  service?: string | null;
}

function carrierKindFromToken(candidate: string | null | undefined): string | null {
  const token = candidate?.trim().toLowerCase();
  if (!token) return null;
  const whole = CARRIER_CODE_ALIASES[token] ?? token;
  if (TRACKING_URL_BUILDERS[whole]) return whole;
  // Service codes lead with the carrier: "inpost_locker_standard" → "inpost".
  const prefix = token.split(/[_-]/, 1)[0];
  return prefix ? CARRIER_CODE_ALIASES[prefix] ?? prefix : null;
}

/**
 * Collapse carrier evidence to a canonical lowercase carrier kind ("inpost" |
 * "dpd" | "dhl" | ...), or null when no evidence was provided. Prefers the
 * first candidate that resolves to a carrier with a registered tracking URL;
 * otherwise keeps the first recognizable token (informative even when no URL
 * is known for it).
 */
export function normalizeCarrierKind(evidence: CarrierTrackingEvidence): string | null {
  const kinds = [evidence.carrierKind, evidence.carrier, evidence.service]
    .map(carrierKindFromToken)
    .filter((kind): kind is string => kind !== null);
  return kinds.find((kind) => Boolean(TRACKING_URL_BUILDERS[kind])) ?? kinds[0] ?? null;
}

/**
 * Public tracking page URL for a carrier kind + tracking number, or null when
 * the carrier has no registered tracking page or the tracking number is blank.
 */
export function carrierTrackingUrl(
  carrierKind: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  const nr = trackingNumber?.trim();
  if (!nr) return null;
  const build = TRACKING_URL_BUILDERS[carrierKind?.trim().toLowerCase() ?? ""];
  return build ? build(nr) : null;
}

/**
 * One-step convenience: normalize the carrier evidence and build the tracking
 * URL. Returns both so callers can persist carrier_kind + tracking_url together.
 */
export function resolveCarrierTracking(
  evidence: CarrierTrackingEvidence,
  trackingNumber: string | null | undefined,
): { carrierKind: string | null; trackingUrl: string | null } {
  const carrierKind = normalizeCarrierKind(evidence);
  return { carrierKind, trackingUrl: carrierTrackingUrl(carrierKind, trackingNumber) };
}
