import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { omnipackHandoffAccountingInvoiceIdempotencyKey } from "./omnipackAccountingInvoice.js";
import { omnipackDispatchAcceptanceKeys } from "./omnipackDispatchAcceptance.js";
import {
  OmnipackFulfillmentStateConflict,
  type ParsedOmnipackWebhookPayload,
  type OmnipackWebhookHandlerDeps,
} from "./omnipackWebhookContracts.js";
import { applyFulfillmentEffects, handsOverFor, localStatusFor } from "./omnipackStatusVocabulary.js";
import {
  EVENT_TO_STATUS,
  buildProviderEventId,
  buildStoredPayload,
  uniqueTrackingReferences,
  verifyOmnipackWebhookToken,
} from "./omnipackWebhookPayload.js";

// Re-exported for existing call sites/tests (helpers now live in payload module).
export { buildProviderEventId, verifyOmnipackWebhookToken } from "./omnipackWebhookPayload.js";
export { OmnipackFulfillmentStateConflict } from "./omnipackWebhookContracts.js";
export type {
  OmnipackWebhookDispatchRef,
  OmnipackWebhookEvidence,
  OmnipackWebhookHandlerDeps,
  OmnipackWebhookInboundEvent,
  OmnipackWebhookPort,
  OmnipackWebhookRouteEvent,
  OmnipackWebhookStatusEvidence,
  ParsedOmnipackWebhookPayload,
} from "./omnipackWebhookContracts.js";

