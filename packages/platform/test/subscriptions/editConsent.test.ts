import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SubscriptionEditAmount, SubscriptionEditDisclosure } from "../../src/subscriptions/contracts/editConsent.js";
import {
  canonicalEditDisclosure, compareEditLines, frameEditReceipt, matchesEditReceipt, sealEditDisclosure,
} from "../../src/subscriptions/editConsent.js";
import { checkEditDisclosureQuotePort, projectEditDisclosure } from "../../src/subscriptions/editConsentProjection.js";

const actorId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const subscriptionId = "00000000-0000-4000-8000-000000000003";
const variantId = "00000000-0000-4000-8000-000000000004";
const otherId = "00000000-0000-4000-8000-000000000005";
const evidence = { owner: "fixture-pricing", version: "1", digest: "a".repeat(64) };
const payment = { kind: "payable" as const, label: "Recurring payment", amount: { amountMinor: 500, currency: "USD", basis: "tax_inclusive" as const }, evidence };
const terms = { payment, cadence: { days: 28, evidence } };
const presentation = { version: "1", locale: "en-US", labels: { title: "Review changes", agreed: "Current terms",
  proposed: "Proposed terms", effectiveCycle: "Effective cycle", cadence: "Billing frequency", confirmation: "Accept changes" } };
const baseline = { subscriptionId, clientId, templateVersion: 1, cadenceDays: 28, constraint: null, currency: "USD",
  scheduledAt: "2026-12-05T12:00:00.000001Z", editCutoffAt: "2026-12-04T12:00:00.000001Z",
  lines: [{ variantId, sku: "REFILL", quantity: 4, unitAmountMinor: 100, ordinal: 1, lineId: variantId, isAddon: false }] };
const owner = { agreedUnitBasis: () => ({ basis: "tax_inclusive" as const, evidence }), agreed: terms,
  proposed: terms, labelLine: () => "Refill", cycleNumber: 2, cycleEvidence: evidence };
const scope = { actorId, clientId, subscriptionId, action: "update_package_template", lane: "classic" as const };
const binding = { ...scope, templateVersion: 1, baselineFingerprint: "b".repeat(64), innerQuoteHash: "c".repeat(64),
  proposalFingerprint: "d".repeat(64), normalizedRequest: { base: [{ variantId, qty: 5 }], planDays: 28 } };

function classic(qty = 5, quoteCurrency = "USD") {
  const unit = { amountMinor: 140, currency: quoteCurrency };
  const quoted = { variantId, qty, quoteLine: { sku: "REFILL", quantity: qty, unitPriceGross: unit, lineSubtotalGross: unit } };
  return { lane: "classic" as const, actorId, owner, baseline, presentation,
    request: { subscriptionId, planDays: 28, base: [{ variantId, qty }] },
    quote: { quoteHash: binding.innerQuoteHash, expectedTemplateVersion: 1, compositionConstraint: null, cadenceDays: 28,
      baseLines: [quoted], addonLines: [], newRecurringPrice: unit, currentRecurringPrice: unit, delta: unit } };
}

