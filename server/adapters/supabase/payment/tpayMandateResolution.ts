import type { TpayQueryBuilder, TpaySubscriptionActivationClient } from "./tpaySubscriptionActivation.js";

interface ActiveMethodRef {
  id: string;
  providerMethodRef: string;
  methodKind: "blik_payid";
}

interface SubscriptionCycleCandidate {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  subscriptionId: string;
}

/**
 * The BLIK mandate belonging to this subscription.
 *
 * A customer running two subscriptions has two mandates in flight, and
 * `payment.succeeded` for the second can land before its `ALIAS_REGISTER` —
 * picking "the client's newest active PAYID" would attach the first
 * subscription's mandate to the second and strip it from the first. Both would
 * then renew on a consent their payer never gave for them.
 *
 * Resolution order:
 *  1. a mandate explicitly linked to this subscription — unambiguous;
 *  2. otherwise the client's single active mandate, since one mandate cannot be
 *     the wrong one. Older refs can carry a null `subscription_id` (the generic
 *     provider-webhook path does not always know the subscription), so this
 *     fallback is what keeps ordinary single-subscription customers working.
 *
 * ⛔ Ambiguity is never resolved by recency. Several unlinked mandates means we
 * cannot tell which consent belongs here, so we return none and stay provisional;
 * the later alias event re-invokes confirmation with the link in place.
 */
export async function resolveMandateForSubscription(
  client: TpaySubscriptionActivationClient,
  candidate: SubscriptionCycleCandidate,
): Promise<ActiveMethodRef | null> {
  const linked = await readTpayBlikMethodRefForSubscription(client, candidate.subscriptionId);
  if (linked) return linked;
  const unlinked = await readActiveTpayBlikMethodRefs(client, candidate.clientId);
  return unlinked.length === 1 ? unlinked[0] : null;
}

async function readTpayBlikMethodRefForSubscription(
  client: TpaySubscriptionActivationClient,
  subscriptionId: string,
): Promise<ActiveMethodRef | null> {
  const row = await maybeSingle(client.from("commerce_payment_method_refs")
    .select("id,provider_kind,method_kind,provider_method_ref,status,active")
    .eq("provider_kind", "tpay")
    .eq("method_kind", "blik_payid")
    .eq("subscription_id", subscriptionId)
    .eq("status", "active")
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1));
  if (!row) return null;
  return {
    id: readString(row, "id"),
    providerMethodRef: readString(row, "provider_method_ref"),
    methodKind: "blik_payid",
  };
}

/**
 * Every active BLIK mandate the client holds.
 *
 * Awaited directly rather than through `maybeSingle`: the COUNT is the point —
 * more than one means we cannot tell which subscription a mandate belongs to.
 */
async function readActiveTpayBlikMethodRefs(
  client: TpaySubscriptionActivationClient,
  clientId: string,
): Promise<ActiveMethodRef[]> {
  const { data, error } = await client.from("commerce_payment_method_refs")
    .select("id,provider_kind,method_kind,provider_method_ref,status,active")
    .eq("client_id", clientId)
    .eq("provider_kind", "tpay")
    .eq("method_kind", "blik_payid")
    .eq("status", "active")
    .eq("active", true);
  if (error) throw error instanceof Error ? error : new Error("supabase_query_failed");
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.map((row) => {
    const record = asRecord(row);
    return {
      id: readString(record, "id"),
      providerMethodRef: readString(record, "provider_method_ref"),
      methodKind: "blik_payid" as const,
    };
  });
}

/**
 * The autopayment model the mandate was actually registered under.
 *
 * Read from the registering attempt rather than from configuration: the flag can
 * be flipped, reverted, or flipped again, while the agreement the payer gave does
 * not change. Returns `null` when it cannot be established, which callers must
 * treat as "not model O" rather than guessing.
 */
export async function readRegisteredRecurringModel(
  client: TpaySubscriptionActivationClient,
  paymentIntentId: string,
): Promise<string | null> {
  const row = await maybeSingle(client.from("commerce_payment_attempts")
    .select("request_payload")
    .eq("payment_intent_id", paymentIntentId)
    .eq("provider", "tpay")
    .order("created_at", { ascending: false })
    .limit(1));
  const payload = row?.request_payload;
  if (!payload || typeof payload !== "object") return null;
  const model = (payload as Record<string, unknown>).recurringModel;
  return model === "O" || model === "M" ? model : null;
}


export async function readActiveTpayBlikMethodRef(
  client: TpaySubscriptionActivationClient,
  clientId: string,
): Promise<ActiveMethodRef | null> {
  const row = await maybeSingle(client.from("commerce_payment_method_refs")
    .select("id,provider_kind,method_kind,provider_method_ref,status,active")
    .eq("client_id", clientId)
    .eq("provider_kind", "tpay")
    .eq("method_kind", "blik_payid")
    .eq("status", "active")
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1));
  if (!row) return null;
  return {
    id: readString(row, "id"),
    providerMethodRef: readString(row, "provider_method_ref"),
    methodKind: "blik_payid",
  };
}


async function maybeSingle(query: TpayQueryBuilder): Promise<Record<string, unknown> | null> {
  const { data, error } = await query.maybeSingle();
  if (error) throw error instanceof Error ? error : new Error("supabase_query_failed");
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`missing_${key}`);
  return raw;
}
