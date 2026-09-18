import {
  endsStoredMethodUsability,
  type PaymentMethodLifecycleEvent,
  type PaymentMethodReplacementFacts,
} from "@openlup/core/payment";
import { methodFactSnapshotKeys } from "../../../domains/payment/paymentMethodLifecycle.js";
import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";
import { readMethodLifecycleEvent } from "../../../domains/payment/paymentMethodLifecycle.js";
import { scheduleRetryOnDurableMethodUpdate } from "./methodUpdateRetry.js";

export interface PaymentMethodLifecycleQueryBuilder {
  select(columns: string): PaymentMethodLifecycleQueryBuilder;
  eq(column: string, value: unknown): PaymentMethodLifecycleQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export interface PaymentMethodLifecycleClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown | null }>;
  from(table: string): PaymentMethodLifecycleQueryBuilder;
}

export type PaymentMethodLifecycleOutcome = "deactivated" | "metadata_refreshed" | "skipped";

export interface PaymentMethodLifecycleResult {
  outcome: PaymentMethodLifecycleOutcome;
  reason: string | null;
}

const REF_COLUMNS = [
  "id", "client_id", "subscription_id", "method_kind", "provider_customer_ref",
  "provider_mandate_ref", "status", "active", "expires_at", "consent_snapshot",
  "raw_provider_payload",
].join(",");

/**
 * Apply one neutral transition to the stored method it addresses.
 *
 * Idempotent by construction, which webhook redelivery requires:
 *   * an absent row is a no-op, so a transition that outran the registration it
 *     belongs to acknowledges instead of failing forever;
 *   * an already-inactive row is a no-op, so a redelivered death is not a
 *     second deactivation;
 *   * a refresh goes through the upsert RPC under an event-scoped idempotency
 *     key, so a redelivered refresh replays the stored response.
 *
 * The row identity is never changed here: the same client, subscription, kind
 * and references are re-asserted, and only the published facts move.
 */
export async function applyPaymentMethodLifecycleEvent(
  client: PaymentMethodLifecycleClient,
  event: PaymentMethodLifecycleEvent,
): Promise<PaymentMethodLifecycleResult> {
  const ref = await readMethodRef(client, event.providerKind, event.providerMethodRef);
  if (!ref) return { outcome: "skipped", reason: "method_ref_absent" };

  const facts = event.replacement ?? null;
  // A refresh whose fresh expiry is already behind the instant the rail
  // reported it is not a refresh at all — it is the rail telling us the method
  // is finished. Consuming it as an expiry is both truthful and what keeps the
  // storage invariant (no active row with a past expiry) from raising.
  const expiredOnArrival = isExpiredAt(facts?.expiresAt ?? null, event.occurredAt);
  if (endsStoredMethodUsability(event.kind) || expiredOnArrival) {
    if (!ref.active && ref.status !== "active") {
      return { outcome: "skipped", reason: "method_ref_already_inactive" };
    }
    await deactivate(client, event, ref.id, expiredOnArrival && !endsStoredMethodUsability(event.kind)
      ? "method_expired"
      : event.kind);
    return { outcome: "deactivated", reason: null };
  }

  if (!facts) return { outcome: "skipped", reason: "no_published_facts" };
  await refresh(client, event, ref, facts);
  return { outcome: "metadata_refreshed", reason: null };
}

interface StoredMethodRef {
  id: string;
  clientId: string;
  subscriptionId: string | null;
  methodKind: string;
  providerCustomerRef: string | null;
  providerMandateRef: string | null;
  status: string;
  active: boolean;
  expiresAt: string | null;
  consentSnapshot: Record<string, unknown>;
  rawProviderPayload: Record<string, unknown>;
}