describe("edit disclosure v1", () => {
  it("seals stable UTF-8 display bytes and binds the preview separately", () => {
    const { disclosure } = projectEditDisclosure({ ...classic(), owner: { ...owner, labelLine: () => "Recharge 🎁" } });
    const sealed = sealEditDisclosure(disclosure, binding);
    expect(JSON.parse(sealed.canonicalDisplay)).toEqual(disclosure);
    expect(sealed.canonicalDisplay).toContain("Recharge 🎁");
    expect(sealEditDisclosure(JSON.parse(sealed.canonicalDisplay), { ...binding, normalizedRequest: { planDays: 28, base: [{ qty: 5, variantId }] } })).toEqual(sealed);
    expect(sealed.hash).toBe("b883aa1c8b496403b843228b9716053326fc14b3e8d775bcad5afdcbae906320");
    expect(createHash("sha256").update(sealed.canonicalDisplay, "utf8").digest("hex")).not.toBe(sealed.hash);
  });

  it("binds material display facts even when the recurring amount is unchanged", () => {
    const { disclosure } = projectEditDisclosure(classic());
    const hash = sealEditDisclosure(disclosure, binding).hash;
    const swap = { ...disclosure.lines[0], variantId: otherId, sku: "OTHER" };
    const changed: SubscriptionEditDisclosure[] = [
      { ...disclosure, lines: [swap] },
      { ...disclosure, proposed: { ...terms, payment: { ...payment, amount: { ...payment.amount, basis: "tax_exclusive" } } } },
      { ...disclosure, proposed: { ...terms, payment: { ...payment, kind: "estimate", label: "Estimated recurring payment" } } },
      { ...disclosure, proposed: { ...terms, cadence: { ...terms.cadence, days: 21 } } },
      { ...disclosure, effectiveCycle: { ...disclosure.effectiveCycle, number: 3 } },
      { ...disclosure, effectiveCycle: { ...disclosure.effectiveCycle, scheduledAt: "2026-12-05T12:00:00.000002Z" } },
      { ...disclosure, presentation: { ...presentation, version: "2" } },
      { ...disclosure, presentation: { ...presentation, locale: "en-CA" } },
      { ...disclosure, presentation: { ...presentation, labels: { ...presentation.labels, confirmation: "Confirm recurring terms" } } },
    ];
    for (const display of changed) expect(sealEditDisclosure(display, binding).hash).not.toBe(hash);
    for (const identity of [
      { actorId: otherId }, { clientId: otherId }, { subscriptionId: otherId }, { action: "update_base_mix" },
      { lane: "exact" as const }, { templateVersion: 2 }, { normalizedRequest: {} },
      { baselineFingerprint: "1".repeat(64) }, { innerQuoteHash: "2".repeat(64) }, { proposalFingerprint: "3".repeat(64) },
    ]) expect(sealEditDisclosure(disclosure, { ...binding, ...identity }).hash).not.toBe(hash);
  });

  it("compares distinct roles and SKUs and omits a delta for different bases", () => {
    const line = { variantId, sku: "REFILL", isAddon: false, quantity: 4, label: "Refill", unitAmount: payment.amount };
    const amount: SubscriptionEditAmount = { ...payment.amount, basis: "tax_exclusive" };
    expect(compareEditLines([line], [{ ...line, quantity: 5, unitAmount: amount }], "USD", false)).toEqual([
      { variantId, sku: line.sku, isAddon: false, kind: "retained", agreed: { quantity: 4, label: "Refill", unitAmount: payment.amount },
        proposed: { quantity: 5, label: "Refill", unitAmount: amount }, unitDelta: null },
    ]);
    const extra = { ...line, variantId: otherId, sku: "EXTRA", isAddon: true };
    expect(compareEditLines([line, extra], [{ ...line, sku: "NEW" }], "USD", false)).toMatchObject([
      { kind: "removed", sku: "REFILL", proposed: null },
      { kind: "removed", sku: "EXTRA", isAddon: true },
      { kind: "added", sku: "NEW", agreed: null },
    ]);
  });

  it("keeps agreed money, cadence and labels for a content-only no-op after live repricing", () => {
    const original = classic(4);
    const { disclosure, hash } = projectEditDisclosure({ ...original, owner: { ...owner, proposed: undefined } });
    expect(disclosure.disposition).toBe("keeps_agreement");
    expect(disclosure.proposed).toEqual(disclosure.agreed);
    expect(disclosure.lines[0]).toMatchObject({ proposed: { unitAmount: { amountMinor: 100 } }, unitDelta: { amountMinor: 0 } });
    expect(projectEditDisclosure({ ...original, quote: { ...original.quote, quoteHash: "e".repeat(64) } }).hash).not.toBe(hash);
  });

  it("refuses missing or unsupported owner evidence and cross-currency comparisons", () => {
    const inputs = classic();
    for (const unknownBasis of [undefined, { basis: "unknown", evidence }, { basis: "tax_inclusive" }]) {
      const agreedUnitBasis = () => unknownBasis as ReturnType<typeof owner.agreedUnitBasis> | undefined;
      expect(() => projectEditDisclosure({ ...inputs, owner: { ...owner, agreedUnitBasis } })).toThrow("basis_unavailable");
    }
    for (const unknownTerms of [undefined, { cadence: terms.cadence }, { ...terms, payment: { ...payment, kind: "estimate", label: " " } },
      { ...terms, payment: { ...payment, evidence: { ...evidence, version: "" } } }]) {
      expect(() => projectEditDisclosure({ ...inputs, owner: { ...owner, proposed: unknownTerms as typeof owner.proposed } })).toThrow("recurring_evidence_unavailable");
    }
    expect(() => projectEditDisclosure(classic(4, "EUR"))).toThrow("currency_mismatch");
    expect(() => projectEditDisclosure({ ...inputs, owner: { ...owner, proposed: { ...terms, payment: { ...payment, amount: { ...payment.amount, currency: "EUR" } } } } })).toThrow("currency_mismatch");
    expect(() => projectEditDisclosure({ ...inputs, owner: { ...owner, proposed: { ...terms, cadence: { ...terms.cadence, days: 21 } } } })).toThrow("cadence_mismatch");
  });

  it("rejects forged display deltas and unsupported versions", () => {
    const { disclosure } = projectEditDisclosure(classic());
    const [line] = disclosure.lines;
    expect(() => canonicalEditDisclosure({ ...disclosure, lines: [{ ...line, unitDelta: payment.amount }] as typeof disclosure.lines })).toThrow("disclosure_invalid");
    expect(() => canonicalEditDisclosure({ ...disclosure, version: 2 } as unknown as SubscriptionEditDisclosure)).toThrow("disclosure_invalid");
  });

  it("refuses values that cannot round-trip in canonical JSON", () => {
    const { disclosure } = projectEditDisclosure(classic());
    for (const value of [undefined, NaN, -0, "\u0000", "\uD800", new Array(2), new Date()]) {
      expect(() => sealEditDisclosure(disclosure, { ...binding, normalizedRequest: { value } })).toThrow("disclosure_invalid");
    }
  });

  it("checks quote-authority currency and line identity before a legacy merge", async () => {
    const line = classic().quote.baseLines[0].quoteLine;
    const money = line.unitPriceGross;
    const request = { lines: [{ sku: line.sku, quantity: line.quantity }] };
    const project = (totalCurrency: string, responseSku: string) => checkEditDisclosureQuotePort("USD", {
      async createServerAuthoritativeQuote() {
        return { quote: { lines: [{ ...line, sku: responseSku }], totalGross: { ...money, currency: totalCurrency }, subtotalGross: money, discountTotalGross: money } };
      },
    }).createServerAuthoritativeQuote(request);
    await expect(project("USD", line.sku)).resolves.toMatchObject({ quote: { lines: [line] } });
    await expect(project("EUR", line.sku)).rejects.toThrow("currency_mismatch");
    await expect(project("USD", "WRONG")).rejects.toThrow("quote_line_mismatch");
  });
});

it("matches an original receipt using both hashes and authenticated scope without fresh pricing", () => {
  const old = frameEditReceipt({ ...scope, idempotencyKey: "original-key", commandFingerprint: "e".repeat(64), acceptedHash: "f".repeat(64) });
  expect(matchesEditReceipt(old, { ...old })).toBe(true);
  for (const change of [
    { commandFingerprint: "a".repeat(64) }, { acceptedHash: "b".repeat(64) }, { clientId: otherId },
    { actorId: otherId }, { subscriptionId: otherId }, { action: "swap_base_line" },
    { lane: "exact" as const }, { idempotencyKey: "different-key" },
  ]) expect(matchesEditReceipt(old, { ...old, ...change })).toBe(false);
});
