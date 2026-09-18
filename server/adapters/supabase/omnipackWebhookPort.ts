import type { AccountingInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import { parseOmnipackDispatchAcceptanceResult } from "../../domains/fulfillment/omnipackDispatchAcceptance.js";
import { findOmnipackDispatchRef } from "./omnipackDispatchRefLookup.js";
import {
  OmnipackFulfillmentStateConflict,
  type OmnipackWebhookDispatchRef,
  type OmnipackWebhookEvidence,
  type OmnipackWebhookInboundEvent,
  type OmnipackWebhookPort,
  type OmnipackWebhookStatusEvidence,
} from "../../domains/fulfillment/omnipackWebhookHandler.js";

export interface OmnipackWebhookPortOptions {
  // Injected accounting port (constructed in the BFF composition root) so the
  // webhook hand-over issues a fail-soft invoice request. The Omnipack provider
  // reaches handed_over HERE, not at dispatch time, so the auto-dispatch invoice
  // trigger never fires for it. The actual RPC call stays in the accounting
  // domain (route/RPC catalog scope), not in this fulfillment port.
  accountingPort?: AccountingInvoiceIssuePort;
  accountingProviderKind?: string;
}

// Terminal FSM rejections that mean the inbound event is superseded by a later
// state (an at-least-once redelivery / out-of-order event). These must NOT 5xx
// — the handler settles them as processed. "requires_label"/"before_handoff"
// are deliberately excluded: they are "not ready yet" and should retry.
const STATE_SUPERSEDED_MARKER = /tracking_after_delivered_forbidden/;

function asStateConflict(error: RpcError | null): OmnipackFulfillmentStateConflict | null {
  const message = error?.message ?? "";
  return STATE_SUPERSEDED_MARKER.test(message) ? new OmnipackFulfillmentStateConflict(message) : null;
}

export interface OmnipackWebhookSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  limit(count: number): SupabaseQueryBuilder;
  insert(values: Record<string, unknown>): SupabaseQueryBuilder;
  upsert(values: Record<string, unknown>, options?: Record<string, unknown>): SupabaseQueryBuilder;
  update(values: Record<string, unknown>): SupabaseQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult>;
}

interface SupabaseQueryResult {
  data: unknown;
  error: RpcError | null;
}

interface RpcError {
  code?: string;
  message?: string;
}

