import type {
  VercelRequest as HttpRequest,
  VercelResponse as HttpResponse,
} from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CHECKOUT_CONTRACT_VERSION,
  paymentStatusResponseSchema,
  type PaymentStatusResponse,
} from "../../../src/domains/commerce/checkoutContracts.js";
import { paymentStatusContinuationRequestSchema } from "../../../src/domains/commerce/paymentContinuationContracts.js";
import { deriveAsyncCheckoutStatus } from "../../../src/domains/commerce/paymentStatus.js";
import { displayReasonFor } from "../../adapters/paymentFailureDisplay.js";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "../../../src/domains/commerce/paymentFailureDisplayContracts.js";
import type {
  PaymentAttemptStatus,
  PaymentIntentStatus,
} from "../../../src/domains/payment/types.js";
import type { SubscriptionActivationStatus } from "../../../src/domains/payment/contracts.js";
import type { CheckoutPaymentContinuationClaims } from "./checkoutPaymentContinuationCredential.js";
import type {
  CheckoutActivePaymentActionResolver,
  ProviderRecoveryAction,
} from "../payment/contracts.js";

import { PAYMENT_RECOVERY_GUIDANCE_HEADER } from "../../../src/domains/commerce/paymentRecoveryGuidanceContracts.js";
import { readAuthorizedPaymentRecovery, type PaymentRecoveryReadDeps } from "./paymentRecoveryGuidanceAuthorization.js";

export interface PaymentStatusSnapshot {
  orderId: string;
  orderStatus: string;
  clientId: string;
  paymentIntentId: string;
  intentStatus: PaymentIntentStatus;
  paymentAttemptId: string | null;
  attemptStatus: PaymentAttemptStatus | null;
  provider: string | null;
  providerPaymentId: string | null;
  updatedAt: string;
  /** Stable code, never provider prose. Drives what the buyer is told. */
  failureReason: string | null;
  subscriptionActivationStatus: SubscriptionActivationStatus;
  subscriptionId: string | null;
}

export interface PaymentStatusReadPort {
  getPaymentStatus(input: {
    orderId: string;
    paymentIntentId: string;
  }): Promise<PaymentStatusSnapshot | null>;
}

export interface CommercePaymentStatusHandlerDeps {
  statusPort: PaymentStatusReadPort;
  recoveryGuidance?: PaymentRecoveryReadDeps;
  mutationsEnabled: () => boolean;
  readContinuationClaims?: (cookieHeader: unknown) => CheckoutPaymentContinuationClaims | null;
  activeActionResolver?: CheckoutActivePaymentActionResolver;
}

export function createCommercePaymentStatusHandler({
  statusPort,
  recoveryGuidance,
  mutationsEnabled,
  readContinuationClaims,
  activeActionResolver,
}: CommercePaymentStatusHandlerDeps) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    appendVaryStatusCapabilities(res);
    if (!mutationsEnabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Provider payment status is disabled", {
        details: {
          feature: "payment-status",
          featureFlag: "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    const parsed = paymentStatusContinuationRequestSchema.safeParse(normalizeQuery(req.query));
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid payment status request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const claims = readContinuationClaims?.(req.headers.cookie) ?? null;
    const guidanceRequested = req.headers[PAYMENT_RECOVERY_GUIDANCE_HEADER.toLowerCase()] === "1";
    const recovery = guidanceRequested && recoveryGuidance
      ? await readAuthorizedPaymentRecovery({ request: parsed.data, claims,
        authorization: req.headers.authorization, deps: recoveryGuidance }) : null;
    const snapshot = recovery?.snapshot ?? await statusPort.getPaymentStatus(parsed.data);
    if (!snapshot) {
      sendBffError(res, "NOT_FOUND", "Payment status not found");
      return;
    }
    if (snapshot.clientId !== parsed.data.clientId) {
      sendBffError(res, "FORBIDDEN", "Payment status does not belong to this client");
      return;
    }

    let nextAction: ProviderRecoveryAction | null = null;
    if (
      activeActionResolver
      && claims
      && parsed.data.journeyId === claims.journeyId
      && parsed.data.orderId === claims.orderId
      && parsed.data.clientId === claims.clientId
      && parsed.data.paymentIntentId === claims.paymentIntentId
      && snapshot.paymentAttemptId === claims.paymentAttemptId
      && snapshot.provider === claims.executionRail
    ) {
      nextAction = await activeActionResolver.readActiveAction({
        orderId: claims.orderId,
        clientId: claims.clientId,
        paymentIntentId: claims.paymentIntentId,
        paymentAttemptId: claims.paymentAttemptId,
        executionRail: claims.executionRail,
      });
    }

    const response = buildPaymentStatusResponse(snapshot, nextAction);
    // Project after validation: older strict clients cannot accept even null.
    const { failureDisplay, ...legacyResponse } = response;
    const optedIn = req.headers[PAYMENT_FAILURE_DISPLAY_HEADER.toLowerCase()] === "1";
    const legacy = optedIn ? { ...legacyResponse, failureDisplay } : legacyResponse;
    sendBffSuccess(res, guidanceRequested ? { ...legacy, recoveryGuidance: recovery?.guidance ?? null } : legacy, {
      contractVersion: CHECKOUT_CONTRACT_VERSION,
    });
  };
}

export function buildPaymentStatusResponse(
  snapshot: PaymentStatusSnapshot,
  nextAction: ProviderRecoveryAction | null = null,
): PaymentStatusResponse {
  return paymentStatusResponseSchema.parse({
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    orderId: snapshot.orderId,
    paymentIntentId: snapshot.paymentIntentId,
    orderStatus: snapshot.orderStatus,
    status: deriveAsyncCheckoutStatus({
      intentStatus: snapshot.intentStatus,
      attemptStatus: snapshot.attemptStatus,
      orderStatus: snapshot.orderStatus,
    }),
    payment: {
      intentStatus: snapshot.intentStatus,
      attemptStatus: snapshot.attemptStatus,
      paymentAttemptId: snapshot.paymentAttemptId,
      provider: snapshot.provider,
      providerPaymentId: snapshot.providerPaymentId,
      updatedAt: snapshot.updatedAt,
    },
    // Passed through untouched. It is the stable provider-native identity that
    // logs, evidence and the account-recovery surfaces read, and two of those
    // compare it to a literal.
    failureReason: snapshot.failureReason,
    // The same refusal in a vocabulary a surface can render. Derived here rather
    // than in the browser so the provider's own naming never crosses into a
    // buyer's URL, and so one deployment answers the question once.
    failureDisplay: displayReasonFor(snapshot.failureReason),
    subscriptionActivation: {
      status: snapshot.subscriptionActivationStatus,
      subscriptionId: snapshot.subscriptionId,
    },
    nextAction,
  });
}

function appendVaryStatusCapabilities(res: HttpResponse): void {
  const current = res.getHeader?.("Vary");
  const values = (Array.isArray(current) ? current : [current])
    .flatMap((value) => typeof value === "string" ? value.split(",") : [])
    .map((value) => value.trim())
    .filter(Boolean);
  for (const header of ["Cookie", "Authorization", PAYMENT_FAILURE_DISPLAY_HEADER, PAYMENT_RECOVERY_GUIDANCE_HEADER]) {
    if (!values.some((value) => value.toLowerCase() === header.toLowerCase())) values.push(header);
  }
  res.setHeader("Vary", values.join(", "));
}

function normalizeQuery(query: HttpRequest["query"]): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    normalized[key] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
