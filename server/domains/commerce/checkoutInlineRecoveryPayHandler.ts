import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION,
  checkoutInlineRecoveryPayRequestSchema,
  checkoutInlineRecoveryPayResponseSchema,
  type CheckoutInlineRecoveryPayRequest,
} from "../../../src/domains/commerce/checkoutInlineRecoveryContracts.js";
import type { CheckoutPaymentContinuationClaims, CheckoutPaymentContinuationMinter } from "./checkoutPaymentContinuationCredential.js";
import type { PaymentRecoveryReadDeps, PaymentRecoverySnapshot } from "./paymentRecoveryGuidanceAuthorization.js";
import { readAuthorizedPaymentRecovery } from "./paymentRecoveryGuidanceAuthorization.js";
import type { CheckoutRecoveryOrderReadPort, CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import { CheckoutRecoveryPayError, type CheckoutRecoveryPayResult, type CheckoutRecoveryPayService } from "./checkoutRecoveryPayService.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutActivePaymentActionResolver } from "../payment/contracts.js";

const INLINE_RETRY_PREFIX = "checkout-inline-recovery:";
const LIVE_ATTEMPT_STATUSES = new Set(["created", "sent_to_provider", "requires_action", "processing"]);

export interface CheckoutInlineRecoveryPayHandlerDeps {
  recoveryEnabled: () => boolean;
  readContinuationClaims: (cookieHeader: unknown) => CheckoutPaymentContinuationClaims | null;
  mintContinuation: CheckoutPaymentContinuationMinter;
  recoveryGuidance: PaymentRecoveryReadDeps;
  orderPort: CheckoutRecoveryOrderReadPort;
  payService: CheckoutRecoveryPayService;
  activeActionResolver: CheckoutActivePaymentActionResolver;
}

export function checkoutInlineRecoveryTransitionKey(expectedPaymentAttemptId: string): string {
  return `${INLINE_RETRY_PREFIX}${expectedPaymentAttemptId}`;
}

export function createCheckoutInlineRecoveryPayHandler(deps: CheckoutInlineRecoveryPayHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!deps.recoveryEnabled()) return unavailable(res, "feature_flag_disabled");
    const parsed = checkoutInlineRecoveryPayRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendBffError(res, "BAD_REQUEST", "Invalid inline recovery request", { details: parsed.error.flatten() });
    }
    const request = parsed.data;
    const claims = deps.readContinuationClaims(req.headers.cookie);
    if (!claims || !claimsMatchRequest(claims, request)) return unauthorized(res);

    const recovery = await readAuthorizedPaymentRecovery({
      request: { orderId: request.orderId, clientId: request.clientId,
        paymentIntentId: request.paymentIntentId, journeyId: request.journeyId },
      claims,
      // This sibling route is cookie-only. A bearer token must never widen it.
      authorization: undefined,
      deps: { port: deps.recoveryGuidance.port },
    });
    if (!recovery) return conflict(res, "recovery_state_unavailable");

    const order = await deps.orderPort.getRecoveryOrder({ orderId: request.orderId });
    if (!orderMatches(order, request) || !stateIsPayable(recovery.snapshot, order!)) {
      return conflict(res, "order_not_recoverable");
    }

    if (!recovery.guidance) {
      const replay = await replayResponse(request, recovery.snapshot, order!, deps.activeActionResolver);
      if (!replay) return conflict(res, "stale_recovery_authority");
      mintAndSend(res, request, order!, replay, deps.mintContinuation);
      return;
    }
    if (recovery.guidance.paymentAttemptId !== request.expectedPaymentAttemptId
      || !methodAllowed(request, recovery.guidance.methodKey, recovery.guidance.actions,
        recovery.guidance.restriction)) {
      return conflict(res, "recovery_action_not_allowed");
    }
    if (recovery.snapshot.paymentAttemptId !== request.expectedPaymentAttemptId
      || recovery.snapshot.attemptStatus !== "failed"
      || recovery.snapshot.intentStatus !== "failed"
      || order!.paymentIntentStatus !== "failed"
      || order!.priorPaymentEvidence?.paymentAttemptId !== request.expectedPaymentAttemptId) {
      return conflict(res, "stale_recovery_authority");
    }
    if (!executionMatchesContext(request, recovery.snapshot.purchaseContext)) {
      return conflict(res, "recovery_execution_not_allowed");
    }

    try {
      const result = await deps.payService.pay({
        order: order!, clientId: request.clientId,
        paymentProvider: request.paymentProvider,
        paymentExecution: request.paymentMethod === "blik" ? request.paymentExecution : undefined,
        idempotencyKey: checkoutInlineRecoveryTransitionKey(request.expectedPaymentAttemptId),
        exactInlineRetry: {
          expectedPaymentAttemptId: request.expectedPaymentAttemptId,
          retryRequestId: request.retryRequestId,
          purchaseContext: recovery.snapshot.purchaseContext!,
        },
      });
      if (!freshResultMatches(result, request)) return unavailable(res, "invalid_provider_result");
      mintAndSend(res, request, order!, result, deps.mintContinuation);
    } catch (error) {
      if (error instanceof CheckoutRecoveryPayError || error instanceof CommerceRuntimeConflictError) {
        return conflict(res, "payment_admission_refused");
      }
      throw error;
    }
  };
}

