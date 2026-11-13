import type { SyncBinding } from './marketingSync.js';

type Fact<K extends string, D> = Readonly<{ schemaVersion: 1; sourceId: string; sourceType: K;
  occurredAt: string; subject: Readonly<{ clientId: string }>; data: Readonly<D> }>;
export type EcommerceEvent =
  | Fact<'order.paid', { orderId: string; settlementIntentId: string;
      purchaseKind: 'one_time' | 'subscription_initial' | 'renewal'; amountMinor: number; currency: string;
      lines: readonly Readonly<{ sku: string; quantity: number; amountMinor: number }>[] }>
  | Fact<'order.refund_status_changed', { orderId: string; status: 'refunded' }>
  | Fact<'checkout.recovery_qualified', { orderId: string; expiresAt: string }>
  | Fact<'subscription.created' | 'subscription.paused' | 'subscription.resumed' | 'subscription.cancelled', { subscriptionId: string }>;

/** Frozen host projection. Provider profiles already exist; no email or implicit upsert. */
export interface EcommerceEventExportRequest {
  readonly binding: SyncBinding; readonly event: EcommerceEvent;
  readonly subjectReference: string; readonly profileId: string; readonly generation: number;
  readonly authorityReference: string; readonly classification: 'live' | 'historical';
  readonly currencyExponent?: number; readonly currencyExponentSource?: string;
}
export type EcommerceEventExportResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'retryable'; readonly reason: 'cooling' | 'host' | 'provider'; readonly afterSeconds: number }
  | { readonly kind: 'unknown'; readonly reason: 'acceptance_ambiguous' | 'dispatch_unresolved' | 'record_failed' }
  | { readonly kind: 'refused'; readonly reason: string };
export interface EcommerceEventsPort {
  exportEvent(request: EcommerceEventExportRequest, context?: Readonly<{ signal?: AbortSignal; deadlineMs?: number }>): Promise<EcommerceEventExportResult>;
}
