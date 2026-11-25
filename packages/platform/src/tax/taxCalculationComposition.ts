import { z } from "zod";

export const uuid = z.string().length(36).regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
export const digest = z.string().length(64).regex(/^[0-9a-f]+$/u);
export const currency = z.string().length(3).regex(/^[A-Z]{3}$/u);
export const instant = z.string().length(24).refine(value => value >= "0001" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);

type Basis = "inclusive" | "exclusive";
type Assignment = { taxClassKey: string; assignmentRef: string };
type Line = Assignment & { lineKey: string; sourceOrdinal: number; sku: string; mode: "one_time" | "subscription";
  quantity: number; unitBasisMinor: number; amountKind: "gross" | "net" };
type Delivery = Assignment & { bucketKey: string; kind: "shipping" | "handling"; carrierRef: string; serviceRef: string;
  cost: { ref: string; currency: string; amountMinor: number }; separatelyStated: boolean; amountMinor: number;
  threshold?: { flatMinor: number; freeThresholdMinor: number } };
type Fee = { feeKey: string; jurisdictionRef: string; feeKind: string; amountMinor: number;
  scope: { kind: "order" } | { kind: "delivery"; bucketKey: string };
  refundRule: { ref: string; revision: string }; providerPositionRef?: string };
type Adjustment = { amountOffMinor: number; adjustmentRef: string; evidenceRef: string } & (
  | { appliesTo: "line" | "order_total"; target: { lineKeys: readonly string[] } }
  | { appliesTo: "shipping"; target: { bucketKey: string } }
);
type Candidate = { amountBasis: Basis; deliverySelectionRef: string; delivery: readonly Delivery[]; feeLines: readonly Fee[] };

type FiscalDetails = {
  facts: { country: string; category: string; vatRateBps: number; legalBasis: string };
  coordinates: { installationRef: string; marketRef: string; packId: string; packVersion: string };
};
export type FiscalSuccessEvidence = FiscalDetails & { policyRevision: string; calculationId: string;
  coverage: { kind: "not_applicable" }; posting: "no_provider_posting" };
export type CheckoutComposition = {
  planInput: { currency: string; listBasis: Basis | null; engine: "promotion-engine.v1" | "promotion-engine.v2";
    price: { priceListRef: string; priceContextDigest: string; priceEvidenceRef: string; classMapRevision: string };
    lines: readonly Line[]; baseline: Candidate; selected?: Candidate & { adjustments: readonly Adjustment[] } };
  catalogueEvidenceRef: string;
  evidenceExpiresAt: string;
  selection: { kind: "checkout"; scopeRef: string; selectionRevision: string };
  service: { deliverySelectionRef: string; providerRef: string; carrierRef: string; serviceRef: string;
    servicePolicyRevision: string; adapterRevision: string };
  limits: { installationRef: string; channelKey: string; methodKey: string; providerKey: string; accountRef: string;
    mode: "test" | "live"; currency: string; profileRef: string; revision: number; minMinor: number; maxMinor: number;
    effective: { minMinor: number; maxMinor: number } };
};
export type FiscalCheckoutComposition = CheckoutComposition & { fiscal: FiscalDetails };

// This projection mirrors the pricing owner's planning schema across the tax module boundary.
// The input snapshot has already rejected malformed Unicode and embedded NULs.
const ref = z.string().min(1).max(256);
const moneyRef = ref.refine(value => value.length <= 128);
const limitsRef = z.string().refine(value => value.length > 0 && Buffer.byteLength(value) <= 200);
const minor = z.number().int().nonnegative();
const positive = minor.min(1);
const int32 = 2_147_483_647;
const basis = z.enum(["inclusive", "exclusive"]);
const assignment = { taxClassKey: ref, assignmentRef: ref };

function unique<T>(rows: z.ZodType<T[]>, key: (row: T) => string | number, field: string) {
  return rows.superRefine((items, ctx) => {
    const seen = new Set<string | number>();
    items.forEach((item, index) => {
      const id = key(item);
      if (seen.has(id)) ctx.addIssue({ code: "custom", path: [index, field], message: "Supply distinct values." });
      seen.add(id);
    });
  });
}