function claimsMatchRequest(claims: CheckoutPaymentContinuationClaims, request: CheckoutInlineRecoveryPayRequest): boolean {
  return claims.orderId === request.orderId && claims.clientId === request.clientId
    && claims.paymentIntentId === request.paymentIntentId && claims.journeyId === request.journeyId
    && claims.paymentAttemptId === request.expectedPaymentAttemptId;
}

function orderMatches(order: CheckoutRecoveryOrderSnapshot | null, request: CheckoutInlineRecoveryPayRequest): boolean {
  return Boolean(order) && order?.orderId === request.orderId && order.clientId === request.clientId
    && order.paymentIntentId === request.paymentIntentId && order.status === "pending_payment"
    && order.technicallyExpired !== true;
}

function stateIsPayable(snapshot: PaymentRecoverySnapshot, order: CheckoutRecoveryOrderSnapshot): boolean {
  if (snapshot.orderStatus !== "pending_payment" || snapshot.eligible !== true || !snapshot.purchaseContext) return false;
  if (snapshot.purchaseContext === "subscription_initial") {
    return snapshot.subscriptionStatus === "pending_activation" && Boolean(snapshot.subscriptionId)
      && order.mode === "subscription_cycle" && order.subscriptionId === snapshot.subscriptionId;
  }
  return snapshot.subscriptionStatus === null && snapshot.subscriptionId === null
    && order.mode === "one_time_order" && order.subscriptionId === null;
}

function methodAllowed(
  request: CheckoutInlineRecoveryPayRequest,
  previousMethod: string | null,
  actions: readonly string[],
  restriction: string | null,
): boolean {
  if (previousMethod !== "card" && previousMethod !== "blik") return false;
  if (previousMethod !== request.paymentMethod) return actions.includes("change_method");
  return restriction !== "method"
    && (actions.includes("change_instrument") || actions.includes("correct_data"));
}

function executionMatchesContext(
  request: CheckoutInlineRecoveryPayRequest,
  context: PaymentRecoverySnapshot["purchaseContext"],
): boolean {
  if (request.paymentMethod === "card") return request.paymentProvider === "stripe";
  return request.paymentProvider === "tpay" && (context === "one_time"
    ? request.paymentExecution.flow === "blik_one_time"
    : context === "subscription_initial"
      && request.paymentExecution.flow === "blik_recurring_activation"
      && request.paymentExecution.recurringModel === "O");
}

function freshResultMatches(result: CheckoutRecoveryPayResult, request: CheckoutInlineRecoveryPayRequest): boolean {
  return result.orderId === request.orderId && result.clientId === request.clientId
    && result.paymentIntentId === request.paymentIntentId && Boolean(result.paymentAttemptId)
    && result.provider === request.paymentProvider
    && ["processing", "requires_action", "failed"].includes(result.status);
}

