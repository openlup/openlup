import type { StoreConfig } from './config.ts';

/** Host operations compose existing public ports; this is an application wire contract. */
export const operations = [
  'checkout.create', 'checkout.read', 'payment.simulate', 'payment.recover',
  'account.read', 'account.orders', 'account.invoice', 'account.consent',
  'subscription.command', 'subscription.address', 'return.request',
  'auth.request', 'auth.verify', 'auth.callback', 'auth.signOut', 'auth.operator',
  'operator.orders', 'operator.order', 'operator.hold', 'operator.release',
  'operator.cancelUnpaid', 'operator.externalRefund', 'operator.customerSearch',
  'operator.customer', 'operator.recovery', 'operator.shipments', 'operator.shipment',
  'operator.label', 'operator.handoff', 'operator.delivery', 'operator.invoice',
  'operator.returns', 'operator.returnApprove', 'operator.returnReject',
  'operator.bundles', 'operator.bundle', 'operator.bundleCommand', 'operator.catalogDrafts',
  'operator.reviews', 'operator.reviewModerate', 'operator.partners', 'operator.partnerTransition',
  'review.read', 'review.submit', 'unsubscribe.apply', 'inquiry.submit',
  'tracking.read', 'acquisition.submit', 'research.submit', 'partners.submit',
  'ingest.submit', 'application.status', 'offer.validate',
] as const;

export type Operation = typeof operations[number];
export type ActionInput = Record<string, unknown>;

export type ActionResult =
  | { ok: true; value: unknown; replayed?: boolean }
  | { ok: false; code: string; field?: string };

export interface AppConfigurationResponse {
  config: StoreConfig;
  artifact: { kind: 'local-candidate'; setVersion: string | null; verified: false };
}

export function isOperation(value: string): value is Operation {
  return (operations as readonly string[]).includes(value);
}
