import type {
  CatalogCurrency,
  CatalogProduct,
  CatalogSku,
} from "../../../src/domains/catalog/types.js";
import type {
  CommercePriceAuthorityRefusal,
  PricingResolverPort,
} from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice } from "../../../src/domains/pricing/types.js";
import {
  readSettlementProfile,
  type SettlementProfile,
} from "../../../src/lib/currency/platformCurrency.js";

/**
 * Live pricing join for the DB-backed catalog read port.
 *
 * The structural read port leaves every SKU `pricing.status = "not_configured"`
 * (that is what keeps it byte-identical to the static port — the parity gate). This
 * module overlays REAL list prices resolved from the commerce-v2 pricing tables via
 * the {@link PricingResolverPort}, so a caller that enables the pricing resolver
 * can carry current list prices.
 *
 * The "list price" shown on the storefront is the one-time base tier: mode
 * `one_time`, a single unit (`lineQty = eligibleCartQty = 1`), in the catalog's
 * region/currency. Price entries are gross by schema default
 * (`commerce_v2_w2_pricing_core`), so the resolved `unitPriceMinor` is used directly
 * as the displayed gross amount — no VAT math here (that lives in the quote path,
 * which is the authority on the price actually charged). A variant with no matching
 * entry stays `not_configured` rather than quoting zero.
 *
 * Decoupling note: this imports only the pricing PORT + TYPES (public domain
 * segments), never the resolver adapter — the adapter is constructed in the BFF
 * layer and injected, keeping the catalog domain free of a cross-domain adapter
 * dependency (architecture guardrail).
 */
export interface CatalogPricingRegion {
  regionCode: string;
  currency: CatalogCurrency;
}

/** Private batch seam for the one exact current base anchor per catalog SKU. */
export interface CatalogExactOneTimeBasePriceReadPort {
  listExactOneTimeBasePrices(query: CatalogListPriceQuery): Promise<ReadonlyMap<string, ResolvedPrice>>;
}

/**
 * Why a single SKU was left unpriced by the batch reader.
 *
 * A per-SKU price fault degrades that one SKU to `not_configured` rather than
 * refusing the whole batch, because one mispriced SKU must not remove the entire
 * storefront listing. The degrade is therefore the SAFE direction - but a SILENT
 * degrade is the unsafe one: it turns a loud 503 into an invisible missing price.
 * Every degrade emits exactly one of these so the fault stays attributable to the
 * variant that caused it.
 *
 * ⛔ Deployment-wide faults (`active_price_list_not_found`,
 * `active_price_list_ambiguous`) are NOT degraded and never reach here. They are
 * not per-SKU data faults, and degrading them would blank every price at once
 * while reporting success.
 *
 * Private, bounded operational fact: a variant id and a refusal code, never
 * request or customer data.
 */
export interface CatalogListPriceRefusalDiagnostic {
  event: "catalog_list_price_sku_degraded";
  variant_id: string;
  refusal_code: Extract<
    CommercePriceAuthorityRefusal,
    "base_price_not_found" | "base_price_ambiguous" | "base_price_amount_kind_invalid"
  >;
}

/**
 * Classify one variant's exact-base candidates and, when they cannot anchor a
 * price, emit the degrade and report it. Returns true when the caller must skip
 * this variant, leaving it `not_configured`.
 *
 * Both the Postgres and Supabase batch readers call this ONE function. They are
 * separately implemented and would otherwise drift in what they refuse and in
 * what they report - the drift being invisible precisely because each adapter's
 * own test would keep passing.
 */
export function degradedExactOneTimeBase(
  variantId: string,
  candidateCount: number,
  amountKind: string | undefined,
): boolean {
  const refusal = candidateCount === 0
    ? "base_price_not_found"
    : candidateCount !== 1
      ? "base_price_ambiguous"
      : amountKind !== "gross"
        ? "base_price_amount_kind_invalid"
        : null;
  if (!refusal) return false;
  try {
    console.info(JSON.stringify({
      event: "catalog_list_price_sku_degraded", variant_id: variantId, refusal_code: refusal,
    } satisfies CatalogListPriceRefusalDiagnostic));
  } catch {
    // A private diagnostic sink must never alter the price read it observes.
  }
  return true;
}

