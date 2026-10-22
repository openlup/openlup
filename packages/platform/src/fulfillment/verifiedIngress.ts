import type { FulfillmentObservation, FulfillmentObservationPort, FulfillmentRefusal } from "./contracts/index.js";
import { safeDiagnosticCode } from "./dispatchProjection.js";
import { applyFulfillmentObservationEffects } from "./fulfillmentObservationEffects.js";
import { observationStatusPolicy, projectObservation } from "./observationProjection.js";
import { uniqueTrackingReferences } from "./providerTrackingReferences.js";

type EffectInput = Parameters<typeof applyFulfillmentObservationEffects<FulfillmentObservation["fact"]["canonicalStatus"], "in_transit" | "delivered">>[0];
type DispatchRef = { orderRef: string; fulfillmentRef: string; dispatchRef: string; externalRef: string | null };
export interface FulfillmentIngressCounts { invalidTimestamps: number; rejectedCorrelationRefs: number; rejectedTrackingRefs: number; rejectedTrackingUrls: number }
export type FulfillmentIngressResult = { counts: FulfillmentIngressCounts } & (
  | { kind: "refused"; receiptId: null; refusal: FulfillmentRefusal; diagnostics?: { invalidTimestamp?: true; rejectedCorrelationRefs?: number } }
  | { kind: "processed" | "ignored" | "superseded"; receiptId: string; observation: FulfillmentObservation; replayed: boolean; trackingRefs: number; trackingReadBacks: number; supersededCause?: string });
