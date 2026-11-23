import { isDeepStrictEqual } from "node:util";
import { isCatalogueMoneyV2RateDecimal } from "@openlup/core/pricing";
import { z } from "zod";
import { CATALOG_DRAFT_MAX_BYTES } from "../catalog/contracts/index.js";
import { CATALOG_PRICE_SETUP_MAX_MINOR } from "./catalogPriceSetupSchemas.js";
import { PROMOTION_ENGINE_V1, PROMOTION_ENGINE_V2 } from "./contracts/offerPolicy.js";
import type { CommerceQuoteMoneyV2, CommerceQuoteV2, MoneyLineV2 } from "./contracts/quoteV2.js";

const jsonText = (value: string) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
export const ref = z.string().min(1).max(256).refine(jsonText);
export const moneyRef = ref.refine(value => value.length <= 128);
export const minor = z.number().int().nonnegative().refine(value => !Object.is(value, -0));
export const currency = z.string().length(3).regex(/^[A-Z]{3}$/u);
export const uuid = z.string().length(36).regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
export const digest = z.string().length(64).regex(/^[0-9a-f]+$/u);
export const engine = z.enum([PROMOTION_ENGINE_V1, PROMOTION_ENGINE_V2]);
export const mode = z.enum(["one_time", "subscription"]);
const instant = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const effective = z.strictObject({ from: instant, until: instant.optional() }).refine(
  ({ from, until }) => until === undefined || from < until, { path: ["until"] },
);
const ordinal = minor.refine(value => value > 0);
const assignment = { taxClassKey: ref, assignmentRef: ref };
export const lineSource = z.strictObject({
  ...assignment, lineKey: moneyRef, sourceOrdinal: ordinal, sku: ref, mode,
  quantity: minor.refine(value => value > 0 && value <= 99),
  unitBasisMinor: minor.refine(value => value <= CATALOG_PRICE_SETUP_MAX_MINOR),
});
export const bucketSource = z.strictObject({
  ...assignment, bucketKey: moneyRef, kind: z.enum(["shipping", "handling"]),
  carrierRef: ref, serviceRef: ref, cost: z.strictObject({ ref, currency, amountMinor: minor }), separatelyStated: z.boolean(),
});
const positionIdentity = {
  positionRef: moneyRef, jurisdictionRef: ref, level: ref, taxKind: ref, taxabilityReason: ref, ruleRef: ref,
  resolution: z.strictObject({ assignmentRef: ref, policyRevision: ref, sourceRef: ref, sourceDigest: digest.optional(), effective }),
  resolutionDigest: digest, providerLineRef: ref.optional(),
};
export const positionMetadata = z.strictObject(positionIdentity);
export const positionAmounts = { rateDecimal: z.string().refine(isCatalogueMoneyV2RateDecimal).optional(), taxableMinor: minor, taxMinor: minor };
const position = z.strictObject({ ...positionIdentity, ...positionAmounts });
const taxPositions = z.array(position).max(32);
const state = z.strictObject({ basisMinor: minor, netMinor: minor, taxMinor: minor, taxPositions });
const allocation = z.strictObject({
  allocationId: uuid, adjustmentRef: moneyRef, sequence: ordinal.refine(value => value <= 20), source: z.literal("legacy_promotion"),
  basisReductionMinor: ordinal, netReductionMinor: minor, taxReductionMinor: minor, evidenceRef: ref, before: state, after: state,
});
const component = {
  preDiscountMinor: minor, effectiveMinor: minor, discountAllocations: z.array(allocation).max(20),
  taxPositions, netMinor: minor, taxMinor: minor, lineTotalMinor: minor,
};
const line = lineSource.extend(component);
const part = z.strictObject({ ...component, sourceOrdinal: ordinal.optional() });
const bucket = bucketSource.extend({ parts: z.array(part).min(1).max(50) });
export const feeLine = z.strictObject({
  feeKey: moneyRef, jurisdictionRef: ref, feeKind: ref, amountMinor: minor,
  scope: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("order") }),
    z.strictObject({ kind: z.literal("delivery"), bucketKey: moneyRef })]),
  refundRule: z.strictObject({ ref, revision: ref }), providerPositionRef: ref.optional(),
});
export const price = z.strictObject({ priceListRef: ref, priceContextDigest: digest, priceEvidenceRef: ref, classMapRevision: ref });
export const evidence = { calculationId: uuid, evidenceDigest: digest, taxDate: instant, expiresAt: instant };
export const factsShape = z.strictObject({
  catalogueEvidenceRef: ref, mode,
  cadence: z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("fixed_days"),
    days: minor.refine(value => value > 0 && value <= 3660) }).optional(),
  destination: z.strictObject({ snapshotRef: uuid, schemaVersion: z.literal(2), destinationDigest: digest, policyRevision: ref }),
  coverageDigest: digest,
  paymentLimits: z.strictObject({ profileRef: ref, revision: ref, channelKey: ref, currency, minMinor: minor, maxMinor: minor }),
});
const body = { ...factsShape.shape, currency, price, deliverySelectionRef: ref, lines: z.array(line).min(1).max(50),
  deliveryBuckets: z.array(bucket).max(256), feeLines: z.array(feeLine).max(256), netTotal: minor, taxTotal: minor, feeTotal: minor, payableMinor: minor,
};
const inclusive = {
  amountBasis: z.literal("inclusive"),
  promotion: z.strictObject({ engine, rankingRuleRef: z.literal("lowest_payable_gross") }),
  taxEvidence: z.strictObject({ ...evidence, kind: z.literal("fiscal_profile") }),
};
const exclusive = {
  amountBasis: z.literal("exclusive"),
  promotion: z.strictObject({ engine, rankingRuleRef: z.literal("lowest_pre_tax.v1") }),
  taxEvidence: z.strictObject({ ...evidence, kind: z.literal("tax_calculation") }),
};
const seal = { contractVersion: z.literal("commerce.v1"), schemaVersion: z.literal(2), quoteId: uuid,
  status: z.enum(["estimate", "final"]), moneyDigest: digest, quoteDigest: digest };