export interface CatalogListPriceQuery extends CatalogPricingRegion {
  variantIds: readonly string[];
  atTime: string;
}

/**
 * The region the catalog reads list prices for when a caller names none. Read
 * from the deployment's settlement profile rather than written here, so the
 * catalog's displayed price and the quote path's charged price cannot end up
 * asking the resolver two different questions.
 */
export const DEFAULT_CATALOG_PRICING_REGION: CatalogPricingRegion = catalogPricingRegionOf(
  readSettlementProfile(process.env),
);

function catalogPricingRegionOf(profile: SettlementProfile): CatalogPricingRegion {
  return { regionCode: profile.regionCode, currency: profile.defaultCurrency };
}

export async function joinCatalogPricing(
  products: CatalogProduct[],
  resolver: PricingResolverPort,
  region: CatalogPricingRegion = DEFAULT_CATALOG_PRICING_REGION,
): Promise<CatalogProduct[]> {
  return Promise.all(products.map((product) => joinProductPricing(product, resolver, region)));
}

/**
 * Private public-discovery join. Unlike the legacy catalog join above, this
 * accepts the bounded list reader and one caller-pinned instant. It is never
 * selected by the live legacy catalog read port.
 */
export async function joinCatalogListPricing(
  products: CatalogProduct[],
  priceReader: CatalogExactOneTimeBasePriceReadPort,
  region: CatalogPricingRegion = DEFAULT_CATALOG_PRICING_REGION,
  atTime: string,
): Promise<CatalogProduct[]> {
  const variantIds = [...new Set(products.flatMap((product) => product.variants
    .map((variant) => variant.variantId)
    .filter(Boolean)))];
  const resolvedByVariant = await priceReader.listExactOneTimeBasePrices({ ...region, variantIds, atTime });

  return applyResolvedCatalogPricing(products, resolvedByVariant, region);
}

async function joinProductPricing(
  product: CatalogProduct,
  resolver: PricingResolverPort,
  region: CatalogPricingRegion,
): Promise<CatalogProduct> {
  const variants = await Promise.all(
    product.variants.map((variant) => joinSkuPricing(variant, resolver, region)),
  );

  // primarySku is the same logical SKU as one of the variants; re-point it at the
  // re-priced instance (match by variantId, falling back to the first variant) so
  // the displayed price is consistent between the product and its primary SKU.
  const primarySku =
    variants.find((variant) => variant.variantId === product.primarySku.variantId) ??
    variants[0] ??
    product.primarySku;

  return { ...product, primarySku, variants };
}

async function joinSkuPricing(
  sku: CatalogSku,
  resolver: PricingResolverPort,
  region: CatalogPricingRegion,
): Promise<CatalogSku> {
  // A placeholder/empty SKU has no resolvable variant id — leave it untouched.
  if (!sku.variantId) return sku;
  const resolved = await resolver.resolvePrice({
    variantId: sku.variantId,
    mode: "one_time",
    lineQty: 1,
    eligibleCartQty: 1,
    regionCode: region.regionCode,
    currency: region.currency,
  });
  return applyResolvedSkuPricing(sku, resolved, region);
}

function applyResolvedCatalogPricing(
  products: CatalogProduct[],
  resolvedByVariant: ReadonlyMap<string, ResolvedPrice>,
  region: CatalogPricingRegion,
): CatalogProduct[] {
  return products.map((product) => {
    const variants = product.variants.map((variant) => {
      return applyResolvedSkuPricing(variant, resolvedByVariant.get(variant.variantId) ?? null, region);
    });
    const primarySku = variants.find((variant) => variant.variantId === product.primarySku.variantId)
      ?? variants[0]
      ?? product.primarySku;
    return { ...product, primarySku, variants };
  });
}

function applyResolvedSkuPricing(
  sku: CatalogSku,
  resolved: ResolvedPrice | null,
  region: CatalogPricingRegion,
): CatalogSku {
  if (!resolved) return sku;
  return {
    ...sku,
    pricing: {
      ...sku.pricing,
      status: "configured",
      listPrice: { amountMinor: resolved.unitPriceMinor, currency: region.currency },
    },
  };
}
