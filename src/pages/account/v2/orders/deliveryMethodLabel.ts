// Known OmniPack carrier service codes → a friendly, localized service-tier
// label. The carrier/service set is dictionary-driven (whatever OmniPack
// confirms for the merchant account), NOT a fixed allowlist — see
// deliverySelectionContracts — so any unknown code MUST route through the
// generic fallback: a raw enum/slug like `DHL_COURIER_STANDARD` must never
// render on the customer-facing orders surface (OBS-R2; same class as the
// OBS-12 payment-slug leak fixed in #1457).
const KNOWN_SERVICE_CODES = new Set([
  "inpost_locker_standard",
  "inpost_courier_standard",
  "dpd_courier_standard",
  "dhl_courier_standard",
]);

/**
 * Map a raw carrier service code (e.g. `DHL_COURIER_STANDARD`, or the lowercase
 * `service` slug on a tracking reference) to a friendly, localized label.
 * Returns null for an empty/absent code so the segment is dropped; a known code
 * resolves to its tier label; any unknown code resolves to the generic
 * fallback. A raw enum/slug can therefore never reach the DOM.
 */
export function serviceTierLabel(
  code: string | null | undefined,
  t: (key: string) => string,
): string | null {
  const key = code?.trim().toLowerCase();
  if (!key) return null;
  if (KNOWN_SERVICE_CODES.has(key)) {
    return t(`account:dashboard.ordersV2.serviceTier.${key}`);
  }
  return t("account:dashboard.ordersV2.serviceTier.fallback");
}
