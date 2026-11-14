import type { FulfillmentCustomerAlignmentRowsReader } from '../contracts/customerAlignment.js';
import type { PgExecutor } from '../postgresDispatchStore.js';

/** Raw customer rows in update order; feed readFulfillmentDelay with the current schedules.
 * The host authorizes subscription IDs and owns the executor's lifetime. */
export function createPostgresCustomerAlignmentRowsReader(db: PgExecutor): FulfillmentCustomerAlignmentRowsReader {
  return async subscriptionIds => {
    if (!subscriptionIds.length) return [];
    const { rows } = await db.query(`SELECT subscription_id,state,aligned_next_cycle_at,updated_at
      FROM public.subscription_delivery_alignment_cases
      WHERE subscription_id=ANY($1::uuid[]) AND state IN ('protected','aligned')
      ORDER BY updated_at DESC`, [subscriptionIds]);
    return rows.map(row => ({ subscription_id: row.subscription_id, state: row.state,
      aligned_next_cycle_at: row.aligned_next_cycle_at instanceof Date ? row.aligned_next_cycle_at.toISOString() : row.aligned_next_cycle_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at }));
  };
}
