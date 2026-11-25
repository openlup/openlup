import { expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/index.js";
import { planningShape } from "../../src/pricing/commerceQuoteMoneyV2.js";
import { exclusiveComposition, fiscalComposition } from "../../src/tax/taxCalculationComposition.js";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const instant = "2026-01-01T00:00:00.000Z";
const delivery = { kind: "shipping", bucketKey: "ship", carrierRef: "carrier", serviceRef: "service",
  cost: { ref: "cost", currency: "XXX", amountMinor: 10 }, separatelyStated: true, amountMinor: 10,
  taxClassKey: "class", assignmentRef: "assignment" };
const fee = { feeKey: "fee", jurisdictionRef: "region", feeKind: "levy", amountMinor: 1, scope: { kind: "order" },
  refundRule: { ref: "rule", revision: "revision" } };
const line = { lineKey: "line", sourceOrdinal: 1, sku: "item", mode: "one_time", quantity: 1, unitBasisMinor: 100,
  amountKind: "gross", taxClassKey: "class", assignmentRef: "assignment" };
const standard = { currency: "XXX", listBasis: "inclusive", engine: "promotion-engine.v1", lines: [line],
  price: { priceListRef: "list", priceContextDigest: "a".repeat(64), priceEvidenceRef: "price", classMapRevision: "classes" },
  baseline: { amountBasis: "inclusive", deliverySelectionRef: "service", delivery: [delivery], feeLines: [fee] } };
const limits = { installationRef: "store", channelKey: "web", methodKey: "card", providerKey: "provider", accountRef: "account",
  mode: "test", currency: "XXX", profileRef: "standard", revision: 1, minMinor: 1, maxMinor: 500, effective: { minMinor: 1, maxMinor: 500 } };
const base = { catalogueEvidenceRef: "catalogue", evidenceExpiresAt: instant, limits,
  selection: { kind: "checkout", scopeRef: id, selectionRevision: id },
  service: { providerRef: "provider", deliverySelectionRef: "service", carrierRef: "carrier", serviceRef: "service",
    servicePolicyRevision: "rules", adapterRevision: "revision" } };
const fiscal = { facts: { country: "XA", category: "standard", vatRateBps: 2300, legalBasis: "rules" },
  coordinates: { installationRef: "store", marketRef: "market", packId: "pack", packVersion: "1" } };
const admitted = (value: unknown) => JSON.parse(canonicalCatalogDraftJson(value)) as unknown;
const rows = <T>(count: number, build: (index: number) => T) => Array.from({ length: count }, (_, index) => build(index));
const withLine = (changes: object) => ({ ...standard, lines: [{ ...line, ...changes }] });
const withDelivery = (changes: object) => ({ ...standard, baseline: { ...standard.baseline, delivery: [{ ...delivery, ...changes }] } });
const withFee = (changes: object) => ({ ...standard, baseline: { ...standard.baseline, feeLines: [{ ...fee, ...changes }] } });
const adjustment = (i: number) => ({ amountOffMinor: 1, adjustmentRef: "discount-" + i, evidenceRef: "promo",
  appliesTo: "line", target: { lineKeys: [line.lineKey] } });
const withAdjustments = (adjustments: unknown[]) => ({ ...standard, selected: { ...standard.baseline, adjustments } });

const cases: [string, unknown, boolean][] = [
  ["plain", standard, true],
  ["nullable list basis", { ...standard, listBasis: null }, true],
  ["currency grammar", { ...standard, currency: "XX\n" }, false],
  ["engine enum", { ...standard, engine: "unknown" }, false],
  ["mode enum", withLine({ mode: "unknown" }), false],
  ["amount kind enum", withLine({ amountKind: "unknown" }), false],
  ["delivery enum", withDelivery({ kind: "unknown" }), false],
  ["general Unicode ref bound", withLine({ sku: "😀".repeat(256) }), true],
  ["general Unicode ref overflow", withLine({ sku: "😀".repeat(257) }), false],
  ["UTF-16 money ref bound", withLine({ lineKey: "😀".repeat(64) }), true],
  ["UTF-16 money ref overflow", withLine({ lineKey: "😀".repeat(64) + "a" }), false],
  ["empty ref", withLine({ lineKey: "" }), false],
  ["quantity lower edge", withLine({ quantity: 0 }), false],
  ["quantity upper edge", withLine({ quantity: 99 }), true],
  ["quantity overflow", withLine({ quantity: 100 }), false],
  ["unit int32 bound", withLine({ unitBasisMinor: 2_147_483_647 }), true],
  ["unit int32 overflow", withLine({ unitBasisMinor: 2_147_483_648 }), false],
  ["safe minor bound", withDelivery({ amountMinor: Number.MAX_SAFE_INTEGER }), true],
  ["unsafe minor", withDelivery({ amountMinor: Number.MAX_SAFE_INTEGER + 1 }), false],
  ["threshold", withDelivery({ threshold: { flatMinor: 1, freeThresholdMinor: 2 } }), true],
  ["unexpected threshold key", withDelivery({ threshold: { flatMinor: 1, freeThresholdMinor: 2, other: false } }), false],
  ["optional fee sources", withFee({ providerPositionRef: "position" }), true],
  ["mixed fee scope", withFee({ scope: { kind: "order", bucketKey: "ship" } }), false],
  ["delivery fee scope", withFee({ scope: { kind: "delivery", bucketKey: "ship" } }), true],
  ["line count", { ...standard, lines: rows(50, i => ({ ...line, sourceOrdinal: i + 1, lineKey: String(i) })) }, true],
  ["line count overflow", { ...standard, lines: rows(51, i => ({ ...line, sourceOrdinal: i + 1, lineKey: String(i) })) }, false],
  ["duplicate line key", { ...standard, lines: [line, { ...line, sourceOrdinal: 2 }] }, false],
  ["duplicate ordinal", { ...standard, lines: [line, { ...line, lineKey: "other" }] }, false],
  ...(["delivery", "feeLines"] as const).flatMap(field => [256, 257].map((size): [string, unknown, boolean] => [
    field + " count " + size, { ...standard, baseline: { ...standard.baseline,
      [field]: rows(size, i => field === "delivery" ? { ...delivery, bucketKey: String(i) } : { ...fee, feeKey: String(i) }) } }, size === 256,
  ])),
  ["duplicate delivery", { ...standard, baseline: { ...standard.baseline, delivery: [delivery, delivery] } }, false],
  ["duplicate fee", { ...standard, baseline: { ...standard.baseline, feeLines: [fee, fee] } }, false],
  ["adjustment count", withAdjustments(rows(20, adjustment)), true],
  ["adjustment count overflow", withAdjustments(rows(21, adjustment)), false],
  ["empty selection adjustments", withAdjustments([]), false],
  ["duplicate adjustment", withAdjustments([adjustment(1), adjustment(1)]), false],
  ["target count", withAdjustments([{ ...adjustment(1), target: { lineKeys: rows(50, String) } }]), true],
  ["target count overflow", withAdjustments([{ ...adjustment(1), target: { lineKeys: rows(51, String) } }]), false],
  ["shipping adjustment", withAdjustments([{ ...adjustment(1), appliesTo: "shipping", target: { bucketKey: "ship" } }]), true],
  ["mixed adjustment target", withAdjustments([{ ...adjustment(1), target: { lineKeys: ["line"], bucketKey: "ship" } }]), false],
];

it.each(cases)("%s has the same acceptance in pricing and both retained pins", (_label, value, accepted) => {
  const planInput = admitted(value);
  expect(planningShape.safeParse(planInput).success).toBe(accepted);
  expect(exclusiveComposition.safeParse({ ...base, planInput }).success).toBe(accepted);
  expect(fiscalComposition.safeParse({ ...base, planInput, fiscal }).success).toBe(accepted);
});

it("admits diagnostics in pricing and only the projected input in either retained arm", () => {
  const planInput = { ...standard, codeDiagnostics: { appliedCodes: [], codeRejections: [], codeRejectionDetails: [] } };
  expect(planningShape.safeParse(admitted(planInput)).success).toBe(true);
  expect(exclusiveComposition.safeParse({ ...base, planInput }).success).toBe(false);
  expect(fiscalComposition.safeParse({ ...base, planInput, fiscal }).success).toBe(false);
  const { codeDiagnostics: _diagnostics, ...projected } = planInput;
  expect(exclusiveComposition.safeParse({ ...base, planInput: admitted(projected) }).success).toBe(true);
  expect(fiscalComposition.safeParse({ ...base, planInput: admitted(projected), fiscal }).success).toBe(true);
});

it.each(["\u0000", "\ud800", -0])("refuses noncanonical values at the shared admission step", value => {
  expect(() => admitted({ ...standard, marker: value })).toThrow();
});
