import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type {
  CommerceMoney,
  CommerceQuotePricingComponent,
} from "../../../src/domains/commerce/types.js";
import type { PricingComponent } from "../../../src/domains/commerce/pricingBreakdown.js";
import { CommerceQuoteError } from "../../../src/domains/commerce/ports.js";
import {
  CommercePriceAuthorityError,
  type CommercePriceAuthorityPort,
  type CommercePriceAuthorityResult,
  type PricingResolverPort,
} from "../../../src/domains/pricing/ports.js";
import type { PricingMode, ResolvedPrice } from "../../../src/domains/pricing/types.js";
import type {
  CommerceQuoteCatalogItem,
  CommerceQuoteCatalogReadPort,
} from "./commerceQuoteCatalogReadPort.js";

/** Pure helpers for the DB-backed commerce quote port (extracted to keep the port under the LOC cap). */

export interface SkuIndexEntry {
  item: CommerceQuoteCatalogItem;
}

export async function buildSkuIndex(
  quoteCatalogReadPort: CommerceQuoteCatalogReadPort,
): Promise<Map<string, SkuIndexEntry>> {
  const items = await quoteCatalogReadPort.listQuoteCatalogItems();
  return new Map(
    items.map((item) => [item.skuCode, { item }] as const),
  );
}

export function eligibleQtyForMode(request: CreateQuoteRequest, mode: Exclude<PricingMode, "any">): number {
  return request.lines
    .filter((line) => !line.isAddon)
    .filter((line) => (line.modeAtLine ?? request.mode) === mode)
    .reduce((sum, line) => sum + line.quantity, 0);
}

export async function resolveOneTimeComparison(input: {
  pricingResolverPort: PricingResolverPort;
  variantId: string;
  lineQty: number;
  eligibleCartQty: number;
  regionCode: string;
  currency: string;
  atTime: string;
}): Promise<ResolvedPrice | null> {
  return input.pricingResolverPort.resolvePrice({
    variantId: input.variantId,
    mode: "one_time",
    lineQty: input.lineQty,
    eligibleCartQty: input.eligibleCartQty,
    regionCode: input.regionCode,
    currency: input.currency,
    atTime: input.atTime,
  });
}

export interface StrictQuotePriceResolution {
  base: ResolvedPrice;
  resolved: ResolvedPrice;
  policy?: {
    policyRevisionId: string;
    policyDigest: string;
  };
}

/**
 * Strict D1 quotes have one exact base anchor. Subscription money is either
 * derived by a validated policy, or is the authority's explicit pre-cutover
 * legacy observation; this layer never reaches back to the generic resolver.
 */
export async function resolveStrictQuotePrice(input: {
  commercePriceAuthorityPort: CommercePriceAuthorityPort;
  variantId: string;
  mode: Exclude<PricingMode, "any">;
  regionCode: string;
  currency: string;
  channel: string;
  atTime: string;
}): Promise<StrictQuotePriceResolution> {
  try {
    const authority = await input.commercePriceAuthorityPort.resolvePrice({
      variantId: input.variantId,
      mode: input.mode,
      regionCode: input.regionCode,
      currency: input.currency,
      channel: input.channel,
      atTime: input.atTime,
    });
    return strictQuotePriceResolution(authority, input.mode);
  } catch (error) {
    if (error instanceof CommercePriceAuthorityError) {
      throw new CommerceQuoteError(
        "PRICE_NOT_CONFIGURED",
        "Commerce price is not configured",
        { reason: error.code },
      );
    }
    throw error;
  }
}

function strictQuotePriceResolution(
  authority: CommercePriceAuthorityResult,
  requestedMode: Exclude<PricingMode, "any">,
): StrictQuotePriceResolution {
  const base = authority.base;
  if (base.mode !== "one_time" || base.matchedMinQty !== 1) {
    throw new CommerceQuoteError(
      "PRICING_INVARIANT_VIOLATION",
      "Strict money authority did not return an exact one-time base anchor",
      { basePriceEntryId: base.priceEntryId, mode: base.mode, matchedMinQty: base.matchedMinQty },
    );
  }

  if (requestedMode === "one_time") {
    if (authority.kind !== "one_time" || authority.unitPriceMinor !== base.unitPriceMinor) {
      throw new CommerceQuoteError(
        "PRICING_INVARIANT_VIOLATION",
        "Strict money authority returned an invalid one-time result",
        { authorityKind: authority.kind, basePriceEntryId: base.priceEntryId },
      );
    }
    return { base, resolved: base };
  }

  if (authority.kind === "subscription_policy") {
    return {
      base,
      resolved: { ...base, mode: "subscription", unitPriceMinor: authority.unitPriceMinor },
      policy: {
        policyRevisionId: authority.policy.id,
        policyDigest: authority.policy.digest,
      },
    };
  }
  if (authority.kind === "subscription_legacy") {
    if (authority.legacyResolved.mode !== "subscription" || authority.legacyResolved.unitPriceMinor !== authority.unitPriceMinor) {
      throw new CommerceQuoteError(
        "PRICING_INVARIANT_VIOLATION",
        "Strict money authority returned an invalid legacy subscription result",
        { legacyPriceEntryId: authority.legacyResolved.priceEntryId, mode: authority.legacyResolved.mode },
      );
    }
    return { base, resolved: authority.legacyResolved };
  }
  throw new CommerceQuoteError(
    "PRICING_INVARIANT_VIOLATION",
    "Strict money authority returned a one-time result for a subscription quote",
    { authorityKind: authority.kind, basePriceEntryId: base.priceEntryId },
  );
}

