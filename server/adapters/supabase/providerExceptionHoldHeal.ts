import {
  selectBackfillRows,
  type BackfillRow,
  type HealCandidate,
} from "../../domains/commerce/providerExceptionHoldHeal.js";

type QueryResult = { data?: unknown; error?: { message?: string } | null };
type QueryBuilder = PromiseLike<QueryResult> &
  Record<string, (...args: unknown[]) => QueryBuilder>;

export type ProviderExceptionHealClient = {
  from: (table: string) => QueryBuilder;
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<QueryResult>;
};

export async function readHealableProviderExceptionHolds(
  client: ProviderExceptionHealClient,
): Promise<BackfillRow[]> {
  const candidates = unwrap(
    await client.rpc("commerce_oms_healable_provider_exception_holds", {
      p_fulfillment_order_id: null,
    }),
    "provider_exception_heal_candidate_read",
  ) as HealCandidate[];
  if (candidates.length === 0) return [];

  const deliveries = unwrap(
    await client
      .from("commerce_fulfillment_orders")
      .select("id, delivered_at")
      .in("id", [
        ...new Set(candidates.map((row) => row.fulfillment_order_id)),
      ]),
    "provider_exception_heal_delivery_read",
  ) as { id: string; delivered_at: string | null }[];
  const orders = unwrap(
    await client
      .from("commerce_orders")
      .select("id, order_number")
      .in("id", [...new Set(candidates.map((row) => row.order_id))]),
    "provider_exception_heal_order_read",
  ) as { id: string; order_number: string | null }[];

  return selectBackfillRows(
    candidates,
    new Map(deliveries.map((row) => [row.id, row.delivered_at])),
    new Map(orders.map((row) => [row.id, row.order_number])),
  );
}

export async function releaseHealedProviderExceptionHold(
  client: ProviderExceptionHealClient,
  row: BackfillRow,
): Promise<void> {
  const result = await client.rpc("commerce_oms_release_hold_system", {
    p_idempotency_key: `commerce-heal:provider-exception:${row.hold_id}`,
    p_hold_id: row.hold_id,
    p_source: "commerce.fulfillment.provider_exception_backfill",
    p_proof: "delivered",
    p_metadata: {
      autoReleaseEvidence: {
        fulfillmentOrderId: row.fulfillment_order_id,
        deliveredAt: row.delivered_at,
        clearedStatusEvidenceId: row.cleared_evidence_id,
        clearedProviderStatus: row.cleared_provider_status,
        clearedProviderSubStatus: row.cleared_provider_sub_status,
        clearedOccurredAt: row.cleared_occurred_at,
      },
    },
  });
  if (result.error) {
    throw new Error(
      `provider_exception_heal_release_failed:${result.error.message ?? "unknown"}`,
    );
  }
}

function unwrap(result: QueryResult, label: string): unknown[] {
  if (result.error) {
    throw new Error(`${label}_failed:${result.error.message ?? "unknown"}`);
  }
  return (result.data ?? []) as unknown[];
}
