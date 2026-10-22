import type { PgQueryExecutor } from '../../adapters/postgres/queryBuilder.js';
import { parseDeliveryAlignmentAdmissionResponse } from '../../domains/subscription/callSubscriptionDeliveryAlignmentAdmission.js';
import type { AutomaticRenewalStorePort } from '../../domains/subscription/automaticRenewalPorts.js';

/** Host decorator for the native runner's existing new-cycle admission hook. */
export function withDeliveryAlignmentRenewalAdmission(
  store: AutomaticRenewalStorePort,
  db: PgQueryExecutor,
  now: () => string = () => new Date().toISOString(),
): AutomaticRenewalStorePort {
  return {
    ...store,
    async admitDeliveryAlignment(input) {
      const staticAdmission = await store.admitDeliveryAlignment(input);
      if (!staticAdmission.allowed) return staticAdmission;
      const { rows } = await db.query(`SELECT
        EXISTS (SELECT 1 FROM public.subscription_cycles
          WHERE subscription_id=$1::uuid AND scheduled_at=$2::timestamptz) AS existing_cycle,
        COALESCE(public.subscription_delivery_alignment_get_mode(), 'off') AS mode,
        EXISTS (SELECT 1 FROM public.subscription_delivery_alignment_cases
          WHERE subscription_id=$1::uuid AND state IN ('shadow','protected','manual_review')) AS captured_case`,
      [input.subscriptionId, input.scheduledAt]);
      const context = rows[0];
      if (!context || typeof context.existing_cycle !== 'boolean'
        || typeof context.captured_case !== 'boolean'
        || !['off', 'shadow', 'protect', 'auto_align'].includes(String(context.mode))) {
        throw new Error('subscription_delivery_alignment_context_invalid');
      }
      // Prepared attempts bypass this hook in the runner. Existing cycles and
      // their dunning retries need neither a new admission nor a new receipt.
      if (context.existing_cycle || (context.mode === 'off' && !context.captured_case)) {
        return staticAdmission;
      }
      // Captured cases retain their authority after rollback to off. Let the
      // existing routine release superseded cases before deciding admission.
      const admitted = await db.query(`SELECT public.subscription_delivery_alignment_admit_renewal(
        $1::uuid,$2::timestamptz,$3::timestamptz) AS response`,
      [input.subscriptionId, input.scheduledAt, input.occurredAt ?? now()]);
      const response = parseDeliveryAlignmentAdmissionResponse(admitted.rows[0]?.response, null);
      if (!response.allowed) return { allowed: false, reason: response.reason, deferred: true };
      return { allowed: response.allowed, reason: response.reason };
    },
  };
}
