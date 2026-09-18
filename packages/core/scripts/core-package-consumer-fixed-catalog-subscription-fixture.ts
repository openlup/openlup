export const FIXED_CATALOG_SUBSCRIPTION_MARKER = "fixed-catalog subscription packed consumer ok";

const template = {
  cadence_days: 14,
  currency: "USD",
  region_code: "EXAMPLE",
  edit_window_hours: 24,
  size_constraint: { kind: "fixed.catalog", requiredCoreQty: 3 },
  lines: [
    { variant_id: "core-alpha", qty: 2, sort_order: 1, is_addon: false },
    { variant_id: "core-beta", qty: 1, sort_order: 2, is_addon: false },
    { variant_id: "addon-gamma", qty: 2, sort_order: 3, is_addon: true },
  ],
};

const pricingSnapshot = {
  currency: "USD",
  totalGrossMinor: 2900,
  lines: [
    { sku: "core-alpha", qty: 2, unitGrossMinor: 1000 },
    { sku: "core-delta", qty: 1, unitGrossMinor: 900 },
  ],
};

const bundle = {
  coreLines: [
    { variantId: "core-alpha", qty: 2, isAddon: false },
    { variantId: "core-delta", qty: 1, isAddon: false },
  ],
  addonLines: [{ variantId: "addon-gamma", qty: 2, isAddon: true }],
  constraint: { kind: "fixed.catalog", version: 1, data: { requiredCoreQty: 3 } },
};

const pricingLines = [
  {
    variant_id: "core-alpha",
    line_qty: 2,
    base_unit_price_minor: 1200,
    resolved_unit_price_minor: 1000,
    matched_tier_min_qty: 1,
    mode_at_line: "subscription",
    mode_resolved_via_fallback: false,
  },
  {
    variant_id: "core-delta",
    line_qty: 1,
    base_unit_price_minor: 900,
    resolved_unit_price_minor: 900,
    matched_tier_min_qty: 1,
    mode_at_line: "subscription",
    mode_resolved_via_fallback: false,
  },
];

export function fixedCatalogRuntimeImports(): string[] {
  return [
    "import { createInitialSubscriptionCheckoutModel, pauseSubscription, planSubscriptionCycle, recordPaymentSuccess, resumeSubscription, swapTemplateLine } from '@openlup/core/subscription';",
    "import { assertBreakdownInvariant, buildOrderBreakdown } from '@openlup/core/pricing';",
  ];
}

export function fixedCatalogTypecheckImports(): string[] {
  return [
    "import type { Bundle, CompositionRulesPort } from '@openlup/core/bundle';",
    "import { createInitialSubscriptionCheckoutModel, pauseSubscription, planSubscriptionCycle, recordPaymentSuccess, resumeSubscription, swapTemplateLine, type SubscriptionEngineResult, type SubscriptionTemplateSnapshot } from '@openlup/core/subscription';",
    "import { assertBreakdownInvariant, buildOrderBreakdown, type LinePricingInput } from '@openlup/core/pricing';",
  ];
}

