import type { StoreConfig } from './config.ts';
import type { NeutralSkuEnvelopeV2 } from '@openlup/platform/catalog';

/** Host operations compose existing public ports; this is an application wire contract. */
export const operations = [
  'checkout.tokenPay', 'checkout.inlineRetry', 'checkout.payment', 'checkout.paymentLink',
  'checkout.recovery', 'checkout.create', 'checkout.read', 'payment.simulate', 'payment.recover',
  'account.billing', 'account.defaults', 'account.addresses', 'account.paymentPreference', 'account.deliveryPreference', 'subscription.savedAddress',
  'account.profile', 'account.invoiceCorrection', 'checkout.recoveryStart', 'operator.paymentLink', 'operator.replacement', 'operator.cancelFulfillment',
  'account.read', 'account.orders', 'account.invoice', 'account.consent',
  'subscription.command', 'subscription.preview', 'subscription.catalog', 'subscription.successor', 'subscription.stockWait', 'subscription.address', 'return.request',
  'auth.request', 'auth.verify', 'auth.callback', 'auth.signOut', 'auth.operator',
  'operator.orders', 'operator.order', 'operator.hold', 'operator.release',
  'operator.cancelUnpaid', 'operator.externalRefund', 'operator.customerSearch',
  'operator.customer', 'operator.recovery', 'operator.shipments', 'operator.shipment',
  'operator.label', 'operator.handoff', 'operator.delivery', 'operator.invoice',
  'operator.returnApprove', 'operator.returnReject',
  'operator.bundles', 'operator.bundle', 'operator.bundleCommand', 'operator.catalogDrafts', 'operator.catalogPublication', 'operator.stockWait',
  'operator.reviews', 'operator.reviewModerate', 'operator.partners', 'operator.partnerTransition',
  'review.read', 'review.submit', 'unsubscribe.apply',
  'tracking.read', 'acquisition.submit', 'research.submit', 'partners.submit',
  'ingest.submit', 'application.status', 'offer.validate',
] as const;

export type Operation = typeof operations[number];
export type ActionInput = Record<string, unknown>;

export type ActionResult =
  | { ok: true; value: unknown; replayed?: boolean }
  | { ok: false; code: string; field?: string; status?: 400 | 403 | 409 | 503 };

export interface AppConfigurationResponse {
  config: StoreConfig;
  catalogueAuthority?: 'publication';
  catalogueDraftType: import('@openlup/platform/catalog/contracts').CatalogProductTypeRef;
  artifact: { kind: 'local-candidate'; setVersion: string | null; verified: false };
}

export function publicCatalogueItem(item: NeutralSkuEnvelopeV2) {
  const { id, code, netContent, grossMass, title, options, attributes, sellability } = item.sku;
  const unitPrice = item.sku.unitPrice ?? null;
  return { product: item.product, sku: { id, code, netContent, grossMass, title, options, attributes, unitPrice,
    sellability: { ...sellability, oneTime: unitPrice !== null && sellability.oneTime, subscription: unitPrice !== null && sellability.subscription } },
    publication: item.acceptedReference.publicationHead };
}

export function isOperation(value: string): value is Operation {
  return (operations as readonly string[]).includes(value);
}
