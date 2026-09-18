import type { PaymentProviderCapabilityRegistry } from "@openlup/core/payment";
import type { CanonicalPaymentEvent } from "../../../../src/domains/payment/types.js";
import type {
  AppliedPaymentResult,
  IngestedPaymentEvent,
  PaymentWebhookPort,
} from "../../../../src/domains/payment/ports.js";
import type {
  NormalizedProviderPaymentWebhook,
  PaymentWebhookControlPort,
  PaymentWebhookMethodRefPort,
} from "../../../domains/payment/paymentWebhookHandlers.js";
import { applyPaymentResultRpc } from "../../../shared/applyPaymentResultRpc.js";
import { signalTerminalPaymentDecline } from "../../../shared/signalTerminalPaymentDecline.js";
import { expiryForMethodRefWrite } from "../../../domains/payment/paymentMethodLifecycle.js";
import {
  paymentPayloadFingerprint,
  paymentSourceFingerprint,
} from "../../../domains/payment/paymentTruth.js";

export interface PaymentWebhookSupabaseClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export function createSupabasePaymentWebhookPort(
  client: PaymentWebhookSupabaseClient,
): PaymentWebhookPort {
  return {
    async ingestEvent(input): Promise<IngestedPaymentEvent> {
      const payloadFingerprint = paymentPayloadFingerprint(input.rawPayload);
      const sourceEvidence = {
        sourceKind: "accepted_event",
        sourceReference: input.event.provider_event_id,
        observedStatus: input.event.event_type,
        observedAt: null,
        payloadFingerprint,
      };
      const eventFingerprint = paymentSourceFingerprint({
        sourceEventId: String(input.event.raw_payload.provider ?? "unknown") + ":" + input.event.provider_event_id,
        eventKind: input.event.event_type,
        settlementIntentId: null,
        amountMinor: input.event.amount_minor ?? null,
        currency: readCurrency(input.event.raw_payload),
        occurredAt: null,
        payloadFingerprint,
      });
      const { data, error } = await client.rpc("commerce_payment_control_ingest_event", {
        p_provider: input.event.raw_payload.provider ?? "unknown",
        p_provider_event_id: input.event.provider_event_id,
        p_event_type: input.event.event_type,
        p_provider_payment_id: input.event.payment_provider_id,
        p_payment_intent_id: null,
        p_payment_attempt_id: null,
        p_amount_cents: input.event.amount_minor ?? null,
        p_currency: readCurrency(input.event.raw_payload),
        p_signature_verified: input.signatureVerified,
        p_payload: paymentTruthPayload(input.rawPayload, eventFingerprint, sourceEvidence),
      });
      if (error) throw new Error(`commerce_payment_control_ingest_event: ${readErrorMessage(error)}`);
      const event = readObject(data, "paymentEvent");
      return mapIngestedEvent(event);
    },

    async applyEventResult(input): Promise<AppliedPaymentResult> {
      const { data, error } = await applyPaymentResultRpc(client, {
        idempotencyKey: input.idempotencyKey,
        paymentIntentId: input.paymentIntentId,
        paymentEventId: input.paymentEventId,
        resultStatus: input.resultStatus,
        occurredAt: input.occurredAt,
        failureReason: input.failureReason,
      });
      if (error) throw new Error(`commerce_payment_control_apply_result: ${readErrorMessage(error)}`);
      const result = readObject(data, "paymentResult");
      const replayed = result.replayed === true;
      // A provider callback reporting a refusal terminalises it here. The port
      // input carries no provider field, so none is claimed.
      signalTerminalPaymentDecline({
        resultStatus: input.resultStatus,
        replayed,
        occurredAt: input.occurredAt,
        failureReason: input.failureReason,
        provider: null,
      });
      return {
        paymentIntentId: readString(result, "paymentIntentId"),
        paymentEventId: input.paymentEventId,
        status: readString(result, "status") as AppliedPaymentResult["status"],
        replayed,
      };
    },
  };
}

