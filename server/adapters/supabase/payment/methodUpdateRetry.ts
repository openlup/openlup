import { endsStoredMethodUsability } from "@openlup/core/payment";
import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";
import { readMethodLifecycleEvent } from "../../../domains/payment/paymentMethodLifecycle.js";

/**
 * Start the retry the recovery link already starts, when the payer fixed the
 * method somewhere else.
 *
 * A subscription in dunning gets a usable method back by two routes. The
 * recovery-email link redeems a token and the redeem rail pulls the failed
 * cycle's retry forward as soon as the method-ref webhook is durable. The
 * account's card-update flow writes the same durable row from the same kind of
 * webhook and, until this consumption existed, scheduled nothing — the payer who
 * fixed the card in the account waited for the next rung of the ladder.
 *
 * This module is the second entry to that ONE rail, never a second rail: it does
 * not compute, write or even read `next_retry_at`. It establishes that a usable
 * method is durably stored for a subscription with an open case and hands both
 * facts to `subscription_try_schedule_recovery_retry`, which owns the write and
 * re-verifies every one of them under its own lock.
 *
 * The subject is the STORED ROW, never the delivery's claim. The delivery only
 * supplies which method to look up; whether that method is usable, whose
 * subscription it belongs to and whether it is fresh enough are all read back
 * out of the table the webhook wrote.
 */

/** The entry condition this consumption invokes. The redeem rail keeps the default. */
export const METHOD_REF_WEBHOOK_ENTRY = "method_ref_webhook";

export interface MethodUpdateRetryQueryBuilder {
  select(columns: string): MethodUpdateRetryQueryBuilder;
  eq(column: string, value: unknown): MethodUpdateRetryQueryBuilder;
  order(column: string, options: { ascending: boolean }): MethodUpdateRetryQueryBuilder;
  limit(count: number): MethodUpdateRetryQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export interface MethodUpdateRetryClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown | null }>;
  from(table: string): MethodUpdateRetryQueryBuilder;
}

export type MethodUpdateRetryOutcome = "scheduled" | "not_scheduled" | "skipped";

export interface MethodUpdateRetryResult {
  outcome: MethodUpdateRetryOutcome;
  reason: string | null;
}

/**
 * Consume one delivery. Runs after the method-ref upsert AND after the lifecycle
 * transition, which is what lets one consumption serve both the registration the
 * account flow produces and the rotation the network produces — and what makes a
 * death signal unreachable from here, because the transition that ends a
 * method's usability has already deactivated the row this reads.
 */
export async function scheduleRetryOnDurableMethodUpdate(
  client: unknown,
  event: NormalizedProviderPaymentWebhook,
): Promise<MethodUpdateRetryResult> {
  if (!isMethodUpdateRetryClient(client)) return skipped("client_unavailable");

  const providerMethodRef = usableMethodRefFromDelivery(event);
  if (!providerMethodRef) return skipped("no_usable_method_signal");

  const subscriptionId = await readUsableSubscriptionScopedRef(client, event.provider, providerMethodRef);
  if (!subscriptionId) return skipped("method_ref_not_usable");

  const caseId = await readOpenDunningCaseId(client, subscriptionId);
  if (!caseId) return skipped("no_open_case");

  const { data, error } = await client.rpc("subscription_try_schedule_recovery_retry", {
    p_case_id: caseId,
    p_payment_method_ref: providerMethodRef,
    p_requested_at: event.occurredAt,
    p_entry: METHOD_REF_WEBHOOK_ENTRY,
  });
  if (error) throw error instanceof Error ? error : new Error("subscription_recovery_retry_failed");

  const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    outcome: result.scheduled === true ? "scheduled" : "not_scheduled",
    reason: typeof result.reason === "string" ? result.reason : null,
  };
}

/**
 * The method this delivery asserts is usable, or null when it asserts none.
 *
 * A registration carries it as the reusable method; a rotation carries it as the
 * lifecycle transition. A transition that ENDS usability is refused here as well
 * as by the row read below — one refusal is the contract, the other is the
 * evidence, and neither is allowed to be the only one.
 */
function usableMethodRefFromDelivery(event: NormalizedProviderPaymentWebhook): string | null {
  const reusable = event.reusableMethod;
  if (reusable?.status === "active" && reusable.providerMethodRef.trim()) {
    return reusable.providerMethodRef.trim();
  }
  const lifecycle = readMethodLifecycleEvent(event);
  if (lifecycle && !endsStoredMethodUsability(lifecycle.kind)) {
    return lifecycle.providerMethodRef.trim();
  }
  return null;
}

/**
 * The subscription a stored, usable, subscription-scoped method belongs to.
 *
 * `(provider_kind, provider_method_ref)` is the table's unique key, so this
 * addresses at most one row. An account-scoped row (no subscription) is not this
 * consumption's business and yields null.
 */
async function readUsableSubscriptionScopedRef(
  client: MethodUpdateRetryClient,
  providerKind: string,
  providerMethodRef: string,
): Promise<string | null> {
  const row = await readRow(client.from("commerce_payment_method_refs")
    .select("subscription_id,status,active")
    .eq("provider_kind", providerKind)
    .eq("provider_method_ref", providerMethodRef));
  if (!row || row.active !== true || row.status !== "active") return null;
  return readNullableString(row, "subscription_id");
}

/**
 * The open dunning case for a subscription, newest first. Ordered and bounded
 * rather than read as a singleton: nothing in the schema forbids two open cases
 * for one subscription, and a webhook that throws on that shape would become a
 * provider retry that can never succeed.
 */
async function readOpenDunningCaseId(
  client: MethodUpdateRetryClient,
  subscriptionId: string,
): Promise<string | null> {
  const row = await readRow(client.from("subscription_dunning_cases")
    .select("id")
    .eq("subscription_id", subscriptionId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1));
  return row ? readNullableString(row, "id") : null;
}

async function readRow(builder: MethodUpdateRetryQueryBuilder): Promise<Record<string, unknown> | null> {
  const { data, error } = await builder.maybeSingle();
  if (error) throw error instanceof Error ? error : new Error("method_update_retry_lookup_failed");
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

export function isMethodUpdateRetryClient(client: unknown): client is MethodUpdateRetryClient {
  return !!client &&
    typeof (client as { rpc?: unknown }).rpc === "function" &&
    typeof (client as { from?: unknown }).from === "function";
}

function skipped(reason: string): MethodUpdateRetryResult {
  return { outcome: "skipped", reason };
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
