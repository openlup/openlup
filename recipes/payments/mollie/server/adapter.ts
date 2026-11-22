import { classifyPaymentFailure, type PaymentFailureHint } from "@openlup/core/payment";
import type {
  PaymentAdapter,
  PaymentAdapterCapabilities,
  PaymentAttemptPort,
  PaymentExecutionEnvelope,
  PaymentReadbackEnvelope,
  PaymentReadbackPort,
  PaymentRefusalEnvelope,
} from "@openlup/platform/payments/contracts";
import {
  assertSafeMolliePaymentId,
  majorStringToMinor,
  minorToMajorString,
  MollieTransportError,
  resolveCurrencyExponent,
  toSafeDiagnosticCode,
  type MollieClient,
  type MollieCreatePaymentRequest,
  type MolliePaymentResource,
  type MollieSequenceType,
} from "./client-contract.js";
import { createMollieWebhookVerifier, mapMollieRefusal } from "./webhook.js";

export interface MolliePaymentAdapterConfig {
  /** Narrow structural client (use createMollieHttpClient for zero-SDK REST v2). */
  client: MollieClient;
  /** Valid HTTPS return URL after Mollie hosted checkout completion. */
  redirectUrl: string;
  /** Optional HTTPS webhook URL registered per payment. */
  webhookUrl?: string;
  mode: "live" | "test";
  /** Host-configured canonical 3-letter ISO-4217 uppercase currency codes. */
  supportedCurrencies: readonly string[];
  /** Neutral order description prefix (never contains payer PII). */
  defaultDescription?: string;
  maxWebhookBodyBytes?: number;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const SUPPORTED_METHOD_FAMILIES = new Set(["card", "wallet", "bank-redirect"]);

/** Static protocol capability descriptor; host supplies supportedCurrencies at construction. */
export const molliePaymentCapabilities: Readonly<PaymentAdapterCapabilities> =
  Object.freeze<PaymentAdapterCapabilities>({
    providerKind: "mollie",
    captureFlows: Object.freeze([
      Object.freeze({
        kind: "hosted_checkout",
        handoff: "redirect",
        methodFamilies: Object.freeze(["card", "wallet", "bank-redirect"] as const),
      }),
    ]),
    requiresStoredMandateEvidence: false,
    assessMandate: () => ({ chargeable: true }),
    unattendedChargeFlow: "recurring_mandate",
    payerContext: Object.freeze({
      requiresPayerBlock: false,
      customerRefFallsBackToContactEmail: false,
    }),
    methodHealth: Object.freeze({
      requiresCustomerRef: true,
      requiredMethodKind: null,
      requiresPayerContact: false,
    }),
    terminalOutcomeReporting: Object.freeze({
      kind: "status_field",
      silenceBecomesSuspectAfterMinutes: 360,
    }),
    mandateUpsertIsSubscriptionScoped: false,
    /** Host-configured via MolliePaymentAdapterConfig.supportedCurrencies. */
    supportedCurrencies: Object.freeze([]),
    unattended: "supported",
    readback: "supported",
    close: "supported",
    exactAbsence: "unsupported",
    refundObservation: "supported",
    refundCreate: "unsupported",
    authorizationCaptureSplit: "unsupported",
  });

/**
 * Deterministic serializable projection of static capabilities (omitting the
 * JS function `assessMandate`), cross-checked mechanically against
 * `recipe.json#staticCapabilities` in conformance tests (ADR-001).
 */
export function projectMollieStaticCapabilities(
  capabilities: PaymentAdapterCapabilities = molliePaymentCapabilities,
): Record<string, unknown> {
  const { assessMandate: _omittedFunction, ...serializable } = capabilities;
  return JSON.parse(JSON.stringify(serializable)) as Record<string, unknown>;
}

function assertHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Mollie ${label}`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`Mollie ${label} must be an HTTPS URL without credentials`);
  }
  return parsed.toString();
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function preDispatchRefusal(code: string): PaymentExecutionEnvelope {
  const safeCode = toSafeDiagnosticCode(code, "INVALID_PAYMENT_INPUT");
  const hints: readonly PaymentFailureHint[] = ["dataInvalid"];
  const refusalEnvelope: PaymentRefusalEnvelope = {
    code: classifyPaymentFailure({ neutralReasonHints: hints }).failureClass,
    hints,
  };
  return {
    outcome: { kind: "decline", refusal: refusalEnvelope },
    dispatch: {
      kind: "notDispatched",
      evidence: { exact: true, phase: "before-dispatch", reason: refusalEnvelope },
    },
    diagnostics: {
      diagnosticCode: safeCode,
      preDispatchRefusal: true,
    },
  };
}

function buildMetadata(
  input: Parameters<PaymentAttemptPort["validateInput"]>[0],
): Readonly<Record<string, string>> {
  return {
    intentRef: input.intentRef,
    attemptRef: input.attemptRef,
    fingerprint: input.fingerprint,
    ...(input.orderRef ? { orderRef: input.orderRef } : {}),
  };
}

function resolveMollieMethod(
  selection: Parameters<PaymentAttemptPort["validateInput"]>[0]["methodSelection"],
): string | undefined {
  if (!selection) return undefined;
  if (selection.channelRef && selection.channelRef.trim().length > 0) {
    return selection.channelRef.trim();
  }
  if (selection.family === "card") {
    return "creditcard";
  }
  if (selection.family === "bank-redirect") {
    return "ideal";
  }
  return undefined;
}

function tryExtractCheckoutUrl(payment: MolliePaymentResource): string | null {
  const href = payment._links?.checkout?.href;
  if (typeof href !== "string" || href.trim().length === 0) {
    return null;
  }
  try {
    return assertHttpsUrl(href, "checkout url");
  } catch {
    return null;
  }
}

function mapReadbackPayment(
  payment: MolliePaymentResource,
  input: Parameters<PaymentReadbackPort["readPayment"]>[0],
  expectedMode: "live" | "test",
): PaymentReadbackEnvelope {
  const base = {
    identity: input.identity,
    expectedMoney: input.expectedMoney,
    purpose: input.purpose,
  };

  if (
    !payment
    || typeof payment !== "object"
    || payment.id !== input.identity.providerPaymentRef
    || payment.mode !== expectedMode
  ) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }

  if (!payment.amount || payment.amount.currency !== input.expectedMoney.currency) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }
  const observedMinor = majorStringToMinor(payment.amount.value, input.expectedMoney.currency);
  if (observedMinor === null || observedMinor !== input.expectedMoney.amountMinor) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }

  if (payment.status === "paid") {
    return {
      ...base,
      kind: "succeeded",
      observedMoney: input.expectedMoney,
      providerOccurredAt: normalizeIsoTimestamp(payment.paidAt),
      capturedAmountBasis: "provider_capture_v1",
    };
  }

  if (
    payment.status === "failed"
    || payment.status === "expired"
    || payment.status === "canceled"
  ) {
    const occurredAt = normalizeIsoTimestamp(
      payment.status === "failed"
        ? payment.failedAt
        : payment.status === "expired"
          ? payment.expiredAt
          : payment.canceledAt,
    );
    return {
      ...base,
      kind: "failed",
      observedMoney: input.expectedMoney,
      providerOccurredAt: occurredAt,
      refusal: mapMollieRefusal(payment.status, payment.details),
    };
  }

  if (
    payment.status === "open"
    || payment.status === "pending"
    || payment.status === "authorized"
  ) {
    const checkoutUrl = tryExtractCheckoutUrl(payment);
    return {
      ...base,
      kind: "pending",
      observedMoney: input.expectedMoney,
      providerOccurredAt: normalizeIsoTimestamp(payment.createdAt),
      ...(checkoutUrl ? { handoff: { kind: "redirect", url: checkoutUrl } as const } : {}),
    };
  }

  return { ...base, kind: "unknown", reason: "indeterminate" };
}

function translateTransportFailure(error: unknown): PaymentExecutionEnvelope {
  // Never leak raw error.message from external transports into diagnostics.
  if (error instanceof MollieTransportError) {
    if (error.phase === "before-dispatch") {
      return preDispatchRefusal(error.diagnosticCode);
    }
    return {
      outcome: { kind: "attempt", status: "processing" },
      dispatch: { kind: "unknown" },
      diagnostics: {
        diagnosticCode: error.diagnosticCode,
        httpStatus: error.httpStatus,
        uncertainDispatch: true,
      },
    };
  }

  return {
    outcome: { kind: "attempt", status: "processing" },
    dispatch: { kind: "unknown" },
    diagnostics: {
      diagnosticCode: "MOLLIE_TRANSPORT_UNKNOWN",
      uncertainDispatch: true,
    },
  };
}

/**
 * Explicit factory for the Mollie API v2 PaymentAdapter.
 * Importing this module performs zero I/O, reads zero environment variables,
 * and registers no routes, schedules, or global state.
 */
export function createMolliePaymentAdapter(config: MolliePaymentAdapterConfig): PaymentAdapter {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid Mollie payment mode");
  }
  const redirectUrl = assertHttpsUrl(config.redirectUrl, "redirectUrl");
  const webhookUrl =
    config.webhookUrl !== undefined ? assertHttpsUrl(config.webhookUrl, "webhookUrl") : undefined;

  if (
    !Array.isArray(config.supportedCurrencies)
    || config.supportedCurrencies.length === 0
    || !config.supportedCurrencies.every(
      (c) =>
        typeof c === "string"
        && CURRENCY_PATTERN.test(c)
        && resolveCurrencyExponent(c) !== null,
    )
  ) {
    throw new Error(
      "Mollie adapter requires a non-empty list of valid 3-letter ISO-4217 supportedCurrencies",
    );
  }
  const supportedCurrencies = Object.freeze([...new Set(config.supportedCurrencies)]);
  const descriptionPrefix = config.defaultDescription?.trim() || "Order";

  const capabilities: PaymentAdapterCapabilities = Object.freeze({
    ...molliePaymentCapabilities,
    supportedCurrencies,
  });

  const checkInput = (
    input: Parameters<PaymentAttemptPort["validateInput"]>[0],
  ): string | null => {
    if (input.mode !== config.mode) return "MOLLIE_MODE_MISMATCH";
    if (!["initial", "recovery", "renewal-unattended"].includes(input.purpose)) {
      return "MOLLIE_UNSUPPORTED_PURPOSE";
    }
    if (
      !input.attemptRef?.trim()
      || !input.intentRef?.trim()
      || !input.fingerprint?.trim()
      || !input.providerIdempotencyKey?.trim()
    ) {
      return "MOLLIE_MISSING_ATTEMPT_IDENTITY";
    }
    if (!Number.isSafeInteger(input.money.amountMinor) || input.money.amountMinor <= 0) {
      return "MOLLIE_INVALID_AMOUNT";
    }
    if (!supportedCurrencies.includes(input.money.currency)) {
      return "MOLLIE_UNSUPPORTED_CURRENCY";
    }
    if (input.orderMode !== undefined && !["one_time", "subscription_cycle"].includes(input.orderMode)) {
      return "MOLLIE_INVALID_ORDER_MODE";
    }
    if (input.purpose === "renewal-unattended" && input.orderMode === "one_time") {
      return "MOLLIE_INVALID_RENEWAL_ORDER_MODE";
    }
    if (input.customerAuthorization !== undefined) {
      return "MOLLIE_CUSTOMER_AUTH_UNSUPPORTED";
    }
    if (input.purpose === "renewal-unattended") {
      if (!input.customerRef?.trim()) return "MOLLIE_MISSING_CUSTOMER_REF";
      if (!input.storedMethod?.reference?.trim()) return "MOLLIE_MISSING_STORED_METHOD";
      const assessment = capabilities.assessMandate(input.storedMethod.mandate);
      if (!assessment.chargeable) return "MOLLIE_MANDATE_NOT_CHARGEABLE";
    } else {
      if (input.saveForFutureUse === true && !input.customerRef?.trim()) {
        return "MOLLIE_MISSING_CUSTOMER_REF";
      }
      if (
        input.methodSelection !== undefined
        && !SUPPORTED_METHOD_FAMILIES.has(input.methodSelection.family)
      ) {
        return "MOLLIE_UNSUPPORTED_METHOD_FAMILY";
      }
    }
    return null;
  };

  const validateInput: PaymentAttemptPort["validateInput"] = (input) => {
    const failure = checkInput(input);
    if (failure) {
      throw new Error(`Unsupported Mollie payment input: ${failure}`);
    }
  };

  const verifyPort = createMollieWebhookVerifier({
    mode: config.mode,
    client: config.client,
    supportedCurrencies,
    maxBodyBytes: config.maxWebhookBodyBytes,
  });

  const readPayment: PaymentReadbackPort["readPayment"] = async (input) => {
    const base = {
      identity: input.identity,
      expectedMoney: input.expectedMoney,
      purpose: input.purpose,
    };
    if (input.identity.provider !== "mollie") {
      return { ...base, kind: "unsupported" };
    }
    if (!input.identity.providerPaymentRef) {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    let safeId: string;
    try {
      safeId = assertSafeMolliePaymentId(input.identity.providerPaymentRef);
    } catch {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    try {
      const payment = await config.client.getPayment(safeId);
      return mapReadbackPayment(payment, input, config.mode);
    } catch (error) {
      if (error instanceof MollieTransportError && error.diagnosticCode === "MOLLIE_REQUEST_TIMEOUT") {
        return { ...base, kind: "unknown", reason: "timeout" };
      }
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
  };

  const closePayment: NonNullable<PaymentReadbackPort["close"]> = async (input) => {
    const base = {
      identity: input.identity,
      expectedMoney: input.expectedMoney,
      purpose: input.purpose,
    };
    if (input.identity.provider !== "mollie") {
      return { ...base, kind: "unsupported" };
    }
    if (!input.identity.providerPaymentRef) {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    let safeId: string;
    try {
      safeId = assertSafeMolliePaymentId(input.identity.providerPaymentRef);
    } catch {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    try {
      const payment = await config.client.cancelPayment(safeId, {
        idempotencyKey: `mollie:cancel:${input.identity.attemptRef}`,
      });
      return mapReadbackPayment(payment, input, config.mode);
    } catch (error) {
      if (error instanceof MollieTransportError && error.diagnosticCode === "MOLLIE_REQUEST_TIMEOUT") {
        return { ...base, kind: "unknown", reason: "timeout" };
      }
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
  };

  return {
    capabilities,
    attemptPort: {
      validateInput,
      async execute(input): Promise<PaymentExecutionEnvelope> {
        const preDispatchFailure = checkInput(input);
        if (preDispatchFailure) {
          return preDispatchRefusal(preDispatchFailure);
        }

        const amount = {
          currency: input.money.currency,
          value: minorToMajorString(input.money.amountMinor, input.money.currency),
        };
        const metadata = buildMetadata(input);
        const description = `${descriptionPrefix} ${input.orderRef ?? input.intentRef}`;
        const sequenceType: MollieSequenceType =
          input.purpose === "renewal-unattended"
            ? "recurring"
            : input.saveForFutureUse === true
              ? "first"
              : "oneoff";

        const request: MollieCreatePaymentRequest =
          sequenceType === "recurring"
            ? {
                amount,
                description,
                sequenceType,
                customerId: input.customerRef!.trim(),
                mandateId: input.storedMethod!.reference.trim(),
                ...(webhookUrl ? { webhookUrl } : {}),
                metadata,
              }
            : {
                amount,
                description,
                redirectUrl,
                sequenceType,
                ...(input.customerRef?.trim() ? { customerId: input.customerRef.trim() } : {}),
                ...(resolveMollieMethod(input.methodSelection)
                  ? { method: resolveMollieMethod(input.methodSelection) }
                  : {}),
                ...(webhookUrl ? { webhookUrl } : {}),
                metadata,
              };

        try {
          const response = await config.client.createPayment(request, {
            idempotencyKey: input.providerIdempotencyKey,
          });

          if (!response || typeof response.id !== "string" || response.id.length === 0) {
            return {
              outcome: { kind: "attempt", status: "processing" },
              dispatch: { kind: "unknown" },
              diagnostics: {
                diagnosticCode: "MOLLIE_INCOMPLETE_RESPONSE",
                webhookExpected: true,
              },
            };
          }

          const dispatch: PaymentExecutionEnvelope["dispatch"] = {
            kind: "dispatched",
            providerPaymentRef: response.id,
          };

          if (
            response.status === "failed"
            || response.status === "expired"
            || response.status === "canceled"
          ) {
            const refusal = mapMollieRefusal(response.status, response.details);
            return {
              outcome: { kind: "decline", refusal },
              dispatch,
              diagnostics: {
                flow: sequenceType === "recurring" ? "recurring_mandate" : "hosted_checkout",
                status: toSafeDiagnosticCode(response.status, "FAILED"),
                webhookExpected: false,
                recoveryRequired: true,
              },
              persistence: {
                providerSessionId: response.id,
                nextActionKind: null,
                requestPayload: {
                  flow: sequenceType === "recurring" ? "recurring_mandate" : "hosted_checkout",
                  sequenceType,
                  amountMinor: input.money.amountMinor,
                  currency: input.money.currency,
                },
                responsePayload: {
                  paymentId: response.id,
                  status: response.status,
                },
                customerProviderRef: input.customerRef ?? null,
                paymentMethodRef: input.storedMethod?.reference ?? null,
                declineReason: refusal.code,
              },
            };
          }

          if (sequenceType === "recurring") {
            return {
              outcome: { kind: "attempt", status: "processing" },
              dispatch,
              diagnostics: {
                flow: "recurring_mandate",
                status: toSafeDiagnosticCode(response.status, "PROCESSING"),
                webhookExpected: true,
                recoveryRequired: false,
              },
              persistence: {
                providerSessionId: response.id,
                nextActionKind: null,
                requestPayload: {
                  flow: "recurring_mandate",
                  sequenceType,
                  amountMinor: input.money.amountMinor,
                  currency: input.money.currency,
                },
                responsePayload: {
                  paymentId: response.id,
                  status: response.status,
                },
                customerProviderRef: input.customerRef ?? null,
                paymentMethodRef: input.storedMethod?.reference ?? null,
              },
            };
          }

          const checkoutUrl = tryExtractCheckoutUrl(response);
          if (!checkoutUrl) {
            return {
              outcome: { kind: "attempt", status: "processing" },
              dispatch,
              diagnostics: {
                flow: "hosted_checkout",
                diagnosticCode: "MOLLIE_INVALID_REDIRECT_URL",
                webhookExpected: true,
              },
            };
          }

          return {
            outcome: { kind: "attempt", status: "requires_action" },
            dispatch,
            handoff: { kind: "redirect", url: checkoutUrl },
            diagnostics: {
              flow: "hosted_checkout",
              status: toSafeDiagnosticCode(response.status, "OPEN"),
              webhookExpected: true,
              recoveryRequired: false,
            },
            persistence: {
              providerSessionId: response.id,
              nextActionKind: "redirect",
              requestPayload: {
                flow: "hosted_checkout",
                sequenceType,
                amountMinor: input.money.amountMinor,
                currency: input.money.currency,
                saveForFutureUse: input.saveForFutureUse === true,
              },
              responsePayload: {
                paymentId: response.id,
                status: response.status,
                expiresAt: response.expiresAt ?? null,
              },
              customerProviderRef: input.customerRef ?? null,
              paymentMethodRef: null,
            },
          };
        } catch (error) {
          return translateTransportFailure(error);
        }
      },
    },
    verifyPort,
    readbackPort: {
      readPayment,
      close: closePayment,
    },
  };
}
