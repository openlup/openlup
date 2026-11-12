import { z } from 'zod';
import type { CheckoutContinuationAction, CheckoutPaymentContinuationCodec } from './checkoutPaymentContinuationCredential.js';
import type { NativeCheckoutRecoveryOrder } from './checkoutRecoveryInspection.js';
import type { CheckoutRecoveryOrderReadPort } from './checkoutRecoveryOrderPort.js';
import type { CheckoutRecoveryPayResult } from './checkoutRecoveryPay.js';
import { withCheckoutRecoveryPaymentHold, type CheckoutRecoveryMethodHold } from './checkoutRecoveryPaymentHold.js';
import { readAuthorizedPaymentRecovery, type PaymentRecoveryReadDeps, type PaymentRecoverySnapshot } from './paymentRecoveryGuidance.js';

export interface CheckoutInlineRecoveryRequest<Method> {
  headers: { cookie?: unknown; authorization?: unknown };
  orderId: string; clientId: string; paymentIntentId: string; journeyId: string;
  expectedPaymentAttemptId: string; retryRequestId: string;
  executionRail: string; methodKey: string; method: Method;
}
export interface CheckoutInlineRecoveryAdmission {
  replayOnly: boolean; purchaseContext: 'one_time' | 'subscription_initial' | null;
  previousMethodKey: string | null; actions: readonly string[]; restriction: string | null;
}
export interface CheckoutInlineRecoveryAttemptPort<Method> {
  assertExecutionRail(rail: string): void;
  readPreviousMethod(input: { orderId: string; paymentIntentId: string; paymentAttemptId: string; executionRail: string }): Promise<string | null>;
  begin(input: { order: NativeCheckoutRecoveryOrder; request: Omit<CheckoutInlineRecoveryRequest<Method>, 'headers' | 'method'>; admission: CheckoutInlineRecoveryAdmission; method: Method }): Promise<CheckoutRecoveryPayResult & { executionRail: string }>;
}
export class CheckoutInlineRecoveryError extends Error {
  constructor(readonly kind: 'bad_request' | 'unauthorized' | 'conflict' | 'upstream_unavailable', readonly code: string) {
    super(`checkout_inline_recovery_${code}`); this.name = 'CheckoutInlineRecoveryError';
  }
}
export function checkoutInlineRecoveryTransitionKey(expectedPaymentAttemptId: string): string {
  return `checkout-inline-recovery:${expectedPaymentAttemptId}`;
}
const identity = z.object({ orderId: z.guid(), clientId: z.guid(), paymentIntentId: z.guid(), expectedPaymentAttemptId: z.guid(),
  retryRequestId: z.guid(), journeyId: z.string().min(1).max(128), executionRail: z.string().min(1).max(64), methodKey: z.string().min(1).max(240) });

