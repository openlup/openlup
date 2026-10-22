import type { DeliveryAlignmentPort } from './contracts/index.js';
import type { PgExecutor } from './postgresDispatchStore.js';

/** Server-authorized projection; database browser roles have no direct access. */
export async function readDeliveryAlignment(db: PgExecutor, fulfillmentRef: string): ReturnType<DeliveryAlignmentPort['read']> {
  const result = await db.query(`SELECT alignment.state, alignment.aligned_next_cycle_at
    FROM public.fulfillment_shipments shipment
    LEFT JOIN public.subscription_delivery_alignment_cases alignment ON alignment.predecessor_order_id=shipment.order_id
    WHERE shipment.id=$1::uuid
    ORDER BY (alignment.state IN ('protected','manual_review')) DESC, alignment.created_at ASC LIMIT 1`, [fulfillmentRef]);
  const row = result.rows[0];
  const date = row?.aligned_next_cycle_at;
  return { disposition: row?.state === 'aligned' ? 'aligned' : row?.state === 'protected' ? 'outstanding' : 'manual_review',
    nextCycleAt: date instanceof Date ? date.toISOString() : typeof date === 'string' ? date : null };
}
