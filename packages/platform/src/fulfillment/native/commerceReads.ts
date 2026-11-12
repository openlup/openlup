import type { FulfillmentCommerceReadPort, FulfillmentCommerceReadPolicy, FulfillmentOrdersListRequest } from '../contracts/read.js';
import { buildCommerceFulfillmentOrderDetailResponse, type CommerceFulfillmentOrderRow, type CommerceFulfillmentOperationRow, type CommerceFulfillmentOrderContextRow, type CommerceFulfillmentPaymentIntentRow, type CommerceFulfillmentInventoryReservationRow } from '../commerceFulfillmentReadModel.js';
import type { z } from 'zod';
import { createCommerceFulfillmentResponseSchemas, commerceFulfillmentShippingAddressSnapshotSchema, COMMERCE_FULFILLMENT_CONTRACT_VERSION } from '../handlerSchemas.js';

export const nativeFulfillmentCommerceResponseSchemas = createCommerceFulfillmentResponseSchemas(
  commerceFulfillmentShippingAddressSnapshotSchema.extend({ addressId: commerceFulfillmentShippingAddressSnapshotSchema.shape.addressId.nullable() }),
);
export type NativeFulfillmentCommerceOrder = z.infer<typeof nativeFulfillmentCommerceResponseSchemas.order>;
export type NativeFulfillmentCommerceReadPort = FulfillmentCommerceReadPort<NativeFulfillmentCommerceOrder>;

type Row = Record<string, unknown>;
type Executor = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };
type DestinationReader = { read(scope: 'shipment', id: string): Promise<{ destinationId: string; clientId: string; address: { label: string | null; line1: string; line2: string | null; city: string; postalCode: string; country: string } }> };
const record = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const operationStatuses: Record<string, CommerceFulfillmentOperationRow['operation_type']> = { packed: 'packed', label_created: 'label_created', handed_over: 'handed_over', in_transit: 'tracking_event_recorded', delivered: 'tracking_event_recorded', exception: 'tracking_event_recorded' };
const limit = (name: string): never => { throw new Error(`native_fulfillment_${name}`); };

