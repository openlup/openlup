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
  assertSafePayPalOrderId,
  majorStringToMinor,
  minorToMajorString,
  PayPalTransportError,
  resolveCurrencyExponent,
  toSafeDiagnosticCode,
  type PayPalClient,
  type PayPalCreateOrderRequest,
  type PayPalMode,
  type PayPalOrderResource,
} from "./client-contract.js";
import { createPayPalWebhookVerifier, mapPayPalRefusal } from "./webhook.js";

export interface PayPalPaymentAdapterConfig {
  /** Narrow structural client (use createPayPalHttpClient for zero-SDK REST v2). */
  client: PayPalClient;
  /** PayPal Webhook ID registered in the PayPal Developer Dashboard for signature verification. */
  webhookId: string;
  /** Valid HTTPS return URL after PayPal approval. */
  returnUrl: string;
  /** Valid HTTPS cancel URL if the payer cancels in PayPal checkout. */
  cancelUrl: string;
  mode: PayPalMode;
  /** Host-configured canonical 3-letter ISO-4217 uppercase currency codes. */
  supportedCurrencies: readonly string[];
  /** Neutral order description prefix (never contains payer PII). */
  defaultDescription?: string;
  maxWebhookBodyBytes?: number;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const SUPPORTED_METHOD_FAMILIES = new Set(["wallet", "card"]);

/** Static protocol capability descriptor; host supplies supportedCurrencies at construction. */
export const paypalPaymentCapabilities: Readonly<PaymentAdapterCapabilities> =
  Object.freeze<PaymentAdapterCapabilities>({
    providerKind: "paypal",
    captureFlows: Object.freeze([
      Object.freeze({
        kind: "hosted_checkout",
        handoff: "redirect",
        methodFamilies: Object.freeze(["wallet", "card"] as const),
      }),
    ]),
    requiresStoredMandateEvidence: false,
    assessMandate: () => ({
      chargeable: false,
      blockReason: "mandate_model_unsupported_for_unattended_charge",
    }),
    unattendedChargeFlow: "unsupported",
    payerContext: Object.freeze({
      requiresPayerBlock: false,
      customerRefFallsBackToContactEmail: false,
    }),
    methodHealth: Object.freeze({
      requiresCustomerRef: false,
      requiredMethodKind: null,
      requiresPayerContact: false,
    }),
    terminalOutcomeReporting: Object.freeze({
      kind: "status_field",
      silenceBecomesSuspectAfterMinutes: 360,
    }),
    mandateUpsertIsSubscriptionScoped: false,
    /** Host-configured via PayPalPaymentAdapterConfig.supportedCurrencies. */
    supportedCurrencies: Object.freeze([]),
    unattended: "unsupported",
    readback: "supported",
    close: "unsupported",
    exactAbsence: "unsupported",
    refundObservation: "supported",
    refundCreate: "unsupported",
    authorizationCaptureSplit: "unsupported",
  });

/**
 * Deterministic serializable projection of static capabilities (omitting the
 * JS function `assessMandate`), cross-checked mechanically against
 * `recipe.json#staticCapabilities` in conformance tests (provider recipe contract).
 */
export function projectPayPalStaticCapabilities(
  capabilities: PaymentAdapterCapabilities = paypalPaymentCapabilities,
): Record<string, unknown> {
  const { assessMandate: _omittedFunction, ...serializable } = capabilities;
  return JSON.parse(JSON.stringify(serializable)) as Record<string, unknown>;
}

function assertHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid PayPal ${label}`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`PayPal ${label} must be an HTTPS URL without credentials`);
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

function tryExtractApproveUrl(order: PayPalOrderResource): string | null {
  const links = order.links;
  if (!Array.isArray(links)) return null;
  const approve =
    links.find((l) => l && l.rel === "approve")
    ?? links.find((l) => l && l.rel === "payer-action");
  if (!approve || typeof approve.href !== "string" || approve.href.trim().length === 0) {
    return null;
  }
  try {
    return assertHttpsUrl(approve.href, "approve url");
  } catch {
    return null;
  }
}

function mapReadbackOrder(
  order: PayPalOrderResource,
  input: Parameters<PaymentReadbackPort["readPayment"]>[0],
): PaymentReadbackEnvelope {
  const base = {
    identity: input.identity,
    expectedMoney: input.expectedMoney,
    purpose: input.purpose,
  };

  if (!order || typeof order !== "object" || order.id !== input.identity.providerPaymentRef) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }

  const unit = order.purchase_units?.[0];
  if (!unit?.amount || unit.amount.currency_code !== input.expectedMoney.currency) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }
  const observedMinor = majorStringToMinor(unit.amount.value, input.expectedMoney.currency);
  if (observedMinor === null || observedMinor !== input.expectedMoney.amountMinor) {
    return { ...base, kind: "unknown", reason: "indeterminate" };
  }

  const capture = unit.payments?.captures?.[0];
  if (order.status === "COMPLETED") {
    if (!capture) {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    if (capture.status === "DECLINED" || capture.status === "FAILED") {
      return {
        ...base,
        kind: "failed",
        observedMoney: input.expectedMoney,
        providerOccurredAt: normalizeIsoTimestamp(
          capture.update_time ?? capture.create_time ?? order.update_time,
        ),
        refusal: mapPayPalRefusal(capture.status, capture.status_details?.reason),
      };
    }
    if (capture.status === "PENDING") {
      return {
        ...base,
        kind: "pending",
        observedMoney: input.expectedMoney,
        providerOccurredAt: normalizeIsoTimestamp(
          capture.update_time ?? capture.create_time ?? order.update_time ?? order.create_time,
        ),
      };
    }
    if (capture.status !== "COMPLETED") {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    if (!capture.amount || capture.amount.currency_code !== input.expectedMoney.currency) {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    const capturedMinor = majorStringToMinor(capture.amount.value, input.expectedMoney.currency);
    if (capturedMinor === null || capturedMinor !== input.expectedMoney.amountMinor) {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    return {
      ...base,
      kind: "succeeded",
      observedMoney: input.expectedMoney,
      providerOccurredAt: normalizeIsoTimestamp(
        capture.update_time ?? capture.create_time ?? order.update_time ?? order.create_time,
      ),
      capturedAmountBasis: "provider_capture_v1",
    };
  }

  if (order.status === "VOIDED") {
    return {
      ...base,
      kind: "failed",
      observedMoney: input.expectedMoney,
      providerOccurredAt: normalizeIsoTimestamp(order.update_time ?? order.create_time),
      refusal: mapPayPalRefusal(order.status),
    };
  }

  if (
    order.status === "CREATED"
    || order.status === "SAVED"
    || order.status === "APPROVED"
    || order.status === "PAYER_ACTION_REQUIRED"
  ) {
    const approveUrl = tryExtractApproveUrl(order);
    return {
      ...base,
      kind: "pending",
      observedMoney: input.expectedMoney,
      providerOccurredAt: normalizeIsoTimestamp(order.update_time ?? order.create_time),
      ...(approveUrl ? { handoff: { kind: "redirect", url: approveUrl } as const } : {}),
    };
  }

  return { ...base, kind: "unknown", reason: "indeterminate" };
}

function translateTransportFailure(error: unknown): PaymentExecutionEnvelope {
  // Never leak raw error.message from external transports into diagnostics.
  if (error instanceof PayPalTransportError) {
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
      diagnosticCode: "PAYPAL_TRANSPORT_UNKNOWN",
      uncertainDispatch: true,
    },
  };
}

/**
 * Explicit factory for the PayPal Orders API v2 PaymentAdapter.
 * Importing this module performs zero I/O, reads zero environment variables,
 * and registers no routes, schedules, or global state.
 */
export function createPayPalPaymentAdapter(config: PayPalPaymentAdapterConfig): PaymentAdapter {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid PayPal payment mode");
  }
  const returnUrl = assertHttpsUrl(config.returnUrl, "returnUrl");
  const cancelUrl = assertHttpsUrl(config.cancelUrl, "cancelUrl");

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
      "PayPal adapter requires a non-empty list of valid 3-letter ISO-4217 supportedCurrencies",
    );
  }
  const supportedCurrencies = Object.freeze([...new Set(config.supportedCurrencies)]);
  const descriptionPrefix = config.defaultDescription?.trim() || "Order";

  const capabilities: PaymentAdapterCapabilities = Object.freeze({
    ...paypalPaymentCapabilities,
    supportedCurrencies,
  });

  const checkInput = (
    input: Parameters<PaymentAttemptPort["validateInput"]>[0],
  ): string | null => {
    if (input.mode !== config.mode) return "PAYPAL_MODE_MISMATCH";
    if (input.purpose === "renewal-unattended") {
      return "PAYPAL_UNATTENDED_UNSUPPORTED";
    }
    if (input.purpose !== "initial" && input.purpose !== "recovery") {
      return "PAYPAL_UNSUPPORTED_PURPOSE";
    }
    if (
      !input.attemptRef?.trim()
      || !input.intentRef?.trim()
      || !input.fingerprint?.trim()
      || !input.providerIdempotencyKey?.trim()
    ) {
      return "PAYPAL_MISSING_ATTEMPT_IDENTITY";
    }
    if (!Number.isSafeInteger(input.money.amountMinor) || input.money.amountMinor <= 0) {
      return "PAYPAL_INVALID_AMOUNT";
    }
    if (!supportedCurrencies.includes(input.money.currency)) {
      return "PAYPAL_UNSUPPORTED_CURRENCY";
    }
    if (input.orderMode !== undefined && !["one_time", "subscription_cycle"].includes(input.orderMode)) {
      return "PAYPAL_INVALID_ORDER_MODE";
    }
    if (input.customerAuthorization !== undefined) {
      return "PAYPAL_CUSTOMER_AUTH_UNSUPPORTED";
    }
    if (
      input.methodSelection !== undefined
      && !SUPPORTED_METHOD_FAMILIES.has(input.methodSelection.family)
    ) {
      return "PAYPAL_UNSUPPORTED_METHOD_FAMILY";
    }
    return null;
  };

  const validateInput: PaymentAttemptPort["validateInput"] = (input) => {
    const failure = checkInput(input);
    if (failure) {
      throw new Error(`Unsupported PayPal payment input: ${failure}`);
    }
  };

  const verifyPort = createPayPalWebhookVerifier({
    mode: config.mode,
    webhookId: config.webhookId,
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
    if (input.identity.provider !== "paypal") {
      return { ...base, kind: "unsupported" };
    }
    if (!input.identity.providerPaymentRef) {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    let safeId: string;
    try {
      safeId = assertSafePayPalOrderId(input.identity.providerPaymentRef);
    } catch {
      return { ...base, kind: "unknown", reason: "indeterminate" };
    }
    try {
      const order = await config.client.getOrder(safeId);
      return mapReadbackOrder(order, input);
    } catch (error) {
      if (error instanceof PayPalTransportError && error.diagnosticCode === "PAYPAL_REQUEST_TIMEOUT") {
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

        const request: PayPalCreateOrderRequest = {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: input.attemptRef,
              custom_id: input.intentRef,
              description: `${descriptionPrefix} ${input.orderRef ?? input.intentRef}`,
              amount: {
                currency_code: input.money.currency,
                value: minorToMajorString(input.money.amountMinor, input.money.currency),
              },
            },
          ],
          application_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: "PAY_NOW",
          },
        };

        try {
          const response = await config.client.createOrder(request, {
            idempotencyKey: input.providerIdempotencyKey,
          });

          if (!response || typeof response.id !== "string" || response.id.length === 0) {
            return {
              outcome: { kind: "attempt", status: "processing" },
              dispatch: { kind: "unknown" },
              diagnostics: {
                diagnosticCode: "PAYPAL_INCOMPLETE_RESPONSE",
                webhookExpected: true,
              },
            };
          }

          const dispatch: PaymentExecutionEnvelope["dispatch"] = {
            kind: "dispatched",
            providerPaymentRef: response.id,
          };

          if (response.status === "VOIDED") {
            const refusal = mapPayPalRefusal(response.status);
            return {
              outcome: { kind: "decline", refusal },
              dispatch,
              diagnostics: {
                flow: "hosted_checkout",
                status: toSafeDiagnosticCode(response.status, "VOIDED"),
                webhookExpected: false,
                recoveryRequired: true,
              },
              persistence: {
                providerSessionId: response.id,
                nextActionKind: null,
                requestPayload: {
                  flow: "hosted_checkout",
                  amountMinor: input.money.amountMinor,
                  currency: input.money.currency,
                },
                responsePayload: {
                  orderId: response.id,
                  status: response.status,
                },
                customerProviderRef: input.customerRef ?? null,
                paymentMethodRef: null,
                declineReason: refusal.code,
              },
            };
          }

          const approveUrl = tryExtractApproveUrl(response);
          if (!approveUrl) {
            return {
              outcome: { kind: "attempt", status: "processing" },
              dispatch,
              diagnostics: {
                flow: "hosted_checkout",
                diagnosticCode: "PAYPAL_INVALID_APPROVE_URL",
                webhookExpected: true,
              },
            };
          }

          return {
            outcome: { kind: "attempt", status: "requires_action" },
            dispatch,
            handoff: { kind: "redirect", url: approveUrl },
            diagnostics: {
              flow: "hosted_checkout",
              status: toSafeDiagnosticCode(response.status, "CREATED"),
              webhookExpected: true,
              recoveryRequired: false,
            },
            persistence: {
              providerSessionId: response.id,
              nextActionKind: "redirect",
              requestPayload: {
                flow: "hosted_checkout",
                amountMinor: input.money.amountMinor,
                currency: input.money.currency,
              },
              responsePayload: {
                orderId: response.id,
                status: response.status,
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
    },
  };
}
