import { allocateBundleTargetPrice } from "@openlup/core/pricing";
import { SELLABLE_KIND_BUNDLE } from "./contracts.js";
import type { NormalizedChannelOrder, NormalizedChannelOrderLine } from "./orderContracts.js";

// Turning a marketplace's BUNDLE line into the component lines this shop can actually reserve,
// pick and ship — without moving a single cent.
//
// THE MONEY IS THE MARKETPLACE'S, NOT OURS. A bundle has a target price in this catalogue, but the
// channel already sold it, possibly under its own promotion, and the buyer has already paid the
// figure the wire reports. So the number that gets split across components is the CHANNEL-FINAL
// line subtotal (`lineGrossMinor - lineDiscountMinor`), never the catalogue's target price. The
// catalogue's per-component reference prices are used only as WEIGHTS — they decide how the
// channel's money is apportioned, not how much of it there is.
//
// TWO SPLITS, AND ONLY ONE OF THEM IS A PRICING DECISION. The first is the real one: the shared
// allocator apportions the channel-final subtotal across components by their reference subtotals,
// largest-remainder, summing to the target exactly. The second is bookkeeping: the order's header
// carries the wire's gross and discount separately, and two independent invariants downstream
// compare the sum of the item rows against each of them. Re-running the allocator on the gross
// would satisfy neither reliably — its output is not monotone in the target, so a component could
// come back with a gross BELOW its own channel-final share and produce a negative discount. So the
// discount is apportioned by the same largest-remainder rule over the same weights and ADDED to
// each component's channel-final share. Every component's discount is then non-negative by
// construction, both sums are exact, and `effective = gross - discount` is byte-for-byte the
// allocator's answer.
//
// WHY THIS IS NOT IN SQL. The allocator is the shop's one implementation of bundle price
// allocation, shared with the storefront's sellable feed and the admin price preview. A second
// implementation in PL/pgSQL would be a second answer to the same question. The ingest RPC's sum
// identities remain the backstop: it re-checks that whatever arrives sums to the header it was
// given, so an expansion that got the arithmetic wrong is refused rather than written.

/** One component line ready to be written as an order item, in the wire line's own vocabulary. */
export interface ExpandedChannelOrderLine {
  externalLineRef: string;
  externalOfferRef: string | null;
  skuCode: string;
  quantity: number;
  unitGrossMinor: number;
  lineGrossMinor: number;
  lineDiscountMinor: number;
  vatRateBps: number | null;
  /** Provenance: null for a line that was already a SKU on the wire. */
  bundleCode: string | null;
  /** How many of the bundle this component came from; null for a pass-through SKU line. */
  bundleQty: number | null;
}

/** The catalogue facts the expansion needs, in the channels domain's own words. */
export interface ChannelBundleComponent {
  skuCode: string;
  /** Units of this component in ONE bundle. */
  quantity: number;
  /** The catalogue's reference unit price — a WEIGHT here, never a price the buyer pays. */
  referenceUnitPriceMinor: number | null;
}

export interface ChannelBundleComposition {
  bundleCode: string;
  components: readonly ChannelBundleComponent[];
}

export interface ChannelBundleReadPort {
  /** Every bundle this deployment can sell today, keyed by code. */
  readActiveBundleCompositions(input: {
    currency: string;
  }): Promise<readonly ChannelBundleComposition[]>;
}

export type ChannelBundleExpansionRefusal =
  /** No active bundle in this catalogue carries the code the wire named. */
  | { kind: "unmapped_sellable"; vocabulary: string }
  /**
   * The bundle is known but its money cannot be apportioned: a component the catalogue prices
   * nowhere, or a channel-final subtotal outside what the components can carry. Named separately
   * from an unmapped code because it is a pricing problem an operator fixes in the catalogue, not
   * a mapping problem they fix on the channel.
   */
  | { kind: "money_mismatch"; vocabulary: string; detail: string };

export type ChannelBundleExpansion =
  | { ok: true; lines: readonly ExpandedChannelOrderLine[]; expanded: boolean }
  | { ok: false; refusal: ChannelBundleExpansionRefusal };

/** True when this order has anything the ingest RPC cannot write from the wire line alone. */
export function orderCarriesBundleLines(order: NormalizedChannelOrder): boolean {
  return order.lines.some((line) => line.sellable.kind === SELLABLE_KIND_BUNDLE);
}

export function expandChannelBundleLines(
  order: NormalizedChannelOrder,
  compositions: readonly ChannelBundleComposition[],
): ChannelBundleExpansion {
  const byCode = new Map(compositions.map((entry) => [entry.bundleCode, entry]));
  const lines: ExpandedChannelOrderLine[] = [];
  let expanded = false;

  for (const line of order.lines) {
    if (line.sellable.kind !== SELLABLE_KIND_BUNDLE) {
      lines.push(passThrough(line, line.sellable.skuCode));
      continue;
    }
    const code = line.sellable.bundleCode?.trim() ?? "";
    const composition = code ? byCode.get(code) : undefined;
    if (!composition) {
      // The far side's own token, verbatim, so an operator can search for the string they were
      // actually sent rather than for our rendering of it.
      return {
        ok: false,
        refusal: {
          kind: "unmapped_sellable",
          vocabulary: code || line.sellable.externalOfferRef || "(no bundle code)",
        },
      };
    }
    const exploded = explode(line, composition);
    if (!exploded.ok) return exploded;
    lines.push(...exploded.lines);
    expanded = true;
  }

  return { ok: true, lines, expanded };
}

