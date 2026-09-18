import {
  offerAvailabilityReasonCode,
  offerAvailabilityStatusFor,
  type CommerceOfferAvailabilityStatus,
} from "../commerce/ports.js";

/**
 * Derived stock for a composed bundle — the pure kernel that folds many component
 * stock figures into ONE answer about the bundle.
 *
 * A bundle is only as sellable as its scarcest counted part: with a bill of
 * materials of `quantity` units per component, the number of whole bundles that
 * can ship is `min(floor(component.sellableNow / component.quantity))`. That
 * component is named (`limitingSku`) so an operator learns WHICH part is the
 * constraint instead of only that there is one.
 *
 * FAIL TO UNKNOWN, NEVER GUESS. If any counted component's stock is itself
 * unknown, the bundle's stock is unknown — not the minimum of the parts that did
 * answer. Treating a missing figure as unlimited oversells; treating it as zero
 * hides a sellable bundle. Both are decisions this module refuses to make, so it
 * reports `unknown` and names the component whose figure is missing.
 *
 * The status ladder and the reason-code vocabulary are IMPORTED from the commerce
 * domain's PUBLIC port seam rather than restated, so a bundle and a single unit
 * can never disagree about what `low_stock` means.
 *
 * Pure: integer arithmetic, no clock, no randomness, no I/O.
 */

/**
 * Threshold below which a bundle reads as `low_stock`. Deliberately far under the
 * single-unit default: a bundle consumes several units per sale, so the same raw
 * stock represents far fewer bundles and a unit-scale threshold would report
 * nearly every bundle as low.
 */
export const DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD = 3;

/** A counted component answered with no figure at all. */
export const BUNDLE_COMPONENT_STOCK_UNKNOWN = "component_stock_unknown";

/** Nothing was counted — no non-add-on component to derive an answer from. */
export const BUNDLE_COMPOSITION_EMPTY = "bundle_composition_empty";

export interface BundleAvailabilityComponent {
  sku: string;
  /** Units of this component consumed by ONE bundle; always positive. */
  quantity: number;
  isAddon: boolean;
  /** Sellable units of the component, or `null` when the figure is unknown. */
  sellableNow: number | null;
}

export interface BundleAvailability {
  /** Whole bundles that can ship now, or `null` when any counted part is unknown. */
  sellableNow: number | null;
  status: CommerceOfferAvailabilityStatus;
  reasonCode: string;
  /** The component that decided the answer; `null` only when nothing was counted. */
  limitingSku: string | null;
}

export interface DeriveBundleAvailabilityInput {
  components: readonly BundleAvailabilityComponent[];
  lowStockThreshold?: number;
  /**
   * Add-ons are excluded by default: an add-on is priced into the bundle but
   * optional in composition, so its stock must not make the bundle unsellable.
   * An operator who sells the add-on as mandatory opts in here.
   */
  includeAddonsInStock?: boolean;
}

export function deriveBundleAvailability(
  input: DeriveBundleAvailabilityInput,
): BundleAvailability {
  const counted = input.components.filter(
    (component) => input.includeAddonsInStock === true || !component.isAddon,
  );
  if (counted.length === 0) {
    return {
      sellableNow: null,
      status: "unknown",
      reasonCode: BUNDLE_COMPOSITION_EMPTY,
      limitingSku: null,
    };
  }

  // Unknown wins over every figure that did answer, and the named component is the
  // lowest sku among the unknown ones, so the same set always names the same part.
  const unknown = counted.filter((component) => component.sellableNow === null);
  if (unknown.length > 0) {
    return {
      sellableNow: null,
      status: "unknown",
      reasonCode: BUNDLE_COMPONENT_STOCK_UNKNOWN,
      limitingSku: lowestSku(unknown),
    };
  }

  let limiting = counted[0];
  let sellableNow = wholeBundles(counted[0]);
  for (const component of counted.slice(1)) {
    const candidate = wholeBundles(component);
    // Strictly lower wins; an exact tie is broken by ascending sku code units, so
    // the named component never depends on the order the composition was read in.
    if (candidate < sellableNow || (candidate === sellableNow && component.sku < limiting.sku)) {
      limiting = component;
      sellableNow = candidate;
    }
  }

  const status = offerAvailabilityStatusFor(
    sellableNow,
    input.lowStockThreshold ?? DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD,
  );
  return { sellableNow, status, reasonCode: offerAvailabilityReasonCode(status), limitingSku: limiting.sku };
}

/** Whole bundles this component alone can carry. */
function wholeBundles(component: BundleAvailabilityComponent): number {
  return Math.floor((component.sellableNow ?? 0) / component.quantity);
}

function lowestSku(components: readonly BundleAvailabilityComponent[]): string {
  return components.reduce(
    (lowest, component) => (component.sku < lowest ? component.sku : lowest),
    components[0].sku,
  );
}
