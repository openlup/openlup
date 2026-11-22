import { createHash, createHmac } from "node:crypto";
import { classifyPaymentFailure, type PaymentFailureHint } from "@openlup/core/payment";
import { MAX_WEBHOOK_BODY_BYTES, timingSafeStringEqual } from "@openlup/platform/http";
import type {
  PaymentMoney,
  PaymentRefusalEnvelope,
  PaymentVerifyNormalizePort,
  VerifiedMethodEvidence,
  VerifiedPaymentEvidence,
  VerifiedReusableMethod,
} from "@openlup/platform/payments/contracts";

export type AdyenCaptureMode = "immediate" | "delayed";

export interface AdyenWebhookVerifierConfig {
  mode: "live" | "test";
  merchantAccount: string;
  /** One or more hex-encoded Adyen HMAC keys (supports zero-downtime key rotation). */
  hmacKeysHex: readonly string[];
  supportedCurrencies: readonly string[];
  /**
   * Whether AUTHORISATION(success=true) settles money immediately (Adyen auto-capture)
   * or remains pending until a CAPTURE notification arrives (delayed capture).
   * Defaults to "immediate".
   */
  captureMode?: AdyenCaptureMode;
  maxBodyBytes?: number;
}

type VerificationResult = Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>>;

const HEX_KEY_PATTERN = /^[0-9a-fA-F]+$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

const refusal = (
  reason: Extract<VerificationResult, { kind: "refusal" }>["reason"],
): VerificationResult => ({ kind: "refusal", reason });

/**
 * Adyen canonical HMAC escaping rule:
 * 1. Escape backslashes first (`\` -> `\\`)
 * 2. Escape colons second (`:` -> `\:`)
 */
export function escapeAdyenHmacField(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/:/gu, "\\:");
}

export interface AdyenCanonicalHmacFields {
  pspReference: string;
  originalReference: string;
  merchantAccountCode: string;
  merchantReference: string;
  value: string;
  currency: string;
  eventCode: string;
  success: string;
}