export function createSupabasePaymentWebhookControlPort(
  client: PaymentWebhookSupabaseClient,
): PaymentWebhookControlPort {
  return {
    async ingestPaymentEvent(input) {
      const payloadFingerprint = paymentPayloadFingerprint(input.rawPayload);
      const sourceEvidence = {
        sourceKind: "accepted_event",
        sourceReference: input.providerEventId,
        observedStatus: input.eventType,
        observedAt: input.occurredAt,
        payloadFingerprint,
      };
      const eventFingerprint = paymentSourceFingerprint({
        sourceEventId: `${input.provider}:${input.providerEventId}`,
        eventKind: input.eventType,
        settlementIntentId: input.paymentIntentId ?? null,
        amountMinor: input.amountMinor ?? null,
        currency: input.currency?.toUpperCase() ?? null,
        occurredAt: input.occurredAt,
        payloadFingerprint,
      });
      const { data, error } = await client.rpc("commerce_payment_control_ingest_event", {
        p_provider: input.provider,
        p_provider_event_id: input.providerEventId,
        p_event_type: input.eventType,
        p_provider_payment_id: input.providerPaymentId,
        p_payment_intent_id: input.paymentIntentId ?? null,
        p_payment_attempt_id: input.paymentAttemptId ?? null,
        p_amount_cents: input.amountMinor ?? null,
        p_currency: input.currency ?? null,
        p_signature_verified: true,
        p_payload: paymentTruthPayload(input.rawPayload, eventFingerprint, sourceEvidence),
      });
      if (error) throw error;
      return mapIngestedEvent(readObject(data, "paymentEvent"));
    },

    async applyPaymentResult(input) {
      const { data, error } = await applyPaymentResultRpc(client, {
        idempotencyKey: input.idempotencyKey,
        paymentIntentId: input.paymentIntentId,
        paymentEventId: input.paymentEventId,
        resultStatus: input.resultStatus,
        occurredAt: input.occurredAt,
        failureReason: input.failureReason,
      });
      if (error) throw error;
      return { replayed: readObject(data, "paymentResult").replayed === true };
    },

    async confirmSubscriptionActivation(input) {
      const { data, error } = await client.rpc("commerce_webhook_confirm_subscription_from_intent", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_intent_id: input.paymentIntentId,
        p_payment_method_ref: input.methodRef,
        p_payment_method_kind: input.methodKind,
        p_occurred_at: input.occurredAt,
      });
      if (error) throw error;
      const result = readObject(data, "webhookSubscriptionConfirm");
      const confirmation =
        result.confirmation && typeof result.confirmation === "object"
          ? (result.confirmation as Record<string, unknown>)
          : null;
      return {
        confirmed: result.confirmed === true,
        status: confirmation && typeof confirmation.status === "string" ? confirmation.status : null,
      };
    },

    async markSetupEventProcessed(input) {
      const { data, error } = await client.rpc("commerce_payment_control_mark_setup_event_processed", {
        p_payment_event_id: input.paymentEventId,
      });
      if (error) throw error;
      return { updated: readObject(data, "setupEventProcessed").updated === true };
    },

    async recoverPaidSubscriptionActivationWithCard(input) {
      const { data, error } = await client.rpc("subscription_recover_paid_activation_with_card", {
        p_idempotency_key: input.idempotencyKey,
        p_subscription_id: input.subscriptionId,
        p_payment_method_ref: input.paymentMethodRef,
        p_occurred_at: input.occurredAt,
      });
      if (error) throw error;
      const result = readObject(data, "paidActivationCardRecovery");
      return {
        recovered: result.recovered === true,
        replayed: result.replayed === true,
        reason: readNullableString(result, "reason"),
      };
    },
  };
}

export function createSupabasePaymentWebhookMethodRefPort(
  client: PaymentWebhookSupabaseClient,
  capabilities: PaymentProviderCapabilityRegistry,
): PaymentWebhookMethodRefPort {
  return {
    async upsertFromWebhook(input: NormalizedProviderPaymentWebhook) {
      const method = input.reusableMethod;
      if (!method) return { replayed: false };
      // Whether stored consent belongs to one subscription is a capability of
      // the rail that issued it; an unpublished kind takes the account-scoped
      // write, exactly as an unrecognised provider does today.
      const subscriptionScoped = capabilities.get(input.provider)?.mandateUpsertIsSubscriptionScoped === true;
      const rpcName = subscriptionScoped && method.subscriptionId
        ? "commerce_tpay_alias_method_ref_upsert_guarded"
        : "commerce_payment_method_ref_upsert";
      const active = method.status === "active";
      const { data, error } = await client.rpc(rpcName, {
        p_idempotency_key: `provider-webhook:${input.provider}:${input.providerEventId}:method-ref`,
        p_client_id: method.clientId,
        p_subscription_id: method.subscriptionId ?? null,
        p_provider_kind: input.provider,
        p_method_kind: method.methodKind,
        p_provider_customer_ref: method.providerCustomerRef ?? null,
        p_provider_method_ref: method.providerMethodRef,
        p_provider_mandate_ref: method.providerMandateRef ?? null,
        p_status: method.status,
        p_active: active,
        // Was a literal null at every call site, which is what made the stored
        // expiry unknowable and the expiring-method health state unreachable.
        // The rail's own facts now travel on the consent snapshot the adapter
        // attached, and this is where they become the queryable column.
        p_expires_at: expiryForMethodRefWrite(method.consentSnapshot, input.occurredAt, active),
        p_consent_snapshot: method.consentSnapshot ?? {},
        p_raw_provider_payload: input.rawPayload,
      });
      if (error) throw error;
      const recoveryCaseId = readOptionalString(method.consentSnapshot, "recoveryCaseId");
      if (recoveryCaseId && method.subscriptionId && method.status === "active") {
        const { error: scheduleError } = await client.rpc("subscription_try_schedule_recovery_retry", {
          p_case_id: recoveryCaseId,
          p_payment_method_ref: method.providerMethodRef,
          p_requested_at: input.occurredAt,
        });
        if (scheduleError) throw scheduleError;
      }
      return { replayed: readObject(data, "paymentMethodRef").replayed === true };
    },
  };
}

function mapIngestedEvent(event: Record<string, unknown>): IngestedPaymentEvent {
  return {
    paymentEventId: readString(event, "id"),
    paymentIntentId: readNullableString(event, "paymentIntentId"),
    paymentAttemptId: readNullableString(event, "paymentAttemptId"),
    replayed: event.replayed === true,
  };
}

function readCurrency(payload: CanonicalPaymentEvent["raw_payload"]): string | null {
  const currency = payload.currency;
  return typeof currency === "string" ? currency : null;
}

function paymentTruthPayload(
  payload: Record<string, unknown>,
  fingerprint: string,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...payload,
    __paymentTruth: { fingerprint, evidence },
  };
}

function readObject(value: unknown, key: string): Record<string, unknown> {
  const source = (value as Record<string, unknown> | null | undefined)?.[key];
  if (!source || typeof source !== "object") throw new Error("Invalid payment webhook RPC response");
  return source as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error("Invalid payment webhook RPC response");
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readOptionalString(value: Record<string, unknown> | undefined, key: string): string | null {
  const raw = value?.[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function readErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return String(record.message ?? record.code ?? "failed");
  }
  return "failed";
}
