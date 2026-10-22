import { randomUUID } from 'node:crypto';
import type { FulfillmentOperatorMutationPort, FulfillmentOperatorMutationResult, FulfillmentReplacementPort, FulfillmentReplacementRequest, FulfillmentReplacementResult } from '../../src/fulfillment/contracts/index.js';
import { CommerceFulfillmentConflictError } from '../../src/fulfillment/index.js';
import type { FulfillmentReplacementRefusal } from '../../src/fulfillment/replacementRefusals.js';

export const orderId = '00000000-0000-4000-8000-000000000001';
export const actorUserId = '00000000-0000-4000-8000-000000000002';
export const parcelId = '00000000-0000-4000-8000-000000000003';
/** The host-owned seam's write path: tests invoke handlers, never seed result rows. */
export function lifecycleHost() {
  const parcels = [{ id: parcelId, order_id: orderId, sequence_no: 0, status: 'created', replaces: null as string | null }];
  const receipts = new Map<string, { fingerprint: string; response: FulfillmentOperatorMutationResult | FulfillmentReplacementResult }>();
  const operations: { actorUserId: string; type: string; parcelId: string }[] = [];
  const holds = new Set(['fulfillment_exception']);
  const reservations: string[] = [];
  let replacementRefusal: FulfillmentReplacementRefusal | null = null;
  let paid = true;
  function receipt<T extends FulfillmentOperatorMutationResult | FulfillmentReplacementResult>(input: { idempotencyKey: string; actorUserId: string }, type: string, write: () => T): T {
    const fingerprint = JSON.stringify({ type, ...input });
    const previous = receipts.get(input.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new CommerceFulfillmentConflictError('Host conflict', { reason: 'idempotency_conflict' });
      return { ...previous.response, replayed: true } as T;
    }
    const response = write();
    receipts.set(input.idempotencyKey, { fingerprint, response });
    return response;
  }
  const mutate = (type: string, status?: string) => async (input: { idempotencyKey: string; actorUserId: string; fulfillmentOrderId?: string; orderId?: string }) => receipt(input, type, () => {
    if (!paid) throw new CommerceFulfillmentConflictError('Host conflict', { reason: 'order_not_paid' });
    const parcel = parcels.find(row => row.id === (input.fulfillmentOrderId ?? parcelId));
    if (!parcel) throw new CommerceFulfillmentConflictError('Host conflict', { reason: 'not_found' });
    if (status) parcel.status = status;
    operations.push({ actorUserId: input.actorUserId, type, parcelId: parcel.id });
    return { contractVersion: 'commerce.fulfillment.v0' as const, fulfillmentOrderId: parcel.id, orderId, status: parcel.status as FulfillmentOperatorMutationResult['status'], replayed: false };
  });
  const mutations: FulfillmentOperatorMutationPort = {
    createCommerceFulfillmentOrder: mutate('created'),
    recordCommerceFulfillmentProviderAttempt: mutate('provider_attempt_recorded'),
    recordCommerceFulfillmentLabel: mutate('label_created', 'label_created'),
    handOffCommerceFulfillmentOrder: mutate('handed_over', 'handed_over'),
    recordCommerceFulfillmentTrackingEvent: async input => mutate('tracking_event_recorded', input.status)(input),
    cancelCommerceFulfillmentOrder: mutate('cancelled', 'cancelled'),
  };
  const replacement: FulfillmentReplacementPort = {
    async requestReplacementShipment(input: FulfillmentReplacementRequest) {
      return receipt(input, 'replacement_shipment_requested', () => {
        // Host refusal is before every write, including reservation/hold/receipt changes.
        if (replacementRefusal) throw new CommerceFulfillmentConflictError('Replacement refused', { reason: replacementRefusal });
        if (!paid) throw new CommerceFulfillmentConflictError('Replacement refused', { reason: 'payment_not_succeeded' });
        const current = [...parcels].sort((a,b) => b.sequence_no-a.sequence_no)[0];
        if (current.sequence_no > 0 && ['created','label_created'].includes(current.status)) throw new CommerceFulfillmentConflictError('Replacement refused', { reason: 'undispatched_replacement_exists' });
        if ([...holds].some(reason => reason !== 'fulfillment_exception')) throw new CommerceFulfillmentConflictError('Replacement refused', { reason: `blocked_by_${[...holds].find(reason => reason !== 'fulfillment_exception')}_hold` });
        const id = randomUUID();
        const operationId = randomUUID();
        const result: FulfillmentReplacementResult = { contractVersion: 'commerce.v0', operation: { id: operationId, orderId, type: 'replacement_shipment_requested', holdId: null, actorUserId: input.actorUserId, occurredAt: '2026-10-22T00:00:00Z', payload: {} }, replacement: { fulfillmentOrderId: id, orderId, sequenceNo: current.sequence_no+1, replacesFulfillmentOrderId: current.id, reason: input.reason, status: 'created' }, releasedHoldIds: holds.has('fulfillment_exception') ? [parcelId] : [], replayed: false };
        reservations.push(`${input.idempotencyKey}:item:1`);
        holds.delete('fulfillment_exception');
        parcels.push({ id, order_id: orderId, sequence_no: current.sequence_no+1, status: 'created', replaces: current.id });
        operations.push({ actorUserId: input.actorUserId, type: 'replacement_shipment_requested', parcelId: id });
        return result;
      });
    },
  };
  return { mutations, replacement, parcels, receipts, operations, holds, reservations, setPaid(value: boolean) { paid = value; }, refuse(value: FulfillmentReplacementRefusal | null) { replacementRefusal = value; } };
}

import type { HttpResponse } from '../../src/http/index.js';
export function responseFixture() {
  let output: unknown;
  const response = { setHeader() {}, status() { return this; }, json(value: unknown) { output = value; return this; } } as unknown as HttpResponse;
  return { response, output: () => output };
}
