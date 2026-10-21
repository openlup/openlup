import type { FulfillmentObservation, FulfillmentReadbackResult } from "./contracts/index.js";
import { applyFulfillmentObservationEffects } from "./fulfillmentObservationEffects.js";
import { observationStatusPolicy, projectCorrelation, projectObservation } from "./observationProjection.js";
import { quarantineReconciliationStateConflict } from "./providerReconciliationError.js";
import { isOffTrackFulfillmentStatus } from "./providerReconciliationTerminalSkip.js";
import { normalizeReconciliationTimestamp } from "./providerReconciliationTimestamp.js";
import { enrichTrackingReference, trackingReferenceComplete, uniqueTrackingReferences } from "./providerTrackingReferences.js";

type Ingress = Parameters<typeof import("./verifiedIngress.js").verifyAndNormalizeFulfillmentObservation>[0];
type DispatchRef = NonNullable<Awaited<ReturnType<Ingress["lifecycle"]["findDispatchRef"]>>>;
type PollEvidence = FulfillmentObservation | { correlation: FulfillmentObservation["correlation"]; eventKey: string };
interface ReconciliationResult {
  ok: boolean; checked: number; updated: number; trackingRefs: number; quarantined: number;
  stateConflicts: number; exceptions: number; stale: number; offTrackSkips: number; replayed: number;
  failures: number; invoiceIssueFailures: number; invoiceIssueRefused: number;
  invoiceIssueRefusals: { fulfillmentRef: string; identifier: string | null; sqlstate: string; benign: boolean }[];
  providerCalls: number; readBacks: number; skipped: boolean; reason?: string;
}