/** Safe response classes only; the host owns HTTP and localized message text. */
export function fulfillmentIngressHttpResult(result: FulfillmentIngressResult): { status: 200 | 400 | 403 | 503; messageClass: "accepted" | "bad_request" | "forbidden" | "upstream_unavailable" } {
  if (result.kind !== "refused") return { status: 200, messageClass: "accepted" };
  if (result.refusal.reason === "untrusted") return { status: 403, messageClass: "forbidden" };
  if (result.refusal.reason === "disabled" || result.refusal.reason === "not_ready" || result.refusal.retryable)
    return { status: 503, messageClass: "upstream_unavailable" };
  return { status: 400, messageClass: "bad_request" };
}
/** Adapter verification owns auth-before-parse; the host owns durable replay. */
export async function verifyAndNormalizeFulfillmentObservation(input: {
  enabled: boolean;
  provider: FulfillmentObservationPort;
  verification: Parameters<FulfillmentObservationPort["verifyAndNormalize"]>[0];
  localPersistence: {
    /** G17: atomic insert by eventKey; retries keep the first stored firstReceivedAt. */
    recordObservation(observation: FulfillmentObservation): Promise<{ replayed: boolean; receiptId?: string }>;
    /** Idempotent; only called after completion or a classified superseding conflict. */
    markProcessed(eventKey: string, outcome: { status: "processed" | "ignored"; refusal?: FulfillmentRefusal; supersededCause?: string }): Promise<void>;
  };
  lifecycle: {
    findDispatchRef(observation: FulfillmentObservation): Promise<DispatchRef | null>;
    acknowledgeDispatchAcceptance(ref: DispatchRef, observation: FulfillmentObservation): Promise<void>;
    recordStatusEvidence(ref: DispatchRef, observation: FulfillmentObservation): Promise<{ replayed: boolean }>;
    effects: EffectInput["port"];
    keys: { stock(ref: string): string; handoff(ref: string): string; tracking(eventKey: string, number: string): string };
    issueAccountingInvoice?(ref: string): Promise<void>;
    /** Return a machine identity, never exception prose. */
    supersededCause?(error: unknown): string | null;
    classifyFailure(error: unknown): "stock_contention" | "state_conflict" | "other";
    annotateStockContention?(eventKey: string, fulfillmentRef: string): Promise<void>;
  };
}): Promise<FulfillmentIngressResult> {
  const counts: FulfillmentIngressCounts = { invalidTimestamps: 0, rejectedCorrelationRefs: 0, rejectedTrackingRefs: 0, rejectedTrackingUrls: 0 };
  if (!input.enabled) return { kind: "refused", receiptId: null, counts, refusal: { reason: "disabled", phase: "verify", retryable: false } };
  const verified = await input.provider.verifyAndNormalize(input.verification);
  if (verified.kind === "refused") {
    if (verified.diagnostics?.invalidTimestamp) counts.invalidTimestamps++;
    const rejected = verified.diagnostics?.rejectedCorrelationRefs;
    if (typeof rejected === "number" && Number.isSafeInteger(rejected) && rejected > 0) counts.rejectedCorrelationRefs = rejected;
    return { kind: "refused", receiptId: null, refusal: verified.refusal, counts,
      ...(counts.invalidTimestamps || counts.rejectedCorrelationRefs ? { diagnostics: {
        ...(counts.invalidTimestamps ? { invalidTimestamp: true as const } : {}),
        ...(counts.rejectedCorrelationRefs ? { rejectedCorrelationRefs: counts.rejectedCorrelationRefs } : {}),
      } } : {}) };
  }
  const observation = projectObservation(verified.observation);
  counts.rejectedTrackingRefs = observation.diagnostics?.admission?.rejectedTrackingRefs ?? 0;
  counts.rejectedTrackingUrls = observation.diagnostics?.admission?.rejectedTrackingUrls ?? 0;
  const inbound = await input.localPersistence.recordObservation(observation);
  const receiptId = inbound.receiptId ?? observation.eventKey;
  const ref = await input.lifecycle.findDispatchRef(observation);
  if (!ref) {
    await input.localPersistence.markProcessed(observation.eventKey, { status: "ignored", refusal: { reason: "local_missing", phase: "apply", retryable: false } });
    return { kind: "ignored", receiptId, counts, observation, replayed: inbound.replayed, trackingRefs: 0, trackingReadBacks: 0 };
  }
  const externalRef = observation.correlation.externalRef?.trim() || ref.externalRef?.trim();
  if (!externalRef) throw new TypeError("fulfillment_dispatch_acceptance_external_ref_missing");
  await input.lifecycle.acknowledgeDispatchAcceptance(ref, observation);
  const statusEvidence = await input.lifecycle.recordStatusEvidence(ref, observation);
  let trackingRefs = 0;
  let trackingReadBacks = 0;
  const effectPort: EffectInput["port"] = {
    ...input.lifecycle.effects,
    async markProviderStockConsumed(request) {
      try { return await input.lifecycle.effects.markProviderStockConsumed(request); }
      catch (error) {
        if (input.lifecycle.classifyFailure(error) === "stock_contention") {
          try {
            await input.lifecycle.annotateStockContention?.(observation.eventKey, ref.fulfillmentRef);
          } catch { /* Annotation is best-effort; preserve the original stock failure. */ }
        }
        throw error;
      }
    },
  };
  const localStatus = observation.fact.canonicalStatus;
  const effects: EffectInput = {
    port: effectPort, localStatus, ids: { orderId: ref.orderRef, fulfillmentOrderId: ref.fulfillmentRef }, observation,
    trackingRefs: uniqueTrackingReferences(observation.trackingRefs).map(tracking => ({ trackingNumber: tracking.trackingNumber, trackingUrl: tracking.publicUrl, carrierKind: tracking.carrierRef, service: tracking.serviceRef })),
    stockIdempotencyKey: input.lifecycle.keys.stock(ref.fulfillmentRef), handoffIdempotencyKey: input.lifecycle.keys.handoff(ref.fulfillmentRef),
    trackingIdempotencyKey: number => input.lifecycle.keys.tracking(observation.eventKey, number),
    issueAccountingInvoice: input.lifecycle.issueAccountingInvoice ? () => input.lifecycle.issueAccountingInvoice!(ref.fulfillmentRef) : undefined,
    onTrackingRecorded: result => { trackingRefs += result.replayed ? 0 : 1; trackingReadBacks += result.readBack ? 1 : 0; },
  };
  if (!observationStatusPolicy.handsOver(localStatus)) await applyFulfillmentObservationEffects({ ...effects, trackingRefs: [] }, observationStatusPolicy);
  else {
    try { await applyFulfillmentObservationEffects(effects, observationStatusPolicy); }
    catch (error) {
      if (input.lifecycle.classifyFailure(error) !== "state_conflict") throw error;
      const cause = input.lifecycle.supersededCause ? input.lifecycle.supersededCause(error)
        : error && typeof error === "object" && "reason" in error ? error.reason : null;
      const supersededCause = safeDiagnosticCode(cause) ?? "fulfillment_state_conflict";
      await input.localPersistence.markProcessed(observation.eventKey, { status: "processed", supersededCause });
      return { kind: "superseded", receiptId, counts, supersededCause, observation, replayed: inbound.replayed || statusEvidence.replayed, trackingRefs, trackingReadBacks };
    }
  }
  await input.localPersistence.markProcessed(observation.eventKey, { status: "processed" });
  return { kind: "processed", receiptId, counts, observation, replayed: inbound.replayed || statusEvidence.replayed, trackingRefs, trackingReadBacks };
}
