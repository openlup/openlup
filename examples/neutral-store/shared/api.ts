import type { StoreConfig } from './config.ts';

/** Host operations compose existing public ports; this is an application wire contract. */
export const operations = [
  'checkout.recovery', 'checkout.create', 'checkout.read', 'payment.simulate', 'payment.recover',
  'account.profile', 'account.invoiceCorrection', 'checkout.recoveryStart', 'operator.paymentLink', 'operator.replacement', 'operator.cancelFulfillment',
  'account.read', 'account.orders', 'account.invoice', 'account.consent',
  'subscription.command', 'subscription.preview', 'subscription.catalog', 'subscription.address', 'return.request',
  'auth.request', 'auth.verify', 'auth.callback', 'auth.signOut', 'auth.operator',
  'operator.orders', 'operator.order', 'operator.hold', 'operator.release',
  'operator.cancelUnpaid', 'operator.externalRefund', 'operator.customerSearch',
  'operator.customer', 'operator.recovery', 'operator.shipments', 'operator.shipment',
  'operator.label', 'operator.handoff', 'operator.delivery', 'operator.invoice',
  'operator.returnApprove', 'operator.returnReject',
  'operator.bundles', 'operator.bundle', 'operator.bundleCommand', 'operator.catalogDrafts',
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
  artifact: { kind: 'local-candidate'; setVersion: string | null; verified: false };
}

export function isOperation(value: string): value is Operation {
  return (operations as readonly string[]).includes(value);
}
