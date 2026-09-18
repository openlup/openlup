// Pure payload/key helpers for the OmniPack reconciliation worker.
//
// Extracted from omnipackReconciliationWorker.ts (which sat at the 300-LOC
// guard cap with no headroom) so the loop keeps room for dispositions. These
// are deliberately side-effect free: idempotency-key derivation and the
// sanitized provider proof we persist as evidence. No port, no I/O.

import { normalizeOmnipackReconciliationTimestamp } from "./omnipackReconciliationTimestamp.js";
import type {
  OmnipackReconciliationFulfilment,
  OmnipackReconciliationTrackingReference,
} from "./omnipackReconciliationContracts.js";

export function fulfilmentId(fulfilment: OmnipackReconciliationFulfilment): string {
  return [
    fulfilment.fulfilmentNumber || "unknown-fulfilment",
    fulfilment.orderNumber || fulfilment.externalNumber || "unknown-order",
  ].join(":");
}

export function providerOccurrenceKey(
  fulfillmentOrderId: string,
  providerStatus: string,
  occurredAt: string | null,
): string {
  return `${fulfillmentOrderId}:${providerStatus}:${occurredAt ?? "unknown-time"}`;
}

export function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function sanitizedFulfilment(fulfilment: OmnipackReconciliationFulfilment): Record<string, unknown> {
  return {
    provider: "omnipack",
    occurredAt: normalizeOmnipackReconciliationTimestamp(fulfilment.updatedAt),
    providerOrderId: fulfilment.providerOrderId,
    fulfilmentNumber: fulfilment.fulfilmentNumber,
    externalNumber: fulfilment.externalNumber,
    orderNumber: fulfilment.orderNumber,
    status: fulfilment.status,
    subStatus: fulfilment.subStatus,
    trackingNumbers: unique(fulfilment.trackingNumbers),
    trackingReferences: uniqueTrackingReferences(fulfilment).map((ref) => ({
      trackingNumber: ref.trackingNumber,
      carrierKind: ref.carrierKind ?? null,
      service: ref.service ?? null,
      hasTrackingUrl: Boolean(ref.trackingUrl),
    })),
  };
}

export function uniqueTrackingReferences(
  fulfilment: OmnipackReconciliationFulfilment,
): OmnipackReconciliationTrackingReference[] {
  const refs: OmnipackReconciliationTrackingReference[] = [
    ...(fulfilment.trackingReferences ?? []),
    ...fulfilment.trackingNumbers.map((trackingNumber) => ({ trackingNumber })),
  ];
  const seen = new Set<string>();
  const result: OmnipackReconciliationTrackingReference[] = [];
  for (const ref of refs) {
    const trackingNumber = ref.trackingNumber.trim();
    if (!trackingNumber || seen.has(trackingNumber)) continue;
    seen.add(trackingNumber);
    result.push({
      trackingNumber,
      trackingUrl: ref.trackingUrl ?? null,
      carrier: ref.carrier ?? null,
      carrierKind: ref.carrierKind ?? null,
      service: ref.service ?? null,
    });
  }
  return result;
}

export function safeReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