/** Computes Adyen's base64 HMAC-SHA256 signature over the 8 canonical fields using a hex-decoded key. */
export function computeAdyenNotificationHmac(
  fields: AdyenCanonicalHmacFields,
  hmacKeyHex: string,
): string {
  if (!hmacKeyHex || hmacKeyHex.length % 2 !== 0 || !HEX_KEY_PATTERN.test(hmacKeyHex)) {
    throw new Error("Invalid Adyen HMAC hex key");
  }
  const signingPayload = [
    fields.pspReference,
    fields.originalReference,
    fields.merchantAccountCode,
    fields.merchantReference,
    fields.value,
    fields.currency,
    fields.eventCode,
    fields.success,
  ]
    .map(escapeAdyenHmacField)
    .join(":");
  const keyBytes = Buffer.from(hmacKeyHex, "hex");
  return createHmac("sha256", keyBytes).update(signingPayload, "utf8").digest("base64");
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readMetadata(additionalData: Record<string, unknown>, key: string): string | null {
  const direct = additionalData[`metadata.${key}`];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return null;
}

function extractReusableMethod(
  additionalData: Record<string, unknown>,
  paymentMethod: string | null,
): VerifiedReusableMethod | undefined {
  const detailRef =
    readString(additionalData, "recurring.recurringDetailReference")
    ?? readString(additionalData, "tokenization.storedPaymentMethodId");
  if (!detailRef) return undefined;
  const shopperRef =
    readString(additionalData, "recurring.shopperReference")
    ?? readString(additionalData, "tokenization.shopperReference");
  return {
    providerCustomerRef: shopperRef ?? null,
    providerMethodRef: detailRef,
    providerMandateRef: detailRef,
    methodKind: paymentMethod ?? "card",
    status: "active",
  };
}

export function deriveAdyenFailureHints(
  reasonRaw: string | null,
  refusalCodeRaw: string | null,
): readonly PaymentFailureHint[] {
  const combined = `${reasonRaw ?? ""} ${refusalCodeRaw ?? ""}`.toLowerCase();
  if (/(expired|stolen|lost|revoked|closed|restricted|fraud|not permitted)/u.test(combined)) {
    return ["credentialDead"];
  }
  if (/(mandate|recurring|token)/u.test(combined)) {
    return ["mandateUnsupported"];
  }
  if (/(3ds|authentication|sca|challenge)/u.test(combined)) {
    return ["authenticationRequired"];
  }
  if (/(not enough balance|insufficient|limit|withdrawal)/u.test(combined)) {
    return ["limitExceeded"];
  }
  if (/(invalid|cvc|card number|acquirer|format)/u.test(combined)) {
    return ["dataInvalid"];
  }
  if (/(timeout|unavailable|try again|temporary|issuer unavailable)/u.test(combined)) {
    return ["transient"];
  }
  return [];
}

function mapAdyenRefusal(reasonRaw: string | null, refusalCodeRaw: string | null): PaymentRefusalEnvelope {
  const hints = deriveAdyenFailureHints(reasonRaw, refusalCodeRaw);
  const classification = classifyPaymentFailure({ neutralReasonHints: hints });
  return {
    code: classification.failureClass,
    hints,
  };
}

function parseStrictMoney(
  rawAmount: unknown,
  supportedCurrencies: readonly string[],
): PaymentMoney | null {
  if (!rawAmount || typeof rawAmount !== "object" || Array.isArray(rawAmount)) return null;
  const amount = rawAmount as Record<string, unknown>;
  if (typeof amount.value !== "number" || !Number.isSafeInteger(amount.value) || amount.value <= 0) {
    return null;
  }
  if (typeof amount.currency !== "string" || !CURRENCY_PATTERN.test(amount.currency)) {
    return null;
  }
  if (!supportedCurrencies.includes(amount.currency)) {
    return null;
  }
  return { amountMinor: amount.value, currency: amount.currency };
}

export function createAdyenWebhookVerifier(
  config: AdyenWebhookVerifierConfig,
): PaymentVerifyNormalizePort {
  if (!Array.isArray(config.hmacKeysHex) || config.hmacKeysHex.length === 0) {
    throw new Error("Adyen webhook verifier requires at least one hex HMAC key");
  }
  for (const key of config.hmacKeysHex) {
    if (typeof key !== "string" || key.length === 0 || key.length % 2 !== 0 || !HEX_KEY_PATTERN.test(key)) {
      throw new Error("Invalid Adyen HMAC hex key");
    }
  }
  const hmacKeysHex = Object.freeze([...config.hmacKeysHex]);
  const supportedCurrencies = Object.freeze([...config.supportedCurrencies]);
  const captureMode: AdyenCaptureMode = config.captureMode ?? "immediate";
  const maxBodyBytes = config.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;

  return {
    async verifyAndNormalize(input) {
      if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > maxBodyBytes) {
        return refusal("malformed");
      }

      // Enforce strict UTF-8 fidelity on the untouched raw bytes before JSON.parse.
      const rawText = Buffer.from(input.rawBody).toString("utf8");
      if (!Buffer.from(rawText, "utf8").equals(Buffer.from(input.rawBody))) {
        return refusal("malformed");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return refusal("malformed");
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return refusal("malformed");
      }
      const envelope = parsed as Record<string, unknown>;
      const liveFlag = envelope.live;
      if (liveFlag !== "true" && liveFlag !== "false") {
        return refusal("malformed");
      }
      if (!Array.isArray(envelope.notificationItems) || envelope.notificationItems.length !== 1) {
        return refusal("malformed");
      }

      const wrapper = envelope.notificationItems[0];
      if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) {
        return refusal("malformed");
      }
      const itemRaw = (wrapper as Record<string, unknown>).NotificationRequestItem;
      if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) {
        return refusal("malformed");
      }
      const item = itemRaw as Record<string, unknown>;

      const additionalDataRaw = item.additionalData;
      const additionalData: Record<string, unknown> =
        additionalDataRaw && typeof additionalDataRaw === "object" && !Array.isArray(additionalDataRaw)
          ? (additionalDataRaw as Record<string, unknown>)
          : {};

      const providedSignature = readString(additionalData, "hmacSignature");
      if (!providedSignature) {
        return refusal("signature");
      }

      const pspReference = readString(item, "pspReference") ?? "";
      const originalReference = readString(item, "originalReference") ?? "";
      const merchantAccountCode = readString(item, "merchantAccountCode") ?? "";
      const merchantReference = readString(item, "merchantReference") ?? "";
      const eventCode = readString(item, "eventCode") ?? "";
      const success = readString(item, "success") ?? "";

      const amountObj =
        item.amount && typeof item.amount === "object" && !Array.isArray(item.amount)
          ? (item.amount as Record<string, unknown>)
          : null;
      const valueStr =
        amountObj && (typeof amountObj.value === "number" || typeof amountObj.value === "string")
          ? String(amountObj.value)
          : "";
      const currencyStr = amountObj && typeof amountObj.currency === "string" ? amountObj.currency : "";

      const hmacFields: AdyenCanonicalHmacFields = {
        pspReference,
        originalReference,
        merchantAccountCode,
        merchantReference,
        value: valueStr,
        currency: currencyStr,
        eventCode,
        success,
      };

      const signatureValid = hmacKeysHex.some((keyHex) => {
        const expected = computeAdyenNotificationHmac(hmacFields, keyHex);
        return timingSafeStringEqual(expected, providedSignature);
      });
      if (!signatureValid) {
        return refusal("signature");
      }

      // Authenticated payload checks: reject live/test or merchant-account mismatch.
      const isLiveEvent = liveFlag === "true";
      if (isLiveEvent !== (config.mode === "live")) {
        return refusal("unsupported-event");
      }
      if (merchantAccountCode !== config.merchantAccount) {
        return refusal("unsupported-event");
      }
      if (!pspReference || !eventCode || (success !== "true" && success !== "false")) {
        return refusal("malformed");
      }

      const providerOccurredAt = normalizeIsoTimestamp(item.eventDate);
      const intentRef = readMetadata(additionalData, "intentRef") ?? (merchantReference || null);
      const attemptRef = readMetadata(additionalData, "attemptRef");
      const paymentMethod = readString(item, "paymentMethod");
      const reusableMethod = extractReusableMethod(additionalData, paymentMethod);
      const paymentRef = originalReference || pspReference;

      // Method lifecycle event: RECURRING_CONTRACT (never money settlement).
      if (eventCode === "RECURRING_CONTRACT") {
        if (!reusableMethod) {
          return refusal("malformed");
        }
        const outcome: VerifiedMethodEvidence["outcome"] =
          success === "true" ? "registered" : "failed";
        const providerEventId = `adyen:${pspReference}:RECURRING_CONTRACT:${outcome}`;
        const fingerprint = sha256Hex({
          v: 1,
          provider: "adyen",
          kind: "method",
          providerEventId,
          methodRef: reusableMethod.providerMethodRef,
          outcome,
        });
        return {
          kind: "method",
          provider: "adyen",
          providerEventId,
          providerOccurredAt,
          fingerprint,
          outcome,
          reusableMethod,
          methodRef: reusableMethod.providerMethodRef,
          setupRef: readMetadata(additionalData, "setupRef"),
          intentRef,
        };
      }

      const money = parseStrictMoney(item.amount, supportedCurrencies);
      if (!money) {
        return refusal("malformed");
      }

      let outcome: VerifiedPaymentEvidence["outcome"];
      let capturedAmountBasis: VerifiedPaymentEvidence["capturedAmountBasis"];
      let refusalEnvelope: PaymentRefusalEnvelope | undefined;

      switch (eventCode) {
        case "AUTHORISATION": {
          if (success === "true") {
            outcome = captureMode === "immediate" ? "succeeded" : "pending";
            if (outcome === "succeeded") {
              capturedAmountBasis = "provider_capture_v1";
            }
          } else {
            outcome = "failed";
            refusalEnvelope = mapAdyenRefusal(
              readString(item, "reason"),
              readString(additionalData, "refusalReasonRaw"),
            );
          }
          break;
        }
        case "CAPTURE": {
          if (success === "true") {
            outcome = "succeeded";
            capturedAmountBasis = "provider_capture_v1";
          } else {
            outcome = "failed";
            refusalEnvelope = mapAdyenRefusal(readString(item, "reason"), null);
          }
          break;
        }
        case "CAPTURE_FAILED": {
          outcome = "failed";
          refusalEnvelope = mapAdyenRefusal(readString(item, "reason"), "capture_failed");
          break;
        }
        case "CANCELLATION": {
          if (success !== "true") {
            return refusal("unsupported-event");
          }
          outcome = "failed";
          refusalEnvelope = mapAdyenRefusal(readString(item, "reason"), "cancelled");
          break;
        }
        case "REFUND": {
          if (success !== "true") {
            return refusal("unsupported-event");
          }
          // Adyen REFUND webhooks carry only the delta amount without echoing
          // originalPaymentMoney; emit outcome: "refunded" honestly without
          // fabricating original payment totals.
          outcome = "refunded";
          break;
        }
        case "CHARGEBACK":
        case "NOTIFICATION_OF_CHARGEBACK":
        case "SECOND_CHARGEBACK": {
          outcome = "disputed";
          break;
        }
        default:
          return refusal("unsupported-event");
      }

      const providerEventId = `adyen:${pspReference}:${eventCode}:${outcome}`;
      // 64-char lowercase hex SHA-256 fingerprint (excludes receivedAt, secrets, raw bodies).
      const fingerprint = sha256Hex({
        v: 1,
        provider: "adyen",
        kind: "money",
        providerEventId,
        providerPaymentRef: paymentRef,
        intentRef,
        attemptRef,
        outcome,
        money,
      });

      const auditPayload: Record<string, unknown> = {
        eventCode,
        paymentMethod: paymentMethod ?? null,
        merchantReference: merchantReference || null,
      };

      const evidence: VerifiedPaymentEvidence = {
        kind: "money",
        provider: "adyen",
        providerEventId,
        providerOccurredAt,
        fingerprint,
        providerAuditPayload: Object.freeze(auditPayload),
        providerPaymentRef: paymentRef,
        intentRef,
        attemptRef,
        outcome,
        money,
        ...(capturedAmountBasis ? { capturedAmountBasis } : {}),
        ...(refusalEnvelope ? { refusal: refusalEnvelope } : {}),
        ...(reusableMethod ? { reusableMethod } : {}),
      };

      return evidence;
    },
  };
}
