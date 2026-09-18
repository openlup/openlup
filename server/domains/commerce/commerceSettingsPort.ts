/**
 * Read access to admin-editable commerce settings (the `commerce_settings` table).
 *
 * v1 exposes only the flat shipping rate. The quote port treats shipping as a flat
 * per-order gross charged when no free-shipping promo applies; a free-shipping promo
 * zeroes it in the shipping lane. Resolved server-side (deterministic), so the same
 * value is reproduced by the order-draft snapshot verifier.
 */
export interface CommerceSettingsPort {
  /** Flat shipping cost in minor units, or 0 when unset (fail-open to free shipping). */
  getShippingFlatMinor(): Promise<number>;
}

/** Independent text setting used by the storefront configurator. */
export interface CommerceOfferLayoutSettingsPort {
  getConfiguratorOfferLayout(): Promise<ConfiguratorOfferLayout>;
}
import type { ConfiguratorOfferLayout } from "../../../src/domains/commerce/offerLayoutContracts.js";
