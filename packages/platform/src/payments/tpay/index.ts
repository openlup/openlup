import { createHash, X509Certificate } from "node:crypto";
import { classifyPaymentFailure, isPaymentRetryAdviceCode } from "@openlup/core/payment";
import type { PaymentAdapter, PaymentAdapterCapabilities, PaymentAttemptPort, PaymentExecutionEnvelope,
  PaymentReadbackEnvelope, PaymentRefusalEnvelope, PaymentVerifyNormalizePort,
  VerifiedMethodEvidence, VerifiedPaymentEvidence } from "../contracts/index.js";
import type { PaymentExecutionInput, PaymentExecutionResult } from "./donorContracts.js";
import { createTpayHttpClient } from "./tpayHttpClient.js";
import { createTpayPaymentExecutionAdapter } from "./tpayPaymentExecutionAdapter.js";
import { ProviderAttemptPreDispatchError } from "./preparedProviderAttempt.js";
import { createTpayPaymentReconciliationProvider } from "./tpayPaymentReconciliationProvider.js";
import { verifyTpayJwsSignature, type TpayJwsCertificateResolver } from "./webhookJwsVerifier.js";
import { normalizeTpayWebhook, toNormalizedProviderTpayWebhook } from "./webhookNormalizer.js";

/** Explicit host configuration. clock returns UTC seconds; imports perform no I/O. */
export interface TpayPaymentAdapterConfig {
  http: { baseUrl: string; clientId: string; clientSecret: string; fetchImpl: (url: string, init?: {
    method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
  }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>; timeoutMs?: number };
  notification: {
    rootCertificatePem: string;
    /** HTTPS certificate directory ending in a slash; resolver must enforce redirect/egress policy. */
    allowedCertificateUrlPrefix: string;
    resolveCertificate: TpayJwsCertificateResolver;
    /** Seven days by default: generous retry allowance assumed until provider schedule is established. */
    maxNotificationAgeSeconds?: number;
    /** Maximum future signed issue time relative to receipt; defaults to 300 seconds. */
    maxClockSkewSeconds?: number;
  };
  urls: { notificationUrl: string; successUrl: string; errorUrl: string };
  modelOActivationEnabled: boolean;
  mode: "live" | "test";
  clock?: () => number;
}

/** Bank-redirect, one-time-code and unattended Model O attempts are supported with host payer/method input; account availability remains verification_pending. */
export const tpayPaymentCapabilities: Readonly<PaymentAdapterCapabilities> = Object.freeze<PaymentAdapterCapabilities>({
  providerKind: "tpay",
  captureFlows: Object.freeze([
    Object.freeze({ kind: "bank_redirect", handoff: "redirect", methodFamilies: Object.freeze(["bank-redirect"] as const) }),
    Object.freeze({ kind: "one_time_code", handoff: "customer-authorization", methodFamilies: Object.freeze(["one-time-code"] as const) }),
  ]),
  requiresStoredMandateEvidence: true,
  assessMandate: snapshot => snapshot.recurringModel === "O" ? { chargeable: true }
    : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
  unattendedChargeFlow: "recurring_charge",
  payerContext: Object.freeze({ requiresPayerBlock: true, customerRefFallsBackToContactEmail: false }),
  methodHealth: Object.freeze({ requiresCustomerRef: false, requiredMethodKind: "blik_payid", requiresPayerContact: true }),
  terminalOutcomeReporting: Object.freeze({ kind: "attempt_records", silenceBecomesSuspectAfterMinutes: 360 }),
  mandateUpsertIsSubscriptionScoped: true,
  supportedCurrencies: Object.freeze(["PLN"]), unattended: "supported", readback: "supported", close: "unsupported",
  exactAbsence: "unsupported", refundObservation: "supported", refundCreate: "unsupported", authorizationCaptureSplit: "unsupported",
});

type Verification = Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>>;
const refusal = (reason: Extract<Verification, { kind: "refusal" }>["reason"]): Verification => ({ kind: "refusal", reason });

/** Construction explicitly selects this adapter; the host owns account activation and I/O policy. */
export function createTpayPaymentAdapter(config: TpayPaymentAdapterConfig): PaymentAdapter {
  const notification = config.notification;
  if (!notification?.rootCertificatePem || typeof notification.resolveCertificate !== "function") throw new Error("Required certificate configuration missing");
  const prefix = new URL(notification.allowedCertificateUrlPrefix);
  if (prefix.protocol !== "https:" || prefix.username || prefix.password || prefix.search || prefix.hash
    || !notification.allowedCertificateUrlPrefix.endsWith("/")) throw new Error("Invalid certificate URL prefix");
  const root = new X509Certificate(notification.rootCertificatePem);
  const maxAge = notification.maxNotificationAgeSeconds ?? 7 * 24 * 60 * 60;
  const maxClockSkew = notification.maxClockSkewSeconds ?? 300;
  if (!Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(maxClockSkew) || maxClockSkew < 0 || !["test", "live"].includes(config.mode)
    || typeof config.http.fetchImpl !== "function" || !config.http.clientId || !config.http.clientSecret
    || typeof config.modelOActivationEnabled !== "boolean") throw new Error("Invalid payment configuration");
  for (const url of [config.http.baseUrl, ...Object.values(config.urls)]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid payment URL");
  }
  const now = config.clock ?? (() => Date.now() / 1000);
  const client = createTpayHttpClient({ ...config.http, now: () => now() * 1000 });
  const execution = createTpayPaymentExecutionAdapter({ client, ...config.urls,
    modelOActivationEnabled: config.modelOActivationEnabled });
  const reconciliation = createTpayPaymentReconciliationProvider(client);
  const donorInput = (input: Parameters<PaymentAttemptPort["execute"]>[0]): PaymentExecutionInput => {
    if (input.mode !== config.mode || !["initial", "recovery", "renewal-unattended"].includes(input.purpose)
      || !input.attemptRef || !input.intentRef || !input.fingerprint || !input.providerIdempotencyKey
      || !Number.isSafeInteger(input.money.amountMinor) || input.money.amountMinor <= 0 || input.money.currency !== "PLN"
      || !input.payer?.email || (input.payer.name !== undefined && typeof input.payer.name !== "string")) {
      throw new Error("Invalid payment input");
    }
    const renewal = input.purpose === "renewal-unattended";
    const family = input.methodSelection?.family;
    if (renewal ? !input.storedMethod?.reference || input.storedMethod.mandate.recurringModel !== "O"
      || input.customerAuthorization !== undefined
      : family !== "bank-redirect" && family !== "one-time-code") throw new Error("Unsupported payment flow");
    if (!renewal && (family === "bank-redirect" ? !input.methodSelection?.channelRef || input.customerAuthorization !== undefined
      : !input.customerAuthorization)) throw new Error("Required payment context missing");
    return {
      idempotencyKey: input.attemptRef, providerIdempotencyKey: input.providerIdempotencyKey,
      providerRequestFingerprint: input.fingerprint, paymentIntentId: input.intentRef, orderRef: input.intentRef,
      amountMinor: input.money.amountMinor, currency: input.money.currency,
      mode: renewal ? "subscription_cycle" : "one_time",
      payer: { email: input.payer.email, name: input.payer.name?.trim() ? input.payer.name : "Customer" },
      ...(renewal ? { providerFlow: "recurring_charge", paymentMethodRef: input.storedMethod!.reference,
        paymentMethodAliasType: "PAYID", paymentMethodRecurringModel: "O" } : {
        transientProviderInput: family === "bank-redirect"
          ? { provider: "tpay", flow: "pbl_one_time", channelId: input.methodSelection!.channelRef }
          : { provider: "tpay", flow: "blik_one_time", blikToken: input.customerAuthorization },
      }),
    };
  };
  const validateInput = (input: Parameters<PaymentAttemptPort["execute"]>[0]): void => { execution.validateInput?.(donorInput(input)); };
  return {
    capabilities: tpayPaymentCapabilities,
    attemptPort: {
      validateInput,
      async execute(input: Parameters<PaymentAttemptPort["execute"]>[0]): Promise<PaymentExecutionEnvelope> {
        let prepared: PaymentExecutionInput;
        try { prepared = donorInput(input); execution.validateInput?.(prepared); }
        catch {
          const reason: PaymentRefusalEnvelope = { code: "fix_and_retry_customer_action", hints: ["dataInvalid"] };
          return { outcome: { kind: "decline", refusal: reason },
            dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason } }, diagnostics: {} };
        }
        let result: PaymentExecutionResult;
        try { result = await execution.execute(prepared); }
        catch (error) {
          if (!(error instanceof ProviderAttemptPreDispatchError)) throw error;
          // The donor retries this closed no-charge lane; ambiguous failures still throw.
          const hints: PaymentRefusalEnvelope["hints"] = ["transient"];
          const reason: PaymentRefusalEnvelope = { code: classifyPaymentFailure({ neutralReasonHints: hints }).failureClass, hints };
          return { outcome: { kind: "decline", refusal: reason },
            dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason } }, diagnostics: {} };
        }
        // Only these neutral facts cross the boundary; donor payloads and transient payer/authorization stay local.
        return {
          outcome: result.providerDecline ? { kind: "decline", refusal: neutralDecline(result.providerDecline) }
            : { kind: "attempt", status: result.attemptStatus },
          // API transaction ID is required for readback; notification titles remain distinct.
          dispatch: result.providerSessionId ? { kind: "dispatched", providerPaymentRef: result.providerSessionId } : { kind: "unknown" },
          ...(result.nextActionKind === "redirect" && result.redirectUrl
            ? { handoff: { kind: "redirect" as const, url: result.redirectUrl } } : {}),
          diagnostics: { webhookExpected: result.webhookExpected === true, recoveryRequired: result.recoveryRequired === true },
        };
      },
    },
    verifyPort: {
      async verifyAndNormalize(input) {
        const header = Object.entries(input.headers).find(([key]) => key.toLowerCase() === "x-jws-signature")?.[1];
        if (typeof header !== "string") return refusal("signature");
        const rawBody = Buffer.from(input.rawBody).toString("utf8");
        if (!Buffer.from(rawBody).equals(Buffer.from(input.rawBody))) return refusal("malformed");
        try {
          const current = now() * 1000;
          if (!validAt(root, current)) return refusal("signature");
          const verified = await verifyTpayJwsSignature({ rawBody, signatureHeader: header,
            rootCertificatePem: notification.rootCertificatePem, allowedX5uPrefix: notification.allowedCertificateUrlPrefix,
            resolveCertificate: async url => {
              const pem = await notification.resolveCertificate(url);
              if (!validAt(new X509Certificate(pem), current)) throw new Error("Certificate outside validity window");
              return pem;
            } });
          if (!verified) return refusal("signature");
        } catch { return refusal("signature"); }
        try {
          // Only a signed protected-header issued-at assertion supplies notification time.
          const protectedHeader = JSON.parse(Buffer.from(header.split(".")[0]!, "base64url").toString("utf8")) as { iat?: unknown };
          const asserted = protectedHeader.iat;
          if (asserted !== undefined && (typeof asserted !== "number" || !Number.isFinite(asserted)
            || !Number.isFinite(new Date(asserted * 1000).getTime()))) return refusal("malformed");
          const occurred = typeof asserted === "number" ? new Date(asserted * 1000).toISOString() : null;
          if (occurred !== null) {
            const received = Date.parse(input.receivedAt) / 1000;
            if (!Number.isFinite(received)) return refusal("malformed");
            if (received - (asserted as number) > maxAge || (asserted as number) - received > maxClockSkew) return refusal("stale");
          }
          return mapVerifiedTpayEvent(rawBody, occurred, config.mode);
        } catch { return refusal("malformed"); }
      },
    },
    readbackPort: {
      async readPayment(input) {
        const base = { identity: input.identity, expectedMoney: input.expectedMoney, purpose: input.purpose };
        if (input.identity.provider !== "tpay" || !input.identity.providerPaymentRef) return { ...base, kind: "unsupported" };
        try {
          const reading = await reconciliation.readRecoveryPayment({
            providerPaymentId: input.identity.providerPaymentRef, purpose: input.purpose, attempt: input.expectedMoney,
          });
          const observed = reading.status;
          if (!reading.identityMatches || !reading.configuredMoneyMatches || reading.manualReviewRequired
            || !Number.isSafeInteger(input.expectedMoney.amountMinor) || input.expectedMoney.amountMinor <= 0
            || observed.status === "unknown") return unknown(base);
          // Success must match paid money; pending/refused identify the configured obligation even when unpaid.
          if (observed.status === "succeeded" && (observed.amountMinor !== input.expectedMoney.amountMinor
            || observed.currency !== input.expectedMoney.currency.toUpperCase())) return unknown(base);
          return { ...base, kind: observed.status, observedMoney: { amountMinor: input.expectedMoney.amountMinor,
            currency: input.expectedMoney.currency.toUpperCase() },
            providerOccurredAt: observed.occurredAt };
        } catch { return unknown(base); }
      },
    },
  };
}

