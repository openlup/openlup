import { allocateChannelMoney, type ChannelFrozenMoneyComponent } from "../channelMoneyAllocation.js";
import type { ExpandedChannelOrderLine } from "../bundleLineExpansion.js";
import { normalizedChannelOrderSchema, type NormalizedChannelOrder } from "../orderContracts.js";
import { channelApprovalSchema, channelBundleBindingSchema, channelListingDraftSchema, channelQualificationSchema,
  type ChannelBundleBinding, type ChannelListingDetail } from "../channelListingContracts.js";
import { channelScopeSchema, channelControlTimeSchema, type ChannelScope } from "../channelRegistryContracts.js";
import type { ChannelPurchaseNamespace, ChannelPurchasedProductFacts } from "../channelPurchaseSourceContracts.js";
export interface ChannelRetainedPurchaseContext {
  readonly scope: ChannelScope; readonly namespace: Readonly<ChannelPurchaseNamespace>;
  readonly listing: ChannelListingDetail["listing"];
  readonly firstApproval: NonNullable<ChannelListingDetail["firstApproval"]>;
  readonly firstQualification: NonNullable<ChannelListingDetail["firstQualification"]>;
  readonly bundle: ChannelBundleBinding; readonly channelSlug: NormalizedChannelOrder["channelSlug"];
}
export interface ChannelResolvedPurchaseRow {
  line: ExpandedChannelOrderLine;
  provenance: { skuId: string; groupIndex: number; listingId: string; bundleDigest: string;
    firstApprovalId: string; firstQualificationId: string; weightMinor: number; normalizationFactor: number };
}
export type ChannelPurchaseResolution = { ok: true; rows: ChannelResolvedPurchaseRow[] } |
  { ok: false; reason: "retained_binding_missing" | "retained_binding_conflict" | "purchased_products_conflict" | "purchase_money_invalid" };
function scopeIdentity(scope: ChannelScope): readonly unknown[] {
  return [scope.connectionId, scope.channelId, scope.connectorKind, scope.sellerRef, scope.environmentRef, scope.currency, scope.regionCode];
}
function sameScope(a: ChannelScope, b: ChannelScope): boolean {
  const other = scopeIdentity(b); return scopeIdentity(a).every((value, index) => value === other[index]);
}

