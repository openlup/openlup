import { z } from "../../lib/validation/zod.js";

/**
 * Site-wide default offer layout for the package configurator.
 *
 * Which offer a first-time visitor sees first is a merchandising decision, not a
 * release decision: it is stored as one `commerce_settings` row and read through
 * a public BFF endpoint, so changing it is an operator UPDATE rather than a
 * redeploy. The vocabulary is closed on both sides — a DB CHECK and this enum.
 *
 * The default below is the fail-safe used whenever the setting cannot be read
 * (missing row, NULL, unknown string, or an unavailable endpoint). It is
 * deliberately `subscription_first`, which is what production presents today, so
 * a read failure degrades to the status quo instead of a silent re-merchandising.
 */

export const COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION =
  "commerce.configurator-offer-layout.v1" as const;

export const CONFIGURATOR_OFFER_LAYOUTS = [
  "subscription_first",
  "one_time_first",
  "starter_first",
] as const;

export type ConfiguratorOfferLayout = (typeof CONFIGURATOR_OFFER_LAYOUTS)[number];

export const DEFAULT_CONFIGURATOR_OFFER_LAYOUT: ConfiguratorOfferLayout =
  "subscription_first";

export const configuratorOfferLayoutResponseSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION),
    layout: z.enum(CONFIGURATOR_OFFER_LAYOUTS),
  })
  .strict();

export type ConfiguratorOfferLayoutResponse = z.infer<
  typeof configuratorOfferLayoutResponseSchema
>;

export function isConfiguratorOfferLayout(
  value: unknown,
): value is ConfiguratorOfferLayout {
  return (
    typeof value === "string" &&
    (CONFIGURATOR_OFFER_LAYOUTS as readonly string[]).includes(value)
  );
}