function canonicalUuidKey(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const body = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  if (/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.exec(body)?.[0] !== body) return value;
  const hex = body.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Native shipment commerce projection. Supply the existing eligibility policy and
 * optionally override the nonmutating shipment destination view reader.
 * The host owns authorization, connection lifetime and snapshot transaction. */
export function createPostgresFulfillmentCommerceReadPort(input: {
  executor: Executor; destinations?: DestinationReader; policy: FulfillmentCommerceReadPolicy;
  orderMode(input: { orderId: string; subscriptionCycleId: string | null; capturedMode: string | null }): Parameters<FulfillmentCommerceReadPolicy['evaluateCommerceFulfillmentEligibility']>[0]['orderMode'];
}): NativeFulfillmentCommerceReadPort {
  const rows = async (sql: string, values: unknown[]) => (await input.executor.query(sql, values)).rows;
  const destinations: DestinationReader = input.destinations ?? { async read(_scope, id) {
    const [result] = await rows('SELECT public.commerce_view_shipment_destination($1::uuid) AS value', [id]);
    const value = result.value as Awaited<ReturnType<DestinationReader['read']>>;
    return { destinationId: value.destinationId, clientId: value.clientId, address: value.address };
  } };
  async function project(shipment: Row) {
    const [facts] = await rows(`SELECT to_jsonb(o) AS order_context,
      (SELECT to_jsonb(i) FROM public.commerce_settlement_intents i WHERE i.order_id=o.id) AS payment,
      (SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE c.id=o.subscription_cycle_id) AS cycle,
      (SELECT count(*) FROM public.commerce_order_holds h WHERE h.order_id=o.id AND h.status='active') AS holds,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at ASC) FROM public.commerce_order_items i WHERE i.order_id=o.id) AS lines,
      (SELECT to_jsonb(op) FROM public.fulfillment_shipment_operations op WHERE shipment_id=$2::uuid
        ORDER BY occurred_at DESC LIMIT 1) AS operation,
      (SELECT jsonb_build_object('externalId',r.external_id,'providerKind',r.provider_kind)
        FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
        WHERE s.order_id=o.id AND (r.shipment_id=$2::uuid OR r.provider_kind IS NULL) AND r.ref_role='tracking'
        ORDER BY r.recorded_at DESC,r.id DESC LIMIT 1) AS tracking,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC)
        FROM public.fulfillment_inventory_reservations r WHERE r.purchase_order_id=o.id
          OR (r.renewal_operation_id=o.renewal_operation_id AND r.operation_fingerprint=o.renewal_operation_fingerprint)) AS reservations
      FROM public.commerce_orders o WHERE o.id=$1::uuid`, [shipment.order_id, shipment.id]);
    if (!facts) return limit('order_unavailable');
    const order = record(facts.order_context), payment = record(facts.payment), tracking = record(facts.tracking);
    if (!payment.id) return limit('payment_intent_unavailable');
    let destination: Awaited<ReturnType<DestinationReader['read']>>;
    try { destination = await destinations.read('shipment', String(shipment.id)); }
    catch (error) {
      if (error instanceof Error && error.message === 'commerce_destination_unavailable') return limit('destination_unavailable');
      if (error instanceof Error && error.message === 'commerce_destination_owner_mismatch') return limit('destination_owner_mismatch');
      throw error;
    }
    if (canonicalUuidKey(destination.clientId) !== canonicalUuidKey(order.client_id)) return limit('destination_owner_mismatch');
    const reservations: CommerceFulfillmentInventoryReservationRow[] = array(facts.reservations).map(row => ({
      id: String(row.id), order_id: String(order.id), status: row.status === 'held' || row.status === 'committed' ? 'reserved' : row.status as 'consumed' | 'released' | 'expired',
      expires_at: row.expires_at ? String(row.expires_at) : null, location_id: null,
    }));
    const metadata = record(order.metadata), draft = record(metadata.orderDraftSnapshot);
    const snapshots = array(draft.lines);
    const lines = array(facts.lines).map(row => {
      const snapshot = snapshots[Number(row.source_line_ordinal ?? row.line_ordinal) - 1];
      if (!row.sku_id || !snapshot || typeof snapshot.sku !== 'string' || !snapshot.sku.trim()) return limit('line_snapshot_unavailable');
      return { id: null, fulfillment_order_id: String(shipment.id), order_item_id: String(row.id),
        sku_id: String(row.sku_id), sku: snapshot.sku, title: typeof snapshot.title === 'string' ? snapshot.title : null,
        quantity: Number(row.quantity), product_snapshot: snapshot,
        inventory_reservation_ids: [] };
    });
    if (!lines.length) return limit('line_snapshot_unavailable');
    const op = record(facts.operation), payload = record(op.payload);
    let latestOperation: CommerceFulfillmentOperationRow | null = null;
    if (op.id) {
      if (!op.payload || typeof op.payload !== 'object' || Array.isArray(op.payload)) return limit('operation_unrepresentable');
      const type = op.operation_type === 'shipment_created' ? 'created'
        : op.operation_type === 'shipment_cancelled' ? 'cancelled'
        : op.operation_type === 'shipment_advanced' ? operationStatuses[String(payload.toStatus)]
        : op.operation_type === 'evidence_recorded' ? payload.refRole === 'label' ? 'label_created' : payload.refRole === 'tracking' ? 'tracking_event_recorded' : null : null;
      if (!type) return limit('operation_unrepresentable');
      latestOperation = { id: String(op.id), fulfillment_order_id: String(shipment.id), operation_type: type,
        occurred_at: String(op.occurred_at), actor_user_id: typeof op.actor_user_id === 'string' ? op.actor_user_id : null, payload };
    }
    return buildCommerceFulfillmentOrderDetailResponse({
      fulfillmentOrder: { id: String(shipment.id), order_id: String(order.id), client_id: null,
        status: shipment.status as CommerceFulfillmentOrderRow['status'], provider_kind: typeof tracking.providerKind === 'string' ? tracking.providerKind : null,
        shipping_address_snapshot: { addressId: null, clientId: destination.clientId, ...destination.address },
        created_at: String(shipment.created_at), updated_at: String(shipment.updated_at) },
      responseSchemas: nativeFulfillmentCommerceResponseSchemas, hasShippingAddress: Boolean(destination),
      lines, latestOperation,
      orderContext: { id: String(order.id), status: order.status, mode: input.orderMode({ orderId: String(order.id), subscriptionCycleId: order.subscription_cycle_id as string | null,
          capturedMode: (record(draft.context).mode ?? null) as string | null }),
        shipping_address_id: null, subscription_cycle_id: order.subscription_cycle_id } as CommerceFulfillmentOrderContextRow,
      paymentIntent: { id: String(payment.id), order_id: String(order.id), status: payment.status === 'settled' ? 'succeeded' : payment.status,
        provider_payment_id: payment.external_ref } as CommerceFulfillmentPaymentIntentRow,
      inventoryReservations: reservations,
      shipmentRef: tracking.externalId ? { order_id: String(order.id), provider_tracking_id: String(tracking.externalId), active: true } : null,
      activeHoldCount: Number(facts.holds), subscriptionCycleStatus: (record(facts.cycle).status ?? null) as Parameters<typeof buildCommerceFulfillmentOrderDetailResponse>[0]['subscriptionCycleStatus'],
    }, input.policy);
  }
  return {
    async listCommerceFulfillmentOrders(request: FulfillmentOrdersListRequest) {
      const { page, pageSize, status } = request;
      const [result] = await rows(`WITH selected AS (SELECT * FROM public.fulfillment_shipments WHERE ($1::text IS NULL OR status=$1))
        SELECT (SELECT count(*) FROM selected) AS total,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.updated_at DESC) FROM
          (SELECT * FROM selected ORDER BY updated_at DESC LIMIT $2 OFFSET $3) s) AS shipments`, [status ?? null, pageSize, (page - 1) * pageSize]);
      const orders = [];
      for (const shipment of array(result.shipments)) orders.push((await project(shipment)).order);
      return { contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION, orders, totalCount: Number(result.total), page, pageSize };
    },
    async getCommerceFulfillmentOrderDetail(request) {
      const { fulfillmentOrderId, orderId } = request;
      const [selected] = await rows(`SELECT to_jsonb(s) AS shipment FROM public.fulfillment_shipments s WHERE
        (($1::uuid IS NOT NULL AND id=$1) OR ($1::uuid IS NULL AND order_id=$2::uuid))
        ORDER BY sequence_no DESC,id DESC LIMIT 1`, [fulfillmentOrderId ?? null, fulfillmentOrderId ? null : orderId ?? null]);
      return selected ? project(record(selected.shipment)) : null;
    },
  };
}