/** Resolve paid debt from its first retained basis; current status, price and expiry cannot rewrite it. */
export function resolveChannelPurchasedBundles(input: {
  order: NormalizedChannelOrder; products: readonly ChannelPurchasedProductFacts[];
  observed: { scope: ChannelScope; namespace: ChannelPurchaseNamespace }; contexts: readonly ChannelRetainedPurchaseContext[];
}): ChannelPurchaseResolution {
  const parsed = normalizedChannelOrderSchema.safeParse(input.order);
  if (!parsed.success || !channelScopeSchema.safeParse(input.observed.scope).success) return { ok: false, reason: "retained_binding_conflict" };
  const order = parsed.data;
  if (order.payment.state !== "paid_externally" || new Set(order.lines.map(line => line.externalLineRef)).size !== order.lines.length ||
      new Set(input.products.map(line => line.externalLineRef)).size !== input.products.length || input.products.length !== order.lines.length) {
    return { ok: false, reason: "purchased_products_conflict" };
  }
  const rows: ChannelResolvedPurchaseRow[] = [];
  for (const line of order.lines) {
    const matches = input.contexts.filter(value => value.listing.externalOfferRef === line.sellable.externalOfferRef);
    if (matches.length !== 1) return { ok: false, reason: "retained_binding_missing" };
    const context = matches[0];
    const l = channelListingDraftSchema.safeParse(context.listing), a = channelApprovalSchema.safeParse(context.firstApproval);
    const q = channelQualificationSchema.safeParse(context.firstQualification), b = channelBundleBindingSchema.safeParse(context.bundle);
    if (!l.success || !a.success || !q.success || !b.success) return { ok: false, reason: "retained_binding_missing" };
    const listing = l.data, approval = a.data, qualification = q.data, bundle = b.data;
    const purchase = input.products.find(value => value.externalLineRef === line.externalLineRef);
    if (!purchase || !channelControlTimeSchema.safeParse(purchase.purchasedAt).success) return { ok: false, reason: "purchased_products_conflict" };
    if (!channelScopeSchema.safeParse(context.scope).success || line.sellable.kind !== "bundle" || order.channelSlug !== context.channelSlug ||
        order.currency !== context.scope.currency || !sameScope(input.observed.scope, context.scope) || !sameScope(listing.scope, context.scope) ||
        !sameScope(qualification.offer.scope, context.scope) || !context.namespace.applicationRef ||
        context.namespace.applicationRef !== input.observed.namespace.applicationRef ||
        context.namespace.channelExternalRef !== input.observed.namespace.channelExternalRef || listing.bundleId !== bundle.bundleId ||
        (line.sellable.bundleCode !== null && line.sellable.bundleCode !== bundle.code) || approval.listingId !== listing.id ||
        qualification.listingId !== listing.id || approval.qualificationId !== qualification.id || approval.firstBasisApprovalId !== approval.id ||
        qualification.disposition !== "qualified" || qualification.offer.externalOfferRef !== listing.externalOfferRef || !bundle.lockedAt ||
        bundle.compositionDigest !== approval.bundleDigest || bundle.compositionDigest !== qualification.bundleDigest ||
        approval.controlledDigest !== qualification.offer.controlledDigest || approval.termsDigest !== qualification.offer.terms.digest ||
        approval.policyRef !== qualification.policyRef || approval.requestedPrice.grossMinor !== qualification.requestedPrice.grossMinor ||
        qualification.offer.price.currency !== order.currency || approval.requestedPrice.currency !== order.currency ||
        qualification.requestedPrice.currency !== order.currency || Date.parse(approval.approvedAt) > Date.parse(purchase.purchasedAt) ||
        Date.parse(bundle.lockedAt) > Date.parse(purchase.purchasedAt) || bundle.components.some(component => component.isAddon)) {
      return { ok: false, reason: "retained_binding_conflict" };
    }
    if (purchase.externalOfferRef !== listing.externalOfferRef ||
        new Set(purchase.products.map(value => value.externalProductRef)).size !== purchase.products.length ||
        purchase.products.length !== bundle.components.length || qualification.mapping.length !== bundle.components.length ||
        qualification.basis.length !== bundle.components.length || qualification.offer.products.length !== bundle.components.length) {
      return { ok: false, reason: "purchased_products_conflict" };
    }
    const components: ChannelFrozenMoneyComponent[] = [];
    for (const component of bundle.components) {
      const mapping = qualification.mapping.find(value => value.skuId === component.skuId);
      const basis = qualification.basis.find(value => value.skuId === component.skuId);
      const bought = purchase.products.find(value => value.externalProductRef === mapping?.externalProductRef);
      const retained = qualification.offer.products.find(value => value.externalProductRef === mapping?.externalProductRef);
      if (!mapping || !basis || !bought || !retained || bought.quantityPerSet !== component.quantity || retained.quantity !== component.quantity) {
        return { ok: false, reason: "purchased_products_conflict" };
      }
      components.push({ skuId: component.skuId, skuCode: component.skuCode, quantityPerSet: component.quantity, weightMinor: basis.weightMinor });
    }
    try {
      const money = allocateChannelMoney({ finalMinor: line.lineGrossMinor - line.lineDiscountMinor,
        discountMinor: line.lineDiscountMinor, purchasedSets: line.quantity, components });
      for (const group of money.groups) {
        rows.push({ line: { externalLineRef: line.externalLineRef, externalOfferRef: listing.externalOfferRef,
          skuCode: group.skuCode, quantity: group.quantity, unitGrossMinor: group.unitGrossMinor, lineGrossMinor: group.lineGrossMinor,
          lineDiscountMinor: group.lineDiscountMinor, vatRateBps: line.vatRateBps, bundleCode: bundle.code, bundleQty: line.quantity },
        provenance: { skuId: group.skuId, groupIndex: group.groupIndex, listingId: listing.id, bundleDigest: bundle.compositionDigest,
          firstApprovalId: approval.id, firstQualificationId: qualification.id,
          weightMinor: components.find(value => value.skuId === group.skuId)!.weightMinor, normalizationFactor: money.normalizationFactor } });
      }
    } catch { return { ok: false, reason: "purchase_money_invalid" }; }
  }
  return { ok: true, rows };
}