/** Cookie-only exact transition. Host transport and method/purchase eligibility remain injected policy. */
export function createCheckoutInlineRecovery<Method>(deps: {
  codec: CheckoutPaymentContinuationCodec;
  guidance: Pick<PaymentRecoveryReadDeps, 'port' | 'projectGuidance'>;
  orderPort: CheckoutRecoveryOrderReadPort<NativeCheckoutRecoveryOrder>;
  attemptPort: CheckoutInlineRecoveryAttemptPort<Method>;
  executionAllowed(input: { methodKey: string; executionRail: string; purchaseContext: 'one_time' | 'subscription_initial' }): boolean;
  activeActionResolver?: { readActiveAction(input: { orderId: string; clientId: string; paymentIntentId: string; paymentAttemptId: string; executionRail: string }): Promise<CheckoutContinuationAction | null> };
  hold?: { readHolds(): Promise<readonly CheckoutRecoveryMethodHold[]>;
    classify(input: { order: NativeCheckoutRecoveryOrder; method: Method }): { kind: string; method: string } | null;
    offeredMethods(kind: string): ReadonlySet<string>; isFirstPurchase?(order: NativeCheckoutRecoveryOrder): Promise<boolean | null> };
}) {
  type PayInput = Parameters<CheckoutInlineRecoveryAttemptPort<Method>['begin']>[0];
  const fresh = withCheckoutRecoveryPaymentHold<PayInput, CheckoutRecoveryPayResult & { executionRail: string }>(
    { pay: input => deps.attemptPort.begin(input) }, deps.hold ?? { readHolds: async () => [], classify: () => null, offeredMethods: () => new Set<string>() });
  return { async retry(request: CheckoutInlineRecoveryRequest<Method>) {
    if (!identity.safeParse(request).success) throw new CheckoutInlineRecoveryError('bad_request', 'invalid_request');
    const claims = deps.codec.verifyCookieHeader(request.headers.cookie);
    if (!claims || claims.orderId !== request.orderId || claims.clientId !== request.clientId
      || claims.paymentIntentId !== request.paymentIntentId || claims.journeyId !== request.journeyId
      || claims.paymentAttemptId !== request.expectedPaymentAttemptId) throw new CheckoutInlineRecoveryError('unauthorized', 'continuation_required');
    try { deps.attemptPort.assertExecutionRail(request.executionRail); } catch (error) { throw executionError(error); }
    // Preserve the owning atomic snapshot and its named capability refusal. The
    // authorization/derivation helper consumes this same value without another read.
    let snapshot: PaymentRecoverySnapshot | null;
    try { snapshot = await deps.guidance.port.getGuidanceSnapshot({ orderId: request.orderId, paymentIntentId: request.paymentIntentId }); }
    catch (error) { throw executionError(error); }
    const recovery = await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined,
      deps: { ...deps.guidance, port: { getGuidanceSnapshot: async () => snapshot } } });
    if (!recovery) throw conflict('recovery_state_unavailable');
    const order = await deps.orderPort.getRecoveryOrder({ orderId: request.orderId });
    const state = recovery.snapshot;
    if (!order || order.orderId !== request.orderId || order.clientId !== request.clientId || order.paymentIntentId !== request.paymentIntentId
      || order.status !== 'pending_payment' || order.technicallyExpired || order.subscriptionCycleId !== null
      || state.orderStatus !== 'pending_payment' || !state.eligible || state.observedSuccess || !state.purchaseContext
      || state.subscriptionId !== null || state.subscriptionStatus !== null
      || (state.purchaseContext === 'one_time' ? order.mode !== 'one_time_order' || order.subscriptionId !== null
        : order.mode !== 'subscription_cycle' || !order.initialDeclarationId || order.initialActivationState !== 'provisional' || state.activationState !== 'provisional')) {
      throw conflict('order_not_recoverable');
    }
    const guidance = recovery.guidance;
    let admission: CheckoutInlineRecoveryAdmission = { replayOnly: true, purchaseContext: null, previousMethodKey: null, actions: [], restriction: null };
    if (guidance) {
      if (guidance.paymentAttemptId !== request.expectedPaymentAttemptId || state.paymentAttemptId !== request.expectedPaymentAttemptId
        || state.attemptStatus !== 'failed' || state.intentStatus !== 'failed' || order.paymentIntentStatus !== 'failed') throw conflict('stale_recovery_authority');
      const previousMethodKey = guidance.methodKey ?? await deps.attemptPort.readPreviousMethod({ orderId: request.orderId, paymentIntentId: request.paymentIntentId, paymentAttemptId: request.expectedPaymentAttemptId, executionRail: claims.executionRail });
      if (!previousMethodKey || (previousMethodKey === request.methodKey
        ? guidance.restriction === 'method' || !(guidance.actions.includes('change_instrument') || guidance.actions.includes('correct_data'))
        : !guidance.actions.includes('change_method'))) throw conflict('recovery_action_not_allowed');
      if (!deps.executionAllowed({ methodKey: request.methodKey, executionRail: request.executionRail, purchaseContext: state.purchaseContext })) throw conflict('recovery_execution_not_allowed');
      admission = { replayOnly: false, purchaseContext: state.purchaseContext, previousMethodKey, actions: guidance.actions, restriction: guidance.restriction };
    }
    let result: CheckoutRecoveryPayResult & { executionRail: string };
    try { const input = { order, request: { orderId: request.orderId, clientId: request.clientId, paymentIntentId: request.paymentIntentId,
        journeyId: request.journeyId, expectedPaymentAttemptId: request.expectedPaymentAttemptId, retryRequestId: request.retryRequestId,
        executionRail: request.executionRail, methodKey: request.methodKey }, admission, method: request.method };
      result = admission.replayOnly ? await deps.attemptPort.begin(input) : await fresh.pay(input);
    } catch (error) { throw executionError(error); }
    if (result.orderId !== request.orderId || result.clientId !== request.clientId || result.paymentIntentId !== request.paymentIntentId
      || !result.paymentAttemptId || result.executionRail !== request.executionRail || !['processing', 'failed'].includes(result.status)
      || (admission.replayOnly && !result.replayed)) throw new CheckoutInlineRecoveryError('upstream_unavailable', 'invalid_payment_result');
    let clientAction: CheckoutContinuationAction = { kind: 'none' };
    if (result.status === 'processing' && deps.activeActionResolver) {
      try { clientAction = await deps.activeActionResolver.readActiveAction({ orderId: request.orderId, clientId: request.clientId, paymentIntentId: request.paymentIntentId, paymentAttemptId: result.paymentAttemptId, executionRail: request.executionRail }) ?? clientAction; } catch { /* Lagging readback retains safe polling. */ }
    }
    const cookie = deps.codec.issue({ journeyId: request.journeyId, orderId: request.orderId, clientId: request.clientId,
      paymentIntentId: request.paymentIntentId, paymentAttemptId: result.paymentAttemptId, executionRail: result.executionRail });
    return { result: { ...result, orderRef: order.orderRef, clientAction }, setCookie: cookie.setCookie };
  } };
}
function conflict(code: string) { return new CheckoutInlineRecoveryError('conflict', code); }
function executionError(error: unknown) {
  if (error instanceof CheckoutInlineRecoveryError) return error;
  const code = error instanceof Error ? error.message : '';
  if (code === 'native_prepared_attempt_store_unsupported') return new CheckoutInlineRecoveryError('upstream_unavailable', code);
  return conflict('payment_admission_refused');
}
