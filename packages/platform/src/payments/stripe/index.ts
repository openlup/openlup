import { createHash } from "node:crypto";
import { classifyPaymentFailure, isPaymentRetryAdviceCode } from "@openlup/core/payment";
import type {
  PaymentAdapter, PaymentAdapterCapabilities, PaymentAttemptPort, PaymentReadbackEnvelope,
  PaymentReadbackPort, PaymentRefusalEnvelope, PaymentVerifyNormalizePort, TransientSecret,
  VerifiedMethodEvidence, VerifiedPaymentEvidence,
} from "../contracts/index.js";
import { createStripeSandboxPaymentExecutionAdapter, type StripeSandboxClient } from "./stripeSandboxPaymentExecutionAdapter.js";
import { createStripePaymentReconciliationProvider, type StripePaymentIntentReader } from "./stripePaymentReconciliationProvider.js";
import { normalizeStripeWebhookEvent } from "./stripeWebhookNormalizer.js";
import { verifyStripeSignature } from "./webhookSignature.js";
import { declineCodeHints } from "./declineFailureHints.js";
import type { PaymentExecutionResult } from "./donorContracts.js";

/** Host-owned client, credentials, SDK construction and mode policy. clock returns UTC seconds. */
export interface StripePaymentAdapterConfig {
  client: Omit<StripeSandboxClient, "createSetupIntent"> & Partial<Pick<StripeSandboxClient, "createSetupIntent">> & StripePaymentIntentReader;
  webhookSigningSecrets: readonly string[];
  mode: "live" | "test";
  supportedCurrencies: readonly string[];
  toleranceSeconds?: number;
  clock?: () => number;
}

/** Observed protocol capabilities; account activation remains host-owned. */
export const stripePaymentCapabilities: PaymentAdapterCapabilities = {
  providerKind: "stripe",
  captureFlows: [{ kind: "card_payment", handoff: "client-confirmed", methodFamilies: ["card", "wallet"] }],
  requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }),
  unattendedChargeFlow: "off_session_payment",
  payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
  methodHealth: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
  mandateUpsertIsSubscriptionScoped: false,
  /** declared by the host through the adapter config */
  supportedCurrencies: [],
  unattended: "supported", readback: "supported", close: "unsupported", exactAbsence: "unsupported",
  refundObservation: "supported", refundCreate: "unsupported", authorizationCaptureSplit: "unsupported",
};

type VerificationResult = Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>>;
const refusal = (reason: Extract<VerificationResult, { kind: "refusal" }>["reason"]): VerificationResult => ({ kind: "refusal", reason });

