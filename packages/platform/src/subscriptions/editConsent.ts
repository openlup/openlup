import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  SubscriptionEditAmount, SubscriptionEditDisclosure, SubscriptionEditDisclosureLine, SubscriptionEditRecurringTerms,
} from "./contracts/editConsent.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const text = z.string().refine(value => value.trim().length > 0);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const positive = z.number().int().positive();
const lane = z.enum(["classic", "exact", "sized"]);
const evidence = z.strictObject({ owner: text, version: text, digest });
const editAmountBasis = z.enum(["tax_inclusive", "tax_exclusive"]);
const agreedBasis = z.strictObject({ basis: editAmountBasis, evidence });
const signedAmount = z.strictObject({ currency, basis: editAmountBasis, amountMinor: z.number().int() });
const amount = signedAmount.extend({ amountMinor: z.number().int().nonnegative() });
const ownerTerms = z.strictObject({
  payment: z.strictObject({ kind: z.enum(["payable", "estimate"]), label: text, amount, evidence }),
  cadence: z.strictObject({ days: positive, evidence }),
});
const isoInstant = z.iso.datetime({ offset: true });
const cycle = z.strictObject({ number: positive, scheduledAt: isoInstant, editCutoffAt: isoInstant, evidence });
const lineSide = z.strictObject({ quantity: positive, label: text, unitAmount: amount });
const lineIdentity = { variantId: z.uuid(), sku: text, isAddon: z.boolean() };
const line = z.discriminatedUnion("kind", [
  z.strictObject({ ...lineIdentity, kind: z.literal("added"), agreed: z.null(), proposed: lineSide, unitDelta: z.null() }),
  z.strictObject({ ...lineIdentity, kind: z.literal("removed"), agreed: lineSide, proposed: z.null(), unitDelta: z.null() }),
  z.strictObject({ ...lineIdentity, kind: z.literal("retained"), agreed: lineSide, proposed: lineSide, unitDelta: signedAmount.nullable() }),
]);
const disclosureSchema = z.strictObject({
  version: z.literal(1),
  currency,
  disposition: z.enum(["changes_agreement", "keeps_agreement"]),
  agreed: ownerTerms,
  proposed: ownerTerms,
  effectiveCycle: cycle,
  presentation: z.strictObject({ version: text, locale: text, labels: z.strictObject({
    title: text, agreed: text, proposed: text, effectiveCycle: text, cadence: text, confirmation: text,
  }) }),
  lines: z.array(line).min(1),
});
const scope = z.strictObject({ actorId: z.uuid(), clientId: z.uuid(), subscriptionId: z.uuid(), lane, action: text });
const bindingSchema = scope.extend({
  templateVersion: positive, baselineFingerprint: digest, innerQuoteHash: digest, proposalFingerprint: digest,
  normalizedRequest: z.record(z.string(), z.unknown()),
});
const receiptSchema = scope.extend({ idempotencyKey: text, commandFingerprint: digest, acceptedHash: digest });

type EditDisclosureBinding = z.infer<typeof bindingSchema>;
type EditReceiptIdentity = z.infer<typeof receiptSchema>;
const pricedLine = lineSide.extend(lineIdentity);
type PricedLine = z.infer<typeof pricedLine>;

const invalidFrame = "subscription_edit_disclosure_invalid";
const invalidJsonText = (value: string) => value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value);
function canonical(value: unknown): string {
  // Keep this codec local to v1, including its ordering and admissible JSON values.
  function normalize(input: unknown, depth: number): unknown {
    if (depth > 48) throw new Error(invalidFrame);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string" && !invalidJsonText(input)) return input;
    if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) return input;
    if (typeof input !== "object" || input === null) throw new Error(invalidFrame);
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== "string" || invalidJsonText(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, "value"))) throw new Error(invalidFrame);
    if (Array.isArray(input)) {
      if (keys.length !== input.length + 1) throw new Error(invalidFrame);
      return Array.from({ length: input.length }, (_, index) => {
        if (!Object.hasOwn(input, index)) throw new Error(invalidFrame);
        return normalize(input[index], depth + 1);
      });
    }
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(invalidFrame);
    const record = input as Record<string, unknown>;
    return Object.fromEntries((keys as string[]).sort().map(key => [key, normalize(record[key], depth + 1)]));
  }
  const bytes = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(bytes, "utf8") > 1_048_576) throw new Error(invalidFrame);
  return bytes;
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unitDelta(agreed: SubscriptionEditAmount, proposed: SubscriptionEditAmount): SubscriptionEditAmount | null {
  if (agreed.currency !== proposed.currency || agreed.basis !== proposed.basis) return null;
  return { ...proposed, amountMinor: proposed.amountMinor - agreed.amountMinor };
}
export function assertEditCurrency(expected: string, actual: unknown): void {
  if (!currency.safeParse(expected).success || !currency.safeParse(actual).success) {
    throw new Error("subscription_edit_disclosure_currency_unavailable");
  }
  if (expected !== actual) throw new Error("subscription_edit_disclosure_currency_mismatch");
}