export async function reconcileFulfillmentObservations(input: {
  /** Adapter/host maps the private page into typed readback, preserving unknowns. */
  readPage(input: { page: number; size: number }): Promise<readonly (FulfillmentReadbackResult | { kind: "unmapped"; evidence: { correlation: FulfillmentObservation["correlation"]; eventKey: string }; externalRef: string | null })[]>;
  batchSize: number; page?: number;
  localPersistence: {
    /** G17: local persisted chronology, never inferred from dispatch or provider state. */
    readLocalFulfillmentState(ref: string): Promise<{ status: string | null; latestStatusOccurredAt: string | null; handedOverAt: string | null }>;
  };
  lifecycle: Pick<Ingress["lifecycle"], "recordStatusEvidence" | "effects" | "keys"> & {
    findDispatchRef(evidence: PollEvidence): Promise<DispatchRef | null>;
    acknowledgeDispatchAcceptance(ref: DispatchRef, evidence: PollEvidence): Promise<void>;
    recordQuarantine(observation: PollEvidence | null, reason: "missing_correlation" | "missing_external_ref" | "unknown_status" | "state_conflict", detail?: "fulfillment_not_found" | "stock_consumed_requires_label"): Promise<{ replayed: boolean }>;
    recordProviderException(ref: DispatchRef, observation: FulfillmentObservation): Promise<{ replayed: boolean }>;
    readDeliveryCarrier(ref: string): Promise<{ carrierRef: string | null; serviceRef: string | null } | null>;
    trackingCodecs: Parameters<typeof enrichTrackingReference>[2];
    issueAccountingInvoice?(ref: string): Promise<void>;
    /** Private RPC decoding retains permanent/benign distinction and safe refusal identity. */
    invoiceFailure(error: unknown): { permanent: boolean; identifier: string | null; sqlstate: string | null; benign: boolean };
    classifyStateConflict(error: unknown): "fulfillment_not_found" | "stock_consumed_requires_label" | null;
  };
}): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    ok: true, checked: 0, updated: 0, trackingRefs: 0, quarantined: 0, stateConflicts: 0, exceptions: 0,
    stale: 0, offTrackSkips: 0, replayed: 0, failures: 0, invoiceIssueFailures: 0, invoiceIssueRefused: 0,
    invoiceIssueRefusals: [], providerCalls: 0, readBacks: 0, skipped: false,
  };
  const page = await input.readPage({ page: input.page ?? 0, size: input.batchSize });
  result.providerCalls += 1;
  // A failed provider read cannot become a successful unknown-status quarantine.
  if (page.some(readback => readback.kind === "unknown")) throw new Error("fulfillment_reconciliation_provider_read_failed");
  result.checked = page.length;
  const quarantine = async (observation: PollEvidence | null, reason: Parameters<typeof input.lifecycle.recordQuarantine>[1]) => {
    const evidence = await input.lifecycle.recordQuarantine(observation, reason);
    if (evidence.replayed) result.replayed += 1;
    result.quarantined += evidence.replayed ? 0 : 1;
  };
  const invoice = async (ref: string) => {
    try { await input.lifecycle.issueAccountingInvoice?.(ref); }
    catch (error) {
      const refusal = input.lifecycle.invoiceFailure(error);
      if (refusal.permanent) {
        result.invoiceIssueRefused += 1;
        if (result.invoiceIssueRefusals.length < 10) result.invoiceIssueRefusals.push({ fulfillmentRef: ref,
          identifier: refusal.identifier, sqlstate: refusal.sqlstate ?? "22023", benign: refusal.benign });
        result.reason ??= "reconciliation_invoice_issue_refused";
        return;
      }
      result.ok = false; result.failures += 1; result.invoiceIssueFailures += 1;
      result.reason ??= "reconciliation_invoice_issue_failed";
    }
  };
  for (const readback of page) {
    let observation: FulfillmentObservation | null = null;
    try {
      if (readback.kind === "unmapped") {
        // An unknown primary status still correlates/ACKs, but an off-track row
        // must never trade a benign skip for a quarantine alarm.
        const evidence = { eventKey: readback.evidence.eventKey, correlation: projectCorrelation(readback.evidence.correlation) };
        const ref = await input.lifecycle.findDispatchRef(evidence);
        if (!ref) { await quarantine(evidence, "missing_correlation"); continue; }
        const state = await input.localPersistence.readLocalFulfillmentState(ref.fulfillmentRef);
        if (isOffTrackFulfillmentStatus(state.status)) { result.offTrackSkips += 1; continue; }
        if (!(readback.externalRef?.trim() || ref.externalRef?.trim())) { await quarantine(evidence, "missing_external_ref"); continue; }
        await input.lifecycle.acknowledgeDispatchAcceptance(ref, evidence);
        await quarantine(evidence, "unknown_status");
        continue;
      }
      if (readback.kind !== "found") {
        // Neither unsupported nor a provider absence is a local transition.
        continue;
      }
      observation = projectObservation(readback.observation);
      const ref = await input.lifecycle.findDispatchRef(observation);
      if (!ref) { await quarantine(observation, "missing_correlation"); continue; }
      const state = await input.localPersistence.readLocalFulfillmentState(ref.fulfillmentRef);
      const offTrack = isOffTrackFulfillmentStatus(state.status);
      if (offTrack) result.offTrackSkips += 1;
      if (!offTrack) {
        if (!(readback.externalRef.trim() || ref.externalRef?.trim())) { await quarantine(observation, "missing_external_ref"); continue; }
        await input.lifecycle.acknowledgeDispatchAcceptance(ref, observation);
      }
      const occurredAt = normalizeReconciliationTimestamp(readback.updatedAt);
      const localStatus = observation.fact.canonicalStatus;
      if (state.latestStatusOccurredAt && occurredAt && Date.parse(occurredAt) < Date.parse(state.latestStatusOccurredAt)) {
        result.stale += 1;
        if (!offTrack && input.lifecycle.issueAccountingInvoice && state.handedOverAt) await invoice(ref.fulfillmentRef);
        continue;
      }
      // The normalized fact carries the same nullable occurrence used by dedupe.
      observation = { ...observation, fact: { ...observation.fact, occurredAt } };
      const status = await input.lifecycle.recordStatusEvidence(ref, observation);
      if (status.replayed) result.replayed += 1;
      if (offTrack) continue;
      result.updated += status.replayed ? 0 : 1;
      if (localStatus === "exception") {
        const exception = await input.lifecycle.recordProviderException(ref, observation);
        if (exception.replayed) result.replayed += 1;
        result.exceptions += exception.replayed ? 0 : 1;
        if (input.lifecycle.issueAccountingInvoice && state.handedOverAt) await invoice(ref.fulfillmentRef);
        continue;
      }
      const trackingRefs = [];
      if (observationStatusPolicy.handsOver(localStatus)) {
        let carrier: Awaited<ReturnType<typeof input.lifecycle.readDeliveryCarrier>> | undefined;
        for (const tracking of uniqueTrackingReferences(observation.trackingRefs)) {
          if (!trackingReferenceComplete(tracking) && carrier === undefined) carrier = await input.lifecycle.readDeliveryCarrier(ref.fulfillmentRef);
          const enriched = enrichTrackingReference(tracking, carrier ?? null, input.lifecycle.trackingCodecs);
          trackingRefs.push({ trackingNumber: enriched.trackingNumber, trackingUrl: enriched.publicUrl, carrierKind: enriched.carrierRef, service: enriched.serviceRef });
        }
      }
      await applyFulfillmentObservationEffects({
        port: input.lifecycle.effects, localStatus, ids: { orderId: ref.orderRef, fulfillmentOrderId: ref.fulfillmentRef }, observation,
        trackingRefs, stockIdempotencyKey: input.lifecycle.keys.stock(ref.fulfillmentRef), handoffIdempotencyKey: input.lifecycle.keys.handoff(ref.fulfillmentRef),
        trackingIdempotencyKey: number => input.lifecycle.keys.tracking(observation!.eventKey, number),
        issueAccountingInvoice: input.lifecycle.issueAccountingInvoice ? () => invoice(ref.fulfillmentRef) : undefined,
        onReplayed: () => { result.replayed += 1; },
        onTrackingRecorded: tracking => {
          if (tracking.replayed) result.replayed += 1;
          if (tracking.readBack) result.readBacks += 1;
          result.trackingRefs += tracking.replayed ? 0 : 1;
        },
      }, observationStatusPolicy);
    } catch (caught) {
      const error = observation ? await quarantineReconciliationStateConflict(caught, observation,
        input.lifecycle.classifyStateConflict, input.lifecycle.recordQuarantine, result) : caught;
      if (error === null) continue;
      result.ok = false; result.failures += 1; result.reason ??= "reconciliation_local_operation_failed";
    }
  }
  return result;
}
