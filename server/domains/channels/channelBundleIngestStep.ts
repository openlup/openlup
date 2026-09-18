import {
  expandChannelBundleLines,
  orderCarriesBundleLines,
  type ChannelBundleReadPort,
  type ExpandedChannelOrderLine,
} from "../../../src/domains/channels/bundleLineExpansion.js";
import type { NormalizedChannelOrder } from "../../../src/domains/channels/orderContracts.js";

// The saga's bundle step, as a decision that writes nothing.
//
// It lives beside the saga rather than inside it because it is the one step whose whole job is to
// change the SHAPE of the order rather than to advance it: a wire line naming a bundle becomes
// several component lines, or the order stops. Keeping it here leaves the saga's body as the five
// durable steps it has always been, in the order that is its correctness argument.
//
// IT RESOLVES, IT DOES NOT PERSIST. The refusal it returns is filed by the caller, through the same
// drawer every other refusal goes to, so there is exactly one place in this domain where an order
// becomes operator work.

export interface ChannelBundleStepRefusal {
  kind: "unmapped_sellable" | "money_mismatch";
  /** The far side's own token, verbatim, so an operator can search for what they were sent. */
  vocabulary: string;
  detail: string;
}

export type ChannelBundleStepOutcome =
  | { ok: true; lines: readonly ExpandedChannelOrderLine[] | undefined }
  | { ok: false; refusal: ChannelBundleStepRefusal };

export async function resolveBundleExpansion(input: {
  bundles: ChannelBundleReadPort | undefined;
  order: NormalizedChannelOrder;
  currency: string;
}): Promise<ChannelBundleStepOutcome> {
  // An order with no bundle line needs no expansion, and `undefined` is the answer the store reads
  // as "write the wire lines". An empty array would mean an order with no lines at all.
  if (!orderCarriesBundleLines(input.order)) return { ok: true, lines: undefined };

  if (!input.bundles) {
    // Named as an unmapped sellable rather than as a fault, because that is what it is from the
    // operator's side: this deployment cannot map the bundle the far side sold.
    return {
      ok: false,
      refusal: {
        kind: "unmapped_sellable",
        vocabulary: firstBundleToken(input.order),
        detail: "no bundle catalogue is bound on this deployment",
      },
    };
  }

  const compositions = await input.bundles.readActiveBundleCompositions({
    currency: input.currency,
  });
  const expansion = expandChannelBundleLines(input.order, compositions);
  if (expansion.ok === false) {
    return {
      ok: false,
      refusal: {
        kind: expansion.refusal.kind,
        vocabulary: expansion.refusal.vocabulary,
        detail:
          expansion.refusal.kind === "money_mismatch"
            ? expansion.refusal.detail
            : `bundle ${expansion.refusal.vocabulary} is not sellable by this catalogue today`,
      },
    };
  }
  return { ok: true, lines: expansion.lines };
}

/** The first bundle code on the order, for a refusal raised before any line was examined. */
function firstBundleToken(order: NormalizedChannelOrder): string {
  for (const line of order.lines) {
    if (line.sellable.kind !== "bundle") continue;
    return line.sellable.bundleCode ?? line.sellable.externalOfferRef ?? "(no bundle code)";
  }
  return "(no bundle line)";
}