export function createSupabaseOmnipackWebhookPort(
  client: OmnipackWebhookSupabaseClient,
  options: OmnipackWebhookPortOptions = {},
): OmnipackWebhookPort {
  const port: OmnipackWebhookPort = {
    async ingestInboundEvent(input): Promise<OmnipackWebhookInboundEvent> {
      const existing = await client
        .from("inbound_provider_events")
        .select("id")
        .eq("provider", "omnipack")
        .eq("provider_event_id", input.providerEventId)
        .maybeSingle();
      if (existing.error) throw new Error(`omnipack_webhook_inbound_read_failed:${existing.error.code ?? "unknown"}`);
      if (existing.data) {
        return { inboundProviderEventId: text((existing.data as Record<string, unknown>).id), replayed: true };
      }

      const inserted = await client
        .from("inbound_provider_events")
        .insert({
          provider: "omnipack",
          provider_event_id: input.providerEventId,
          event_type: input.eventType,
          processing_status: input.processingStatus,
          payload: input.payload,
          error: input.error,
          signature_verified: true,
          received_via: "omnipack.webhook.v0",
        })
        .select("id")
        .maybeSingle();
      if (inserted.error) throw new Error(`omnipack_webhook_inbound_insert_failed:${inserted.error.code ?? "unknown"}`);
      return { inboundProviderEventId: text((inserted.data as Record<string, unknown> | null)?.id), replayed: false };
    },

    async findDispatchRef(evidence): Promise<OmnipackWebhookDispatchRef | null> {
      return findOmnipackDispatchRef(client, evidence, "webhook");
    },

    async acknowledgeDispatchAcceptance(input) {
      const { data, error } = await client.rpc("omnipack_acknowledge_dispatch_acceptance", {
        p_dispatch_ref_id: input.dispatchRefId,
        p_provider_order_id: input.providerOrderId,
        p_provider_attempt_idempotency_key: input.providerAttemptIdempotencyKey,
        p_label_idempotency_key: input.labelIdempotencyKey,
        p_sanitized_request: null,
        p_sanitized_response: input.sanitizedProviderProof,
        p_metadata: { source: "omnipack_webhook", evidenceKind: "webhook" },
      });
      if (error) throw new Error(`omnipack_webhook_dispatch_acknowledgement_failed:${error.code ?? "unknown"}`);
      return parseOmnipackDispatchAcceptanceResult(
        data,
        "omnipack_webhook_dispatch_acknowledgement_readback_invalid",
      );
    },

    async recordStatusEvidence(input): Promise<OmnipackWebhookStatusEvidence> {
      const { data, error } = await client.rpc("omnipack_record_status_evidence", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_dispatch_ref_id: input.dispatchRefId,
        p_provider_status: input.providerStatus,
        p_provider_sub_status: input.providerSubStatus,
        p_local_status: input.localStatus,
        p_evidence_kind: "webhook",
        p_occurred_at: input.occurredAt,
        p_inbound_provider_event_id: input.inboundProviderEventId,
        p_sanitized_payload: input.sanitizedPayload,
      });
      if (error) throw new Error(`omnipack_webhook_status_evidence_write_failed:${error.code ?? "unknown"}`);
      const row = data as Record<string, unknown>;
      return {
        statusEvidenceId: text(row.statusEvidenceId),
        replayed: row.replayed === true,
      };
    },

    async recordTrackingReference(input): Promise<{ replayed: boolean; readBack: boolean }> {
      const ref = await client
        .from("shipment_external_refs")
        .upsert({
          order_id: input.orderId,
          // The reference belongs to the parcel this event is about, not to the order: an
          // order with a replacement carries one per parcel and readers resolve by parcel.
          fulfillment_order_id: input.fulfillmentOrderId,
          provider_kind: "omnipack",
          provider_tracking_id: input.trackingNumber,
          tracking_url: input.trackingUrl,
          carrier_kind: input.carrierKind,
          service: input.service,
          active: true,
        }, { onConflict: "provider_kind,provider_tracking_id" })
        .select("order_id, provider_kind, provider_tracking_id, tracking_url, carrier_kind, service, active")
        .maybeSingle();
      if (ref.error) throw new Error(`omnipack_webhook_tracking_ref_write_failed:${ref.error.code ?? "unknown"}`);

      const readBack = await client
        .from("shipment_external_refs")
        .select("order_id, provider_kind, provider_tracking_id, tracking_url, carrier_kind, service, active")
        .eq("provider_kind", "omnipack")
        .eq("provider_tracking_id", input.trackingNumber)
        .maybeSingle();
      if (readBack.error) throw new Error(`omnipack_webhook_tracking_ref_readback_failed:${readBack.error.code ?? "unknown"}`);
      const row = readBack.data as Record<string, unknown> | null;

      const { data, error } = await client.rpc("commerce_fulfillment_record_tracking_event", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_status: input.status,
        p_provider_tracking_id: input.trackingNumber,
        p_raw_event: input.rawEvent,
        p_actor_user_id: null,
        p_metadata: { source: "omnipack_webhook" },
      });
      if (error) {
        const conflict = asStateConflict(error);
        if (conflict) throw conflict;
        throw new Error(`omnipack_webhook_tracking_event_write_failed:${error.code ?? "unknown"}`);
      }

      return {
        replayed: (data as Record<string, unknown> | null)?.replayed === true,
        readBack: row?.order_id === input.orderId && row.provider_tracking_id === input.trackingNumber && row.active === true,
      };
    },

    async markHandedOver(input): Promise<{ status: string; replayed: boolean }> {
      const { data, error } = await client.rpc("commerce_fulfillment_mark_handed_over", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_actor_user_id: null,
        p_metadata: {
          source: "omnipack_webhook",
          suppressShipmentDispatched: input.suppressDispatched,
        },
      });
      if (error) {
        const conflict = asStateConflict(error);
        if (conflict) throw conflict;
        throw new Error(`omnipack_webhook_handoff_write_failed:${error.code ?? "unknown"}`);
      }
      const row = (data ?? {}) as Record<string, unknown>;
      return { status: text(row.status), replayed: row.replayed === true };
    },

    async markProviderStockConsumed(input): Promise<{ status: string; replayed: boolean }> {
      const { data, error } = await client.rpc("commerce_fulfillment_mark_provider_stock_consumed", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_actor_user_id: null,
        p_metadata: { source: "omnipack_webhook", providerEvent: "finished_picking" },
      });
      if (error) throw new Error(`omnipack_webhook_provider_stock_consumed_write_failed:${error.code ?? "unknown"}`);
      const row = (data ?? {}) as Record<string, unknown>;
      return { status: text(row.status), replayed: row.replayed === true };
    },

    async markInboundEventProcessed(input): Promise<void> {
      const result = await client
        .from("inbound_provider_events")
        .update({
          processing_status: input.processingStatus,
          error: input.error,
          processed_at: new Date().toISOString(),
        })
        .eq("id", input.inboundProviderEventId)
        .select("id")
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_webhook_inbound_update_failed:${result.error.code ?? "unknown"}`);
    },
  };

  // Fail-soft accounting shadow-invoice request on the webhook-driven hand-over.
  // Idempotent (the issue RPC dedups on the order-derived invoice_ref) and never
  // fails the webhook. The RPC call itself lives in the accounting domain's port.
  const accountingPort = options.accountingPort;
  if (accountingPort) {
    port.issueAccountingInvoice = async (input): Promise<void> => {
      try {
        await accountingPort.requestInvoiceIssueFromFulfillmentHandoff({
          idempotencyKey: input.idempotencyKey,
          fulfillmentOrderId: input.fulfillmentOrderId,
          providerKind: options.accountingProviderKind ?? "fakturownia",
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "unknown";
        console.error(
          `[omnipack-webhook] accounting_invoice_issue_failed fulfillment=${input.fulfillmentOrderId} code=${code}`,
        );
      }
    };
  }

  return port;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
