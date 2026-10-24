import type { collectPaidFulfillmentRecoveryCandidates } from './paidFulfillmentRecovery.js';
import type { PgExecutor } from './postgresDispatchStore.js';
type RecoveryInput = Parameters<typeof collectPaidFulfillmentRecoveryCandidates>[0];

/** Read the selected native port's local obligations; never infer external absence. */
export function createPostgresPaidFulfillmentRecoveryOpsPort(db: PgExecutor, selection: { portKey: string; providerRef: string }) {
  return {
    async readRecoveryInputs(input: { minimumAgeSeconds: number; limit: number; now: Date; orderIds?: string[] }): Promise<Pick<RecoveryInput,'orders' | 'fulfillmentOrders' | 'dispatchRefs' | 'orderPaidOutboxEvents'>> {
      const ids=[...new Set(input.orderIds ?? [])];
      const orders=(await db.query(`SELECT id,status,metadata->>'mode' AS mode,created_at::text,updated_at::text FROM public.commerce_orders
        WHERE status=ANY($1::text[]) AND updated_at<=$2 AND ($4::uuid[]='{}'::uuid[] OR id=ANY($4::uuid[])) ORDER BY updated_at ASC LIMIT $3`,
      [['paid','fulfillment_pending'],new Date(input.now.getTime()-input.minimumAgeSeconds*1000),input.limit,ids])).rows as RecoveryInput['orders'];
      const orderIds=orders.map(row => row.id);
      if (!orderIds.length) return {orders:[],fulfillmentOrders:[],dispatchRefs:[],orderPaidOutboxEvents:[]};
      const [shipments,refs,events]=await Promise.all([
        db.query('SELECT id,order_id,$3::text AS provider_kind,status,created_at::text,updated_at::text FROM public.fulfillment_shipments WHERE order_id=ANY($1::uuid[]) AND port_key=$2 ORDER BY created_at DESC',[orderIds,selection.portKey,selection.providerRef]),
        db.query('SELECT ref.id,ref.shipment_id AS fulfillment_order_id,ref.external_ref AS provider_order_id,ref.status,ref.updated_at::text FROM public.fulfillment_dispatch_refs ref JOIN public.fulfillment_shipments shipment ON shipment.id=ref.shipment_id WHERE ref.order_id=ANY($1::uuid[]) AND shipment.port_key=$2',[orderIds,selection.portKey]),
        db.query("SELECT id,event_type,status,aggregate_id,created_at::text,available_at::text,attempts,metadata->>'updatedAt' AS updated_at FROM public.outbox_events WHERE event_type=$1 AND aggregate_id=ANY($2::uuid[]) ORDER BY created_at DESC",['commerce.order.paid',orderIds]),
      ]);
      return {orders,fulfillmentOrders:shipments.rows as RecoveryInput['fulfillmentOrders'],dispatchRefs:refs.rows as RecoveryInput['dispatchRefs'],orderPaidOutboxEvents:events.rows as RecoveryInput['orderPaidOutboxEvents']};
    },
    async requeueDiscardedOrderPaidOutboxEvents(input: { eventIds: string[]; limit?: number; requeuedBy: string; reason: string }) {
      const ids=[...new Set(input.eventIds.filter(Boolean))];
      if (!ids.length) return {requeuedCount:0,eventIds:[]};
      const result=await db.query('SELECT id FROM public.outbox_requeue_discarded(p_event_ids=>$1::uuid[],p_event_type=>$2,p_limit=>$3,p_requeued_by=>$4,p_reason=>$5)',[ids,'commerce.order.paid',input.limit ?? ids.length,input.requeuedBy,input.reason]);
      return {requeuedCount:result.rows.length,eventIds:result.rows.map(row => String(row.id))};
    },
  };
}
