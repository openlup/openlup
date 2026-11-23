import { createHash } from "node:crypto";
import { classifyPaymentFailure, type PaymentFailureHint } from "@openlup/core/payment";
import { MAX_WEBHOOK_BODY_BYTES } from "@openlup/platform/adapter-kit";
import type {
  PaymentMoney,
  PaymentRefundObservation,
  PaymentRefusalEnvelope,
  PaymentVerifyNormalizePort,
  VerifiedPaymentEvidence,
} from "@openlup/platform/payments/contracts";
import {
  assertSafePayPalOrderId,
  majorStringToMinor,
  PayPalTransportError,
  type PayPalClient,
  type PayPalOrderResource,
} from "./client-contract.js";

export interface PayPalWebhookVerifierConfig {
  mode: "live" | "test";
  client: Pick<PayPalClient, "getOrder">;
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

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function derivePayPalFailureHints(
  status: string,
  reason?: string | null,
): readonly PaymentFailureHint[] {
  const combined = `${status} ${reason ?? ""}`.toLowerCase();
  if (/(expired_card|lost|stolen|fraud|restricted|revoked)/u.test(combined)) {
    return ["credentialDead"];
  }
  if (/(payer_action|authentication|3ds|sca|instrument_declined)/u.test(combined)) {
    return ["authenticationRequired"];
  }
  if (/(insufficient|limit|exceeded|max_number)/u.test(combined)) {
    return ["limitExceeded"];
  }
  if (/(invalid|cvv|card_number|billing_address)/u.test(combined)) {
    return ["dataInvalid"];
  }
  if (/(declined|failed|voided|timeout|unavailable|temporary)/u.test(combined)) {
    return ["transient"];
  }
  return [];
}

export function mapPayPalRefusal(status: string, reason?: string | null): PaymentRefusalEnvelope {
  const hints = derivePayPalFailureHints(status, reason);
  const classification = classifyPaymentFailure({ neutralReasonHints: hints });
  return {
    code: classification.failureClass,
    hints,
  };
}

export function parseStrictPayPalMoney(
  rawAmount: unknown,
  supportedCurrencies: readonly string[],
): PaymentMoney | null {
  if (!rawAmount || typeof rawAmount !== "object" || Array.isArray(rawAmount)) {
    return null;
  }
  const amount = rawAmount as Record<string, unknown>;
  if (typeof amount.currency_code !== "string" || !CURRENCY_PATTERN.test(amount.currency_code)) {
    return null;
  }
  if (!supportedCurrencies.includes(amount.currency_code)) {
    return null;
  }
  const amountMinor = majorStringToMinor(amount.value, amount.currency_code);
  if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  return { amountMinor, currency: amount.currency_code };
}

interface ParsedWebhookEnvelope {
  orderId: string;
  eventType: string | null;
  providerWebhookId: string | null;
}

function parseWebhookEnvelope(
  rawBody: Uint8Array,
  maxBodyBytes: number,
): ParsedWebhookEnvelope | null {
  if (rawBody.byteLength === 0 || rawBody.byteLength > maxBodyBytes) {
    return null;
  }
  const rawText = Buffer.from(rawBody).toString("utf8");
  if (!Buffer.from(rawText, "utf8").equals(Buffer.from(rawBody))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const eventType = readNonEmptyString(record.event_type);
  const providerWebhookId = readNonEmptyString(record.id);
  const resource =
    record.resource && typeof record.resource === "object" && !Array.isArray(record.resource)
      ? (record.resource as Record<string, unknown>)
      : null;

  const supplementary =
    resource?.supplementary_data
    && typeof resource.supplementary_data === "object"
    && !Array.isArray(resource.supplementary_data)
      ? (resource.supplementary_data as Record<string, unknown>)
      : null;
  const relatedIds =
    supplementary?.related_ids
    && typeof supplementary.related_ids === "object"
    && !Array.isArray(supplementary.related_ids)
      ? (supplementary.related_ids as Record<string, unknown>)
      : null;

  const rawOrderId =
    readNonEmptyString(relatedIds?.order_id)
    ?? readNonEmptyString(resource?.order_id)
    ?? readNonEmptyString(resource?.id);

  if (!rawOrderId) {
    return null;
  }

  try {
    const orderId = assertSafePayPalOrderId(rawOrderId);
    return { orderId, eventType, providerWebhookId };
  } catch {
    return null;
  }
}

function sumCompletedRefunds(
  order: PayPalOrderResource,
  expectedCurrency: string,
): { kind: "none" } | { kind: "invalid" } | { kind: "ok"; amountMinor: number; latestOccurredAt: string | null } {
  const unit = order.purchase_units?.[0];
  const refunds = unit?.payments?.refunds;
  if (!refunds || refunds.length === 0) {
    return { kind: "none" };
  }
  let totalMinor = 0n;
  let latestOccurredAt: string | null = null;
  for (const item of refunds) {
    if (item.status !== "COMPLETED") continue;
    if (!item.amount || item.amount.currency_code !== expectedCurrency) {
      return { kind: "invalid" };
    }
    const minor = majorStringToMinor(item.amount.value, expectedCurrency);
    if (minor === null || minor < 0) {
      return { kind: "invalid" };
    }
    totalMinor += BigInt(minor);
    latestOccurredAt =
      normalizeIsoTimestamp(item.update_time ?? item.create_time) ?? latestOccurredAt;
  }
  if (totalMinor === 0n) {
    return { kind: "none" };
  }
  if (totalMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", amountMinor: Number(totalMinor), latestOccurredAt };
}

/**
 * Readback-authenticated PayPal webhook verifier.
 * Extracts the PayPal order ID from the webhook envelope and verifies the
 * authoritative state directly against `GET /v2/checkout/orders/{id}` on the
 * pinned PayPal origin before emitting money or dispute evidence.
 */
export function createPayPalWebhookVerifier(
  config: PayPalWebhookVerifierConfig,
): PaymentVerifyNormalizePort {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid PayPal webhook mode");
  }
  const supportedCurrencies = Object.freeze([...config.supportedCurrencies]);
  const maxBodyBytes = config.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("Invalid PayPal maxBodyBytes");
  }

  return {
    async verifyAndNormalize(input) {
      const envelope = parseWebhookEnvelope(input.rawBody, maxBodyBytes);
      if (!envelope) {
        return refusal("malformed");
      }

      let order: PayPalOrderResource;
      try {
        order = await config.client.getOrder(envelope.orderId);
      } catch (error) {
        if (
          error instanceof PayPalTransportError
          && (error.httpStatus === 404 || error.httpStatus === 401 || error.httpStatus === 403)
        ) {
          return refusal("signature");
        }
        throw error;
      }

      if (!order || typeof order !== "object" || order.id !== envelope.orderId) {
        return refusal("signature");
      }

      const unit = order.purchase_units?.[0];
      const originalAmount = parseStrictPayPalMoney(unit?.amount, supportedCurrencies);
      if (!originalAmount) {
        return refusal("malformed");
      }

      const capture = unit?.payments?.captures?.[0];
      const refundsSummary = sumCompletedRefunds(order, originalAmount.currency);
      if (refundsSummary.kind === "invalid") {
        return refusal("malformed");
      }

      const intentRef = readNonEmptyString(unit?.custom_id);
      const attemptRef = readNonEmptyString(unit?.reference_id);

      let outcome: VerifiedPaymentEvidence["outcome"];
      let providerEventId: string;
      let providerOccurredAt: string | null = null;
      let capturedAmountBasis: VerifiedPaymentEvidence["capturedAmountBasis"];
      let refusalEnvelope: PaymentRefusalEnvelope | undefined;
      let refundObservation: PaymentRefundObservation | undefined;

      const isDisputeEvent =
        envelope.eventType === "CUSTOMER.DISPUTE.CREATED"
        || envelope.eventType === "CUSTOMER.DISPUTE.RESOLVED";

      if (isDisputeEvent) {
        if (order.status !== "COMPLETED" || !capture || capture.status !== "COMPLETED") {
          return refusal("unsupported-event");
        }
        outcome = "disputed";
        providerEventId = `paypal:${envelope.orderId}:disputed:${originalAmount.amountMinor}`;
        providerOccurredAt = normalizeIsoTimestamp(
          capture.update_time ?? capture.create_time ?? order.update_time ?? order.create_time,
        );
        refundObservation = {
          kind: "full-reversal",
          reason: "chargeback",
          operationId: `paypal:chargeback:${envelope.orderId}:${originalAmount.amountMinor}`,
          originalPaymentMoney: originalAmount,
        };
      } else if (refundsSummary.kind === "ok" && refundsSummary.amountMinor > 0) {
        if (refundsSummary.amountMinor > originalAmount.amountMinor) {
          return refusal("malformed");
        }
        outcome = "refunded";
        providerEventId = `paypal:${envelope.orderId}:refunded:${refundsSummary.amountMinor}`;
        providerOccurredAt =
          refundsSummary.latestOccurredAt
          ?? normalizeIsoTimestamp(capture?.update_time ?? order.update_time ?? order.create_time);
        refundObservation = {
          kind: "cumulative-snapshot",
          operationId: `paypal:refund:${envelope.orderId}:${refundsSummary.amountMinor}`,
          originalPaymentMoney: originalAmount,
          refundedMoney: {
            amountMinor: refundsSummary.amountMinor,
            currency: originalAmount.currency,
          },
        };
      } else if (order.status === "COMPLETED") {
        if (capture && (capture.status === "DECLINED" || capture.status === "FAILED")) {
          outcome = "failed";
          providerEventId = `paypal:${envelope.orderId}:${capture.status.toLowerCase()}:failed`;
          providerOccurredAt = normalizeIsoTimestamp(
            capture.update_time ?? capture.create_time ?? order.update_time,
          );
          refusalEnvelope = mapPayPalRefusal(capture.status, capture.status_details?.reason);
        } else {
          if (capture?.amount) {
            const capturedMoney = parseStrictPayPalMoney(capture.amount, supportedCurrencies);
            if (!capturedMoney || capturedMoney.currency !== originalAmount.currency) {
              return refusal("malformed");
            }
          }
          outcome = "succeeded";
          providerEventId = `paypal:${envelope.orderId}:completed:succeeded`;
          providerOccurredAt = normalizeIsoTimestamp(
            capture?.update_time ?? capture?.create_time ?? order.update_time ?? order.create_time,
          );
          capturedAmountBasis = "provider_capture_v1";
        }
      } else if (order.status === "VOIDED") {
        outcome = "failed";
        providerEventId = `paypal:${envelope.orderId}:voided:failed`;
        providerOccurredAt = normalizeIsoTimestamp(order.update_time ?? order.create_time);
        refusalEnvelope = mapPayPalRefusal(order.status);
      } else if (
        order.status === "CREATED"
        || order.status === "SAVED"
        || order.status === "APPROVED"
        || order.status === "PAYER_ACTION_REQUIRED"
      ) {
        outcome = "pending";
        providerEventId = `paypal:${envelope.orderId}:${order.status.toLowerCase()}:pending`;
        providerOccurredAt = normalizeIsoTimestamp(order.update_time ?? order.create_time);
      } else {
        return refusal("unsupported-event");
      }

      // 64-hex lowercase SHA-256 fingerprint excludes receivedAt, secrets, and raw bodies.
      const fingerprint = sha256Hex({
        v: 1,
        provider: "paypal",
        kind: "money",
        providerEventId,
        providerPaymentRef: envelope.orderId,
        intentRef,
        attemptRef,
        outcome,
        money: originalAmount,
        ...(refundObservation ? { refund: refundObservation } : {}),
      });

      const auditPayload: Record<string, unknown> = {
        status: order.status,
        mode: config.mode,
        captureStatus: capture?.status ?? null,
        ...(envelope.eventType ? { eventType: envelope.eventType } : {}),
        ...(refundObservation ? { refundOperationId: refundObservation.operationId } : {}),
      };

      const evidence: VerifiedPaymentEvidence = {
        kind: "money",
        provider: "paypal",
        providerEventId,
        providerOccurredAt,
        fingerprint,
        providerAuditPayload: Object.freeze(auditPayload),
        providerPaymentRef: envelope.orderId,
        intentRef,
        attemptRef,
        outcome,
        money: originalAmount,
        ...(capturedAmountBasis ? { capturedAmountBasis } : {}),
        ...(refusalEnvelope ? { refusal: refusalEnvelope } : {}),
        ...(refundObservation ? { refund: refundObservation } : {}),
      };

      return evidence;
    },
  };
}
