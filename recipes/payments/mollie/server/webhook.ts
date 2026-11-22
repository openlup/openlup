import { createHash } from "node:crypto";
import { classifyPaymentFailure, type PaymentFailureHint } from "@openlup/core/payment";
import { MAX_WEBHOOK_BODY_BYTES } from "@openlup/platform/http";
import type {
  PaymentMoney,
  PaymentRefundObservation,
  PaymentRefusalEnvelope,
  PaymentVerifyNormalizePort,
  VerifiedPaymentEvidence,
  VerifiedReusableMethod,
} from "@openlup/platform/payments/contracts";
import {
  assertSafeMolliePaymentId,
  majorStringToMinor,
  MollieTransportError,
  type MollieClient,
  type MolliePaymentStatus,
} from "./client-contract.js";

export interface MollieWebhookVerifierConfig {
  mode: "live" | "test";
  client: Pick<MollieClient, "getPayment">;
  supportedCurrencies: readonly string[];
  maxBodyBytes?: number;
}

type VerificationResult = Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>>;

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

const refusal = (
  reason: Extract<VerificationResult, { kind: "refusal" }>["reason"],
): VerificationResult => ({ kind: "refusal", reason });

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function readMetadataString(
  metadata: Readonly<Record<string, string>> | null | undefined,
  key: string,
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function deriveMollieFailureHints(
  status: MolliePaymentStatus | string,
  details?: Readonly<Record<string, unknown>> | null,
): readonly PaymentFailureHint[] {
  const failureReason =
    details && typeof details.failureReason === "string" ? details.failureReason : "";
  const failureMessage =
    details && typeof details.failureMessage === "string" ? details.failureMessage : "";
  const combined = `${status} ${failureReason} ${failureMessage}`.toLowerCase();

  if (/(expired|stolen|lost|revoked|closed|fraud|inactive_card|possible_fraud|restricted)/u.test(combined)) {
    return ["credentialDead"];
  }
  if (/(mandate|recurring|direct_debit)/u.test(combined)) {
    return ["mandateUnsupported"];
  }
  if (/(authentication|3ds|sca|challenge)/u.test(combined)) {
    return ["authenticationRequired"];
  }
  if (/(insufficient|limit|exceeded)/u.test(combined)) {
    return ["limitExceeded"];
  }
  if (/(invalid|cvv|cvc|card_number|card_holder)/u.test(combined)) {
    return ["dataInvalid"];
  }
  if (/(timeout|unavailable|try_again|temporary|refused_by_issuer|card_declined)/u.test(combined)) {
    return ["transient"];
  }
  return [];
}

export function mapMollieRefusal(
  status: MolliePaymentStatus | string,
  details?: Readonly<Record<string, unknown>> | null,
): PaymentRefusalEnvelope {
  const hints = deriveMollieFailureHints(status, details);
  const classification = classifyPaymentFailure({ neutralReasonHints: hints });
  return {
    code: classification.failureClass,
    hints,
  };
}

export function parseStrictMollieMoney(
  rawAmount: unknown,
  supportedCurrencies: readonly string[],
): PaymentMoney | null {
  if (!rawAmount || typeof rawAmount !== "object" || Array.isArray(rawAmount)) {
    return null;
  }
  const amount = rawAmount as Record<string, unknown>;
  if (typeof amount.currency !== "string" || !CURRENCY_PATTERN.test(amount.currency)) {
    return null;
  }
  if (!supportedCurrencies.includes(amount.currency)) {
    return null;
  }
  const amountMinor = majorStringToMinor(amount.value, amount.currency);
  if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  return { amountMinor, currency: amount.currency };
}

function parseOptionalReversalMinor(
  rawAmount: unknown,
  expectedCurrency: string,
): { kind: "absent" } | { kind: "invalid" } | { kind: "ok"; amountMinor: number } {
  if (rawAmount === undefined || rawAmount === null) {
    return { kind: "absent" };
  }
  if (typeof rawAmount !== "object" || Array.isArray(rawAmount)) {
    return { kind: "invalid" };
  }
  const record = rawAmount as Record<string, unknown>;
  if (record.currency !== expectedCurrency) {
    return { kind: "invalid" };
  }
  const minor = majorStringToMinor(record.value, expectedCurrency);
  if (minor === null || !Number.isSafeInteger(minor) || minor < 0) {
    return { kind: "invalid" };
  }
  return { kind: "ok", amountMinor: minor };
}

function parseWebhookPaymentId(rawBody: Uint8Array, maxBodyBytes: number): string | null {
  if (rawBody.byteLength === 0 || rawBody.byteLength > maxBodyBytes) {
    return null;
  }
  const rawText = Buffer.from(rawBody).toString("utf8");
  if (!Buffer.from(rawText, "utf8").equals(Buffer.from(rawBody))) {
    return null;
  }
  if (/\s/u.test(rawText) || !rawText.includes("=")) {
    return null;
  }
  const parts = rawText.split("&");
  if (parts.some((part) => !part.includes("="))) {
    return null;
  }
  const params = new URLSearchParams(rawText);
  const ids = params.getAll("id");
  if (ids.length !== 1) {
    return null;
  }
  try {
    return assertSafeMolliePaymentId(ids[0]!);
  } catch {
    return null;
  }
}

export function createMollieWebhookVerifier(
  config: MollieWebhookVerifierConfig,
): PaymentVerifyNormalizePort {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid Mollie webhook mode");
  }
  const supportedCurrencies = Object.freeze([...config.supportedCurrencies]);
  const maxBodyBytes = config.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("Invalid Mollie maxBodyBytes");
  }

  return {
    async verifyAndNormalize(input) {
      const paymentId = parseWebhookPaymentId(input.rawBody, maxBodyBytes);
      if (!paymentId) {
        return refusal("malformed");
      }

      let payment;
      try {
        payment = await config.client.getPayment(paymentId);
      } catch (error) {
        if (
          error instanceof MollieTransportError
          && (error.httpStatus === 404 || error.httpStatus === 401 || error.httpStatus === 403)
        ) {
          return refusal("signature");
        }
        throw error;
      }

      if (!payment || typeof payment !== "object" || payment.id !== paymentId) {
        return refusal("signature");
      }

      if (payment.mode !== config.mode) {
        return refusal("unsupported-event");
      }

      const originalAmount = parseStrictMollieMoney(payment.amount, supportedCurrencies);
      if (!originalAmount) {
        return refusal("malformed");
      }

      const chargedBackParsed = parseOptionalReversalMinor(
        payment.amountChargedBack,
        originalAmount.currency,
      );
      if (chargedBackParsed.kind === "invalid") {
        return refusal("malformed");
      }

      const refundedParsed = parseOptionalReversalMinor(
        payment.amountRefunded,
        originalAmount.currency,
      );
      if (refundedParsed.kind === "invalid") {
        return refusal("malformed");
      }

      const intentRef = readMetadataString(payment.metadata, "intentRef");
      const attemptRef = readMetadataString(payment.metadata, "attemptRef");

      let outcome: VerifiedPaymentEvidence["outcome"];
      let providerEventId: string;
      let providerOccurredAt: string | null = null;
      let capturedAmountBasis: VerifiedPaymentEvidence["capturedAmountBasis"];
      let refusalEnvelope: PaymentRefusalEnvelope | undefined;
      let refundObservation: PaymentRefundObservation | undefined;
      let reusableMethod: VerifiedReusableMethod | undefined;

      if (chargedBackParsed.kind === "ok" && chargedBackParsed.amountMinor > 0) {
        const chargedBackMinor = chargedBackParsed.amountMinor;
        outcome = "disputed";
        providerEventId = `mollie:${paymentId}:disputed:${chargedBackMinor}`;
        providerOccurredAt = normalizeIsoTimestamp(payment.paidAt ?? payment.createdAt);
        refundObservation =
          chargedBackMinor >= originalAmount.amountMinor
            ? {
                kind: "full-reversal",
                reason: "chargeback",
                operationId: `mollie:chargeback:${paymentId}:${chargedBackMinor}`,
                originalPaymentMoney: originalAmount,
              }
            : {
                kind: "cumulative-snapshot",
                operationId: `mollie:chargeback:${paymentId}:${chargedBackMinor}`,
                originalPaymentMoney: originalAmount,
                refundedMoney: {
                  amountMinor: chargedBackMinor,
                  currency: originalAmount.currency,
                },
              };
      } else if (refundedParsed.kind === "ok" && refundedParsed.amountMinor > 0) {
        const refundedMinor = refundedParsed.amountMinor;
        if (refundedMinor > originalAmount.amountMinor) {
          return refusal("malformed");
        }
        outcome = "refunded";
        providerEventId = `mollie:${paymentId}:refunded:${refundedMinor}`;
        providerOccurredAt = normalizeIsoTimestamp(payment.paidAt ?? payment.createdAt);
        refundObservation = {
          kind: "cumulative-snapshot",
          operationId: `mollie:refund:${paymentId}:${refundedMinor}`,
          originalPaymentMoney: originalAmount,
          refundedMoney: {
            amountMinor: refundedMinor,
            currency: originalAmount.currency,
          },
        };
      } else if (payment.status === "paid") {
        outcome = "succeeded";
        providerEventId = `mollie:${paymentId}:paid:succeeded`;
        providerOccurredAt = normalizeIsoTimestamp(payment.paidAt);
        capturedAmountBasis = "provider_capture_v1";
        if (typeof payment.mandateId === "string" && payment.mandateId.trim().length > 0) {
          const mandateId = payment.mandateId.trim();
          reusableMethod = {
            providerCustomerRef:
              typeof payment.customerId === "string" && payment.customerId.trim().length > 0
                ? payment.customerId.trim()
                : null,
            providerMethodRef: mandateId,
            providerMandateRef: mandateId,
            methodKind:
              typeof payment.method === "string" && payment.method.trim().length > 0
                ? payment.method.trim()
                : "card",
            status: "active",
          };
        }
      } else if (
        payment.status === "failed"
        || payment.status === "expired"
        || payment.status === "canceled"
      ) {
        outcome = "failed";
        providerEventId = `mollie:${paymentId}:${payment.status}:failed`;
        providerOccurredAt = normalizeIsoTimestamp(
          payment.status === "failed"
            ? payment.failedAt
            : payment.status === "expired"
              ? payment.expiredAt
              : payment.canceledAt,
        );
        refusalEnvelope = mapMollieRefusal(payment.status, payment.details);
      } else if (
        payment.status === "open"
        || payment.status === "pending"
        || payment.status === "authorized"
      ) {
        outcome = "pending";
        providerEventId = `mollie:${paymentId}:${payment.status}:pending`;
        providerOccurredAt = normalizeIsoTimestamp(payment.createdAt);
      } else {
        return refusal("unsupported-event");
      }

      // 64-hex lowercase SHA-256 fingerprint excludes receivedAt, secrets, and raw bodies.
      const fingerprint = sha256Hex({
        v: 1,
        provider: "mollie",
        kind: "money",
        providerEventId,
        providerPaymentRef: paymentId,
        intentRef,
        attemptRef,
        outcome,
        money: originalAmount,
        ...(refundObservation ? { refund: refundObservation } : {}),
      });

      const auditPayload: Record<string, unknown> = {
        status: payment.status,
        mode: payment.mode,
        method: payment.method ?? null,
        sequenceType: payment.sequenceType ?? null,
        ...(refundObservation ? { refundOperationId: refundObservation.operationId } : {}),
      };

      const evidence: VerifiedPaymentEvidence = {
        kind: "money",
        provider: "mollie",
        providerEventId,
        providerOccurredAt,
        fingerprint,
        providerAuditPayload: Object.freeze(auditPayload),
        providerPaymentRef: paymentId,
        intentRef,
        attemptRef,
        outcome,
        money: originalAmount,
        ...(capturedAmountBasis ? { capturedAmountBasis } : {}),
        ...(refusalEnvelope ? { refusal: refusalEnvelope } : {}),
        ...(refundObservation ? { refund: refundObservation } : {}),
        ...(reusableMethod ? { reusableMethod } : {}),
      };

      return evidence;
    },
  };
}
