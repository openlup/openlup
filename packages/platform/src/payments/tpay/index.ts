import { createHash, X509Certificate } from "node:crypto";
import type { PaymentAdapter, PaymentAdapterCapabilities, PaymentReadbackEnvelope, PaymentVerifyNormalizePort,
  VerifiedMethodEvidence, VerifiedPaymentEvidence } from "../contracts/index.js";
import { createTpayHttpClient } from "./tpayHttpClient.js";
import { createTpayPaymentReconciliationProvider } from "./tpayPaymentReconciliationProvider.js";
import { verifyTpayJwsSignature, type TpayJwsCertificateResolver } from "./webhookJwsVerifier.js";
import { normalizeTpayWebhook } from "./webhookNormalizer.js";

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
  };
  urls: { notificationUrl: string; successUrl: string; errorUrl: string };
  modelOActivationEnabled: boolean;
  mode: "live" | "test";
  clock?: () => number;
}

/** Observed protocol offers; account-dependent availability remains verification_pending. */
export const tpayPaymentCapabilities: PaymentAdapterCapabilities = {
  providerKind: "tpay",
  captureFlows: [
    { kind: "bank_redirect", handoff: "redirect", methodFamilies: ["bank-redirect"] },
    { kind: "one_time_code", handoff: "customer-authorization", methodFamilies: ["one-time-code"] },
    { kind: "scheme_alias_registration", handoff: "customer-authorization", methodFamilies: ["one-time-code"] },
  ],
  requiresStoredMandateEvidence: true,
  assessMandate: snapshot => snapshot.recurringModel === "O" ? { chargeable: true }
    : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
  unattendedChargeFlow: "recurring_charge",
  payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: false },
  methodHealth: { requiresCustomerRef: false, requiredMethodKind: "blik_payid", requiresPayerContact: true },
  terminalOutcomeReporting: { kind: "attempt_records", silenceBecomesSuspectAfterMinutes: 360 },
  mandateUpsertIsSubscriptionScoped: true,
  supportedCurrencies: ["PLN"], unattended: "supported", readback: "supported", close: "unsupported",
  exactAbsence: "unsupported", refundObservation: "supported", refundCreate: "unsupported", authorizationCaptureSplit: "unsupported",
};

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
  if (!Number.isFinite(maxAge) || maxAge < 0 || !["test", "live"].includes(config.mode)
    || typeof config.http.fetchImpl !== "function" || !config.http.clientId || !config.http.clientSecret
    || typeof config.modelOActivationEnabled !== "boolean") throw new Error("Invalid payment configuration");
  for (const url of [config.http.baseUrl, ...Object.values(config.urls)]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid payment URL");
  }
  const now = config.clock ?? (() => Date.now() / 1000);
  const client = createTpayHttpClient({ ...config.http, now: () => now() * 1000 });
  return {
    capabilities: tpayPaymentCapabilities,
    // Coordinator decision pending: the fixed M07 input has no payer/channel fields.
    // Never manufacture payer context to dispatch an attempt.
    attemptPort: {
      validateInput() { throw new Error("Explicit payer and flow context required"); },
      async execute() { throw new Error("Explicit payer and flow context required"); },
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
            if (received - (asserted as number) > maxAge) return refusal("stale");
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
          const transaction = await client.getTransaction(input.identity.providerPaymentRef);
          const observed = await createTpayPaymentReconciliationProvider({ getTransaction: async () => transaction }).readPayment({
            providerPaymentId: input.identity.providerPaymentRef, purpose: input.purpose,
          });
          const configured = Math.round(Number(transaction.amount) * 100);
          if (transaction.transactionId !== input.identity.providerPaymentRef || !Number.isSafeInteger(configured)
            || configured <= 0 || configured !== input.expectedMoney.amountMinor
            || transaction.currency?.toUpperCase() !== input.expectedMoney.currency.toUpperCase()
            || !observed.amountMinor || !Number.isSafeInteger(observed.amountMinor) || !observed.currency
            || observed.status === "unknown") return unknown(base);
          return { ...base, kind: observed.status, observedMoney: { amountMinor: observed.amountMinor, currency: observed.currency },
            providerOccurredAt: observed.occurredAt };
        } catch { return unknown(base); }
      },
    },
  };
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
    evidence = { ...identity, kind: "method", outcome, providerEventId: `${event.provider_event_id}:${outcome}`,
      methodRef: event.payment_provider_id, setupRef: null, intentRef: event.payment_intent_id ?? null };
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
  return { ...evidence, fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
