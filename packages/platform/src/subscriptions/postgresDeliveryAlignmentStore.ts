import type { RenewalStorePort } from "./contracts/renewal.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** Native new-cycle admission; prepared attempts and existing cycles keep their
 * original obligation. The host owns mode selection and actual arrival facts. */
export function withNativeDeliveryAlignmentRenewalAdmission(
  store: RenewalStorePort,
  db: SubscriptionQueryExecutor,
  now: () => string = () => new Date().toISOString(),
): RenewalStorePort {
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
      if (!context || typeof context.existing_cycle !== "boolean"
        || typeof context.captured_case !== "boolean"
        || !["off", "shadow", "protect", "auto_align"].includes(String(context.mode))) {
        throw new Error("subscription_delivery_alignment_context_invalid");
      }
      if (context.existing_cycle || (context.mode === "off" && !context.captured_case)) return staticAdmission;
      const result = await db.query(`SELECT public.subscription_delivery_alignment_admit_renewal(
        $1::uuid,$2::timestamptz,$3::timestamptz) AS response`,
      [input.subscriptionId, input.scheduledAt, input.occurredAt ?? now()]);
      const response = subscriptionRecord(result.rows[0]?.response);
      if (typeof response.allowed !== "boolean" || typeof response.state !== "string" || typeof response.reason !== "string") {
        throw new Error("subscription_delivery_alignment_admission_invalid_response");
      }
      return response.allowed
        ? { allowed: true, state: response.state, reason: response.reason }
        : { allowed: false, state: response.state, reason: response.reason, deferred: true };
    },
  };
}
