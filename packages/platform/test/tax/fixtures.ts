import { taxDigest } from "../../src/tax/digest.js";
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

export const localTime = "2030-01-02T00:00:00.000Z";
export const localCutover = "2030-01-02T00:00:05.000Z";
export const rateRule = {
  kind: "rate", jurisdiction: "district-a", taxClass: "standard", taxKind: "sale",
  ruleRef: "rule-a", legalBasisRef: "rulebook-a", effective: { from: date }, ratePercent: "0",
} as const;
export const localRegistration = { ...active, jurisdiction: "district-a", taxKind: "sale" };
export const exemptRule = {
  kind: "exempt", jurisdiction: "district-a", taxClass: "delivery-a", taxKind: "sale",
  ruleRef: "rule-delivery", legalBasisRef: "rulebook-delivery", effective: { from: date }, reason: "delivery-exemption",
} as const;
export const feeRule = {
  kind: "fee", jurisdiction: "district-a", taxClass: "fee-class", taxKind: "fee-a",
  ruleRef: "rule-fee", legalBasisRef: "rulebook-fee", effective: { from: date },
  amountMinor: 25, refundRule: { ref: "refund-a", revision: "1" },
} as const;

export function localInput(): TaxQuoteInputV1 {
  const exemplar = quote();
  return {
    ...exemplar, taxDate: localTime, lines: exemplar.lines.slice(0, 1), coverage: coverage(registered()),
    delivery: [], required: [cell()],
    money: { ...exemplar.money, sources: exemplar.money.sources.slice(0, 1), delivery: [], adjustments: [] },
  };
}

export function feeInput(): TaxQuoteInputV1 {
  const input = localInput(), exemplar = quote();
  return {
    ...input, delivery: exemplar.delivery, required: [cell(), ...exemplar.required.slice(2)],
    coverage: coverage(registered(), { ...registered(), taxKind: "fee-a" }),
    money: { ...input.money, delivery: exemplar.money.delivery },
  };
}

export function localOptions() {
  return {
    scope, market: "market-a", currency: "XXX", now: () => localTime,
    rounding: "half_up_largest_remainder", calculationLifetimeMs: 10_000, validityWindowMs: 2_000,
    rules: [rateRule], registrations: [localRegistration],
  } as const;
}

// Bind the raw fixture so adapters reach class validation.
export function withoutTaxClass(request: import("../../src/tax/contracts/index.js").TaxQuoteRequestV1) {
  const input = { ...request.input, lines: [{ ...request.input.lines[0], taxClass: "" }, ...request.input.lines.slice(1)] };
  return { ...request, input, inputDigest: taxDigest("input", input) };
}