export function fixedCatalogScenarioLines(typescript: boolean): string[] {
  const unwrapDeclaration = typescript
    ? "function unwrapFixedCatalog<T>(result: SubscriptionEngineResult<T>): T {"
    : "function unwrapFixedCatalog(result) {";
  const templateDeclaration = typescript
    ? `  const fixedCatalogTemplate: SubscriptionTemplateSnapshot = { ...${JSON.stringify(template)}, cadence_days: fixedCatalogCase.cadenceDays };`
    : `  const fixedCatalogTemplate = { ...${JSON.stringify(template)}, cadence_days: fixedCatalogCase.cadenceDays };`;
  const bundleDeclaration = typescript
    ? `const fixedCatalogBundle: Bundle = ${JSON.stringify(bundle)};`
    : `const fixedCatalogBundle = ${JSON.stringify(bundle)};`;
  const rulesDeclaration = typescript
    ? "const fixedCatalogRules: CompositionRulesPort = {"
    : "const fixedCatalogRules = {";
  const linesDeclaration = typescript
    ? `const fixedCatalogPricingLines: LinePricingInput[] = ${JSON.stringify(pricingLines)};`
    : `const fixedCatalogPricingLines = ${JSON.stringify(pricingLines)};`;
  const quantityAssertionDeclaration = typescript
    ? "  const fixedCatalogHasExpectedQuantities = (lines: SubscriptionTemplateSnapshot['lines']) => Object.entries(fixedCatalogExpectedQty).every(([variantId, qty]) => lines.some((line) => line.variant_id === variantId && line.qty === qty)) && lines.length === Object.keys(fixedCatalogExpectedQty).length;"
    : "  const fixedCatalogHasExpectedQuantities = (lines) => Object.entries(fixedCatalogExpectedQty).every(([variantId, qty]) => lines.some((line) => line.variant_id === variantId && line.qty === qty)) && lines.length === Object.keys(fixedCatalogExpectedQty).length;";
  const resumedDeclaration = typescript
    ? "let fixedCatalogResumed: { subscription: { status: string } } | undefined;"
    : "let fixedCatalogResumed;";
  const cycleDeclaration = typescript
    ? "let fixedCatalogCycle: { cycle: { status: string } } | undefined;"
    : "let fixedCatalogCycle;";

  return [
    unwrapDeclaration,
    "  if (result.ok === false) throw new Error(`${result.error.code}: ${result.error.message}`);",
    "  return result.value;",
    "}",
    // The cycle is scheduled 2026-08-01T10:00Z and paid 2026-08-02T10:00Z: exactly one
    // whole day late, so each anchor is cadence + 1 day past the scheduled date. The
    // renewal assertion further down reads the same three values back off the planned
    // successor cycle, so it follows this table rather than restating it.
    "const fixedCatalogCadenceCases = [",
    "  { cadenceDays: 14, expectedNextCycleAt: '2026-08-16T10:00:00.000Z' },",
    "  { cadenceDays: 21, expectedNextCycleAt: '2026-08-23T10:00:00.000Z' },",
    "  { cadenceDays: 28, expectedNextCycleAt: '2026-08-30T10:00:00.000Z' },",
    "];",
    `const fixedCatalogPricingSnapshot = ${JSON.stringify(pricingSnapshot)};`,
    resumedDeclaration,
    cycleDeclaration,
    "for (const fixedCatalogCase of fixedCatalogCadenceCases) {",
    templateDeclaration,
    "  const fixedCatalogInitial = unwrapFixedCatalog(createInitialSubscriptionCheckoutModel({ subscriptionId: `sub-fixed-catalog-${fixedCatalogCase.cadenceDays}`, clientRef: 'client-fixed-catalog', template: fixedCatalogTemplate, paymentMethodRef: 'pm-fixed-catalog', paymentMethodKind: 'card', firstCycleAt: '2026-08-01T10:00:00.000Z', now: '2026-07-01T10:00:00.000Z', pricingSnapshot: fixedCatalogPricingSnapshot, idempotencyKey: `fixed-catalog-initial-${fixedCatalogCase.cadenceDays}`, timezone: 'UTC' }));",
    "  if (fixedCatalogInitial.subscription.status !== 'active' || fixedCatalogInitial.cycle.scheduledAt !== '2026-08-01T10:00:00.000Z' || fixedCatalogInitial.events[0]?.eventType !== 'subscription.created') throw new Error('fixed-catalog create failed');",
    "  const fixedCatalogEdited = unwrapFixedCatalog(swapTemplateLine({ subscription: fixedCatalogInitial.subscription, fromVariantId: 'core-beta', toVariantId: 'core-delta', now: '2026-07-02T10:00:00.000Z' }));",
    "  const fixedCatalogExpectedQty = { 'core-alpha': 2, 'core-delta': 1, 'addon-gamma': 2 };",
    quantityAssertionDeclaration,
    "  if (fixedCatalogEdited.subscription.templateVersion !== 2 || !fixedCatalogHasExpectedQuantities(fixedCatalogEdited.subscription.template.lines)) throw new Error('fixed-catalog swap changed independent quantities');",
    "  const fixedCatalogPaid = unwrapFixedCatalog(recordPaymentSuccess({ subscription: fixedCatalogEdited.subscription, cycle: fixedCatalogInitial.cycle, paidAt: '2026-08-02T10:00:00.000Z', recordedAt: '2026-08-02T10:00:00.000Z' }));",
    "  if (fixedCatalogPaid.subscription.nextCycleAt !== fixedCatalogCase.expectedNextCycleAt || fixedCatalogPaid.cycle.status !== 'paid') throw new Error('fixed-catalog payment cadence failed');",
    "  const fixedCatalogPaused = unwrapFixedCatalog(pauseSubscription({ subscription: fixedCatalogPaid.subscription, now: '2026-08-03T10:00:00.000Z', reason: 'customer_request' }));",
    "  if (fixedCatalogPaused.subscription.status !== 'paused' || fixedCatalogPaused.events[0]?.eventType !== 'subscription.paused') throw new Error('fixed-catalog pause failed');",
    "  const fixedCatalogResumedForCase = unwrapFixedCatalog(resumeSubscription({ subscription: fixedCatalogPaused.subscription, now: '2026-08-04T10:00:00.000Z' }));",
    "  if (fixedCatalogResumedForCase.subscription.status !== 'active' || fixedCatalogResumedForCase.events[0]?.eventType !== 'subscription.resumed') throw new Error('fixed-catalog resume failed');",
    "  const fixedCatalogCycleForCase = unwrapFixedCatalog(planSubscriptionCycle({ subscription: fixedCatalogResumedForCase.subscription, cycleNumber: 2, now: '2026-08-05T10:00:00.000Z', pricingSnapshot: fixedCatalogPricingSnapshot, idempotencyKey: `fixed-catalog-cycle-2-${fixedCatalogCase.cadenceDays}` }));",
    "  if (fixedCatalogCycleForCase.cycle.status !== 'payment_pending' || fixedCatalogCycleForCase.cycle.scheduledAt !== fixedCatalogCase.expectedNextCycleAt || fixedCatalogCycleForCase.cycle.templateVersion !== 2 || !fixedCatalogHasExpectedQuantities(fixedCatalogCycleForCase.cycle.templateSnapshot.lines)) throw new Error('fixed-catalog renewal failed');",
    "  fixedCatalogResumed = fixedCatalogResumedForCase;",
    "  fixedCatalogCycle = fixedCatalogCycleForCase;",
    "}",
    "if (fixedCatalogResumed === undefined || fixedCatalogCycle === undefined) throw new Error('fixed-catalog cadence matrix was empty');",
    rulesDeclaration,
    "  async validateComposition(input) {",
    "    const required = Number(input.constraint.data.requiredCoreQty);",
    "    const actual = input.coreLines.reduce((sum, line) => sum + line.qty, 0);",
    "    return input.constraint.kind === 'fixed.catalog' && Number.isInteger(required) && actual === required ? { ok: true } : { ok: false, code: 'core_qty_mismatch', details: { required, actual } };",
    "  },",
    "  async resizeComposition(input) {",
    "    if (input.lever.kind !== 'requiredCoreQty' || typeof input.lever.value !== 'number' || !Number.isInteger(input.lever.value) || input.lever.value < input.coreLines.length) return null;",
    "    const requiredCoreQty = Number(input.lever.value);",
    "    return { constraint: { ...input.constraint, data: { ...input.constraint.data, requiredCoreQty } }, coreLines: input.coreLines.map((line, index) => ({ ...line, qty: index === 0 ? requiredCoreQty - input.coreLines.length + 1 : 1 })) };",
    "  },",
    "};",
    bundleDeclaration,
    "const fixedCatalogAccepted = await fixedCatalogRules.validateComposition(fixedCatalogBundle);",
    "if (!fixedCatalogAccepted.ok) throw new Error('fixed-catalog valid bundle rejected');",
    "const fixedCatalogRejected = await fixedCatalogRules.validateComposition({ ...fixedCatalogBundle, coreLines: fixedCatalogBundle.coreLines.slice(0, 1) });",
    "if (fixedCatalogRejected.ok || fixedCatalogRejected.code !== 'core_qty_mismatch') throw new Error('fixed-catalog invalid bundle accepted');",
    "const fixedCatalogResized = await fixedCatalogRules.resizeComposition({ coreLines: fixedCatalogBundle.coreLines, constraint: fixedCatalogBundle.constraint, lever: { kind: 'requiredCoreQty', value: 4 } });",
    "if (!fixedCatalogResized || !(await fixedCatalogRules.validateComposition({ ...fixedCatalogBundle, ...fixedCatalogResized })).ok) throw new Error('fixed-catalog resize acceptance failed');",
    "const fixedCatalogResizeRejected = await fixedCatalogRules.resizeComposition({ coreLines: fixedCatalogBundle.coreLines, constraint: fixedCatalogBundle.constraint, lever: { kind: 'unsupported', value: 3 } });",
    "if (fixedCatalogResizeRejected !== null) throw new Error('fixed-catalog unsupported resize accepted');",
    linesDeclaration,
    "const fixedCatalogBreakdown = buildOrderBreakdown({ lines: fixedCatalogPricingLines, shipping: { amount_minor: 300, applied_rule_id: 'standard', carrier_kind: 'neutral-carrier', vat_rate_bps: 0 }, discounts: [{ promotionId: 'promo-neutral', amountOffMinor: 100, reasonCode: 'neutral_credit' }] });",
    "assertBreakdownInvariant(fixedCatalogBreakdown, 3100);",
    `console.log('${FIXED_CATALOG_SUBSCRIPTION_MARKER}');`,
  ];
}
