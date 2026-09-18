import type {
  PaymentMethodLifecycleEvent,
  PaymentMethodLifecycleEventKind,
} from "@openlup/core/payment";

const PROVIDER_KIND = "tpay";

/**
 * Alias-rail event names, mapped to the neutral lifecycle vocabulary.
 *
 * ⛔ `ALIAS_UPDATE` is a ROTATION, not a death: the payer's standing consent is
 * unchanged and only the alias behind it moves. Classifying it with the two
 * terminal names would strip a healthy subscription of the mandate it renews
 * on. That is why the `active` flag below already treats register and update
 * alike, and why this table must keep them apart from unregister and expiry.
 */
const ALIAS_LIFECYCLE_KINDS: Record<string, PaymentMethodLifecycleEventKind> = {
  ALIAS_REGISTER: "method_registered",
  ALIAS_UPDATE: "method_updated",
  ALIAS_UNREGISTER: "method_revoked",
  ALIAS_EXPIRED: "method_expired",
};

type TpayCanonicalPaymentEvent = {
  provider_event_id: string;
  event_type:
    | "payment.succeeded"
    | "payment.failed"
    | "payment.refunded"
    | "payment.requires_action"
    | "payment.disputed"
    | "setup.succeeded"
    | "setup.failed"
    | "setup.requires_action";
  payment_provider_id: string;
  payment_intent_id?: string | null;
  amount_minor?: number;
  raw_payload: Record<string, unknown>;
};

export interface NormalizedTpayMethodRef {
  clientId: string | null;
  subscriptionId?: string | null;
  providerMethodRef: string;
  methodKind: "blik_payid";
  status: "active" | "inactive";
  consentSnapshot: Record<string, unknown>;
}

export interface NormalizedTpayWebhook {
  event: TpayCanonicalPaymentEvent;
  methodRef: NormalizedTpayMethodRef | null;
  /**
   * The neutral transition this delivery reports about the stored mandate. The
   * instant it happened is not known at this layer, so the full neutral event
   * is assembled by the provider-webhook mapper below.
   */
  methodLifecycleKind: PaymentMethodLifecycleEventKind | null;
  responseBody: "TRUE";
}

type NormalizedTpayProviderWebhook = {
  provider: typeof PROVIDER_KIND;
  providerEventId: string;
  eventType: TpayCanonicalPaymentEvent["event_type"];
  providerPaymentId: string;
  paymentIntentId?: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: string;
  rawPayload: Record<string, unknown>;
  reusableMethod: {
    clientId: string;
    subscriptionId: string | null;
    providerCustomerRef: null;
    providerMethodRef: string;
    providerMandateRef: null;
    methodKind: "blik_payid";
    status: "active" | "inactive";
    consentSnapshot: Record<string, unknown>;
  } | null;
  methodLifecycle: PaymentMethodLifecycleEvent | null;
};

export function normalizeTpayWebhook(rawBody: string): NormalizedTpayWebhook {
  const payload = parsePayload(rawBody);
  const aliasEvent = payload.event;
  if (aliasEvent) {
    return normalizeAliasWebhook(payload);
  }
  return normalizeTransactionWebhook(payload);
}

export function toNormalizedProviderTpayWebhook(
  webhook: NormalizedTpayWebhook,
  occurredAt: string,
): NormalizedTpayProviderWebhook {
  return {
    provider: PROVIDER_KIND,
    providerEventId: webhook.event.provider_event_id,
    eventType: webhook.event.event_type,
    providerPaymentId: webhook.event.payment_provider_id,
    paymentIntentId: webhook.event.payment_intent_id ?? null,
    amountMinor: webhook.event.amount_minor ?? null,
    currency: readCurrency(webhook.event.raw_payload),
    occurredAt,
    rawPayload: webhook.event.raw_payload,
    reusableMethod: toReusableMethod(webhook.methodRef),
    // The alias value IS the stored method reference on this rail. The rail
    // publishes no scheme label or digits with an alias transition, and its
    // expiry field is deliberately not read here (see the wave plan): a
    // transition on this rail is a state change, not a facts refresh.
    methodLifecycle: webhook.methodLifecycleKind
      ? {
        kind: webhook.methodLifecycleKind,
        providerKind: PROVIDER_KIND,
        providerMethodRef: webhook.event.payment_provider_id,
        providerEventId: webhook.event.provider_event_id,
        occurredAt,
        replacement: null,
      }
      : null,
  };
}

