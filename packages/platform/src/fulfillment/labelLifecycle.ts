import type { FulfillmentLabelPort, LabelDocument } from './contracts/label.js';
/** Storage-only read: a missing cached label never proves the parcel absent. Signed URLs are transient. */
export async function readFulfillmentLabel(port: Pick<FulfillmentLabelPort, 'read'>, document: LabelDocument | null) {
  if (!document) return { kind: 'refused' as const, refusal: { reason: 'local_missing' as const, phase: 'readback' as const, retryable: false } };
  return port.read(document);
}
/** Provider and storage deletion remain host-owned; canProceed never asserts either deletion. */
type LabelCleanupInput = Parameters<FulfillmentLabelPort['void']>[0] & { actorUserId: string; idempotencyKey: string };
export async function cleanupFulfillmentLabel(port: { void(input: LabelCleanupInput): ReturnType<FulfillmentLabelPort['void']> }, input: LabelCleanupInput) {
  return port.void(input);
}