async function readMethodRef(
  client: PaymentMethodLifecycleClient,
  providerKind: string,
  providerMethodRef: string,
): Promise<StoredMethodRef | null> {
  // (provider_kind, provider_method_ref) is the table's unique key, so this
  // addresses at most one row and needs no ordering or tie-break.
  const { data, error } = await client.from("commerce_payment_method_refs")
    .select(REF_COLUMNS)
    .eq("provider_kind", providerKind)
    .eq("provider_method_ref", providerMethodRef)
    .maybeSingle();
  if (error) throw error instanceof Error ? error : new Error("method_ref_lookup_failed");
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const id = readNullableString(row, "id");
  const clientId = readNullableString(row, "client_id");
  if (!id || !clientId) return null;
  return {
    id,
    clientId,
    subscriptionId: readNullableString(row, "subscription_id"),
    methodKind: readNullableString(row, "method_kind") ?? "card",
    providerCustomerRef: readNullableString(row, "provider_customer_ref"),
    providerMandateRef: readNullableString(row, "provider_mandate_ref"),
    status: readNullableString(row, "status") ?? "inactive",
    active: row.active === true,
    expiresAt: readNullableString(row, "expires_at"),
    consentSnapshot: readRecord(row, "consent_snapshot"),
    rawProviderPayload: readRecord(row, "raw_provider_payload"),
  };
}

async function deactivate(
  client: PaymentMethodLifecycleClient,
  event: PaymentMethodLifecycleEvent,
  methodRefId: string,
  reason: string,
): Promise<void> {
  const { error } = await client.rpc("commerce_payment_method_ref_deactivate", {
    p_idempotency_key: idempotencyKey(event),
    p_method_ref_id: methodRefId,
    p_reason: reason,
    p_metadata: {
      lifecycleKind: event.kind,
      providerEventId: event.providerEventId,
      occurredAt: event.occurredAt,
    },
  });
  if (error) throw error instanceof Error ? error : new Error("method_ref_deactivate_failed");
}

async function refresh(
  client: PaymentMethodLifecycleClient,
  event: PaymentMethodLifecycleEvent,
  ref: StoredMethodRef,
  facts: PaymentMethodReplacementFacts,
): Promise<void> {
  const { error } = await client.rpc("commerce_payment_method_ref_upsert", {
    p_idempotency_key: idempotencyKey(event),
    p_client_id: ref.clientId,
    p_subscription_id: ref.subscriptionId,
    p_provider_kind: event.providerKind,
    p_method_kind: ref.methodKind,
    p_provider_customer_ref: ref.providerCustomerRef,
    p_provider_method_ref: event.providerMethodRef,
    p_provider_mandate_ref: ref.providerMandateRef,
    p_status: ref.status,
    p_active: ref.active,
    p_expires_at: facts.expiresAt ?? ref.expiresAt,
    // Merged, never replaced: the recorded consent evidence the health view
    // classifies on (the autopayment model above all) survives a refresh that
    // only ever adds the published facts.
    p_consent_snapshot: { ...ref.consentSnapshot, ...methodFactSnapshotKeys(facts) },
    p_raw_provider_payload: ref.rawProviderPayload,
  });
  if (error) throw error instanceof Error ? error : new Error("method_ref_refresh_failed");
}

function idempotencyKey(event: PaymentMethodLifecycleEvent): string {
  return `provider-webhook:${event.providerKind}:${event.providerEventId}:method-lifecycle`;
}

function isExpiredAt(expiresAt: string | null, occurredAt: string): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  const reference = Date.parse(occurredAt);
  return Number.isFinite(expiry) && Number.isFinite(reference) && expiry <= reference;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** Managed webhook delivery composition, colocated with the concrete lifecycle
 * adapter so the neutral domain never imports a Supabase implementation. */
export async function consumeSupabasePaymentMethodDelivery(
  client: unknown,
  input: NormalizedProviderPaymentWebhook,
): Promise<void> {
  const lifecycle = readMethodLifecycleEvent(input);
  if (lifecycle && isPaymentMethodDeliveryClient(client)) {
    await applyPaymentMethodLifecycleEvent(client, lifecycle);
  }
  await scheduleRetryOnDurableMethodUpdate(client, input);
}

function isPaymentMethodDeliveryClient(
  client: unknown,
): client is PaymentMethodLifecycleClient {
  return Boolean(client) &&
    typeof (client as { rpc?: unknown }).rpc === "function" &&
    typeof (client as { from?: unknown }).from === "function";
}
