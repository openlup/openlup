import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerAccountV2Response } from "../../../src/domains/customers/accountV2Contracts.js";

type Row = Record<string, unknown>;
export type CustomerSubscriptionEditBlockedReason = NonNullable<
  CustomerAccountV2Response["subscriptions"][number]["editBlockedReason"]
>;

export async function readSubscriptionBlockers(
  serviceClient: SupabaseClient,
  subscriptionIds: string[],
  nextCycleAtBySubscription = new Map<string, string | null>(),
): Promise<Map<string, CustomerSubscriptionEditBlockedReason>> {
  const ids = Array.from(new Set(subscriptionIds.filter(Boolean)));
  const map = new Map<string, CustomerSubscriptionEditBlockedReason>();
  if (ids.length === 0) return map;

  const [
    { data: dunningRows, error: dunningError },
    { data: cycleRows, error: cycleError },
    { data: orderRows, error: orderError },
  ] = await Promise.all([
    serviceClient
      .from("subscription_dunning_cases")
      .select("subscription_id")
      .in("subscription_id", ids)
      .eq("status", "open"),
    serviceClient
      .from("subscription_cycles")
      .select("id, subscription_id, scheduled_at, status")
      .in("subscription_id", ids)
      .in("status", ["payment_pending", "paid"]),
    serviceClient
      .from("commerce_orders")
      .select("subscription_id, subscription_cycle_id, status")
      .in("subscription_id", ids)
      .in("status", ["paid", "fulfillment_pending", "fulfilled"]),
  ]);
  if (dunningError) throw dunningError;
  if (cycleError) throw cycleError;
  if (orderError) throw orderError;

  for (const row of (dunningRows ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    if (subscriptionId) map.set(subscriptionId, "payment_blocked");
  }

  const lockedCycleIds = new Set<string>();
  for (const row of (cycleRows ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    const expectedNextCycleAt = nextCycleAtBySubscription.get(subscriptionId);
    if (subscriptionId && (!expectedNextCycleAt || nullableText(row.scheduled_at) === expectedNextCycleAt)) {
      if (!map.has(subscriptionId)) map.set(subscriptionId, "cycle_locked");
      lockedCycleIds.add(text(row.id));
    }
  }

  for (const row of (orderRows ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    const expectedNextCycleAt = nextCycleAtBySubscription.get(subscriptionId);
    const cycleId = text(row.subscription_cycle_id);
    if (subscriptionId && !map.has(subscriptionId) && (!expectedNextCycleAt || lockedCycleIds.has(cycleId))) {
      map.set(subscriptionId, "cycle_locked");
    }
  }

  return map;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
