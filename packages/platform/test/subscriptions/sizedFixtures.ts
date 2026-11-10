import type { SizedAgreedLine, SizedEditContext, SizedEditPolicy, SizedQuoteLine, SizedRecurringQuote } from "../../src/subscriptions/contracts/sizedEdit.js";
import type { SizedCatalogFact, SizedHostPorts } from "../../src/subscriptions/sizedEditPorts.js";
export const ids = { subscription: "10000000-0000-4000-8000-000000000001", client: "20000000-0000-4000-8000-000000000001",
  actor: "30000000-0000-4000-8000-000000000001", a: "40000000-0000-4000-8000-000000000001",
  b: "40000000-0000-4000-8000-000000000002", addon: "40000000-0000-4000-8000-000000000003" };
export const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
export function quoteLine(sku: string, quantity: number, unit = 100): SizedQuoteLine & Record<string, unknown> {
  return { sku, productSlug: "refill", quantity, unitPriceGross: money(unit), lineSubtotalGross: money(unit * quantity),
    tax: { included: true, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "synthetic", netAmount: money(unit * quantity), vatAmount: money(0), grossAmount: money(unit * quantity) },
    pricingComponents: [{ scope: "line", componentType: "base_unit", amountMinor: 173 * quantity, reasonCode: "configured", reasonPayload: { preserve: true } }], frozenEvidence: { revision: "retained", sequence: [3, 1, 2] } };
}
export function fullQuote(lines: SizedQuoteLine[]): SizedRecurringQuote {
  const total = money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0));
  return { currency: "XXX", taxIncluded: true, lines, discounts: [], subtotalGross: total, discountTotalGross: money(0), totalGross: total,
    netTotal: total, taxTotal: money(0), context: { mode: "subscription", promoCodes: [] } };
}
export const policy: SizedEditPolicy = { minimumCoreUnits: 4, maximumCoreLines: 3, maximumAddonLines: 5, maximumQuantity: 12,
  allowedCadences: [10, 20, 30], maximumExclusions: 8, maximumCatalogExclusions: 16, fixedThroughCycle: 2, graduationCycle: 3,
  portionModes: { full: { mode: "complete", factor: 1 }, reduced: { mode: "partial", factor: 0.5 } } };
export function agreed(variantId = ids.a, qty = 4, isAddon = false): SizedAgreedLine {
  return { lineId: variantId, variantId, sku: variantId, groupId: variantId, qty, isAddon, quoteLine: quoteLine(variantId, qty) };
}
export function context(): SizedEditContext {
  return { subscriptionId: ids.subscription, clientId: ids.client, binding: "sized.v1", templateVersion: 1, cadenceDays: 20,
    nextCycleAt: "2026-12-20T12:00:00.000Z", paidCycleCount: 0, marker: null,
    compositionConstraint: { kind: "unit_count", value: 4, dailyNeed: 4 }, lines: [agreed(), agreed(ids.addon, 1, true)], graduationLines: [] };
}
export function catalog(): SizedCatalogFact[] {
  return [ids.a, ids.b, ids.addon].map((id, index) => ({ variantId: id, sku: id, groupId: id, isAddon: id === ids.addon, sellable: true,
    physicalSize: 250 + index * 125, demandPerUnit: 20, documentRevisionId: id, documentDigest: "a".repeat(64), verified: true, exclusions: [], sellableNow: 10 }));
}
export function host(): SizedHostPorts {
  return { readFacts: async (_db, current) => ({ subscriptionId: current.subscriptionId, clientId: current.clientId,
    subjectRef: "owned-subject", exclusions: [], snapshot: { revision: 1 } }),
  resolveOptInNeed: async () => ({ dailyNeed: 4, snapshot: { revision: 1, source: "owned-profile" } }),
  readCatalog: async () => catalog(), assertCurrentFacts: async () => {},
  proposePortion: async ({ current, factor }) => current.map(line => ({ variantId: line.variantId, qty: Math.max(1, Math.floor(line.qty * factor)) })),
  quotePort: { createServerAuthoritativeQuote: async request => ({ quote: fullQuote(request.lines.map(line => quoteLine(line.sku, line.quantity, 137))) }) } };
}