export const quoteShape: z.ZodType<CommerceQuoteV2> = z.discriminatedUnion("amountBasis", [
  z.strictObject({ ...body, ...inclusive, ...seal }), z.strictObject({ ...body, ...exclusive, ...seal }),
]);

export const sumMinor = <T>(items: readonly T[], amount: (item: T) => number) =>
  items.reduce((sum, item) => sum + BigInt(amount(item)), 0n);

type Component = CommerceQuoteMoneyV2["deliveryBuckets"][number]["parts"][number] | MoneyLineV2;
type State = MoneyLineV2["discountAllocations"][number]["before"];
export type Path = (string | number)[];
export const remedies = {
  money_input_invalid: "Supply the documented value at this field.",
  money_amount_basis_mixed: "Select a published list with the required basis and obtain a fresh quote.",
  shipping_tax_basis_empty: "Select a supported delivery pricing policy.",
  promotion_allocation_unsubstantiated: "Obtain a quote using a supported promotion combination.",
  money_tax_evidence_mismatch: "Replay the original money and its matching tax evidence.",
  money_amount_out_of_range: "Choose a supported amount and obtain a fresh quote.",
};
export type Code = keyof typeof remedies;
export class MoneyIssue extends Error {
  constructor(readonly code: Code, readonly path: Path, readonly remedy = remedies[code]) { super(remedy); }
}
const invalid = (path: Path) => new MoneyIssue("money_input_invalid", path);
const taxMismatch = (path: Path) => new MoneyIssue("money_tax_evidence_mismatch", path);
const allocationMismatch = (path: Path) => new MoneyIssue("promotion_allocation_unsubstantiated", path);

export function shapePath(issue: z.ZodIssue): Path {
  return (issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path)
    .map(key => typeof key === "symbol" ? String(key) : key);
}
export const pointer = (path: Path): string =>
  path.map(key => "/" + String(key).replaceAll("~", "~0").replaceAll("/", "~1")).join("");

