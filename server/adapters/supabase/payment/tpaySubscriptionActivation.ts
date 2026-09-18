import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";
import {
  readRegisteredRecurringModel,
  readActiveTpayBlikMethodRef,
  resolveMandateForSubscription,
} from "./tpayMandateResolution.js";
import {
  isActiveTpayBlikAliasEvent,
  paymentIntentIdFromAlias,
  tpayProviderMethodRef,
} from "../../../domains/payment/tpayAliasLinkage.js";
import { aliasValue } from "../../tpay/tpayCreateTransactionInput.js";

export interface TpaySubscriptionActivationClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: TpayRpcError | null }>;
  from(table: string): TpayQueryBuilder;
}

interface TpayRpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface TpayQueryBuilder extends PromiseLike<{ data: unknown; error: unknown | null }> {
  select(columns: string): TpayQueryBuilder;
  eq(column: string, value: unknown): TpayQueryBuilder;
  is(column: string, value: null): TpayQueryBuilder;
  order(column: string, opts: { ascending: boolean }): TpayQueryBuilder;
  limit(count: number): TpayQueryBuilder;
  update(values: Record<string, unknown>): TpayQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export interface TpayWebhookActivationInput {
  event: NormalizedProviderPaymentWebhook;
  ingested: { paymentIntentId: string | null };
  resultStatus: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null;
}

export type TpayActivationStatus = "skipped" | "awaiting_mandate" | "activated";

interface SubscriptionCycleCandidate {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  subscriptionId: string;
}

interface ActiveMethodRef {
  id: string;
  providerMethodRef: string;
  methodKind: "blik_payid";
}

/**
 * Model B: confirm a provisional subscription through the same wrapper RPC as
 * Stripe after both facts exist: paid subscription_cycle intent and active BLIK
 * PAYID/UID alias. Either webhook may arrive first; confirmation is idempotent.
 * This intentionally replaces the old Model A bridge.
 */
export async function tryActivateTpaySubscriptionFromWebhook(
  client: TpaySubscriptionActivationClient,
  input: TpayWebhookActivationInput,
): Promise<{ status: TpayActivationStatus; reason?: string }> {
  if (input.event.provider !== "tpay") return { status: "skipped", reason: "provider_mismatch" };

  const isChargeSuccess = input.resultStatus === "succeeded";
  const isMandateEvent = isActiveTpayBlikAliasEvent(input.event);
  const resolvedPaymentIntentId = input.ingested.paymentIntentId
    ?? input.event.paymentIntentId
    ?? paymentIntentIdFromAlias(input.event.providerPaymentId);

  if (isMandateEvent && resolvedPaymentIntentId) {
    const ownership = await readSubscriptionCycleOwnershipByPaymentIntentId(client, resolvedPaymentIntentId);
    if (ownership) {
      await upsertActiveTpayBlikMethodRefFromWebhook(client, {
        event: input.event,
        candidate: ownership,
      });
    }
  }

  if (!isChargeSuccess && !isMandateEvent) {
    return { status: "skipped", reason: "not_success_or_active_method" };
  }

  const candidate = resolvedPaymentIntentId
    ? await readCandidateByPaymentIntentId(client, resolvedPaymentIntentId)
    : await readPendingCandidateByClientId(client, input.event.reusableMethod?.clientId ?? null);
  if (!candidate) return { status: "skipped", reason: "no_subscription_cycle_candidate" };

  const subscription = await maybeSingle(client.from("subscriptions").select("id,status,payment_method_kind").eq("id", candidate.subscriptionId));
  if (subscription?.status === "active" && subscription.payment_method_kind === "card") return { status: "skipped", reason: "card_precedence" };

  // Bind the mandate to THIS subscription, never "the client's newest active
  // PAYID". A customer starting a second subscription while the first is active
  // has two mandates in flight, and `payment.succeeded` for B can land before
  // `ALIAS_REGISTER` for B — picking by recency would attach A's mandate to B and
  // strip it from A. When the mandate for this subscription has not arrived yet we
  // stay provisional and let the later alias event re-invoke confirmation.
  const methodRef = await resolveMandateForSubscription(client, candidate);

  const confirmation = await confirmViaWrapper(client, {
    paymentIntentId: candidate.paymentIntentId,
    methodRef: methodRef?.providerMethodRef ?? null,
    occurredAt: input.event.occurredAt,
  });

  if (!confirmation.confirmed) {
    return { status: "skipped", reason: confirmation.reason ?? "not_subscription_cycle" };
  }
  if (confirmation.status !== "active") {
    // awaiting_mandate (or any non-active interstitial): leave provisional; the
    // later alias event re-invokes confirm. The A4 sweeper reaps stuck provisionals.
    return { status: "awaiting_mandate" };
  }

  if (methodRef) {
    await linkMethodRefToSubscription(
      client,
      methodRef.id,
      candidate.subscriptionId,
      candidate.orderId,
      candidate.paymentIntentId,
    );
  }
  return { status: "activated" };
}

async function confirmViaWrapper(
  client: TpaySubscriptionActivationClient,
  args: { paymentIntentId: string; methodRef: string | null; occurredAt: string },
): Promise<{ confirmed: boolean; status: string | null; reason?: string }> {
  const { data, error } = await client.rpc("commerce_webhook_confirm_subscription_from_intent", {
    p_idempotency_key: `tpay-checkout-confirm:${args.paymentIntentId}`,
    p_payment_intent_id: args.paymentIntentId,
    p_payment_method_ref: args.methodRef,
    p_payment_method_kind: args.methodRef ? "blik_payid" : null,
    p_occurred_at: args.occurredAt,
  });
  if (error) throw error instanceof Error ? error : new Error("commerce_webhook_confirm_failed");
  const envelope = readObject(asRecord(data), "webhookSubscriptionConfirm");
  const confirmation = readObjectOrNull(envelope, "confirmation");
  return {
    confirmed: envelope.confirmed === true,
    status: confirmation ? readNullableString(confirmation, "status") : null,
    reason: readNullableString(envelope, "reason") ?? undefined,
  };
}

async function readCandidateByPaymentIntentId(
  client: TpaySubscriptionActivationClient,
  paymentIntentId: string,
): Promise<SubscriptionCycleCandidate | null> {
  const candidate = await readSubscriptionCycleOwnershipByPaymentIntentId(client, paymentIntentId);
  if (!candidate) return null;
  const intent = await maybeSingle(client.from("commerce_payment_intents")
    .select("id,status")
    .eq("id", paymentIntentId));
  if (!intent || readNullableString(intent, "status") !== "succeeded") return null;
  const order = await maybeSingle(client.from("commerce_orders")
    .select("id,status")
    .eq("id", candidate.orderId));
  if (!order || readNullableString(order, "status") !== "paid") return null;
  return candidate;
}

async function readSubscriptionCycleOwnershipByPaymentIntentId(
  client: TpaySubscriptionActivationClient,
  paymentIntentId: string,
): Promise<SubscriptionCycleCandidate | null> {
  const intent = await maybeSingle(client.from("commerce_payment_intents")
    .select("id,order_id,subscription_id,target_kind,status")
    .eq("id", paymentIntentId));
  if (!intent) return null;
  if (readNullableString(intent, "target_kind") !== "subscription_cycle") return null;
  const orderId = readNullableString(intent, "order_id");
  const subscriptionId = readNullableString(intent, "subscription_id");
  if (!orderId || !subscriptionId) return null;
  const order = await maybeSingle(client.from("commerce_orders")
    .select("id,client_id,status")
    .eq("id", orderId));
  if (!order) return null;
  return { orderId, paymentIntentId, clientId: readString(order, "client_id"), subscriptionId };
}

/**
 * Staging-simulator fidelity: real Tpay sends a `setup.succeeded` (PAYID alias)
 * webhook after a BLIK recurring activation, which is what drives Model B
 * activation. The simulator UI doesn't pass an `aliasResult`, so the simulator
 * webhook handler calls this to EMULATE that alias event for a subscription
 * first-cycle success — but only when there is no active BLIK mandate yet (real
 * Tpay emits the alias on registration, not on saved-method renewal charges).
 * The alias value comes from the one `aliasValue()` the outbound transaction
 * adapter already mints, so the emulated alias can never drift from the real one.
 * Returns null for one-time orders, renewals, or non-subscription intents.
 */
export async function deriveSimulatorRecurringActivationAlias(
  client: TpaySubscriptionActivationClient,
  paymentIntentId: string,
): Promise<{ clientId: string; subscriptionId: string; providerMethodRef: string } | null> {
  const ownership = await readSubscriptionCycleOwnershipByPaymentIntentId(client, paymentIntentId);
  if (!ownership) return null;
  const existing = await readActiveTpayBlikMethodRef(client, ownership.clientId);
  if (existing) return null;
  return {
    clientId: ownership.clientId,
    subscriptionId: ownership.subscriptionId,
    providerMethodRef: aliasValue(paymentIntentId),
  };
}

async function readPendingCandidateByClientId(
  client: TpaySubscriptionActivationClient,
  clientId: string | null,
): Promise<SubscriptionCycleCandidate | null> {
  if (!clientId) return null;
  const subscription = await maybeSingle(client.from("subscriptions")
    .select("id,client_id,status,created_at")
    .eq("client_id", clientId)
    .eq("status", "pending_activation")
    .order("created_at", { ascending: false })
    .limit(1));
  if (!subscription) return null;
  const subscriptionId = readString(subscription, "id");
  const intent = await maybeSingle(client.from("commerce_payment_intents")
    .select("id,order_id,subscription_id,target_kind,status,updated_at")
    .eq("subscription_id", subscriptionId)
    .eq("target_kind", "subscription_cycle")
    .eq("status", "succeeded")
    .order("updated_at", { ascending: false })
    .limit(1));
  if (!intent) return null;
  const orderId = readNullableString(intent, "order_id");
  if (!orderId) return null;
  return { orderId, paymentIntentId: readString(intent, "id"), clientId, subscriptionId };
}

async function linkMethodRefToSubscription(
  client: TpaySubscriptionActivationClient,
  methodRefId: string,
  subscriptionId: string,
  orderId: string,
  paymentIntentId: string,
): Promise<void> {
  const { error } = await client.rpc("commerce_payment_method_ref_link_subscription_mirror", {
    p_idempotency_key: `tpay-subscription-method-ref-link:${orderId}:${paymentIntentId}`,
    p_subscription_id: subscriptionId,
    p_method_ref_id: methodRefId,
  });
  if (error) throw error instanceof Error ? error : new Error("payment_method_ref_link_failed");
}

async function upsertActiveTpayBlikMethodRefFromWebhook(
  client: TpaySubscriptionActivationClient,
  input: {
    event: NormalizedProviderPaymentWebhook;
    candidate: SubscriptionCycleCandidate;
  },
): Promise<void> {
  const providerMethodRef = tpayProviderMethodRef(input.event);
  if (!providerMethodRef) return;
  const { error } = await client.rpc("commerce_tpay_alias_method_ref_upsert_guarded", {
    p_idempotency_key: `tpay-alias-method-ref:${input.candidate.paymentIntentId}:${providerMethodRef}`,
    p_client_id: input.candidate.clientId,
    p_subscription_id: input.candidate.subscriptionId,
    p_provider_kind: "tpay",
    p_method_kind: "blik_payid",
    p_provider_customer_ref: null,
    p_provider_method_ref: providerMethodRef,
    p_provider_mandate_ref: input.event.reusableMethod?.providerMandateRef ?? null,
    p_status: "active",
    p_active: true,
    p_expires_at: null,
    p_consent_snapshot: {
      ...(input.event.reusableMethod?.consentSnapshot ?? {
        source: "tpay.alias.uid.webhook",
        providerEventId: input.event.providerEventId,
        paymentIntentId: input.candidate.paymentIntentId,
      }),
      // The autopayment model is a property of THIS agreement, not of whatever
      // the merchant flag happens to say later. Renewals read it back from here,
      // so a mandate registered under model M is never charged as model O — the
      // payer consented to one specific arrangement.
      recurringModel: await readRegisteredRecurringModel(client, input.candidate.paymentIntentId),
    },
    p_raw_provider_payload: input.event.rawPayload,
  });
  if (error) throw error instanceof Error ? error : new Error("tpay_method_ref_upsert_failed");
}

async function maybeSingle(query: TpayQueryBuilder): Promise<Record<string, unknown> | null> {
  const { data, error } = await query.maybeSingle();
  if (error) throw error instanceof Error ? error : new Error("supabase_query_failed");
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function readObjectOrNull(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const raw = value[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`missing_${key}`);
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