async function replayResponse(
  request: CheckoutInlineRecoveryPayRequest,
  snapshot: PaymentRecoverySnapshot,
  order: CheckoutRecoveryOrderSnapshot,
  resolver: CheckoutActivePaymentActionResolver,
): Promise<CheckoutRecoveryPayResult | null> {
  const evidence = order.priorPaymentEvidence;
  const expectedPrepareKey = `${checkoutInlineRecoveryTransitionKey(request.expectedPaymentAttemptId)}:payment-execution:prepare-attempt`;
  if (!evidence || evidence.paymentIntentId !== request.paymentIntentId
    || evidence.paymentAttemptId !== snapshot.paymentAttemptId
    || evidence.provider !== request.paymentProvider
    || evidence.idempotencyKey !== expectedPrepareKey
    || evidence.retryRequestId !== request.retryRequestId) return null;

  if (snapshot.attemptStatus === "failed" && snapshot.intentStatus === "failed") {
    return { orderId: request.orderId, paymentIntentId: request.paymentIntentId, clientId: request.clientId,
      status: "failed", paymentAttemptId: evidence.paymentAttemptId, provider: evidence.provider,
      providerPaymentId: evidence.providerPaymentId, failureReason: snapshot.failureReason,
      clientAction: { kind: "none" } };
  }
  if (!snapshot.attemptStatus || !LIVE_ATTEMPT_STATUSES.has(snapshot.attemptStatus)
    || !["created", "processing", "requires_action"].includes(snapshot.intentStatus)) return null;
  if (request.paymentProvider === "tpay") {
    return { orderId: request.orderId, paymentIntentId: request.paymentIntentId, clientId: request.clientId,
      status: "processing", paymentAttemptId: evidence.paymentAttemptId, provider: evidence.provider,
      providerPaymentId: evidence.providerPaymentId, clientAction: { kind: "none" } };
  }
  const action = await resolver.readActiveAction({ orderId: request.orderId, clientId: request.clientId,
    paymentIntentId: request.paymentIntentId, paymentAttemptId: evidence.paymentAttemptId,
    executionRail: "stripe" });
  return { orderId: request.orderId, paymentIntentId: request.paymentIntentId, clientId: request.clientId,
    // Exact durable ownership is enough to rotate the cookie. Provider readback
    // only enriches the response; a lagging/null read remains safe polling and
    // must never tempt the browser to dispatch a second provider object.
    status: action && snapshot.intentStatus === "requires_action" ? "requires_action" : "processing",
    paymentAttemptId: evidence.paymentAttemptId, provider: evidence.provider,
    providerPaymentId: evidence.providerPaymentId, clientAction: action ?? { kind: "none" } };
}

function mintAndSend(
  res: VercelResponse,
  request: CheckoutInlineRecoveryPayRequest,
  order: CheckoutRecoveryOrderSnapshot,
  result: CheckoutRecoveryPayResult,
  mint: CheckoutPaymentContinuationMinter,
): void {
  mint(res, { journeyId: request.journeyId, orderId: request.orderId, clientId: request.clientId,
    paymentIntentId: request.paymentIntentId, paymentAttemptId: result.paymentAttemptId!,
    executionRail: request.paymentProvider });
  const response = checkoutInlineRecoveryPayResponseSchema.parse({
    contractVersion: CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION, ...result, orderRef: order.orderRef,
  });
  sendBffSuccess(res, response, { contractVersion: CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION });
}

function unauthorized(res: VercelResponse): void {
  sendBffError(res, "UNAUTHORIZED", "Inline recovery authority is unavailable");
}
function conflict(res: VercelResponse, reason: string): void {
  sendBffError(res, "CONFLICT", "Inline recovery cannot start", { details: { reason } });
}
function unavailable(res: VercelResponse, reason: string): void {
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inline recovery is unavailable", { details: { reason } });
}
