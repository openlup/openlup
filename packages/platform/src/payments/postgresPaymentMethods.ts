import { endsStoredMethodUsability, type PaymentMethodLifecycleEvent } from "@openlup/core/payment";
import { z } from "zod";
import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";
import type { NormalizedProviderPaymentWebhook, PaymentWebhookMethodRefPort } from "./verifiedIngress.js";
import { expiryForMethodRefWrite, methodFactSnapshotKeys, readMethodLifecycleEvent } from "./paymentMethodLifecycle.js";

const methodSchema = z.object({ id: z.uuid(), client_id: z.uuid(), subscription_id: z.uuid().nullable(),
  provider_kind: z.string(), provider_method_ref: z.string(), method_kind: z.string(), provider_customer_ref: z.string().nullable(),
  provider_mandate_ref: z.string().nullable(), status: z.string(), active: z.boolean(), expires_at: z.string().nullable(),
  consent_snapshot: z.record(z.string(), z.unknown()), raw_provider_payload: z.record(z.string(), z.unknown()), open_case_id: z.uuid().nullable() });
type StoredMethod = z.infer<typeof methodSchema>;

/** Bounded server reader; raw reference tables stay private. */
export function createPostgresPaymentMethodStore(db: PaymentProviderExecutor) {
  async function response(sql: string, values: unknown[]) { return (await db.query(sql, values)).rows[0]?.response; }
  return {
    async read(provider: string, reference: string): Promise<StoredMethod | null> {
      const value = await response("SELECT public.payment_method_ref_read($1,$2) AS response", [provider, reference]);
      return value == null ? null : methodSchema.parse(value);
    },
    async upsert(input: { key: string; clientId: string; subscriptionId: string | null; provider: string; methodKind: string;
      customer: string | null; reference: string; mandate: string | null; status: string; active: boolean;
      expiresAt: string | null; consent: Record<string, unknown>; payload: Record<string, unknown> }) {
      const value = await response("SELECT public.payment_method_ref_upsert($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::jsonb,$13::jsonb) AS response",
        [input.key, input.clientId, input.subscriptionId, input.provider, input.methodKind, input.customer, input.reference, input.mandate,
          input.status, input.active, input.expiresAt, JSON.stringify(input.consent), JSON.stringify(input.payload)]);
      return z.object({ paymentMethodRef: z.object({ id: z.uuid(), replayed: z.boolean() }) }).parse(value).paymentMethodRef;
    },
    async deactivate(event: PaymentMethodLifecycleEvent, id: string, reason: string) {
      await response("SELECT public.payment_method_ref_deactivate($1,$2::uuid,$3,$4::jsonb) AS response", [lifecycleKey(event), id, reason,
        JSON.stringify({ lifecycleKind: event.kind, providerEventId: event.providerEventId, occurredAt: event.occurredAt })]);
    },
    async schedule(caseId: string, reference: string, at: string, entry = "method_ref_webhook") {
      const value = await response("SELECT public.subscription_try_schedule_recovery_retry($1::uuid,$2,$3::timestamptz,$4) AS response", [caseId, reference, at, entry]);
      return z.object({ scheduled: z.boolean(), reason: z.string().nullable() }).parse(value);
    },
  };
}

/** Registration precedes lifecycle delivery and the durable retry lookup. */
export function createPostgresPaymentWebhookMethodRefPort(db: PaymentProviderExecutor): PaymentWebhookMethodRefPort {
  const store = createPostgresPaymentMethodStore(db);
  return { async upsertFromWebhook(input) {
    const method = input.reusableMethod;
    if (!method) return { replayed: false };
    const active = method.status === "active";
    const result = await store.upsert({ key: `provider-webhook:${input.provider}:${input.providerEventId}:method-ref`,
      clientId: method.clientId, subscriptionId: method.subscriptionId ?? null, provider: input.provider, methodKind: method.methodKind,
      customer: method.providerCustomerRef ?? null, reference: method.providerMethodRef, mandate: method.providerMandateRef ?? null,
      status: method.status, active, expiresAt: method.expiresAt ?? expiryForMethodRefWrite(method.consentSnapshot, input.occurredAt, active),
      consent: method.consentSnapshot ?? {}, payload: input.rawPayload });
    const caseId = method.consentSnapshot?.recoveryCaseId;
    if (typeof caseId === "string" && caseId && method.subscriptionId && active) {
      await store.schedule(caseId, method.providerMethodRef, input.occurredAt, "recovery_redeem");
    }
    return { replayed: result.replayed };
  } };
}

