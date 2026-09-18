import { omnipackDispatchAcceptanceKeys } from "./omnipackDispatchAcceptance.js";
import { quarantineOmnipackReconciliationStateConflict } from "./omnipackReconciliationError.js";
import { requestAccountingInvoice } from "./omnipackReconciliationInvoice.js";
import {
  fulfilmentId,
  nonBlank,
  providerOccurrenceKey,
  safeReason,
  sanitizedFulfilment,
  uniqueTrackingReferences,
} from "./omnipackReconciliationPayload.js";
import { isOffTrackFulfillmentStatus } from "./omnipackReconciliationTerminalSkip.js";
import { normalizeOmnipackReconciliationTimestamp } from "./omnipackReconciliationTimestamp.js";
import {
  applyFulfillmentEffects,
  canonicalStatusToken,
  handsOverFor,
  localStatusFor,
  normalizeStatus,
  type FulfillmentEffectTrackingReference,
} from "./omnipackStatusVocabulary.js";
import { enrichOmnipackTrackingReference, omnipackTrackingReferenceComplete } from "./omnipackTrackingReferences.js";
import type {
  OmnipackReconciliationDeliveryCarrier,
  OmnipackReconciliationFulfilment,
  OmnipackReconciliationPort,
  OmnipackReconciliationProvider,
  OmnipackReconciliationResult,
} from "./omnipackReconciliationContracts.js";

export type {
  OmnipackReconciliationDeliveryCarrier,
  OmnipackReconciliationDispatchRef,
  OmnipackReconciliationFulfilment,
  OmnipackReconciliationPort,
  OmnipackReconciliationProvider,
  OmnipackReconciliationResult,
  OmnipackReconciliationTrackingReference,
} from "./omnipackReconciliationContracts.js";

