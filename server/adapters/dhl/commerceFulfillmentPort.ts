import { randomUUID } from "node:crypto";
import {
  type OrderPaidFulfillmentPort,
  type OrderPaidFulfillmentResult,
} from "../../domains/commerce/outboxOrderPaidFulfillmentPorts.js";
import {
  preflightSplitShipmentGuard,
  type OrderPaidFulfillmentSupabaseClient,
} from "../supabase/orderPaidFulfillmentPort.js";
import {
  DhlProviderFault,
  createDhlShipmentWithLabel,
  nextWarsawBusinessDate,
  sanitizeProviderText,
  type DhlAuthConfig,
  type DhlParty,
} from "../../infra/dhl/commerceShipmentSoap.js";
import {
  createSupabaseBlobStorage,
  type SupabaseStorageClient,
} from "../supabase/blobStorage.js";
import {
  receiverFromRow,
  sanitizeFulfillmentContactError,
  sanitizedRequestPayload,
  type CommerceDeliveryContactRow,
} from "./createShipmentAdapter.js";

export const DHL_ORDER_PAID_PROVIDER_KIND = "dhl";
const KEY_PREFIX = "order-paid-dhl-dispatch";
const HANDED_OVER = new Set(["handed_over", "in_transit", "delivered"]);
const LABELLED = new Set(["label_created", ...HANDED_OVER]);

export type DhlCommerceEnv = Record<string, string | undefined> & {
  DHL_API_USERNAME?: string;
  DHL_API_PASSWORD?: string;
  DHL_ACCOUNT_NUMBER?: string;
};

interface DhlCommerceClient extends OrderPaidFulfillmentSupabaseClient, SupabaseStorageClient {
  from(table: string): SupabaseQueryBuilder;
}