/** Published method facts update the addressed stored row; they confer no ownership. */
export async function applyPostgresPaymentMethodLifecycleEvent(db: PaymentProviderExecutor, event: PaymentMethodLifecycleEvent) {
  const store = createPostgresPaymentMethodStore(db), ref = await store.read(event.providerKind, event.providerMethodRef);
  if (!ref) return { outcome: "skipped", reason: "method_ref_absent" };
  const facts = event.replacement ?? null;
  const expiry = facts?.expiresAt ? Date.parse(facts.expiresAt) : NaN, at = Date.parse(event.occurredAt);
  const expired = Number.isFinite(expiry) && Number.isFinite(at) && expiry <= at;
  if (endsStoredMethodUsability(event.kind) || expired) {
    if (!ref.active && ref.status !== "active") return { outcome: "skipped", reason: "method_ref_already_inactive" };
    await store.deactivate(event, ref.id, expired && !endsStoredMethodUsability(event.kind) ? "method_expired" : event.kind);
    return { outcome: "deactivated", reason: null };
  }
  if (!facts) return { outcome: "skipped", reason: "no_published_facts" };
  await store.upsert({ key: lifecycleKey(event), clientId: ref.client_id, subscriptionId: ref.subscription_id, provider: event.providerKind,
    methodKind: ref.method_kind, customer: ref.provider_customer_ref, reference: event.providerMethodRef, mandate: ref.provider_mandate_ref,
    status: ref.status, active: ref.active, expiresAt: facts.expiresAt ?? ref.expires_at,
    consent: { ...ref.consent_snapshot, ...methodFactSnapshotKeys(facts) }, payload: ref.raw_provider_payload });
  return { outcome: "metadata_refreshed", reason: null };
}

export async function schedulePostgresRetryOnDurableMethodUpdate(db: PaymentProviderExecutor, event: NormalizedProviderPaymentWebhook) {
  const lifecycle = readMethodLifecycleEvent(event);
  const reference = event.reusableMethod?.status === "active" && event.reusableMethod.providerMethodRef.trim()
    ? event.reusableMethod.providerMethodRef.trim() : lifecycle && !endsStoredMethodUsability(lifecycle.kind) ? lifecycle.providerMethodRef.trim() : null;
  if (!reference) return { outcome: "skipped", reason: "no_usable_method_signal" };
  const store = createPostgresPaymentMethodStore(db), ref = await store.read(event.provider, reference);
  if (!ref?.subscription_id || !ref.active || ref.status !== "active") return { outcome: "skipped", reason: "method_ref_not_usable" };
  if (!ref.open_case_id) return { outcome: "skipped", reason: "no_open_case" };
  const result = await store.schedule(ref.open_case_id, reference, event.occurredAt);
  return { outcome: result.scheduled ? "scheduled" : "not_scheduled", reason: result.reason };
}

/** Compose after registration; a throw leaves the ingress row received for redelivery. */
export async function consumePostgresPaymentMethodDelivery(db: PaymentProviderExecutor, event: NormalizedProviderPaymentWebhook): Promise<void> {
  const lifecycle = readMethodLifecycleEvent(event);
  if (lifecycle) await applyPostgresPaymentMethodLifecycleEvent(db, lifecycle);
  await schedulePostgresRetryOnDurableMethodUpdate(db, event);
}
function lifecycleKey(event: PaymentMethodLifecycleEvent) { return `provider-webhook:${event.providerKind}:${event.providerEventId}:method-lifecycle`; }