export function createOmnipackWebhookHandler({
  expectedEvent,
  enabled,
  verifyToken,
  port,
  parsePayload,
}: OmnipackWebhookHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }
    if (!enabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "OmniPack webhook is disabled", {
        details: { feature: "omnipack-webhook", provider: "omnipack", reason: "feature_flag_disabled" },
      });
      return;
    }
    if (!verifyToken(req)) {
      sendBffError(res, "FORBIDDEN", "OmniPack webhook token rejected", {
        details: { provider: "omnipack", reason: "token_rejected" },
      });
      return;
    }

    let parsed: ParsedOmnipackWebhookPayload;
    try {
      parsed = await parsePayload(req);
    } catch {
      sendBffError(res, "BAD_REQUEST", "Invalid OmniPack webhook payload", {
        details: { provider: "omnipack", reason: "payload_invalid" },
      });
      return;
    }

    const { evidence, sanitizedPayload } = parsed;
    if (evidence.event !== expectedEvent) {
      sendBffError(res, "BAD_REQUEST", "OmniPack webhook route mismatch", {
        details: { provider: "omnipack", reason: "route_mismatch" },
      });
      return;
    }

    const providerEventId = buildProviderEventId(evidence);
    const storedPayload = buildStoredPayload(evidence, sanitizedPayload);
    const inbound = await port.ingestInboundEvent({
      providerEventId,
      eventType: expectedEvent,
      processingStatus: "received",
      payload: storedPayload,
      error: {},
    });

    const dispatchRef = await port.findDispatchRef(evidence);
    if (!dispatchRef) {
      await port.markInboundEventProcessed({
        inboundProviderEventId: inbound.inboundProviderEventId,
        processingStatus: "ignored",
        error: { reason: "omnipack_dispatch_ref_not_found" },
      });
      sendBffSuccess(res, {
        provider: "omnipack",
        status: "ignored_unknown_order",
        inboundProviderEventId: inbound.inboundProviderEventId,
        replayed: inbound.replayed,
      });
      return;
    }

    if (!port.acknowledgeDispatchAcceptance) {
      throw new Error("omnipack_webhook_dispatch_acknowledgement_port_missing");
    }
    const providerOrderId = evidence.providerOrderId?.trim() || dispatchRef.providerOrderId?.trim();
    if (!providerOrderId) {
      throw new Error("omnipack_webhook_dispatch_acceptance_provider_order_id_missing");
    }
    await port.acknowledgeDispatchAcceptance({
      dispatchRefId: dispatchRef.dispatchRefId,
      providerOrderId,
      ...omnipackDispatchAcceptanceKeys(dispatchRef.fulfillmentOrderId),
      sanitizedProviderProof: storedPayload,
    });

    const providerStatus = EVENT_TO_STATUS[expectedEvent];
    const localStatus = localStatusFor(providerStatus);
    const statusEvidence = await port.recordStatusEvidence({
      idempotencyKey: `omnipack:webhook:${providerEventId}:status`,
      fulfillmentOrderId: dispatchRef.fulfillmentOrderId,
      dispatchRefId: dispatchRef.dispatchRefId,
      providerStatus,
      providerSubStatus: expectedEvent,
      localStatus,
      occurredAt: evidence.occurredAt,
      inboundProviderEventId: inbound.inboundProviderEventId,
      sanitizedPayload: storedPayload,
    });
    let trackingRefs = 0;
    let trackingReadBacks = 0;
    const effects = (status: string, refs: readonly { trackingNumber: string; trackingUrl?: string | null; carrierKind?: string | null; service?: string | null }[]) => ({
      port,
      localStatus: status,
      ids: { orderId: dispatchRef.orderId, fulfillmentOrderId: dispatchRef.fulfillmentOrderId },
      payload: storedPayload,
      trackingRefs: refs,
      stockIdempotencyKey: `omnipack:webhook:${dispatchRef.fulfillmentOrderId}:provider-stock-consumed`,
      handoffIdempotencyKey: `omnipack:webhook:${dispatchRef.fulfillmentOrderId}:handoff`,
      trackingIdempotencyKey: (trackingNumber: string) => `omnipack:webhook:${providerEventId}:tracking:${trackingNumber}`,
      issueAccountingInvoice: port.issueAccountingInvoice
        ? () => port.issueAccountingInvoice!({
          idempotencyKey: omnipackHandoffAccountingInvoiceIdempotencyKey(dispatchRef.fulfillmentOrderId),
          fulfillmentOrderId: dispatchRef.fulfillmentOrderId,
        })
        : undefined,
      onTrackingRecorded: (tracking: { replayed: boolean; readBack: boolean }) => {
        trackingRefs += tracking.replayed ? 0 : 1;
        trackingReadBacks += tracking.readBack ? 1 : 0;
      },
    });
    // Stock consumption stays outside the conflict boundary below, exactly as
    // before: only the handover-and-after writes can be superseded by a later
    // terminal event.
    if (!handsOverFor(localStatus)) {
      await applyFulfillmentEffects(effects(localStatus, []));
    } else {
      try {
        // The shared writer advances the canonical order to handed_over FIRST.
        // A delivered-first signal suppresses the late
        // commerce.shipment.dispatched notification.
        await applyFulfillmentEffects(effects(localStatus, uniqueTrackingReferences(evidence)));
      } catch (error) {
        if (error instanceof OmnipackFulfillmentStateConflict) {
          // Out-of-order / superseded terminal event. The status evidence above
          // is already persisted; settle as processed so OmniPack stops retrying
          // (at-least-once delivery makes ordering inversions normal).
          await port.markInboundEventProcessed({
            inboundProviderEventId: inbound.inboundProviderEventId,
            processingStatus: "processed",
            error: { superseded: error.reason },
          });
          sendBffSuccess(res, {
            provider: "omnipack",
            status: "superseded",
            inboundProviderEventId: inbound.inboundProviderEventId,
            statusEvidenceId: statusEvidence.statusEvidenceId,
            reason: error.reason,
            replayed: inbound.replayed || statusEvidence.replayed,
          });
          return;
        }
        throw error;
      }
    }
    await port.markInboundEventProcessed({
      inboundProviderEventId: inbound.inboundProviderEventId,
      processingStatus: "processed",
      error: {},
    });

    sendBffSuccess(res, {
      provider: "omnipack",
      status: "processed",
      inboundProviderEventId: inbound.inboundProviderEventId,
      statusEvidenceId: statusEvidence.statusEvidenceId,
      trackingRefs,
      trackingReadBacks,
      replayed: inbound.replayed || statusEvidence.replayed,
    });
  };
}