/** Explicit construction is the only activation point; importing performs no I/O. */
export function createStripePaymentAdapter(config: StripePaymentAdapterConfig): PaymentAdapter {
  if (config.mode !== "live" && config.mode !== "test") throw new Error("Invalid payment mode");
  const supportedCurrencies = config.supportedCurrencies;
  if (!Array.isArray(supportedCurrencies) || supportedCurrencies.length === 0
    || ![...supportedCurrencies].every(currency => typeof currency === "string" && currency.length === 3 && /^[A-Z]{3}$/u.test(currency))) {
    throw new Error("Invalid supported currencies");
  }
  const tolerance = config.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Invalid signature tolerance");
  const secrets = [...config.webhookSigningSecrets];
  const now = config.clock ?? (() => Math.floor(Date.now() / 1000));
  const execution = createStripeSandboxPaymentExecutionAdapter({ client: {
    createPaymentIntent: config.client.createPaymentIntent.bind(config.client),
    createSetupIntent: inputSetup,
    ensureCustomer: config.client.ensureCustomer?.bind(config.client),
  } });
  function inputSetup(...args: Parameters<StripeSandboxClient["createSetupIntent"]>) {
    if (!config.client.createSetupIntent) throw new Error("Method setup unsupported by injected client");
    return config.client.createSetupIntent(...args);
  }
  const reader = createStripePaymentReconciliationProvider(config.client);
  const validateInput: PaymentAttemptPort["validateInput"] = input => {
    if (input.mode !== config.mode || !["initial", "recovery", "renewal-unattended"].includes(input.purpose)
      || !input.attemptRef || !input.intentRef || !input.fingerprint || !input.providerIdempotencyKey
      || !Number.isSafeInteger(input.money.amountMinor) || input.money.amountMinor <= 0
      || !supportedCurrencies.includes(input.money.currency)
      || input.customerAuthorization !== undefined
      || (input.purpose === "renewal-unattended" && !input.storedMethod?.reference)) {
      throw new Error("Unsupported payment input");
    }
  };
  const read: PaymentReadbackPort["readPayment"] = async input => {
    const base = { identity: input.identity, expectedMoney: input.expectedMoney, purpose: input.purpose };
    if (input.identity.provider !== "stripe" || !input.identity.providerPaymentRef) return { ...base, kind: "unsupported" };
    try {
      // Bind the response to the requested remote object before translating status.
      const intent = await config.client.retrievePaymentIntent(input.identity.providerPaymentRef);
      if (intent.id !== input.identity.providerPaymentRef || intent.amount !== input.expectedMoney.amountMinor
        || intent.currency?.toUpperCase() !== input.expectedMoney.currency.toUpperCase()) {
        return { ...base, kind: "unknown", reason: "indeterminate" };
      }
      const status = await createStripePaymentReconciliationProvider({ retrievePaymentIntent: async () => intent })
        .readPayment({ providerPaymentId: input.identity.providerPaymentRef, purpose: input.purpose });
      return readback(base, status);
    } catch { return { ...base, kind: "unknown", reason: "indeterminate" }; }
  };
  return {
    capabilities: { ...stripePaymentCapabilities, supportedCurrencies, close: config.client.cancelPaymentIntent ? "supported" : "unsupported" },
    attemptPort: {
      validateInput,
      async execute(input) {
        validateInput(input);
        const result = await execution.execute({
          idempotencyKey: input.attemptRef, providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.fingerprint, paymentIntentId: input.intentRef,
          amountMinor: input.money.amountMinor, currency: input.money.currency,
          mode: input.purpose === "renewal-unattended" ? "subscription_cycle" : "one_time",
          orderRef: input.intentRef,
          providerFlow: input.purpose === "renewal-unattended" ? "off_session_payment" : "one_time_payment",
          paymentMethodRef: input.storedMethod?.reference,
        });
        return {
          outcome: result.providerDecline
            ? { kind: "decline", refusal: neutralDecline(result.providerDecline) }
            : { kind: "attempt", status: result.attemptStatus },
          // A synchronous issuer decline is not proof of a pre-dispatch refusal.
          dispatch: result.providerAttemptId ? { kind: "dispatched", providerPaymentRef: result.providerAttemptId } : { kind: "unknown" },
          ...(result.clientSecret ? { handoff: { kind: "client-confirmed", payload: result.clientSecret as TransientSecret } as const } : {}),
          diagnostics: { webhookExpected: result.webhookExpected === true, recoveryRequired: result.recoveryRequired === true },
        };
      },
    },
    verifyPort: {
      async verifyAndNormalize(input) {
        const header = Object.entries(input.headers).find(([key]) => key.toLowerCase() === "stripe-signature")?.[1];
        if (typeof header !== "string") return refusal("signature");
        const parts = Object.fromEntries(header.split(",").map(part => part.split("=")).filter(([key, value]) => key && value));
        const timestamp = Number(parts.t);
        const current = now();
        if (!parts.t || !parts.v1 || !Number.isFinite(timestamp) || !Number.isFinite(current)) return refusal("signature");
        // The preserved verifier supplies HMAC and comparison; this layer owns configurable freshness.
        if (Math.abs(current - timestamp) > tolerance) return refusal("stale");
        const rawBody = Buffer.from(input.rawBody).toString("utf8");
        if (!Buffer.from(rawBody).equals(Buffer.from(input.rawBody))) return refusal("malformed");
        if (!verifyStripeSignature({ rawBody, signatureHeader: header, endpointSecret: secrets, now: () => timestamp })) return refusal("signature");
        try {
          const raw: unknown = JSON.parse(rawBody);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refusal("malformed");
          const event = raw as Record<string, unknown>;
          if (typeof event.livemode === "boolean" && event.livemode !== (config.mode === "live")) return refusal("unsupported-event");
          return mapVerifiedStripeEvent(event);
        } catch { return refusal("malformed"); }
      },
    },
    readbackPort: {
      readPayment: read,
      ...(reader.closePayment ? { close: async (input: Parameters<PaymentReadbackPort["readPayment"]>[0]): Promise<PaymentReadbackEnvelope> => {
        const base = { identity: input.identity, expectedMoney: input.expectedMoney, purpose: input.purpose };
        if (input.identity.provider !== "stripe" || !input.identity.providerPaymentRef) return { ...base, kind: "unsupported" };
        try {
          // Check configured money and object identity before a destructive provider operation.
          const before = await read(input);
          if (before.kind === "unknown" || before.kind === "unsupported") return before;
          await reader.closePayment!({ providerPaymentId: input.identity.providerPaymentRef });
          return read(input);
        } catch { return { ...base, kind: "unknown", reason: "indeterminate" }; }
      } } : {}),
    },
  };
}

function neutralDecline(decline: NonNullable<PaymentExecutionResult["providerDecline"]>): PaymentRefusalEnvelope {
  const hints = decline.neutralReasonHints ?? [];
  const classified = classifyPaymentFailure({ adviceCode: decline.adviceCode, neutralReasonHints: hints });
  return { code: classified.failureClass, hints,
    ...(decline.adviceCode && isPaymentRetryAdviceCode(decline.adviceCode) ? { adviceCode: decline.adviceCode } : {}) };
}