interface SupabaseQueryBuilder extends PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> {
  select(columns: string): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  like(column: string, value: string): SupabaseQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

type FulfillmentRow = CommerceDeliveryContactRow;

export function createDhlOrderPaidFulfillmentPort(
  client: DhlCommerceClient,
  env: DhlCommerceEnv,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): OrderPaidFulfillmentPort {
  return {
    async ensureFulfilledFromPaidOrder({ orderUuid, signal }): Promise<OrderPaidFulfillmentResult> {
      const auth = readDhlAuth(env);
      if (!auth) return { kind: "fatal", reason: "dhl_env_required" };
      const key = (suffix: string) => `${KEY_PREFIX}:${orderUuid}:${suffix}`;
      if (signal.aborted) return retryAbort();

      // Split-shipment preflight before create: a multi-location paid order is
      // routed to manual review (fulfillment_exception hold) rather than left as
      // an orphan label_created row + discarded event. See the simulator port.
      const guard = await preflightSplitShipmentGuard(client, {
        orderUuid,
        keyPrefix: KEY_PREFIX,
        metadataSource: KEY_PREFIX,
      });
      if ("kind" in guard) return guard;
      if (signal.aborted) return retryAbort();

      const created = await client.rpc("commerce_fulfillment_create_order", {
        p_idempotency_key: key("create"),
        p_order_id: orderUuid,
        p_actor_user_id: null,
        p_metadata: { source: KEY_PREFIX, providerKind: DHL_ORDER_PAID_PROVIDER_KIND },
      });
      if (created.error) return rpcResult(created.error);
      const fulfillmentOrderId = text((created.data as { fulfillmentOrderId?: unknown })?.fulfillmentOrderId);
      if (!fulfillmentOrderId) return { kind: "fatal", reason: "fulfillment_create_missing_id" };
      let status = text((created.data as { status?: unknown })?.status) || "created";
      if (HANDED_OVER.has(status)) return { kind: "completed", detail: { fulfillmentOrderId, status } };

      const existingTracking = await readExistingDhlTracking(client, orderUuid);
      if (!existingTracking && !LABELLED.has(status)) {
        const row = await readFulfillmentRow(client, fulfillmentOrderId);
        if (!row) return { kind: "fatal", reason: "fulfillment_row_missing" };
        const shipmentDate = nextWarsawBusinessDate(deps.now?.() ?? new Date());
        const requestPayload = sanitizedRequestPayload(
          row,
          shipmentDate,
          KEY_PREFIX,
          DHL_ORDER_PAID_PROVIDER_KIND,
        );
        try {
          const shipper = await readShipper(client);
          const receiver = receiverFromRow(row);
          const shipment = await createDhlShipmentWithLabel({
            auth,
            shipper,
            receiver,
            shipmentDate,
            fetchImpl: deps.fetchImpl,
          });
          const labelUrl = shipment.labelPdf
            ? await uploadLabel(client, shipment.labelPdf)
            : null;
          const attempt = await recordAttempt(client, key("attempt"), fulfillmentOrderId, "succeeded", requestPayload, {
            trackingNumber: shipment.trackingNumber,
            dispatchId: shipment.dispatchId,
            labelUploaded: Boolean(labelUrl),
          }, null);
          if (attempt.kind !== "completed") return attempt;
          const label = await recordLabel(client, key("label"), fulfillmentOrderId, shipment.trackingNumber, labelUrl, {
            dispatchId: shipment.dispatchId,
            shipmentDate: shipment.shipmentDate,
          });
          if (label.kind !== "completed") return label;
          status = text(label.detail?.status) || "label_created";
        } catch (error) {
          const retryable = error instanceof DhlProviderFault ? error.retryable : true;
          const reason = sanitizeFulfillmentContactError(error, row);
          await recordAttempt(client, key("attempt"), fulfillmentOrderId, "failed", requestPayload, {}, reason);
          return retryable ? { kind: "retryable", reason } : { kind: "fatal", reason };
        }
      } else if (existingTracking && !LABELLED.has(status)) {
        const label = await recordLabel(client, key("label"), fulfillmentOrderId, existingTracking, null, { replayedExistingRef: true });
        if (label.kind !== "completed") return label;
        status = text(label.detail?.status) || "label_created";
      }

      if (signal.aborted) return retryAbort();
      const handoff = await client.rpc("commerce_fulfillment_mark_handed_over", {
        p_idempotency_key: key("handoff"),
        p_fulfillment_order_id: fulfillmentOrderId,
        p_actor_user_id: null,
        p_metadata: { source: KEY_PREFIX, providerKind: DHL_ORDER_PAID_PROVIDER_KIND },
      });
      if (handoff.error) return rpcResult(handoff.error);
      status = text((handoff.data as { status?: unknown })?.status) || status;
      return HANDED_OVER.has(status)
        ? { kind: "completed", detail: { fulfillmentOrderId, status } }
        : { kind: "fatal", reason: `fulfillment_handoff_unexpected_status:${status}` };
    },
  };
}

function readDhlAuth(env: DhlCommerceEnv): DhlAuthConfig | null {
  return env.DHL_API_USERNAME && env.DHL_API_PASSWORD && env.DHL_ACCOUNT_NUMBER
    ? { username: env.DHL_API_USERNAME, password: env.DHL_API_PASSWORD, accountNumber: env.DHL_ACCOUNT_NUMBER }
    : null;
}

async function readFulfillmentRow(client: DhlCommerceClient, id: string): Promise<FulfillmentRow | null> {
  const result = await client.from("commerce_fulfillment_orders").select("id, order_id, status, shipping_address_snapshot, commerce_orders!commerce_fulfillment_orders_order_id_fkey(order_number), clients!commerce_fulfillment_orders_client_id_fkey(email, first_name, last_name, phone)").eq("id", id).maybeSingle();
  if (result.error) throw new Error(`fulfillment_read_failed:${result.error.code ?? "unknown"}`);
  return result.data as FulfillmentRow | null;
}

async function readExistingDhlTracking(client: DhlCommerceClient, orderId: string): Promise<string | null> {
  const result = await client.from("shipment_external_refs").select("provider_tracking_id")
    .eq("order_id", orderId).eq("provider_kind", DHL_ORDER_PAID_PROVIDER_KIND).eq("active", true).maybeSingle();
  if (result.error) throw new Error(`dhl_tracking_ref_read_failed:${result.error.code ?? "unknown"}`);
  return text((result.data as { provider_tracking_id?: unknown } | null)?.provider_tracking_id) || null;
}

async function readShipper(client: DhlCommerceClient): Promise<DhlParty> {
  const result = await client.from("settings").select("key, value").like("key", "dhl_shipper_%");
  if (result.error) throw new Error(`dhl_shipper_settings_read_failed:${result.error.code ?? "unknown"}`);
  const settings: Record<string, string> = {};
  for (const row of Array.isArray(result.data) ? result.data as Array<{ key?: string; value?: unknown }> : []) {
    if (!row.key) continue;
    try {
      settings[row.key] = typeof row.value === "string" ? JSON.parse(row.value) : String(row.value ?? "");
    } catch {
      settings[row.key] = String(row.value ?? "");
    }
  }
  return {
    name: settings.dhl_shipper_name || "Example Company Sp. z o.o.",
    street: settings.dhl_shipper_street || "Example Street",
    houseNumber: settings.dhl_shipper_house_number || "11",
    postalCode: settings.dhl_shipper_postal_code || "32091",
    city: settings.dhl_shipper_city || "ExampleCity",
    phone: settings.dhl_shipper_phone || "",
    email: settings.dhl_shipper_email || "hello@openlup.com",
    contactPerson: settings.dhl_shipper_contact_person || settings.dhl_shipper_name || "Example Company Sp. z o.o.",
  };
}

async function uploadLabel(client: DhlCommerceClient, bytes: Uint8Array): Promise<string | null> {
  // The dhl-labels bucket is PRIVATE and labels carry recipient PII. Use an unguessable
  // object key (never the parcel-printed tracking number) and persist the bucket-relative
  // KEY rather than a public URL — retrieval mints a short-lived signed URL on demand.
  const objectKey = `dhl/${randomUUID()}.pdf`;
  const blob = createSupabaseBlobStorage(client, "dhl-labels", { defaultContentType: "application/pdf" });
  try {
    const result = await blob.upload(objectKey, bytes, { contentType: "application/pdf" });
    return result.pathname;
  } catch {
    return null;
  }
}

async function recordAttempt(
  client: DhlCommerceClient,
  idempotencyKey: string,
  fulfillmentOrderId: string,
  status: "succeeded" | "failed",
  requestPayload: Record<string, unknown>,
  responsePayload: Record<string, unknown>,
  error: string | null,
): Promise<OrderPaidFulfillmentResult> {
  const result = await client.rpc("commerce_fulfillment_record_provider_attempt", {
    p_idempotency_key: idempotencyKey,
    p_fulfillment_order_id: fulfillmentOrderId,
    p_provider_kind: DHL_ORDER_PAID_PROVIDER_KIND,
    p_status: status,
    p_request_payload: requestPayload,
    p_response_payload: responsePayload,
    p_error: error,
    p_actor_user_id: null,
    p_metadata: { source: KEY_PREFIX },
  });
  return result.error ? rpcResult(result.error) : { kind: "completed", detail: {} };
}

async function recordLabel(
  client: DhlCommerceClient,
  idempotencyKey: string,
  fulfillmentOrderId: string,
  trackingNumber: string,
  labelUrl: string | null,
  payload: Record<string, unknown>,
): Promise<OrderPaidFulfillmentResult> {
  const result = await client.rpc("commerce_fulfillment_record_label_created", {
    p_idempotency_key: idempotencyKey,
    p_fulfillment_order_id: fulfillmentOrderId,
    p_provider_kind: DHL_ORDER_PAID_PROVIDER_KIND,
    p_provider_tracking_id: trackingNumber,
    p_label_url: labelUrl,
    p_delivery_estimate_days: 2,
    p_raw_provider_payload: payload,
    p_actor_user_id: null,
    p_metadata: { source: KEY_PREFIX },
  });
  return result.error ? rpcResult(result.error) : { kind: "completed", detail: result.data as Record<string, unknown> };
}

function rpcResult(error: { code?: string; message?: string }): OrderPaidFulfillmentResult {
  const reason = sanitizeProviderText(error.message ?? error.code ?? "fulfillment_rpc_failed");
  const fatal = ["22023", "23505", "23503", "23514", "22P02"].includes(error.code ?? "");
  return fatal ? { kind: "fatal", reason } : { kind: "retryable", reason };
}

function retryAbort(): OrderPaidFulfillmentResult {
  return { kind: "retryable", reason: "outbox_handler_timeout" };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