export function admit<T>(input: T): T {
  const ancestors = new Set<object>(), copies = new Map<object, Record<string, unknown> | unknown[]>();
  let remaining = CATALOG_DRAFT_MAX_BYTES;
  let path: Path = [];
  const refusal = () => new MoneyIssue("money_input_invalid", path, "Supply plain JSON data at this field.");
  function charge(value: string) {
    remaining -= Buffer.byteLength(value);
    if (remaining < 0) throw refusal();
  }
  function visit(value: unknown, at: Path): unknown {
    path = at;
    if (at.length > 47) throw refusal();
    if (at.length && (value === null || typeof value === "boolean" || (typeof value === "string" && jsonText(value))
      || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)))) {
      charge(JSON.stringify(value));
      return value;
    }
    if (value === null || typeof value !== "object" || ancestors.has(value)) throw refusal();
    const captured = copies.get(value) ?? value;
    const array = Array.isArray(captured), prototype = Object.getPrototypeOf(captured);
    if (array ? !at.length || at.length === 47 || prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw refusal();
    const keys = Reflect.ownKeys(captured);
    const length: unknown = array ? Object.getOwnPropertyDescriptor(captured, "length")?.value : undefined;
    const snapshot: Record<string, unknown> | unknown[] = array ? [] : {};
    ancestors.add(value);
    charge("[]");
    let separator = "";
    for (const key of keys) {
      path = at; // A symbol can only be identified by its containing object in a JSON pointer.
      if (typeof key !== "string") throw refusal();
      if (array && key === "length") continue;
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || typeof length !== "number" || Number(key) >= length)) throw refusal();
      path = [...at, key];
      const descriptor = Object.getOwnPropertyDescriptor(captured, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || !jsonText(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw refusal();
      charge(separator + (array ? "" : JSON.stringify(key) + ":"));
      (snapshot as Record<string, unknown>)[key] = visit(descriptor.value, path);
      separator = ",";
    }
    if (array && length !== keys.length - 1) { path = at; throw refusal(); }
    ancestors.delete(value);
    copies.set(value, snapshot);
    return snapshot;
  }
  try { return visit(input, []) as T; }
  catch { throw refusal(); }
}

export const absentFeeBucket = (fees: CommerceQuoteMoneyV2["feeLines"], buckets: ReadonlySet<string>): number =>
  fees.findIndex(({ scope }) => scope.kind === "delivery" && !buckets.has(scope.bucketKey));