function readback(base: Pick<PaymentReadbackEnvelope, "identity" | "expectedMoney" | "purpose">,
  status: Awaited<ReturnType<ReturnType<typeof createStripePaymentReconciliationProvider>["readPayment"]>>): PaymentReadbackEnvelope {
  if (status.status === "unknown" || status.amountMinor === null || !Number.isSafeInteger(status.amountMinor) || !status.currency) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }
  return { ...base, kind: status.status, observedMoney: { amountMinor: status.amountMinor, currency: status.currency }, providerOccurredAt: status.occurredAt };
}

/** Keep outcomes outside the current M07 union in this single refusal mapping. */
function mapStripeOutcome(eventType: string): VerifiedPaymentEvidence["outcome"] | null {
  switch (eventType) {
    case "payment.succeeded": return "succeeded";
    case "payment.failed": return "failed";
    case "payment.refunded": return "refunded";
    case "payment.requires_action": return "pending";
    case "payment.disputed": return null;
    default: return null;
  }
}

function mapVerifiedStripeEvent(raw: Record<string, unknown>): VerificationResult {
  let normalized: ReturnType<typeof normalizeStripeWebhookEvent>;
  try { normalized = normalizeStripeWebhookEvent(raw); }
  catch (error) {
    return refusal(error instanceof Error && error.message.startsWith("Unsupported Stripe webhook event:") ? "unsupported-event" : "malformed");
  }
  const object = (raw.data as { object: Record<string, unknown> }).object;
  const occurred = typeof raw.created === "number" && Number.isFinite(raw.created)
    ? normalized.occurredAt : typeof raw.created === "string" && Number.isFinite(Date.parse(raw.created)) ? normalized.occurredAt : null;
  const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as Record<string, unknown> : {};
  const intentRef = typeof metadata.paymentIntentId === "string" ? metadata.paymentIntentId : null;
  const identity = { provider: "stripe", providerEventId: normalized.providerEventId,
    providerOccurredAt: occurred };
  let result: Omit<VerifiedMethodEvidence, "fingerprint"> | Omit<VerifiedPaymentEvidence, "fingerprint">;
  if (normalized.methodLifecycle || normalized.eventType.startsWith("setup.")) {
    const lifecycle = normalized.methodLifecycle;
    const method = lifecycle?.providerMethodRef ?? (typeof object.payment_method === "string" ? object.payment_method
      : object.payment_method && typeof object.payment_method === "object" ? (object.payment_method as { id?: unknown }).id : null);
    if (typeof method !== "string" || !method) return refusal("unsupported-event");
    const outcomes: Record<string, VerifiedMethodEvidence["outcome"]> = {
      method_registered: "registered", method_updated: "updated", method_revoked: "revoked", method_expired: "expired", method_suspended: "suspended",
      "setup.succeeded": "registered", "setup.failed": "failed", "setup.requires_action": "requires-action",
    };
    const outcome = outcomes[lifecycle?.kind ?? normalized.eventType];
    if (!outcome) return refusal("unsupported-event");
    result = { ...identity, kind: "method", outcome, methodRef: method,
      setupRef: typeof raw.type === "string" && raw.type.startsWith("setup_intent.") ? normalized.providerPaymentId : null, intentRef };
  } else {
    const outcome = mapStripeOutcome(normalized.eventType);
    if (!outcome) return refusal("unsupported-event");
    const money = Number.isSafeInteger(normalized.amountMinor) && normalized.amountMinor! > 0 && normalized.currency
      ? { amountMinor: normalized.amountMinor!, currency: normalized.currency } : null;
    const snapshot = normalized.rawPayload.stripeRefundSnapshot as { chargeId: string; amountRefundedMinor: number } | undefined;
    if (outcome === "refunded" && (!snapshot || !money)) return refusal("malformed");
    result = { ...identity, kind: "money", providerPaymentRef: normalized.providerPaymentId, intentRef, attemptRef: null, outcome, money,
      ...(snapshot && money ? { refund: { kind: "cumulative-snapshot" as const, operationId: snapshot.chargeId,
        originalPaymentMoney: money, refundedMoney: { amountMinor: snapshot.amountRefundedMinor, currency: money.currency } } } : {}),
      ...(outcome === "failed" && object.last_payment_error && typeof object.last_payment_error === "object"
        ? { refusal: neutralDecline({ code: "provider_declined", mandateUnsupported: false,
          neutralReasonHints: declineCodeHints((object.last_payment_error as { decline_code?: string }).decline_code),
          adviceCode: typeof (object.last_payment_error as { advice_code?: unknown }).advice_code === "string"
            ? (object.last_payment_error as { advice_code: string }).advice_code : undefined }) } : {}),
    };
  }
  return { ...result, fingerprint: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
