import type {
  Bundle,
  CompositionConstraint,
  CompositionRulesPort,
} from "@openlup/core/bundle";
import type { PricingResolverPort, ResolvedPrice } from "@openlup/core/pricing";

type CompositionRule = {
  requiredCoreQty: number;
  rejectedVariantId?: string;
};

function ruleOf(constraint: CompositionConstraint): CompositionRule {
  return {
    requiredCoreQty: Number(constraint.data.requiredCoreQty ?? 0),
    rejectedVariantId: typeof constraint.data.rejectedVariantId === "string"
      ? constraint.data.rejectedVariantId
      : undefined,
  };
}

export function createNullCompositionRulesPort(): CompositionRulesPort {
  return {
    async validateComposition(input: Bundle) {
      const rule = ruleOf(input.constraint);
      const coreQty = input.coreLines.reduce((total, line) => total + line.qty, 0);
      const rejectedLine = [...input.coreLines, ...input.addonLines].find(
        (line) => line.variantId === rule.rejectedVariantId,
      );
      if (rejectedLine) {
        return { ok: false, code: "variant_rejected", details: { variantId: rejectedLine.variantId } };
      }
      return coreQty === rule.requiredCoreQty
        ? { ok: true }
        : { ok: false, code: "core_qty_mismatch", details: { coreQty, requiredCoreQty: rule.requiredCoreQty } };
    },

    async resizeComposition(input) {
      if (input.lever.kind !== "requiredCoreQty") return null;
      const requiredCoreQty = Number(input.lever.value);
      const perLineQty = Math.floor(requiredCoreQty / Math.max(input.coreLines.length, 1));
      let remainder = Math.max(0, requiredCoreQty - perLineQty * input.coreLines.length);
      return {
        constraint: {
          ...input.constraint,
          data: { ...input.constraint.data, requiredCoreQty },
        },
        coreLines: input.coreLines.map((line) => {
          const extra = remainder > 0 ? 1 : 0;
          remainder -= extra;
          return { ...line, qty: perLineQty + extra };
        }),
      };
    },
  };
}

const nullPrices = new Map<string, ResolvedPrice>([
  [
    "core-alpha:subscription:USD",
    {
      variantId: "core-alpha",
      mode: "subscription",
      matchedMinQty: 1,
      unitPriceMinor: 2100,
      amountKind: "gross",
      priceListId: "price-list-core",
      priceEntryId: "price-entry-core-alpha",
      resolvedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
]);

export function createNullPricingResolverPort(): PricingResolverPort {
  return {
    async resolvePrice(query) {
      return nullPrices.get(`${query.variantId}:${query.mode}:${query.currency}`) ?? null;
    },
  };
}