function normalizeTransactionWebhook(payload: Record<string, string>): NormalizedTpayWebhook {
  const transactionTitle = required(payload, "tr_id");
  const rawStatus = required(payload, "tr_status");
  // Tpay production sends `tr_status` UPPERCASE ("TRUE"/"CHARGEBACK"); a
  // case-sensitive compare mislabels every real success as payment.failed
  // (caught live 2026-07-13 via a production payment-link). Classify
  // case-insensitively; keep the raw value in raw_payload for observability.
  const status = rawStatus.toLowerCase();
  const amountMinor = amountToMinor(payload.tr_paid || payload.tr_amount);
  const paymentIntentId = parseUuid(payload.tr_crc);
  return {
    event: {
      provider_event_id: transactionTitle,
      event_type: status === "chargeback" ? "payment.refunded" : status === "true" ? "payment.succeeded" : "payment.failed",
      payment_provider_id: transactionTitle,
      payment_intent_id: paymentIntentId,
      amount_minor: amountMinor,
      raw_payload: {
        provider: PROVIDER_KIND,
        eventKind: "transaction",
        transactionTitle,
        hiddenDescription: payload.tr_crc ?? null,
        transactionAmount: payload.tr_amount ?? null,
        paidAmount: payload.tr_paid ?? null,
        // Null, not the settlement default: this records what the provider SAID,
        // and a currency it did not send is unknown. The whole path was already
        // built for that - `NormalizedTpayProviderWebhook.currency` is typed
        // `string | null` and `readCurrency` below returns null for an absent or
        // blank field - so the old `?? "PLN"` was manufacturing an operand rather
        // than filling a gap.
        //
        // It does not weaken the SQL cross-check either. `commerce_payment_control_
        // apply_result` guards `v_event.currency IS NOT NULL AND v_event.currency <>
        // v_intent.currency`; a fabricated code cannot detect a real mismatch, it can
        // only compare equal by luck in a PLN deployment or raise a *false*
        // `payment_control_result_currency_mismatch` in one that settles elsewhere and
        // refuse a legitimate payment. Skipping a comparison nobody can make beats
        // making one against an invented value.
        currency: payload.tr_currency ?? null,
        status: rawStatus,
        testMode: payload.test_mode ?? null,
      },
    },
    methodRef: null,
    methodLifecycleKind: null,
    responseBody: "TRUE",
  };
}

function normalizeAliasWebhook(payload: Record<string, string>): NormalizedTpayWebhook {
  const aliasValue = required(payload, "msg_value[value]");
  // Tpay sends alias event names UPPERCASE; normalize defensively so the
  // classification can never be defeated by casing (see tr_status above).
  const event = required(payload, "event").toUpperCase();
  const active = event === "ALIAS_REGISTER" || event === "ALIAS_UPDATE";
  const paymentIntentId = paymentIntentIdFromAlias(aliasValue);
  return {
    event: {
      provider_event_id: `${event}:${aliasValue}`,
      event_type: active ? "setup.succeeded" : "setup.failed",
      payment_provider_id: aliasValue,
      payment_intent_id: paymentIntentId,
      raw_payload: {
        provider: PROVIDER_KIND,
        eventKind: "blik_alias",
        event,
        paymentIntentId,
        aliasValuePresent: true,
        aliasType: payload["msg_value[type]"] ?? null,
        aliasExpirationDatePresent: Boolean(payload["msg_value[expirationDate]"]),
      },
    },
    methodRef: {
      clientId: payload.client_id ?? null,
      subscriptionId: payload.subscription_id ?? null,
      providerMethodRef: aliasValue,
      methodKind: "blik_payid",
      status: active ? "active" : "inactive",
      consentSnapshot: { source: "tpay.alias.webhook", event },
    },
    methodLifecycleKind: ALIAS_LIFECYCLE_KINDS[event] ?? null,
    responseBody: "TRUE",
  };
}

function toReusableMethod(
  methodRef: NormalizedTpayMethodRef | null,
): NormalizedTpayProviderWebhook["reusableMethod"] {
  if (!methodRef?.clientId) return null;
  return {
    clientId: methodRef.clientId,
    subscriptionId: methodRef.subscriptionId ?? null,
    providerCustomerRef: null,
    providerMethodRef: methodRef.providerMethodRef,
    providerMandateRef: null,
    methodKind: methodRef.methodKind,
    status: methodRef.status,
    consentSnapshot: methodRef.consentSnapshot,
  };
}

function readCurrency(payload: Record<string, unknown>): string | null {
  const currency = payload.currency;
  return typeof currency === "string" && currency.trim() ? currency : null;
}

function parsePayload(rawBody: string): Record<string, string> {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return flattenJson(parsed);
  }
  const params = new URLSearchParams(rawBody);
  return Object.fromEntries(Array.from(params.entries()));
}

function flattenJson(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      Object.assign(out, flattenJson(raw as Record<string, unknown>, name));
    } else if (raw !== undefined && raw !== null) {
      out[name] = String(raw);
    }
  }
  return out;
}

function required(payload: Record<string, string>, key: string): string {
  const value = payload[key];
  if (!value) throw new Error(`tpay_webhook_missing_${key}`);
  return value;
}

function amountToMinor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value.replace(",", "."));
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : undefined;
}

function paymentIntentIdFromAlias(value: string): string | null {
  const match = /^openlup_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function parseUuid(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed.toLowerCase()
    : null;
}