/** Canonical v1 display bytes are the UTF-8 encoding of this JSON text. Array order is display order. */
export function canonicalEditDisclosure(disclosure: SubscriptionEditDisclosure): string {
  if (!disclosureSchema.safeParse(disclosure).success) throw new Error(invalidFrame);
  for (const terms of [disclosure.agreed, disclosure.proposed]) {
    assertEditCurrency(disclosure.currency, terms.payment.amount.currency);
  }
  for (const item of disclosure.lines) {
    if (item.agreed) assertEditCurrency(disclosure.currency, item.agreed.unitAmount.currency);
    if (item.proposed) assertEditCurrency(disclosure.currency, item.proposed.unitAmount.currency);
    if (item.kind === "retained" && canonical(item.unitDelta) !== canonical(unitDelta(item.agreed.unitAmount, item.proposed.unitAmount))) {
      throw new Error(invalidFrame);
    }
  }
  if (Date.parse(disclosure.effectiveCycle.editCutoffAt) > Date.parse(disclosure.effectiveCycle.scheduledAt)) throw new Error(invalidFrame);
  if (disclosure.disposition === "keeps_agreement" && (canonical(disclosure.agreed) !== canonical(disclosure.proposed) ||
    disclosure.lines.some(item => item.kind !== "retained" || canonical(item.agreed) !== canonical(item.proposed)))) {
    throw new Error(invalidFrame);
  }
  return canonical(disclosure);
}

/** The acceptance hash binds the exact display and the private preview identity. */
export function sealEditDisclosure(disclosure: SubscriptionEditDisclosure, binding: EditDisclosureBinding) {
  if (!bindingSchema.safeParse(binding).success) throw new Error(invalidFrame);
  const canonicalDisplay = canonicalEditDisclosure(disclosure);
  return {
    disclosure: JSON.parse(canonicalDisplay) as SubscriptionEditDisclosure,
    canonicalDisplay,
    hash: hash(canonical(["subscription-edit-disclosure", 1, binding, canonicalDisplay])),
  };
}

export function fingerprintEditAgreement(retained: unknown): string {
  return hash(canonical(["subscription-edit-agreement", 1, retained]));
}

export function fingerprintEditProposal(proposal: unknown): string {
  return hash(canonical(["subscription-edit-proposal", 1, proposal]));
}

export function readEditBasis(value: unknown) {
  const parsed = agreedBasis.safeParse(value);
  if (!parsed.success) throw new Error("subscription_edit_disclosure_basis_unavailable");
  return parsed.data;
}

/** Preserve the existing raw-command fingerprint and bind it separately to the accepted hash. */
export function frameEditReceipt(identity: EditReceiptIdentity): EditReceiptIdentity {
  const parsed = receiptSchema.safeParse(identity);
  if (!parsed.success) throw new Error("subscription_edit_receipt_identity_invalid");
  return parsed.data;
}

/** A completed receipt can be matched with those two original hashes and its authenticated lookup scope. */
export function matchesEditReceipt(prior: EditReceiptIdentity, submitted: EditReceiptIdentity): boolean {
  return canonical(frameEditReceipt(prior)) === canonical(frameEditReceipt(submitted));
}

export function readEditRecurringTerms(value: unknown): SubscriptionEditRecurringTerms {
  const parsed = ownerTerms.safeParse(value);
  if (!parsed.success) throw new Error("subscription_edit_disclosure_recurring_evidence_unavailable");
  return parsed.data;
}

const variantKey = (line: { variantId: string }) => line.variantId.toLowerCase();
const lineKey = (line: PricedLine) => JSON.stringify([variantKey(line), line.sku, line.isAddon]);
const side = ({ quantity, label, unitAmount }: PricedLine) => ({ quantity, label, unitAmount });

export function compareEditLines(
  agreed: readonly PricedLine[], proposed: readonly PricedLine[], agreementCurrency: string, keepAgreement: boolean,
): SubscriptionEditDisclosureLine[] {
  // Validate the lane proposal even when the operation keeps the retained agreement.
  for (const lines of [agreed, proposed]) {
    if (!lines.some(line => !line.isAddon) || new Set(lines.map(variantKey)).size !== lines.length ||
      new Set(lines.map(line => line.sku)).size !== lines.length) throw new Error("subscription_edit_disclosure_lines_unavailable");
    for (const item of lines) {
      if (!pricedLine.safeParse(item).success) {
        throw new Error("subscription_edit_disclosure_lines_unavailable");
      }
      assertEditCurrency(agreementCurrency, item.unitAmount.currency);
    }
  }
  const desired = new Map(proposed.map(line => [lineKey(line), line]));
  if (keepAgreement && (agreed.length !== proposed.length ||
    agreed.some(line => desired.get(lineKey(line))?.quantity !== line.quantity))) throw new Error(invalidFrame);
  const comparison = agreed.map((line): SubscriptionEditDisclosureLine => {
    const key = lineKey(line);
    const next = desired.get(key);
    desired.delete(key);
    const identity = { variantId: variantKey(line), sku: line.sku, isAddon: line.isAddon };
    if (!next) return { ...identity, kind: "removed", agreed: side(line), proposed: null, unitDelta: null };
    const after = keepAgreement ? line : next;
    return { ...identity, kind: "retained", agreed: side(line), proposed: side(after), unitDelta: unitDelta(line.unitAmount, after.unitAmount) };
  });
  for (const line of desired.values()) {
    comparison.push({ kind: "added", variantId: variantKey(line), sku: line.sku, isAddon: line.isAddon,
      agreed: null, proposed: side(line), unitDelta: null });
  }
  return comparison;
}
