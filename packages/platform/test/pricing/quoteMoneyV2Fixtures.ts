import { quoteDigest } from "../../src/pricing/index.js";
import type { CommerceQuoteMoneyV2, CommerceQuoteV2, ComposeCommerceQuoteMoneyV2Input,
  DeliveryBucketV2, FeeLineV2, PlanCommerceQuoteMoneyV2Input, TaxPositionV2 } from "../../src/pricing/index.js";

export const taxDate = "2026-06-05T10:00:00.000Z";
export const expiresAt = "2026-06-05T11:00:00.000Z";
export const hex = "a".repeat(64);
export const id = (n: number) => "12345678-1234-4000-8000-" + String(n).padStart(12, "0");
export const price = { priceListRef: "list:α", priceContextDigest: hex, priceEvidenceRef: "price:β", classMapRevision: "assignment:v1" };
export const facts: ComposeCommerceQuoteMoneyV2Input["facts"] = {
  catalogueEvidenceRef: "catalogue:v1", mode: "one_time",
  destination: { snapshotRef: id(1), schemaVersion: 2, destinationDigest: hex, policyRevision: "destination:v1" },
  paymentLimits: { profileRef: "limits", revision: "limits:v1", channelKey: "checkout", currency: "XXX", minMinor: 1, maxMinor: 2_147_483_647 },
  coverageDigest: hex,
};
export const localEvidence = { kind: "fiscal_profile" as const, calculationId: id(2), evidenceDigest: hex, taxDate, expiresAt };
export function metadata(positionRef: string, jurisdictionRef = "district-a"): Omit<TaxPositionV2, "rateDecimal" | "taxableMinor" | "taxMinor"> {
  return {
    positionRef, jurisdictionRef, level: "district", taxKind: "consumption", taxabilityReason: "taxable", ruleRef: "rule",
    resolution: { assignmentRef: "assignment", policyRevision: "policy:v1", sourceRef: "source", effective: { from: taxDate } },
    resolutionDigest: hex,
  };
}
export function source(lineKey: string, sourceOrdinal: number, unitBasisMinor: number,
  quantity = 1, amountKind: "gross" | "net" = "gross"): PlanCommerceQuoteMoneyV2Input["lines"][number] {
  return { lineKey, sourceOrdinal, sku: "article:ż", mode: "one_time", unitBasisMinor, quantity,
    taxClassKey: "standard", assignmentRef: "assignment", amountKind };
}
export function bucket(kind: DeliveryBucketV2["kind"], amountMinor: number) {
  return { bucketKey: kind, kind, amountMinor, taxClassKey: "standard", assignmentRef: "assignment",
    carrierRef: "carrier", serviceRef: "service", cost: { ref: "cost", currency: "XXX", amountMinor }, separatelyStated: true };
}
export function fee(feeKey: string, amountMinor: number): FeeLineV2 {
  return { feeKey, amountMinor, jurisdictionRef: "district-a", feeKind: "service",
    scope: { kind: "delivery", bucketKey: "shipping" }, refundRule: { ref: "policy", revision: "one" } };
}
export function moneyGolden(): CommerceQuoteMoneyV2 {
  const { amountKind: _kindZ, ...z } = source("z", 1, 3);
  const { amountKind: _kindA, ...a } = source("a", 2, 3);
  const after = { ...metadata("position-z"), taxableMinor: 2, taxMinor: 0, rateDecimal: "23" };
  return {
    ...facts, currency: "XXX", price, amountBasis: "inclusive", deliverySelectionRef: "delivery:one",
    lines: [{
      ...z, preDiscountMinor: 3, effectiveMinor: 2, netMinor: 2, taxMinor: 0, lineTotalMinor: 2, taxPositions: [after],
      discountAllocations: [{
        allocationId: id(3), adjustmentRef: "product", evidenceRef: "promotion:α", source: "legacy_promotion", sequence: 1,
        basisReductionMinor: 1, netReductionMinor: 0, taxReductionMinor: 1,
        before: { basisMinor: 3, netMinor: 2, taxMinor: 1, taxPositions: [{ ...after, taxMinor: 1 }] },
        after: { basisMinor: 2, netMinor: 2, taxMinor: 0, taxPositions: [after] },
      }],
    }, {
      ...a, preDiscountMinor: 3, effectiveMinor: 3, netMinor: 3, taxMinor: 0, lineTotalMinor: 3, discountAllocations: [],
      taxPositions: [{ ...metadata("position-a"), taxableMinor: 3, taxMinor: 0, rateDecimal: "8" }],
    }],
    deliveryBuckets: [], feeLines: [], netTotal: 5, taxTotal: 0, feeTotal: 0, payableMinor: 5,
    promotion: { engine: "promotion-engine.v1", rankingRuleRef: "lowest_payable_gross" }, taxEvidence: localEvidence,
  };
}
export function sealQuote(money: CommerceQuoteMoneyV2 = moneyGolden(), status: CommerceQuoteV2["status"] = "final"): CommerceQuoteV2 {
  const quote = { ...money, contractVersion: "commerce.v1", schemaVersion: 2, quoteId: id(4), status,
    moneyDigest: quoteDigest("commerce.quote-money.v2", money) } as const;
  return { ...quote, quoteDigest: quoteDigest("commerce.quote.v2", quote) };
}