const line = z.strictObject({ ...assignment, lineKey: moneyRef, sourceOrdinal: positive, sku: ref,
  mode: z.enum(["one_time", "subscription"]), quantity: positive.max(99), unitBasisMinor: minor.max(int32),
  amountKind: z.enum(["gross", "net"]) });
const delivery = z.strictObject({ ...assignment, bucketKey: moneyRef, kind: z.enum(["shipping", "handling"]),
  carrierRef: ref, serviceRef: ref, cost: z.strictObject({ ref, currency, amountMinor: minor }),
  separatelyStated: z.boolean(), amountMinor: minor,
  threshold: z.strictObject({ flatMinor: minor, freeThresholdMinor: minor }).optional() });
const fee = z.strictObject({ feeKey: moneyRef, jurisdictionRef: ref, feeKind: ref, amountMinor: minor,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("order") }), z.strictObject({ kind: z.literal("delivery"), bucketKey: moneyRef }),
  ]),
  refundRule: z.strictObject({ ref, revision: ref }), providerPositionRef: ref.optional() });
const candidate = z.strictObject({ amountBasis: basis, deliverySelectionRef: ref,
  delivery: unique(z.array(delivery).max(256), item => item.bucketKey, "bucketKey"),
  feeLines: unique(z.array(fee).max(256), item => item.feeKey, "feeKey") });
const adjustmentFields = { amountOffMinor: positive, adjustmentRef: moneyRef, evidenceRef: ref };
const adjustment = z.discriminatedUnion("appliesTo", [
  z.strictObject({ ...adjustmentFields, appliesTo: z.enum(["line", "order_total"]),
    target: z.strictObject({ lineKeys: z.array(moneyRef).min(1).max(50) }) }),
  z.strictObject({ ...adjustmentFields, appliesTo: z.literal("shipping"), target: z.strictObject({ bucketKey: moneyRef }) }),
]);
const planInput = z.strictObject({
  currency, listBasis: basis.nullable(), engine: z.enum(["promotion-engine.v1", "promotion-engine.v2"]),
  price: z.strictObject({ priceListRef: ref, priceContextDigest: digest, priceEvidenceRef: ref, classMapRevision: ref }),
  lines: unique(unique(z.array(line).min(1).max(50), item => item.lineKey, "lineKey"), item => item.sourceOrdinal, "sourceOrdinal"),
  baseline: candidate,
  selected: candidate.extend({ adjustments: unique(z.array(adjustment).min(1).max(20), item => item.adjustmentRef, "adjustmentRef") }).optional(),
});
const limits = z.strictObject({ installationRef: limitsRef, channelKey: limitsRef, methodKey: limitsRef, providerKey: limitsRef,
  accountRef: limitsRef, mode: z.enum(["test", "live"]), currency, profileRef: limitsRef,
  revision: positive.max(int32), minMinor: minor, maxMinor: minor,
  effective: z.strictObject({ minMinor: minor, maxMinor: minor }) });
const fiscalDetails = {
  facts: z.strictObject({ country: z.string().length(2).regex(/^[A-Z]{2}$/u), category: ref, vatRateBps: minor.max(10_000), legalBasis: ref }),
  coordinates: z.strictObject({ installationRef: ref, marketRef: ref, packId: ref, packVersion: ref }),
};
const composition = z.strictObject({ planInput, catalogueEvidenceRef: ref, evidenceExpiresAt: instant,
  selection: z.strictObject({ kind: z.literal("checkout"), scopeRef: uuid, selectionRevision: uuid }),
  service: z.strictObject({ deliverySelectionRef: ref, providerRef: ref, carrierRef: ref, serviceRef: ref, servicePolicyRevision: ref, adapterRevision: ref }),
  limits });
export const exclusiveComposition: z.ZodType<CheckoutComposition> = composition;
export const fiscalComposition: z.ZodType<FiscalCheckoutComposition> = composition.extend({ fiscal: z.strictObject(fiscalDetails) });
export const fiscalSuccessEvidence: z.ZodType<FiscalSuccessEvidence> = z.strictObject({ ...fiscalDetails,
  policyRevision: digest, calculationId: uuid, coverage: z.strictObject({ kind: z.literal("not_applicable") }),
  posting: z.literal("no_provider_posting") });
