import type { FulfillmentObservationPagePort, FulfillmentReconciliationObservation } from "../contracts/index.js";
import { operationError } from "../dispatchProjection.js";
import { projectPollEvidence, projectObservation } from "../observationProjection.js";
import { normalizeReconciliationTimestamp } from "../providerReconciliationTimestamp.js";
import type { OmnipackClient } from "./client.js";
import { OmnipackProviderError } from "./client.js";
import type { OmnipackFulfilmentEvidence } from "./mappers.js";
import { digest, observation, reference, refusal, timestamp } from "./observation.js";
import { localStatusFor, normalizeStatus } from "./omnipackStatusVocabulary.js";

type Config = {
  clock(): string; mintEvidenceReference(): `evidence:${string}`; approveTrackingUrl(url: string): boolean;
};
export function reconciliationObservation(row: OmnipackFulfilmentEvidence, config: Config, fulfillmentRef?: string): Extract<FulfillmentReconciliationObservation, { kind: "found" | "unmapped" }> {
  const providerStatus = { primary: row.status, subStatus: row.subStatus };
  // Original status and occurrence bytes remain part of identity, even for aliases
  // mapping to the same canonical event. Received time never changes that identity.
  const eventKey = digest(JSON.stringify([row.providerOrderId, row.fulfilmentNumber, row.orderNumber, row.status, row.subStatus, row.updatedAt]));
  const correlation = { orderRef: null, fulfillmentRef: fulfillmentRef ?? null, externalRef: reference(row.providerOrderId),
    orderNumber: reference(row.orderNumber), providerFulfillmentRef: reference(row.fulfilmentNumber), parcelRef: null };
  const normalized = normalizeStatus(row.status);
  if (!normalized) return { kind: "unmapped", externalRef: correlation.externalRef, evidence: projectPollEvidence({ eventKey, correlation: { ...correlation, externalRef: row.providerOrderId, orderNumber: row.orderNumber, providerFulfillmentRef: row.fulfilmentNumber }, providerStatus }) };
  const status = localStatusFor(normalized) as "provider_received" | "picking" | "packed" | "in_transit" | "delivered" | "exception";
  const event = ({ provider_received: "shipment.accepted", picking: "order.processing_started", packed: "order.picked", in_transit: "order.shipped", delivered: "order.delivered", exception: "parcel.exception" } as const)[status];
  const occurredAt = normalizeReconciliationTimestamp(row.updatedAt);
  const evidence = { provider: "omnipack" as const, event, providerOrderId: row.providerOrderId, orderNumber: row.orderNumber,
    fulfilmentNumber: row.fulfilmentNumber, occurredAt, trackingNumbers: row.trackingNumbers,
    trackingReferences: row.trackingReferences, shippingMethods: [] };
  const mapped = observation({ evidence, event, status, fulfillmentRef, receivedAt: config.clock(),
    rawDigest: digest(JSON.stringify({ ...evidence, providerStatus })), evidenceRef: config.mintEvidenceReference(), source: "provider_reconciliation", approveTrackingUrl: config.approveTrackingUrl });
  return { kind: "found", externalRef: row.providerOrderId ?? "", createdAt: timestamp(row.createdAt), updatedAt: timestamp(occurredAt),
    observation: projectObservation({ ...mapped, eventKey, fact: { ...mapped.fact, factId: eventKey }, providerStatus }, config.approveTrackingUrl) };
}

export function createReconciliationPagePort(client: OmnipackClient, config: Config, ready: () => ReturnType<typeof refusal> | null): FulfillmentObservationPagePort {
  return {
    async readPage(input) {
      const inactive = ready();
      if (inactive) return { kind: "failed", refusal: inactive };
      if (!Number.isSafeInteger(input.page) || input.page < 0 || !Number.isSafeInteger(input.size) || input.size <= 0)
        return { kind: "failed", refusal: refusal("malformed", "readback") };
      try {
        const rows = await client.getFulfilments(input);
        return { kind: "page", rows: rows.map(row => {
          try { return reconciliationObservation(row, config); }
          catch { return { kind: "unknown" as const, refusal: refusal("malformed", "normalize") }; }
        }) };
      } catch (error) {
        if (error instanceof OmnipackProviderError && error.status === 400 && error.code === "ERR_PAGE_MUST_BE_LESS_THAN_TOTAL_PAGES") return { kind: "page_exhausted" };
        return { kind: "failed", refusal: refusal("io_failure", "readback", error instanceof OmnipackProviderError && error.retryable),
          error: operationError(error instanceof OmnipackProviderError ? error : { code: "provider_read_failed", status: null, retryable: false, mayHaveSucceeded: false }) };
      }
    },
  };
}