function passThrough(
  line: NormalizedChannelOrderLine,
  skuCode: string | null,
): ExpandedChannelOrderLine {
  return {
    externalLineRef: line.externalLineRef,
    externalOfferRef: line.sellable.externalOfferRef,
    // Kept as the wire stated it, including the blank the RPC refuses: this function must not
    // become a second place where an unmappable SKU is decided.
    skuCode: skuCode ?? "",
    quantity: line.quantity,
    unitGrossMinor: line.unitGrossMinor,
    lineGrossMinor: line.lineGrossMinor,
    lineDiscountMinor: line.lineDiscountMinor,
    vatRateBps: line.vatRateBps,
    bundleCode: null,
    bundleQty: null,
  };
}

function explode(
  line: NormalizedChannelOrderLine,
  composition: ChannelBundleComposition,
): ChannelBundleExpansion {
  const priced: { skuCode: string; unitPriceMinor: number; quantity: number }[] = [];
  for (const component of composition.components) {
    if (component.referenceUnitPriceMinor === null) {
      return {
        ok: false,
        refusal: {
          kind: "money_mismatch",
          vocabulary: composition.bundleCode,
          detail: `component ${component.skuCode} has no reference price to weight by`,
        },
      };
    }
    priced.push({
      skuCode: component.skuCode,
      unitPriceMinor: component.referenceUnitPriceMinor,
      // The whole line's worth of this component: one bundle's quantity times how many bundles the
      // marketplace sold on this line.
      quantity: component.quantity * line.quantity,
    });
  }
  if (priced.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: "money_mismatch",
        vocabulary: composition.bundleCode,
        detail: "bundle has no components to allocate across",
      },
    };
  }

  const channelFinal = line.lineGrossMinor - line.lineDiscountMinor;
  const allocation = allocateBundleTargetPrice({
    components: priced.map((component) => ({
      sku: component.skuCode,
      unitPriceMinor: component.unitPriceMinor,
      quantity: component.quantity,
    })),
    targetPriceMinor: channelFinal,
  });
  if (allocation.ok === false) {
    return {
      ok: false,
      refusal: {
        kind: "money_mismatch",
        vocabulary: composition.bundleCode,
        detail: `channel-final ${channelFinal} cannot be allocated: ${allocation.code}`,
      },
    };
  }

  const weights = allocation.components.map((component) => component.referenceSubtotalMinor);
  const discounts = splitByLargestRemainder(line.lineDiscountMinor, weights);

  return {
    ok: true,
    expanded: true,
    lines: allocation.components.map((component, index) => {
      const effective = component.targetSubtotalMinor;
      const discount = discounts[index];
      const gross = effective + discount;
      const quantity = priced[index].quantity;
      return {
        externalLineRef: line.externalLineRef,
        externalOfferRef: line.sellable.externalOfferRef,
        skuCode: component.sku,
        quantity,
        // Informational only. A component's allocated money rarely divides evenly by its quantity,
        // and the order's money identities are stated on the LINE totals, never on this figure.
        unitGrossMinor: Math.round(gross / quantity),
        lineGrossMinor: gross,
        lineDiscountMinor: discount,
        // The bundle was sold as one taxable thing; every component inherits the rate the wire
        // declared for it, and the RPC's own chain resolves the rest when it declared none.
        vatRateBps: line.vatRateBps,
        bundleCode: composition.bundleCode,
        bundleQty: line.quantity,
      };
    }),
  };
}

/**
 * Apportion `total` across `weights`, largest remainder, ties to the lower index. Every share is
 * non-negative and they sum to `total` exactly. A zero total gives every share zero, which is the
 * common case: most marketplaces report their promotion in the line's own price rather than as a
 * separate discount.
 */
function splitByLargestRemainder(total: number, weights: readonly number[]): number[] {
  const shares = weights.map(() => 0);
  if (total <= 0 || weights.length === 0) return shares;
  const sum = weights.reduce((carry, weight) => carry + weight, 0);
  if (sum <= 0) {
    // Nothing to weight by: give it all to the first component rather than dropping it, because
    // the sum identity is what the order row will be checked against.
    shares[0] = total;
    return shares;
  }
  const remainders: { index: number; remainder: number }[] = [];
  let assigned = 0;
  weights.forEach((weight, index) => {
    const exact = (total * weight) / sum;
    const floor = Math.floor(exact);
    shares[index] = floor;
    assigned += floor;
    remainders.push({ index, remainder: exact - floor });
  });
  remainders.sort((left, right) =>
    right.remainder === left.remainder ? left.index - right.index : right.remainder - left.remainder,
  );
  for (let index = 0; index < total - assigned; index += 1) {
    shares[remainders[index % remainders.length].index] += 1;
  }
  return shares;
}