export function checkMoney(money: CommerceQuoteMoneyV2): MoneyIssue | undefined {
  const ordinals = new Set<number>(), lineKeys = new Set<string>(), bucketKeys = new Set<string>();
  const ids = new Set<string>(), adjustments = new Map<number, string>(), sequences = new Map<string, number>();
  const positionOwners = new Map<string, Component>();
  const isInclusive = money.amountBasis === "inclusive";
  let net = 0n, tax = 0n;
  function checkState(owner: Component, value: State, path: Path, shipping: boolean): MoneyIssue | undefined {
    const assessed = sumMinor(value.taxPositions, position => position.taxMinor);
    const basis = BigInt(value.netMinor) + (isInclusive ? assessed : 0n);
    if (basis !== BigInt(value.basisMinor) || assessed !== BigInt(value.taxMinor)) return taxMismatch(path);
    if ((shipping && value.basisMinor === 0 && value.taxPositions.length)
      || (isInclusive && (value.taxPositions.length !== Number(value.basisMinor > 0)
        || value.taxPositions.some(position => position.taxableMinor !== value.netMinor)))) return taxMismatch([...path, "taxPositions"]);
    const seen = new Set<string>();
    for (const [index, { positionRef }] of value.taxPositions.entries()) {
      const prior = positionOwners.get(positionRef);
      if (seen.has(positionRef) || (prior && prior !== owner)) return taxMismatch([...path, "taxPositions", index, "positionRef"]);
      seen.add(positionRef);
      positionOwners.set(positionRef, owner);
    }
  }
  function checkComponent(item: Component, path: Path, shipping = false): MoneyIssue | undefined {
    let previous: State | undefined;
    let sequence = 0;
    for (const [index, share] of item.discountAllocations.entries()) {
      const at = [...path, "discountAllocations", index];
      const { before, after, adjustmentRef, evidenceRef } = share;
      const identity = JSON.stringify([adjustmentRef, evidenceRef]);
      if (share.sequence <= sequence || ids.has(share.allocationId)
        || (adjustments.has(share.sequence) && adjustments.get(share.sequence) !== identity)
        || (sequences.has(adjustmentRef) && sequences.get(adjustmentRef) !== share.sequence)
        || before.basisMinor !== (previous?.basisMinor ?? item.preDiscountMinor)
        || (previous && (previous.netMinor !== before.netMinor || previous.taxMinor !== before.taxMinor
          || !isDeepStrictEqual(previous.taxPositions, before.taxPositions)))
        || before.basisMinor - after.basisMinor !== share.basisReductionMinor
        || before.netMinor - after.netMinor !== share.netReductionMinor
        || before.taxMinor - after.taxMinor !== share.taxReductionMinor) return allocationMismatch(at);
      const issue = checkState(item, before, [...at, "before"], shipping) ?? checkState(item, after, [...at, "after"], shipping);
      if (issue) return issue;
      ids.add(share.allocationId);
      adjustments.set(share.sequence, identity);
      sequences.set(adjustmentRef, share.sequence);
      previous = after;
      sequence = share.sequence;
    }
    if (item.effectiveMinor !== (previous?.basisMinor ?? item.preDiscountMinor)
      || (previous && (previous.netMinor !== item.netMinor || previous.taxMinor !== item.taxMinor
        || !isDeepStrictEqual(previous.taxPositions, item.taxPositions)))) return allocationMismatch([...path, "effectiveMinor"]);
    if (BigInt(item.lineTotalMinor) !== BigInt(item.netMinor) + BigInt(item.taxMinor)) return invalid([...path, "lineTotalMinor"]);
    net += BigInt(item.netMinor);
    tax += BigInt(item.taxMinor);
    return checkState(item, { ...item, basisMinor: item.effectiveMinor }, path, shipping);
  }
  for (const [index, item] of money.lines.entries()) {
    const path = ["lines", index];
    if (lineKeys.has(item.lineKey) || ordinals.has(item.sourceOrdinal)) return invalid(path);
    lineKeys.add(item.lineKey);
    ordinals.add(item.sourceOrdinal);
    if (BigInt(item.unitBasisMinor) * BigInt(item.quantity) !== BigInt(item.preDiscountMinor)) return invalid([...path, "preDiscountMinor"]);
    const issue = checkComponent(item, path);
    if (issue) return issue;
  }
  let inclusiveShipping = false;
  for (const [index, delivery] of money.deliveryBuckets.entries()) {
    const path = ["deliveryBuckets", index];
    if (bucketKeys.has(delivery.bucketKey)) return invalid([...path, "bucketKey"]);
    if (delivery.cost.currency !== money.currency) return invalid([...path, "cost", "currency"]);
    bucketKeys.add(delivery.bucketKey);
    const shares = isInclusive && delivery.kind === "shipping";
    if (shares && inclusiveShipping) return invalid([...path, "kind"]);
    inclusiveShipping ||= shares;
    const apportioned = shares && delivery.parts.some(item => item.preDiscountMinor > 0);
    if (!apportioned && delivery.parts.length !== 1) return invalid([...path, "parts"]);
    const partOrdinals = new Set<number>();
    for (const [partIndex, item] of delivery.parts.entries()) {
      const at = [...path, "parts", partIndex];
      if (apportioned ? item.sourceOrdinal === undefined || !ordinals.has(item.sourceOrdinal) || partOrdinals.has(item.sourceOrdinal)
        : item.sourceOrdinal !== undefined) return invalid([...at, "sourceOrdinal"]);
      if (item.sourceOrdinal !== undefined) partOrdinals.add(item.sourceOrdinal);
      const issue = checkComponent(item, at, delivery.kind === "shipping");
      if (issue) return issue;
    }
  }
  const orphan = absentFeeBucket(money.feeLines, bucketKeys);
  if (orphan !== -1) return invalid(["feeLines", orphan, "scope", "bucketKey"]);
  const duplicateFee = money.feeLines.findIndex(({ feeKey }, index) => money.feeLines.findIndex(fee => fee.feeKey === feeKey) !== index);
  if (duplicateFee !== -1) return invalid(["feeLines", duplicateFee, "feeKey"]);
  const fees = sumMinor(money.feeLines, fee => fee.amountMinor);
  if (net !== BigInt(money.netTotal)) return invalid(["netTotal"]);
  if (tax !== BigInt(money.taxTotal)) return invalid(["taxTotal"]);
  if (fees !== BigInt(money.feeTotal)) return invalid(["feeTotal"]);
  if (net + tax + fees !== BigInt(money.payableMinor)) return invalid(["payableMinor"]);
  if ((money.mode === "subscription") !== (money.cadence !== undefined)) return invalid(["cadence"]);
  if (money.taxEvidence.expiresAt <= money.taxEvidence.taxDate) return taxMismatch(["taxEvidence", "expiresAt"]);
  const limits = money.paymentLimits;
  if (limits.currency !== money.currency) return invalid(["paymentLimits", "currency"]);
  if (limits.minMinor > limits.maxMinor) return invalid(["paymentLimits", "maxMinor"]);
  if (money.payableMinor <= 0 || money.payableMinor < limits.minMinor || money.payableMinor > limits.maxMinor) return new MoneyIssue("money_amount_out_of_range", ["payableMinor"]);
}