function neutralDecline(decline: NonNullable<PaymentExecutionResult["providerDecline"]>): PaymentRefusalEnvelope {
  const hints = decline.neutralReasonHints ?? [];
  return { code: classifyPaymentFailure({ adviceCode: decline.adviceCode, neutralReasonHints: hints }).failureClass, hints,
    ...(decline.adviceCode && isPaymentRetryAdviceCode(decline.adviceCode) ? { adviceCode: decline.adviceCode } : {}) };
}

function validAt(certificate: X509Certificate, instant: number): boolean {
  return Number.isFinite(instant) && Date.parse(certificate.validFrom) <= instant && instant <= Date.parse(certificate.validTo);
}
function unknown(base: Pick<PaymentReadbackEnvelope, "identity" | "expectedMoney" | "purpose">): PaymentReadbackEnvelope {
  return { ...base, kind: "unknown", reason: "indeterminate" };
}

/** All donor outcomes outside the current neutral union are refused here. */
function mapTpayOutcome(event: string): VerifiedPaymentEvidence["outcome"] | null {
  switch (event) {
    case "payment.succeeded": return "succeeded";
    case "payment.failed": return "failed";
    case "payment.requires_action": return "pending";
    case "payment.refunded": return "refunded";
    default: return null;
  }
}
function mapVerifiedTpayEvent(rawBody: string, occurred: string | null, mode: "live" | "test"): Verification {
  const webhook = normalizeTpayWebhook(rawBody);
  const event = webhook.event;
  const payload = event.raw_payload;
  if (payload.testMode !== null && payload.testMode !== undefined
    && payload.testMode !== (mode === "test" ? "1" : "0")) return refusal("unsupported-event");
  const identity = { provider: "tpay", providerOccurredAt: occurred };
  let evidence: Omit<VerifiedPaymentEvidence, "fingerprint"> | Omit<VerifiedMethodEvidence, "fingerprint">;
  if (payload.eventKind === "blik_alias") {
    const kinds: Record<string, VerifiedMethodEvidence["outcome"]> = {
      method_registered: "registered", method_updated: "updated", method_revoked: "revoked", method_expired: "expired",
    };
    const outcome = kinds[webhook.methodLifecycleKind ?? ""];
    if (!outcome) return refusal("unsupported-event");
    const lifecycle = occurred !== null ? toNormalizedProviderTpayWebhook(webhook, occurred).methodLifecycle : null;
    evidence = { ...identity, kind: "method", outcome, providerEventId: `${event.provider_event_id}:${outcome}`,
      methodRef: event.payment_provider_id, setupRef: null, intentRef: event.payment_intent_id ?? null,
      ...(lifecycle ? { methodLifecycle: lifecycle } : {}) };
  } else {
    const outcome = mapTpayOutcome(event.event_type);
    if (!outcome) return refusal("unsupported-event");
    const amount = event.amount_minor;
    const currency = payload.currency;
    const money = Number.isSafeInteger(amount) && amount! > 0 && typeof currency === "string" && /^[A-Za-z]{3}$/u.test(currency)
      ? { amountMinor: amount!, currency: currency.toUpperCase() } : null;
    const originalAmount = typeof payload.transactionAmount === "string"
      ? Math.round(Number(payload.transactionAmount.replace(",", ".")) * 100) : NaN;
    if (outcome === "refunded" && (!money || !Number.isSafeInteger(originalAmount) || originalAmount <= 0)) return refusal("malformed");
    evidence = { ...identity, kind: "money", providerEventId: `${event.payment_provider_id}:${outcome}`,
      providerPaymentRef: event.payment_provider_id, intentRef: event.payment_intent_id ?? null, attemptRef: null, outcome, money,
      ...(outcome === "refunded" && money ? { refund: { kind: "full-reversal" as const, reason: "chargeback" as const,
        operationId: `${event.payment_provider_id}:chargeback`, originalPaymentMoney: { amountMinor: originalAmount, currency: money.currency } } } : {}),
    };
  }
  return { ...evidence, fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    providerAuditPayload: payload };
}