export function assertSubscriptionCheapest(input: {
  requestSku: string;
  modeAtLine: Exclude<PricingMode, "any">;
  resolved: ResolvedPrice;
  oneTime: ResolvedPrice | null;
  vatRateBps: number;
}): void {
  if (
    input.modeAtLine === "subscription" &&
    input.oneTime &&
    toGrossMinor(input.resolved, input.vatRateBps) > toGrossMinor(input.oneTime, input.vatRateBps)
  ) {
    throw new CommerceQuoteError(
      "PRICING_INVARIANT_VIOLATION",
      "Subscription price must not exceed active one-time price",
      {
        sku: input.requestSku,
        subscriptionPriceEntryId: input.resolved.priceEntryId,
        oneTimePriceEntryId: input.oneTime.priceEntryId,
      },
    );
  }
}

export function toGrossMinor(price: ResolvedPrice, vatRateBps: number): number {
  if (price.amountKind === "gross") return price.unitPriceMinor;
  return Math.round((price.unitPriceMinor * (10_000 + vatRateBps)) / 10_000);
}

export function calculateIncludedVat(
  grossMinor: number,
  vatRateBps: number,
): { netMinor: number; vatMinor: number } {
  const netMinor = Math.round((grossMinor * 10_000) / (10_000 + vatRateBps));
  return {
    netMinor,
    vatMinor: grossMinor - netMinor,
  };
}

/**
 * The component types the quote transport can actually carry. Declared as an
 * exhaustive record over the app union on purpose: when that union grows, this
 * object stops compiling until the seam below is updated with it.
 *
 * The kernel vocabulary used to be AHEAD of the transport: `bundle` existed in the
 * pricing kernel from wave A2 while neither this union nor the
 * `order_line_pricing_breakdown` `component_type` CHECK carried it, because
 * widening either half alone puts a value on the wire that the other half rejects.
 * Wave A3 closes that gap and moves both halves in one commit — the CHECK in
 * 20260812203000 and this record together. The tripwire stays: the next component
 * type the kernel learns stops this object compiling until the same pair moves again.
 */
const TRANSPORT_COMPONENT_TYPES: Record<CommerceQuotePricingComponent["componentType"], true> = {
  base_unit: true,
  mode_discount: true,
  qty_tier: true,
  promo: true,
  loyalty: true,
  shipping: true,
  bundle: true,
};

function isTransportComponentType(
  componentType: PricingComponent["component_type"],
): componentType is CommerceQuotePricingComponent["componentType"] {
  return Object.prototype.hasOwnProperty.call(TRANSPORT_COMPONENT_TYPES, componentType);
}

/**
 * Map one kernel pricing component onto the quote transport shape.
 *
 * A component type outside the transport union stops the quote loudly. It is never
 * cast through and never silently dropped: a dropped component breaks the breakdown
 * invariant (components must sum to the line total), so a quote would go out priced
 * from an incomplete explanation of its own total.
 */
export function mapPricingComponent(
  component: PricingComponent,
  scope: "line" | "order",
): CommerceQuotePricingComponent {
  const componentType = component.component_type;
  if (!isTransportComponentType(componentType)) {
    throw new CommerceQuoteError(
      "PRICING_INVARIANT_VIOLATION",
      "Pricing component type is not carried by the quote transport",
      { componentType, carriedTypes: Object.keys(TRANSPORT_COMPONENT_TYPES) },
    );
  }
  return {
    scope,
    componentType,
    amountMinor: component.amount_minor,
    reasonCode: component.reason_code,
    reasonPayload: component.reason_payload,
  };
}

/**
 * A money builder bound to one currency.
 *
 * This used to be a plain `money(amountMinor)` that stamped the settlement
 * currency as a literal, which meant the quote's declared `currency` and the
 * currency on every amount inside it came from two different places. They
 * agreed only because the port's `currency` option was typed as that same
 * literal. Binding the builder once per port makes the agreement structural:
 * there is no second place left for the two to disagree.
 */
export function moneyIn(currency: string): (amountMinor: number) => CommerceMoney {
  return (amountMinor) => ({ amountMinor, currency });
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Energy content of one unit of a SKU, from the product's per-100g composition
 * and the SKU's net weight. Null when either input is missing, because an
 * estimate resting on a guessed weight is worse than no estimate at all.
 */
export function catalogEnergyPerUnit(
  kcalPer100g: number | null | undefined,
  netWeightGrams: number | undefined,
): number | null {
  return Number.isFinite(kcalPer100g) && Number.isFinite(netWeightGrams)
    ? Math.round(((kcalPer100g as number) * (netWeightGrams as number)) / 100)
    : null;
}

/** Coverage days, rounded to one decimal. Informational only. */
export function roundCoverage(value: number): number {
  return Math.round(value * 10) / 10;
}