export async function runOmnipackReconciliationWorker(input: {
  port: OmnipackReconciliationPort;
  provider: OmnipackReconciliationProvider;
  batchSize: number;
  page?: number;
}): Promise<OmnipackReconciliationResult> {
  const result: OmnipackReconciliationResult = {
    ok: true,
    checked: 0,
    updated: 0,
    trackingRefs: 0,
    quarantined: 0,
    stateConflicts: 0,
    exceptions: 0,
    stale: 0,
    offTrackSkips: 0,
    replayed: 0,
    failures: 0,
    invoiceIssueFailures: 0,
    invoiceIssueRefused: 0,
    invoiceIssueRefusals: [],
    providerCalls: 0,
    readBacks: 0,
    skipped: false,
  };

  const fulfilments = await input.provider.getFulfilments({ page: input.page ?? 0, size: input.batchSize });
  result.providerCalls += 1;
  result.checked = fulfilments.length;

  for (const fulfilment of fulfilments) {
    try {
      const dispatchRef = await input.port.findDispatchRef(fulfilment);
      if (!dispatchRef) {
        const quarantine = await input.port.recordQuarantine({
          idempotencyKey: `omnipack-reconciliation:${fulfilmentId(fulfilment)}:quarantine`,
          fulfilment,
          reason: "omnipack_dispatch_ref_not_found",
        });
        if (quarantine.replayed) result.replayed += 1;
        result.quarantined += quarantine.replayed ? 0 : 1;
        continue;
      }

      // A cancelled/exception fulfillment has no forward transition, and the
      // acceptance ack below raises 22023 for it — which red-lined this job for
      // ~1.3 days after one cancelled order. Benign "nothing to converge": skip
      // WITHOUT quarantining (a quarantine writes inbound_provider_events and
      // would only trade one p1 for another). See
      // omnipackReconciliationTerminalSkip.ts.
      //
      // This is a FLAG rather than a `continue` because status evidence is the
      // one thing an off-track fulfilment must still produce: the
      // provider-exception hold healer is an AFTER INSERT trigger on the
      // status-evidence table (20260719100000_provider_exception_hold_auto_heal.sql),
      // so skipping the whole iteration made the healer unreachable from the
      // pull path for exactly the orders it exists for — a hold survived both
      // its delivery and its recovery proof. Only the EVIDENCE write is
      // reachable below; the ack, the exception hold, stock, handover, tracking
      // and invoicing all stay behind this flag. The evidence RPC carries no
      // fulfillment-status allowlist (pgTAP case 11 in
      // provider_exception_hold_auto_heal_test.sql); the ack RPC does, and that
      // guard is untouched.
      const offTrack = isOffTrackFulfillmentStatus(
        await input.port.readLocalFulfillmentStatus(dispatchRef.fulfillmentOrderId),
      );
      if (offTrack) result.offTrackSkips += 1;

      const sanitizedPayload = sanitizedFulfilment(fulfilment);
      if (!offTrack) {
        const providerOrderId = nonBlank(fulfilment.providerOrderId) ?? nonBlank(dispatchRef.providerOrderId);
        if (!providerOrderId) {
          const quarantine = await input.port.recordQuarantine({
            idempotencyKey: `omnipack-reconciliation:${fulfilmentId(fulfilment)}:missing-provider-order-id`,
            fulfilment,
            reason: "omnipack_dispatch_acceptance_provider_order_id_missing",
          });
          if (quarantine.replayed) result.replayed += 1;
          result.quarantined += quarantine.replayed ? 0 : 1;
          continue;
        }
        await input.port.acknowledgeDispatchAcceptance({
          dispatchRefId: dispatchRef.dispatchRefId,
          providerOrderId,
          ...omnipackDispatchAcceptanceKeys(dispatchRef.fulfillmentOrderId),
          sanitizedProviderProof: sanitizedPayload,
        });
      }

      const providerStatus = normalizeStatus(fulfilment.status);
      if (!providerStatus) {
        // An off-track fulfilment never quarantines — that is the p1-for-p1
        // trade the terminal skip exists to avoid, and an unmapped status gives
        // us no local status to write evidence with either.
        if (offTrack) continue;
        // Unknown primary status must be visible, not skipped: staging ran for
        // weeks with zero status evidence because the guessed vocabulary never
        // matched the real API strings (config/omnipack-status-dictionary.json).
        const quarantine = await input.port.recordQuarantine({
          idempotencyKey: `omnipack-reconciliation:${fulfilmentId(fulfilment)}:unknown-status:${canonicalStatusToken(fulfilment.status) ?? "missing"}`,
          fulfilment,
          reason: "omnipack_unknown_provider_status",
        });
        if (quarantine.replayed) result.replayed += 1;
        result.quarantined += quarantine.replayed ? 0 : 1;
        continue;
      }

      const occurredAt = normalizeOmnipackReconciliationTimestamp(fulfilment.updatedAt);
      const localStatus = localStatusFor(providerStatus);
      const latest = await input.port.latestStatusOccurredAt(dispatchRef.fulfillmentOrderId);
      if (latest && occurredAt && Date.parse(occurredAt) < Date.parse(latest)) {
        result.stale += 1;
        if (
          !offTrack
          && input.port.issueAccountingInvoice
          && await input.port.readHandedOverAt(dispatchRef.fulfillmentOrderId)
        ) {
          await requestAccountingInvoice(input.port, dispatchRef.fulfillmentOrderId, result);
        }
        continue;
      }

      const occurrenceKey = providerOccurrenceKey(
        dispatchRef.fulfillmentOrderId,
        providerStatus,
        occurredAt,
      );
      const status = await input.port.recordStatusEvidence({
        idempotencyKey: `omnipack-reconciliation:${occurrenceKey}`,
        fulfillmentOrderId: dispatchRef.fulfillmentOrderId,
        dispatchRefId: dispatchRef.dispatchRefId,
        providerStatus,
        providerSubStatus: fulfilment.subStatus,
        localStatus,
        occurredAt,
        sanitizedPayload,
      });
      if (status.replayed) result.replayed += 1;
      // Evidence, and nothing else, for an off-track fulfilment. `updated`
      // stays a count of CONVERGED fulfilments so the job's headline number
      // keeps its meaning; the off-track rows are already counted in
      // `offTrackSkips`.
      if (offTrack) continue;
      result.updated += status.replayed ? 0 : 1;

      // Provider rejection/cancellation -> place a fulfillment_exception hold
      // for ops review. The DB emits the existing reassurance event only before
      // durable handoff, so a late provider signal cannot contradict dispatch.
      if (localStatus === "exception") {
        const exception = await input.port.recordProviderException({
          idempotencyKey: `omnipack-reconciliation:${occurrenceKey}:exception`,
          orderId: dispatchRef.orderId,
          fulfillmentOrderId: dispatchRef.fulfillmentOrderId,
          reason: fulfilment.status ?? "provider_rejected",
          providerStatus,
          occurredAt,
        });
        if (exception.replayed) result.replayed += 1;
        result.exceptions += exception.replayed ? 0 : 1;
        if (
          input.port.issueAccountingInvoice
          && await input.port.readHandedOverAt(dispatchRef.fulfillmentOrderId)
        ) {
          await requestAccountingInvoice(input.port, dispatchRef.fulfillmentOrderId, result);
        }
        continue;
      }

      await applyFulfillmentEffects({
        port: input.port,
        localStatus,
        ids: { orderId: dispatchRef.orderId, fulfillmentOrderId: dispatchRef.fulfillmentOrderId },
        payload: sanitizedPayload,
        trackingRefs: handsOverFor(localStatus)
          ? await enrichedTrackingReferences(() => input.port.readDeliveryCarrier(dispatchRef.fulfillmentOrderId), fulfilment)
          : [],
        stockIdempotencyKey: `omnipack-reconciliation:${dispatchRef.fulfillmentOrderId}:provider-stock-consumed`,
        handoffIdempotencyKey: `omnipack-reconciliation:${dispatchRef.fulfillmentOrderId}:handoff`,
        trackingIdempotencyKey: (trackingNumber) =>
          `omnipack-reconciliation:${fulfilmentId(fulfilment)}:${providerStatus}:tracking:${trackingNumber}`,
        issueAccountingInvoice: input.port.issueAccountingInvoice
          ? () => requestAccountingInvoice(input.port, dispatchRef.fulfillmentOrderId, result)
          : undefined,
        onReplayed: () => { result.replayed += 1; },
        onTrackingRecorded: (tracking) => {
          if (tracking.replayed) result.replayed += 1;
          if (tracking.readBack) result.readBacks += 1;
          result.trackingRefs += tracking.replayed ? 0 : 1;
        },
      });
    } catch (caught) {
      const error = await quarantineOmnipackReconciliationStateConflict(
        caught, fulfilmentId(fulfilment), fulfilment, input.port.recordQuarantine, result,
      );
      if (error === null) continue;
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? safeReason(error);
    }
  }

  return result;
}

// The carrier read stays lazy and at most once per fulfilment: only an
// incomplete reference needs it, and the local shipment row is the same for
// every reference on the parcel.
async function enrichedTrackingReferences(
  readDeliveryCarrier: () => Promise<OmnipackReconciliationDeliveryCarrier | null>,
  fulfilment: OmnipackReconciliationFulfilment,
) {
  let deliveryCarrier: OmnipackReconciliationDeliveryCarrier | null | undefined;
  const enriched: FulfillmentEffectTrackingReference[] = [];
  for (const trackingRef of uniqueTrackingReferences(fulfilment)) {
    if (!omnipackTrackingReferenceComplete(trackingRef) && deliveryCarrier === undefined) {
      deliveryCarrier = await readDeliveryCarrier();
    }
    enriched.push({ ...enrichOmnipackTrackingReference(trackingRef, deliveryCarrier ?? null), trackingNumber: trackingRef.trackingNumber });
  }
  return enriched;
}
