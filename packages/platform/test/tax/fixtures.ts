import type { TaxCoverageInputV1, TaxCoverageV1, TaxQuoteInputV1 } from "../../src/tax/contracts/index.js";

export const date = "2030-01-01T00:00:00.000Z";
export const later = "2030-02-01T00:00:00.000Z";
export const digest = "a".repeat(64);
export const scope = { adapter: "adapter-a", adapterVersion: "1", accountRef: "account-a", mode: "test" } as const;

type Cell = TaxCoverageInputV1["required"][number];
export const cell = (key = "item-z", jurisdiction = "district-a"): Cell =>
  ({ target: { kind: "line", key }, jurisdiction, level: "district", taxKind: "sale", sourcing: "destination" });
export const registered = (jurisdiction = "district-a"): TaxCoverageV1["declarations"][number] =>
  ({ jurisdiction, taxKind: "sale", effective: { from: date }, actorRef: "actor-a", recordedAt: date, status: "registered" });
export const coverage = (...declarations: TaxCoverageV1["declarations"]): TaxCoverageV1 =>
  ({ schemaVersion: 1, accountRef: scope.accountRef, revision: "coverage-a", declarations });

export const active = { state: "active", effective: { from: date }, evidenceRef: "registration-a" } as const;
export const taxable = { kind: "taxable", reason: "rate-applies", ruleRef: "rule-a" } as const;

export function coverageInput(): TaxCoverageInputV1 {
  return {
    scope, taxDate: date, coverage: coverage(registered()), required: [cell()],
    observations: [{ cell: cell(), registration: active, treatment: taxable, assessedMinor: 0 }],
  };
}

export function quote(): TaxQuoteInputV1 {
  const sources = ["item-z", "item-a"].map((lineKey, index) =>
    ({ lineKey, sourceOrdinal: index + 1, quantity: 1, unitBasisMinor: 100 }));
  return {
    scope, market: "market-a", currency: "XXX", purpose: "final", taxDate: date,
    destination: {
      snapshotRef: "destination-a", digest, policyRevision: "address-a",
      address: { line1: "1 Example Lane", city: "Example", postalCode: "0000", countryCode: "XX" },
    },
    shipFromRef: "origin-a", policyRevision: "policy-a", classMapRevision: "classes-a",
    money: {
      amountBasis: "exclusive", sources, delivery: [{ bucketKey: "shipping-a", deliveryKind: "shipping", amountMinor: 0 }],
      adjustments: [
        { adjustmentRef: "promo-a", sequence: 1, amountMinor: 3, target: { lineKeys: ["item-z", "item-a"] } },
        { adjustmentRef: "promo-b", sequence: 3, amountMinor: 1, target: { lineKeys: ["item-a"] } },
      ],
      fees: [],
    },
    lines: sources.map(({ lineKey }) => ({ lineKey, sku: lineKey, mode: "one_time", taxClass: "standard", assignmentRef: "assignment-a" })),
    delivery: [{
      bucketKey: "shipping-a", carrierRef: "carrier-a", serviceRef: "service-a", cost: { ref: "cost-a", currency: "XXX", amountMinor: 0 },
      separatelyStated: true, taxClass: "delivery-a", assignmentRef: "assignment-delivery",
    }],
    required: [
      cell(), cell("item-a", "district-b"), { ...cell(), target: { kind: "delivery", key: "shipping-a" } },
      { ...cell(), taxKind: "fee-a", target: { kind: "fee", key: "fee-a", deliveryKey: "shipping-a", taxClass: "fee-class", assignmentRef: "assignment-fee" } },
    ],
    coverage: coverage(registered(), registered("district-b")),
  };
}
