import { classifyPaymentFailure, type PaymentFailureHint } from "@openlup/core/payment";
import type {
  PaymentAdapter,
  PaymentAdapterCapabilities,
  PaymentAttemptPort,
  PaymentExecutionEnvelope,
  PaymentReadbackEnvelope,
  PaymentReadbackPort,
  PaymentRefusalEnvelope,
  TransientSecret,
} from "@openlup/platform/payments/contracts";
import {
  AdyenTransportError,
  assertSafeAdyenPathSegment,
  toSafeDiagnosticCode,
  type AdyenCheckoutClient,
  type AdyenCreatePaymentResponse,
} from "./client-contract.js";
import {
  createAdyenWebhookVerifier,
  deriveAdyenFailureHints,
  type AdyenCaptureMode,
} from "./webhook.js";

export interface AdyenPaymentAdapterConfig {
  /** Narrow structural client (use createAdyenHttpClient for zero-SDK REST v71). */
  client: AdyenCheckoutClient;
  merchantAccount: string;
  /** Valid HTTPS return URL for Drop-in / redirect completions. */
  returnUrl: string;
  /** One or more hex-encoded Adyen HMAC keys for webhook verification. */
  hmacKeysHex: readonly string[];
  mode: "live" | "test";
  /** Host-configured canonical 3-letter ISO-4217 uppercase currency codes. */
  supportedCurrencies: readonly string[];
  /** Optional ISO-3166 alpha-2 country code passed to Adyen /sessions when desired. */
  defaultCountryCode?: string;
  /** Whether AUTHORISATION settles immediately or waits for CAPTURE webhooks. */
  captureMode?: AdyenCaptureMode;
  maxWebhookBodyBytes?: number;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/** Static protocol capability descriptor; host supplies supportedCurrencies at construction. */
export const adyenPaymentCapabilities: Readonly<PaymentAdapterCapabilities> = Object.freeze<PaymentAdapterCapabilities>({
  providerKind: "adyen",
  captureFlows: Object.freeze([
    Object.freeze({
      kind: "dropin_session",
      handoff: "client-confirmed",
      methodFamilies: Object.freeze(["card", "wallet"] as const),
    }),
    Object.freeze({
      kind: "redirect_payment",
      handoff: "redirect",
      methodFamilies: Object.freeze(["bank-redirect"] as const),
    }),
  ]),
  requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }),
  unattendedChargeFlow: "off_session_payment",
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
  /** Host-configured via AdyenPaymentAdapterConfig.supportedCurrencies. */
  supportedCurrencies: Object.freeze([]),
  unattended: "supported",
  readback: "unsupported",
  close: "supported",
  exactAbsence: "unsupported",
  refundObservation: "supported",
  refundCreate: "unsupported",
  authorizationCaptureSplit: "unsupported",
});

/**
 * Deterministic serializable projection of static capabilities (omitting the
 * JS function `assessMandate`), cross-checked mechanically against
 * `recipe.json#staticCapabilities` in conformance tests (ADR-001 §4).
 */
export function projectAdyenStaticCapabilities(
  capabilities: PaymentAdapterCapabilities = adyenPaymentCapabilities,
): Record<string, unknown> {
  const { assessMandate: _omittedFunction, ...serializable } = capabilities;
  return JSON.parse(JSON.stringify(serializable)) as Record<string, unknown>;
}

function brandTransientSecret(value: string): TransientSecret {
  return value as TransientSecret;
}

function assertHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Adyen ${label}`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`Adyen ${label} must be an HTTPS URL without credentials`);
  }
  return parsed.toString();
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

function mapAdyenSyncDecline(response: AdyenCreatePaymentResponse): PaymentRefusalEnvelope {
  const hints = deriveAdyenFailureHints(
    response.refusalReason ?? null,
    response.refusalReasonCode ?? response.resultCode,
  );
  const classified = classifyPaymentFailure({ neutralReasonHints: hints });
  return {
    code: classified.failureClass,
    hints,
  };
}

function isRedirectSelection(
  input: Parameters<PaymentAttemptPort["validateInput"]>[0],
): boolean {
  return input.purpose !== "renewal-unattended" && input.methodSelection?.family === "bank-redirect";
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

/**
 * Explicit factory for the Adyen Checkout v71 PaymentAdapter.
 * Importing this module performs zero I/O, reads zero environment variables,
 * and registers no routes, schedules, or global state.
 */
export function createAdyenPaymentAdapter(config: AdyenPaymentAdapterConfig): PaymentAdapter {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid Adyen payment mode");
  }
  if (!config.merchantAccount || config.merchantAccount.trim().length === 0) {
    throw new Error("Adyen adapter requires merchantAccount");
  }
  const merchantAccount = config.merchantAccount.trim();
  const returnUrl = assertHttpsUrl(config.returnUrl, "returnUrl");

  if (
    !Array.isArray(config.supportedCurrencies)
    || config.supportedCurrencies.length === 0
    || !config.supportedCurrencies.every((c) => typeof c === "string" && CURRENCY_PATTERN.test(c))
  ) {
    throw new Error("Adyen adapter requires a non-empty list of 3-letter ISO supportedCurrencies");
  }
  const supportedCurrencies = Object.freeze([...new Set(config.supportedCurrencies)]);

  const capabilities: PaymentAdapterCapabilities = Object.freeze({
    ...adyenPaymentCapabilities,
    supportedCurrencies,
    close: typeof config.client.cancelPayment === "function" ? "supported" : "unsupported",
  });

  const checkInput = (input: Parameters<PaymentAttemptPort["validateInput"]>[0]): string | null => {
    if (input.mode !== config.mode) return "ADYEN_MODE_MISMATCH";
    if (!["initial", "recovery", "renewal-unattended"].includes(input.purpose)) {
      return "ADYEN_UNSUPPORTED_PURPOSE";
    }
    if (!input.attemptRef || !input.intentRef || !input.fingerprint || !input.providerIdempotencyKey) {
      return "ADYEN_MISSING_ATTEMPT_IDENTITY";
    }
    if (!Number.isSafeInteger(input.money.amountMinor) || input.money.amountMinor <= 0) {
      return "ADYEN_INVALID_AMOUNT";
    }
    if (!supportedCurrencies.includes(input.money.currency)) {
      return "ADYEN_UNSUPPORTED_CURRENCY";
    }
    if (input.orderMode !== undefined && !["one_time", "subscription_cycle"].includes(input.orderMode)) {
      return "ADYEN_INVALID_ORDER_MODE";
    }
    if (input.purpose === "renewal-unattended" && input.orderMode === "one_time") {
      return "ADYEN_INVALID_RENEWAL_ORDER_MODE";
    }
    if (input.customerAuthorization !== undefined) {
      return "ADYEN_CUSTOMER_AUTH_UNSUPPORTED";
    }
    if (input.purpose === "renewal-unattended") {
      if (!input.storedMethod?.reference) return "ADYEN_MISSING_STORED_METHOD";
      const assessment = capabilities.assessMandate(input.storedMethod.mandate);
      if (!assessment.chargeable) return "ADYEN_MANDATE_NOT_CHARGEABLE";
    } else if (
      input.methodSelection !== undefined
      && !["card", "wallet", "bank-redirect"].includes(input.methodSelection.family)
    ) {
      return "ADYEN_UNSUPPORTED_METHOD_FAMILY";
    }
    return null;
  };

  const validateInput: PaymentAttemptPort["validateInput"] = (input) => {
    const failure = checkInput(input);
    if (failure) {
      throw new Error(`Unsupported Adyen payment input: ${failure}`);
    }
  };

  const verifyPort = createAdyenWebhookVerifier({
    mode: config.mode,
    merchantAccount,
    hmacKeysHex: config.hmacKeysHex,
    supportedCurrencies,
    captureMode: config.captureMode,
    maxBodyBytes: config.maxWebhookBodyBytes,
  });

  const readPayment: PaymentReadbackPort["readPayment"] = async (input) => {
    // Adyen Checkout v71 has no synchronous payment-status GET readback API;
    // refuse honestly with zero provider I/O.
    return {
      identity: input.identity,
      expectedMoney: input.expectedMoney,
      purpose: input.purpose,
      kind: "unsupported",
    };
  };

  const closePayment: NonNullable<PaymentReadbackPort["close"]> | undefined =
    typeof config.client.cancelPayment === "function"
      ? async (input): Promise<PaymentReadbackEnvelope> => {
          const base = {
            identity: input.identity,
            expectedMoney: input.expectedMoney,
            purpose: input.purpose,
          };
          if (input.identity.provider !== "adyen" || !input.identity.providerPaymentRef) {
            return { ...base, kind: "unsupported" };
          }
          try {
            const safeRef = assertSafeAdyenPathSegment(
              input.identity.providerPaymentRef,
              "providerPaymentRef",
            );
            const result = await config.client.cancelPayment!(
              safeRef,
              {
                merchantAccount,
                reference: `cancel:${input.identity.attemptRef}`,
              },
              { idempotencyKey: `adyen:cancel:${input.identity.attemptRef}` },
            );
            // Adyen /cancels is asynchronous (`status: "received"`): never fabricate
            // terminal "failed" before the signed CANCELLATION webhook arrives.
            if (result.status === "received") {
              return {
                ...base,
                kind: "pending",
                observedMoney: input.expectedMoney,
                providerOccurredAt: null,
              };
            }
            return { ...base, kind: "unknown", reason: "indeterminate" };
          } catch {
            return { ...base, kind: "unknown", reason: "indeterminate" };
          }
        }
      : undefined;

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
          value: input.money.amountMinor,
        };
        const metadata = buildMetadata(input);
        const options = { idempotencyKey: input.providerIdempotencyKey };

        try {
          // Path 1: Unattended subscription renewal (ContAuth)
          if (input.purpose === "renewal-unattended") {
            const response = await config.client.createPayment(
              {
                merchantAccount,
                amount,
                reference: input.intentRef,
                returnUrl,
                shopperReference: input.customerRef ?? input.clientId ?? input.intentRef,
                shopperInteraction: "ContAuth",
                recurringProcessingModel: "Subscription",
                paymentMethod: {
                  storedPaymentMethodId: input.storedMethod!.reference,
                },
                metadata,
              },
              options,
            );

            return translateAdyenPaymentResponse(response, {
              flow: "off_session_payment",
              amount,
              intentRef: input.intentRef,
              attemptRef: input.attemptRef,
              storedMethodRef: input.storedMethod!.reference,
            });
          }

          // Path 2: Bank redirect flow via POST /payments
          if (isRedirectSelection(input)) {
            const channelType = input.methodSelection?.channelRef ?? "ideal";
            const response = await config.client.createPayment(
              {
                merchantAccount,
                amount,
                reference: input.intentRef,
                returnUrl,
                shopperReference: input.customerRef ?? input.clientId,
                shopperInteraction: "Ecommerce",
                paymentMethod: { type: channelType },
                metadata,
              },
              options,
            );

            return translateAdyenPaymentResponse(response, {
              flow: "redirect_payment",
              amount,
              intentRef: input.intentRef,
              attemptRef: input.attemptRef,
              storedMethodRef: null,
            });
          }

          // Path 3: Interactive card/wallet Drop-in via POST /sessions (TransientSecret handoff)
          const session = await config.client.createSession(
            {
              merchantAccount,
              amount,
              reference: input.intentRef,
              returnUrl,
              ...(config.defaultCountryCode ? { countryCode: config.defaultCountryCode } : {}),
              ...(input.customerRef ?? input.clientId
                ? { shopperReference: input.customerRef ?? input.clientId }
                : {}),
              ...(input.saveForFutureUse
                ? {
                    storePaymentMethodMode: "enabled",
                    recurringProcessingModel: "Subscription",
                  }
                : {}),
              metadata,
            },
            options,
          );

          if (!session.id || !session.sessionData) {
            return {
              outcome: { kind: "attempt", status: "processing" },
              dispatch: { kind: "unknown" },
              diagnostics: { diagnosticCode: "ADYEN_INCOMPLETE_SESSION", webhookExpected: true },
            };
          }

          // Keep sessionData strictly inside the transient handoff payload; never persist it.
          const transientPayload = brandTransientSecret(
            JSON.stringify({ id: session.id, sessionData: session.sessionData }),
          );

          return {
            outcome: { kind: "attempt", status: "requires_action" },
            dispatch: { kind: "dispatched", providerPaymentRef: session.id },
            handoff: { kind: "client-confirmed", payload: transientPayload },
            diagnostics: {
              flow: "dropin_session",
              webhookExpected: true,
              recoveryRequired: false,
            },
            persistence: {
              providerSessionId: session.id,
              nextActionKind: "adyen_dropin_session",
              requestPayload: {
                flow: "dropin_session",
                amountMinor: amount.value,
                currency: amount.currency,
                saveForFutureUse: input.saveForFutureUse === true,
              },
              responsePayload: {
                sessionId: session.id,
                expiresAt: session.expiresAt ?? null,
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
      ...(closePayment ? { close: closePayment } : {}),
    },
  };
}

function translateAdyenPaymentResponse(
  response: AdyenCreatePaymentResponse,
  context: {
    flow: "off_session_payment" | "redirect_payment";
    amount: { currency: string; value: number };
    intentRef: string;
    attemptRef: string;
    storedMethodRef: string | null;
  },
): PaymentExecutionEnvelope {
  const dispatch: PaymentExecutionEnvelope["dispatch"] = response.pspReference
    ? { kind: "dispatched", providerPaymentRef: response.pspReference }
    : { kind: "unknown" };

  if (response.resultCode === "Refused" || response.resultCode === "Error" || response.resultCode === "Cancelled") {
    const refusal = mapAdyenSyncDecline(response);
    return {
      outcome: { kind: "decline", refusal },
      dispatch,
      diagnostics: {
        flow: context.flow,
        resultCode: toSafeDiagnosticCode(response.resultCode, "REFUSED"),
        webhookExpected: false,
        recoveryRequired: true,
      },
      persistence: {
        providerSessionId: response.pspReference ?? null,
        nextActionKind: null,
        requestPayload: {
          flow: context.flow,
          amountMinor: context.amount.value,
          currency: context.amount.currency,
        },
        responsePayload: {
          resultCode: response.resultCode,
          refusalReasonCode: response.refusalReasonCode
            ? toSafeDiagnosticCode(response.refusalReasonCode, "REFUSED")
            : null,
        },
        paymentMethodRef: context.storedMethodRef,
        declineReason: refusal.code,
      },
    };
  }

  let redirectUrl: string | null = null;
  if (response.resultCode === "RedirectShopper" && typeof response.action?.url === "string") {
    try {
      redirectUrl = assertHttpsUrl(response.action.url, "redirect action url");
    } catch {
      return {
        outcome: { kind: "attempt", status: "processing" },
        dispatch,
        diagnostics: {
          flow: context.flow,
          diagnosticCode: "ADYEN_INVALID_REDIRECT_URL",
          webhookExpected: true,
        },
      };
    }
  }

  const status =
    redirectUrl || response.resultCode === "ChallengeShopper" || response.resultCode === "IdentifyShopper"
      ? "requires_action"
      : "processing";

  return {
    outcome: { kind: "attempt", status },
    dispatch,
    ...(redirectUrl ? { handoff: { kind: "redirect", url: redirectUrl } as const } : {}),
    diagnostics: {
      flow: context.flow,
      resultCode: toSafeDiagnosticCode(response.resultCode, "PROCESSING"),
      webhookExpected: true,
      recoveryRequired: false,
    },
    persistence: {
      providerSessionId: response.pspReference ?? null,
      nextActionKind: redirectUrl ? "redirect" : status === "requires_action" ? "3ds_challenge" : null,
      requestPayload: {
        flow: context.flow,
        amountMinor: context.amount.value,
        currency: context.amount.currency,
      },
      responsePayload: {
        resultCode: response.resultCode,
      },
      paymentMethodRef: context.storedMethodRef,
    },
  };
}

function translateTransportFailure(error: unknown): PaymentExecutionEnvelope {
  // Never leak raw error.message from external transports into diagnostics.
  if (error instanceof AdyenTransportError) {
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

  // Adyen Checkout v71 has no pre-dispatch OAuth step; any unverified transport
  // exception (timeouts, 5xx, 409, network resets) must preserve dispatch
  // uncertainty (`dispatch: { kind: "unknown" }`) rather than fabricating
  // exact no-charge (`notDispatched`) evidence.
  return {
    outcome: { kind: "attempt", status: "processing" },
    dispatch: { kind: "unknown" },
    diagnostics: {
      diagnosticCode: "ADYEN_TRANSPORT_UNKNOWN",
      uncertainDispatch: true,
    },
  };
}
