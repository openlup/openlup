import type { FulfillmentObservation, FulfillmentObservationPort, FulfillmentRefusal } from "./contracts/index.js";
import { applyFulfillmentObservationEffects } from "./fulfillmentObservationEffects.js";
import { observationStatusPolicy, projectObservation } from "./observationProjection.js";
import { uniqueTrackingReferences } from "./providerTrackingReferences.js";

type EffectInput = Parameters<typeof applyFulfillmentObservationEffects<FulfillmentObservation["fact"]["canonicalStatus"], "in_transit" | "delivered">>[0];
type DispatchRef = { orderRef: string; fulfillmentRef: string; dispatchRef: string; externalRef: string | null };
/** Adapter verification owns auth-before-parse; the host owns durable replay. */
export async function verifyAndNormalizeFulfillmentObservation(input: {
  enabled: boolean;
  provider: FulfillmentObservationPort;
  verification: Parameters<FulfillmentObservationPort["verifyAndNormalize"]>[0];
  localPersistence: {
    /** G17: atomic insert by eventKey; retries keep the first stored firstReceivedAt. */
    recordObservation(observation: FulfillmentObservation): Promise<{ replayed: boolean }>;
    /** Idempotent; only called after completion or a classified superseding conflict. */
    markProcessed(eventKey: string, outcome: { status: "processed" | "ignored"; refusal?: FulfillmentRefusal }): Promise<void>;
  };
  lifecycle: {
    findDispatchRef(observation: FulfillmentObservation): Promise<DispatchRef | null>;
    acknowledgeDispatchAcceptance(ref: DispatchRef, observation: FulfillmentObservation): Promise<void>;
    recordStatusEvidence(ref: DispatchRef, observation: FulfillmentObservation): Promise<{ replayed: boolean }>;
    effects: EffectInput["port"];
    keys: { stock(ref: string): string; handoff(ref: string): string; tracking(eventKey: string, number: string): string };
    issueAccountingInvoice?(ref: string): Promise<void>;
    classifyFailure(error: unknown): "stock_contention" | "state_conflict" | "other";
    annotateStockContention?(eventKey: string, fulfillmentRef: string): Promise<void>;
  };
}): Promise<{ kind: "refused"; refusal: FulfillmentRefusal } | { kind: "processed" | "ignored" | "superseded"; observation: FulfillmentObservation; replayed: boolean; trackingRefs: number; trackingReadBacks: number }> {
  if (!input.enabled) return { kind: "refused", refusal: { reason: "disabled", phase: "verify", retryable: false } };
  const verified = await input.provider.verifyAndNormalize(input.verification);
  if (verified.kind === "refused") return verified;
  const observation = projectObservation(verified.observation);
  const inbound = await input.localPersistence.recordObservation(observation);
  const ref = await input.lifecycle.findDispatchRef(observation);
  if (!ref) {
    await input.localPersistence.markProcessed(observation.eventKey, { status: "ignored", refusal: { reason: "local_missing", phase: "apply", retryable: false } });
    return { kind: "ignored", observation, replayed: inbound.replayed, trackingRefs: 0, trackingReadBacks: 0 };
  }
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
          observation.diagnostics = { ...observation.diagnostics, stockContention: { sqlState: "55P03", phase: "provider_stock_consumed", retryable: true } };
          try {
            await input.lifecycle.annotateStockContention?.(observation.eventKey, ref.fulfillmentRef);
            observation.diagnostics.annotation = "recorded";
          } catch { observation.diagnostics.annotation = "failed"; }
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
      await input.localPersistence.markProcessed(observation.eventKey, { status: "processed" });
      return { kind: "superseded", observation, replayed: inbound.replayed || statusEvidence.replayed, trackingRefs, trackingReadBacks };
    }
  }
  await input.localPersistence.markProcessed(observation.eventKey, { status: "processed" });
  return { kind: "processed", observation, replayed: inbound.replayed || statusEvidence.replayed, trackingRefs, trackingReadBacks };
}
