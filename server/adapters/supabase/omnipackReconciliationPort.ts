import type { AccountingInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import { resolveDeliverySelectionEvidence } from "../../../src/domains/shipping/contracts.js";
import { parseOmnipackDispatchAcceptanceResult } from "../../domains/fulfillment/omnipackDispatchAcceptance.js";
import type {
  OmnipackReconciliationDeliveryCarrier,
  OmnipackReconciliationDispatchRef,
  OmnipackReconciliationFulfilment,
  OmnipackReconciliationPort,
} from "../../domains/fulfillment/omnipackReconciliationWorker.js";
import { omnipackReconciliationWriteError } from "../../domains/fulfillment/omnipackReconciliationError.js";
import { findOmnipackDispatchRef } from "./omnipackDispatchRefLookup.js";

export interface OmnipackReconciliationSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface OmnipackReconciliationPortOptions {
  accountingPort?: AccountingInvoiceIssuePort;
  accountingProviderKind?: string;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  limit(count: number): SupabaseQueryBuilder;
  insert(values: Record<string, unknown>): SupabaseQueryBuilder;
  upsert(values: Record<string, unknown>, options?: Record<string, unknown>): SupabaseQueryBuilder;
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

export function createSupabaseOmnipackReconciliationPort(
  client: OmnipackReconciliationSupabaseClient,
  options: OmnipackReconciliationPortOptions = {},
): OmnipackReconciliationPort {
  const port: OmnipackReconciliationPort = {
    async findDispatchRef(fulfilment): Promise<OmnipackReconciliationDispatchRef | null> {
      return findOmnipackDispatchRef(client, fulfilment, "reconciliation");
    },

    async readLocalFulfillmentStatus(fulfillmentOrderId): Promise<string | null> {
      const result = await client
        .from("commerce_fulfillment_orders")
        .select("status")
        .eq("id", fulfillmentOrderId)
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_reconciliation_fulfillment_status_read_failed:${result.error.code ?? "unknown"}`);
      return nullableText((result.data as { status?: unknown } | null)?.status);
    },

    async readDeliveryCarrier(fulfillmentOrderId): Promise<OmnipackReconciliationDeliveryCarrier | null> {
      // Same source union + priority as the dispatch port (shared resolver), so
      // the carrier we persist on the tracking ref is the one dispatch shipped with.
      const result = await client
        .from("commerce_fulfillment_orders")
        .select("metadata, shipping_address_snapshot, commerce_orders!commerce_fulfillment_orders_order_id_fkey(metadata), addresses!commerce_fulfillment_orders_shipping_address_id_fkey(metadata)")
        .eq("id", fulfillmentOrderId)
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_reconciliation_delivery_carrier_read_failed:${result.error.code ?? "unknown"}`);
      const row = result.data as {
        metadata?: Record<string, unknown> | null;
        shipping_address_snapshot?: Record<string, unknown> | null;
        commerce_orders?: { metadata?: Record<string, unknown> | null } | null;
        addresses?: { metadata?: Record<string, unknown> | null } | null;
      } | null;
      if (!row) return null;
      const { selection } = resolveDeliverySelectionEvidence({
        fulfillmentMetadata: row.metadata,
        orderMetadata: row.commerce_orders?.metadata,
        shippingAddressSnapshot: row.shipping_address_snapshot,
        addressMetadata: row.addresses?.metadata,
      });
      if (!selection) return null;
      return {
        carrierKind: nullableText(selection.carrierKind),
        service: nullableText(selection.serviceCode) ?? nullableText(selection.service),
      };
    },

    async acknowledgeDispatchAcceptance(input) {
      const { data, error } = await client.rpc("omnipack_acknowledge_dispatch_acceptance", {
        p_dispatch_ref_id: input.dispatchRefId,
        p_provider_order_id: input.providerOrderId,
        p_provider_attempt_idempotency_key: input.providerAttemptIdempotencyKey,
        p_label_idempotency_key: input.labelIdempotencyKey,
        p_sanitized_request: null,
        p_sanitized_response: input.sanitizedProviderProof,
        p_metadata: { source: "omnipack_reconciliation", evidenceKind: "reconciliation" },
      });
      if (error) throw new Error(`omnipack_reconciliation_dispatch_acknowledgement_failed:${error.code ?? "unknown"}`);
      return parseOmnipackDispatchAcceptanceResult(
        data,
        "omnipack_reconciliation_dispatch_acknowledgement_readback_invalid",
      );
    },

    async latestStatusOccurredAt(fulfillmentOrderId): Promise<string | null> {
      const result = await client
        .from("omnipack_status_evidence")
        .select("occurred_at")
        .eq("fulfillment_order_id", fulfillmentOrderId)
        .order("occurred_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (result.error) throw new Error(`omnipack_reconciliation_status_read_failed:${result.error.code ?? "unknown"}`);
      const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
      return nullableText(rows[0]?.occurred_at);
    },

    async readHandedOverAt(fulfillmentOrderId): Promise<string | null> {
      const result = await client
        .from("commerce_fulfillment_orders")
        .select("handed_over_at")
        .eq("id", fulfillmentOrderId)
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_reconciliation_handoff_read_failed:${result.error.code ?? "unknown"}`);
      return nullableText((result.data as { handed_over_at?: unknown } | null)?.handed_over_at);
    },

    async recordStatusEvidence(input): Promise<{ replayed: boolean }> {
      const { data, error } = await client.rpc("omnipack_record_status_evidence", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_dispatch_ref_id: input.dispatchRefId,
        p_provider_status: input.providerStatus,
        p_provider_sub_status: input.providerSubStatus,
        p_local_status: input.localStatus,
        p_evidence_kind: "reconciliation",
        p_occurred_at: input.occurredAt,
        p_inbound_provider_event_id: null,
        p_sanitized_payload: input.sanitizedPayload,
      });
      if (error) throw new Error(`omnipack_reconciliation_status_write_failed:${error.code ?? "unknown"}`);
      return { replayed: (data as Record<string, unknown> | null)?.replayed === true };
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
      if (ref.error) throw new Error(`omnipack_reconciliation_tracking_ref_write_failed:${ref.error.code ?? "unknown"}`);

      const readBack = await client
        .from("shipment_external_refs")
        .select("order_id, provider_kind, provider_tracking_id, tracking_url, carrier_kind, service, active")
        .eq("provider_kind", "omnipack")
        .eq("provider_tracking_id", input.trackingNumber)
        .maybeSingle();
      if (readBack.error) throw new Error(`omnipack_reconciliation_tracking_ref_readback_failed:${readBack.error.code ?? "unknown"}`);
      const row = readBack.data as Record<string, unknown> | null;

      const { data, error } = await client.rpc("commerce_fulfillment_record_tracking_event", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_status: input.status,
        p_provider_tracking_id: input.trackingNumber,
        p_raw_event: input.rawEvent,
        p_actor_user_id: null,
        p_metadata: { source: "omnipack_reconciliation" },
      });
      if (error) throw new Error(`omnipack_reconciliation_tracking_event_write_failed:${error.code ?? "unknown"}`);
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
          source: "omnipack_reconciliation",
          suppressShipmentDispatched: input.suppressDispatched,
        },
      });
      if (error) throw new Error(`omnipack_reconciliation_handoff_write_failed:${error.code ?? "unknown"}`);
      const row = (data ?? {}) as Record<string, unknown>;
      return { status: nullableText(row.status) ?? "", replayed: row.replayed === true };
    },

    async markProviderStockConsumed(input): Promise<{ status: string; replayed: boolean }> {
      const { data, error } = await client.rpc("commerce_fulfillment_mark_provider_stock_consumed", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_actor_user_id: null,
        p_metadata: { source: "omnipack_reconciliation", providerEvent: "finished_picking" },
      });
      if (error) throw omnipackReconciliationWriteError("provider_stock_consumed", error);
      const row = (data ?? {}) as Record<string, unknown>;
      return { status: nullableText(row.status) ?? "", replayed: row.replayed === true };
    },

    async recordProviderException(input): Promise<{ replayed: boolean }> {
      const { data, error } = await client.rpc("commerce_fulfillment_record_provider_exception", {
        p_idempotency_key: input.idempotencyKey,
        p_order_id: input.orderId,
        p_reason: input.reason,
        p_metadata: {
          source: "omnipack_reconciliation",
          fulfillmentOrderId: input.fulfillmentOrderId,
          providerStatus: input.providerStatus,
          occurredAt: input.occurredAt,
        },
      });
      if (error) throw new Error(`omnipack_reconciliation_provider_exception_write_failed:${error.code ?? "unknown"}`);
      return { replayed: (data as Record<string, unknown> | null)?.replayed === true };
    },

    async recordQuarantine(input): Promise<{ replayed: boolean }> {
      const existing = await client
        .from("inbound_provider_events")
        .select("id")
        .eq("provider", "omnipack")
        .eq("provider_event_id", input.idempotencyKey)
        .maybeSingle();
      if (existing.error) throw new Error(`omnipack_reconciliation_quarantine_read_failed:${existing.error.code ?? "unknown"}`);
      if (existing.data) return { replayed: true };

      const inserted = await client
        .from("inbound_provider_events")
        .insert({
          provider: "omnipack",
          provider_event_id: input.idempotencyKey,
          event_type: "fulfilment.reconciliation",
          processing_status: "ignored",
          payload: { provider: "omnipack", fulfilment: input.fulfilment },
          error: { reason: input.reason },
          signature_verified: true,
          received_via: "omnipack.reconciliation.v0",
        })
        .select("id")
        .maybeSingle();
      if (inserted.error) throw new Error(`omnipack_reconciliation_quarantine_write_failed:${inserted.error.code ?? "unknown"}`);
      return { replayed: false };
    },
  };

  const accountingPort = options.accountingPort;
  if (accountingPort) {
    port.issueAccountingInvoice = async (input): Promise<void> => {
      await accountingPort.requestInvoiceIssueFromFulfillmentHandoff({
        idempotencyKey: input.idempotencyKey,
        fulfillmentOrderId: input.fulfillmentOrderId,
        providerKind: options.accountingProviderKind ?? "fakturownia",
      });
    };
  }

  return port;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
