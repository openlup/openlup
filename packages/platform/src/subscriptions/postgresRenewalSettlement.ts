import type { RenewalSettlementPort } from "./contracts/renewal.js";
import { subscriptionRecord, type NativeRenewalCodec, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

const PREPARE_SQL = `SELECT public.commerce_prepare_subscription_renewal(
  $1::uuid, $2::uuid, $3::timestamptz) AS response`;
const ACKNOWLEDGE_ATTEMPT_SQL = `SELECT public.commerce_acknowledge_subscription_renewal_attempt(
  $1::uuid, $2::text, $3::text, $4::timestamptz) AS response`;
const TERMINAL_SQL = `SELECT public.commerce_record_subscription_renewal_outcome(
  $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz) AS response`;

/** Direct settlement persistence; terminal truth must arrive from an external acknowledgement. */
export function createPostgresRenewalSettlementPort(
  executor: SubscriptionQueryExecutor,
  codec: NativeRenewalCodec,
  withTransaction?: <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => Promise<T>,
): RenewalSettlementPort {
  async function prepare(db: SubscriptionQueryExecutor, input: Parameters<RenewalSettlementPort["prepareRenewal"]>[0], atomic: boolean) {
    const operation = (await db.query("SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1::uuid", [input.operationId])).rows[0];
    const wire = record(operation?.cycle_snapshot);
    const retained = wire?.frozenRevision === "native.purchase-renewal.v2";
    if (retained && !atomic) throw new Error("subscription_renewal_transaction_required");
    const snapshot = retained ? codec.decode(wire!) : null;
    const result = await db.query(PREPARE_SQL, [input.operationId, input.claimToken, input.now]);
    const row = requiredRecord(record(result.rows[0])?.response, "prepare_response");
    if (row.contractVersion !== "platform.subscription.renewal.v1" || row.state !== "attempt_prepared") {
      throw new Error("subscription_renewal_prepare_response_invalid");
    }
    // The existing routine creates gross item rows. Finish the retained money
    // projection before the deferred line-sum constraint can commit it.
    if (snapshot && row.replayed !== true) {
      const pricing = snapshot.pricingSnapshot;
      if (pricing.discountAmountMinor) {
        await db.query("DELETE FROM public.commerce_order_items WHERE order_id=$1::uuid", [row.orderId]);
        await db.query(`WITH source AS (
          SELECT (value->>'lineOrdinal')::integer AS ordinal,k.id AS sku_id,
            (value->>'quantity')::integer AS quantity,(value->>'unitAmountMinor')::bigint AS unit,
            (value->>'quantity')::bigint*(value->>'unitAmountMinor')::bigint AS gross
          FROM jsonb_array_elements($2::jsonb) JOIN public.catalog_skus k ON k.sku=value->>'sku'
        ), bases AS (
          SELECT source.*,floor(gross::numeric*($4::bigint-$3::bigint)/$4::bigint)::bigint AS effective_base,
            mod(gross::numeric*($4::bigint-$3::bigint),$4::bigint) AS fraction FROM source
        ), allocated AS (
          SELECT bases.*,effective_base+CASE WHEN row_number() OVER(ORDER BY fraction DESC,ordinal)
            <= $4::bigint-$3::bigint-(SELECT sum(effective_base) FROM bases) THEN 1 ELSE 0 END AS effective FROM bases
        ), split AS (
          SELECT allocated.*,quantity-(effective%quantity)::integer AS qty,effective/quantity AS price FROM allocated
          UNION ALL SELECT allocated.*,(effective%quantity)::integer,effective/quantity+1 FROM allocated WHERE effective%quantity>0
        ) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor,
          source_line_ordinal,catalog_unit_amount_minor,catalog_line_amount_minor,promotion_discount_allocated_minor,promotion_allocation_fingerprint)
        SELECT $1::uuid,sku_id,row_number() OVER(ORDER BY ordinal,price,qty)::integer,qty,price,price*qty,
          ordinal,unit,unit*qty,(unit-price)*qty,$5::text FROM split WHERE qty>0`,
        [row.orderId, JSON.stringify(snapshot.orderSnapshot.lines), pricing.discountAmountMinor, pricing.productSubtotalAmountMinor, snapshot.frozenFingerprint]);
      }
      if (pricing.shippingAmountMinor) await db.query(`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor)
        VALUES($1::uuid,'shipping_charge','shipping',$2)`, [row.orderId, pricing.shippingAmountMinor]);
    }
    return {
      contractVersion: "platform.subscription.renewal.v1" as const,
      replayed: row.replayed === true,
      operationId: requiredText(row.operationId, "operationId"),
      operationFingerprint: requiredText(row.operationFingerprint, "operationFingerprint"),
      cycleId: requiredText(row.cycleId, "cycleId"), orderId: requiredText(row.orderId, "orderId"),
      settlementIntentId: requiredText(row.settlementIntentId, "settlementIntentId"), state: "attempt_prepared" as const,
    };
  }
  return {
    async prepareRenewal(input) {
      return withTransaction ? withTransaction(db => prepare(db, input, true)) : prepare(executor, input, false);
    },

    async acknowledgeExternalAttempt(input) {
      const externalAttemptRef = input.externalAttemptRef.trim();
      if (!externalAttemptRef) throw new Error("subscription_renewal_external_attempt_ref_required");
      const result = await executor.query(ACKNOWLEDGE_ATTEMPT_SQL, [
        input.operationId, input.operationFingerprint, externalAttemptRef, input.acknowledgedAt,
      ]);
      return codec.readback(subscriptionRecord(result.rows[0]?.response));
    },

    async recordTerminalOutcome(input) {
      if (input.outcome === "succeeded" && !input.externalRef?.trim()) {
        throw new Error("subscription_renewal_success_external_ref_required");
      }
      const result = await executor.query(TERMINAL_SQL, [
        input.operationId, input.eventKey, input.operationFingerprint, input.outcome,
        input.externalRef ?? null, input.reason ?? null, input.occurredAt,
      ]);
      return codec.readback(subscriptionRecord(result.rows[0]?.response));
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
function requiredText(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`subscription_renewal_${field}_invalid`);
  return result;
}
