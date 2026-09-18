import {
  deriveBundleAvailability,
  type BundleAvailability,
  type BundleAvailabilityComponent,
} from "../../../src/domains/bundle/availability.js";
import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityPort,
  CommerceOfferAvailabilityRequestItem,
} from "../../../src/domains/commerce/ports.js";
import type {
  ActiveBundleComposition,
  BundleCatalogReadPort,
  BundleComponentRow,
} from "./bundleCatalogReadPort.js";

/**
 * Derived bundle stock, composed from the two ports that already know the halves:
 * the bundle read port knows the bill of materials, the EXISTING commerce offer
 * availability port knows what a unit's stock is. Nothing here re-derives stock and
 * nothing here opens a database handle.
 *
 * ONE BATCHED CALL, ALWAYS. Every component of every bundle in the request is
 * asked for in a single `getAvailability`, deduplicated by sku, because the
 * underlying port answers a set in three queries — asking per bundle would turn a
 * catalogue listing into a query storm and would let two bundles sharing a unit
 * disagree about its stock inside one response.
 *
 * A sku the availability port does not answer for is a MISSING figure, not zero:
 * it is folded in as `sellableNow: null`, so the pure kernel reports the bundle as
 * unknown and names the component rather than quietly overselling or hiding it.
 */

export interface BundleAvailabilityServiceDeps {
  bundleCatalogReadPort: BundleCatalogReadPort;
  offerAvailabilityPort: CommerceOfferAvailabilityPort;
  /** Threshold handed to the pure kernel; its own default applies when omitted. */
  lowStockThreshold?: number;
  includeAddonsInStock?: boolean;
}

export interface BundleAvailabilityRow {
  composition: ActiveBundleComposition;
  availability: BundleAvailability;
  /**
   * The EXACT rows the kernel was given, carried out again rather than recomputed.
   *
   * The bundle-level answer names one limiting component; an operator staring at a bundle that
   * cannot ship needs to know how far off every OTHER component is too, so they can tell "order one
   * more of this" from "this bundle is months away". These rows are the only place that figure
   * exists — the kernel folds them into a single number and the sellable feed's components carry
   * price, never stock. Returning them costs nothing here and is the alternative to a second stock
   * derivation somewhere that can disagree with this one.
   */
  components: readonly BundleAvailabilityComponent[];
}

export interface BundleAvailabilityService {
  /** Fold stock into a set of compositions the caller already holds. */
  describeCompositions(
    compositions: readonly ActiveBundleComposition[],
  ): Promise<BundleAvailabilityRow[]>;
  /** Read the live sellable set and fold stock into it. */
  describeActiveBundles(input?: { currency?: string }): Promise<BundleAvailabilityRow[]>;
}

export function createBundleAvailabilityService(
  deps: BundleAvailabilityServiceDeps,
): BundleAvailabilityService {
  async function describeCompositions(
    compositions: readonly ActiveBundleComposition[],
  ): Promise<BundleAvailabilityRow[]> {
    if (compositions.length === 0) return [];

    const items = requestItems(compositions);
    const stock = items.length === 0
      ? new Map<string, number | null>()
      : sellableBySku(await deps.offerAvailabilityPort.getAvailability({ items }));

    return compositions.map((composition) => {
      const components = composition.components.map((component) => ({
        sku: component.sku,
        quantity: component.quantity,
        isAddon: component.isAddon,
        // `has` distinguishes "answered null" from "never answered"; both fold to
        // null, and neither is allowed to become a number here.
        sellableNow: stock.has(component.sku) ? (stock.get(component.sku) ?? null) : null,
      }));
      return {
        composition,
        components,
        availability: deriveBundleAvailability({
          components,
          lowStockThreshold: deps.lowStockThreshold,
          includeAddonsInStock: deps.includeAddonsInStock,
        }),
      };
    });
  }

  return {
    describeCompositions,
    async describeActiveBundles(input: { currency?: string } = {}) {
      return describeCompositions(
        await deps.bundleCatalogReadPort.listActiveBundleCompositions(input),
      );
    },
  };
}

/**
 * The port to use where no stock source is bound at all.
 *
 * It answers every item with `sellableNow: null`, which the kernel reads as
 * unknown — so a deployment without an inventory rail publishes bundles whose
 * price is exact and whose stock is honestly unstated. The alternative, omitting
 * the availability block, would have made "we do not know" indistinguishable from
 * "we did not ask", and the alternative to THAT — defaulting to available —
 * oversells on a deployment that never counted anything.
 */
export function createUnknownOfferAvailabilityPort(): CommerceOfferAvailabilityPort {
  return {
    getAvailability({ items }) {
      return Promise.resolve(
        items.map((item) => ({
          sku: item.sku,
          productSlug: item.productSlug,
          variantId: item.variantId,
          status: "unknown" as const,
          visibleInConfigurator: true,
          sellableNow: null,
          reasonCode: "stock_unknown",
          source: "unbound",
        })),
      );
    },
  };
}

/**
 * One request item per distinct sku across every bundle. `requestedQuantity` stays
 * at the port's own default of one: the question asked is "how many units exist",
 * and the multiplication by the bill of materials belongs to the pure kernel,
 * which is the only place that knows how many bundles a figure buys.
 */
function requestItems(
  compositions: readonly ActiveBundleComposition[],
): CommerceOfferAvailabilityRequestItem[] {
  const bySku = new Map<string, BundleComponentRow>();
  for (const composition of compositions) {
    for (const component of composition.components) {
      if (!bySku.has(component.sku)) bySku.set(component.sku, component);
    }
  }
  return [...bySku.values()].map((component) => ({
    sku: component.sku,
    productSlug: component.productSlug,
    variantId: component.variantId,
    requestedQuantity: 1,
    checkoutMode: "one_time" as const,
  }));
}

function sellableBySku(
  answers: readonly CommerceOfferAvailability[],
): Map<string, number | null> {
  return new Map(answers.map((answer) => [answer.sku, answer.sellableNow ?? null]));
}
