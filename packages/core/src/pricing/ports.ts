import type { ResolvedPrice, ResolvePriceQuery } from "./types.js";

/**
 * Pricing resolver port - deterministic price resolution from a data-driven
 * price-list / price-entry table.
 *
 * Caller computes eligible cart quantity for the line's pricing mode and
 * passes it in alongside the line's own quantity. Implementations select the
 * matching price entry for variant, mode, region, currency, and request time.
 * Any fallback policy, including fallback to a generic mode, is owned by the
 * adapter implementation; the port preserves the requested mode.
 *
 * Returns null when no entry matches; callers must surface a meaningful error
 * rather than silently quote zero.
 */
/** @beta */
export interface PricingResolverPort {
  resolvePrice(query: ResolvePriceQuery): Promise<ResolvedPrice | null>;
}

/** @beta */
export class PricingResolverNotConfiguredError extends Error {
  constructor(query: ResolvePriceQuery) {
    super(`No price entry for ${query.variantId} (${query.mode}) in ${query.regionCode}/${query.currency}`);
    this.name = "PricingResolverNotConfiguredError";
  }
}
