import { createPrivateCapture } from './private-capture.ts';
import type { PostgresCheckoutRecoveryTokenPort } from '@openlup/platform/commerce/server';
import type { ActionContext } from './bindings.ts';
import { routes } from '../shared/routes.ts';

export interface CheckoutRecoveryMessage {
  kind: 'checkout-recovery';
  email: string;
  subject: string;
  body: string;
  completionUrl: string;
  expiresAt: string;
  orderRef: string;
}
export interface PurchaseRecovery {
  tokens: PostgresCheckoutRecoveryTokenPort;
  deliver(input: { email: string; rawToken: string; orderRef: string; expiresAt: string; context: ActionContext; locale: 'en' | 'pl' }): Promise<void>;
}

/** Private delivery artifact, separate from authentication challenges and logs. */
export function createCheckoutRecoveryDelivery(origin: string,
  capture: (message: CheckoutRecoveryMessage) => Promise<void> = captureRecoveryMessage): PurchaseRecovery['deliver'] {
  return async ({ email, rawToken, orderRef, expiresAt, context, locale: language }) => {
    const copy = context.config.purchase.recoveryMessage;
    const completionUrl = new URL(routes.completion[language], origin);
    completionUrl.searchParams.set('token', rawToken);
    await capture({ kind: 'checkout-recovery', email, subject: copy.subject[language],
      body: [copy.body[language], completionUrl.href, `${copy.expiryLabel[language]} ${expiresAt}`,
        `${copy.orderLabel[language]} ${orderRef}`].join('\n'),
      completionUrl: completionUrl.href, expiresAt, orderRef });
  };
}
async function captureRecoveryMessage(message: CheckoutRecoveryMessage): Promise<void> {
  const capture = createPrivateCapture();
  const key = `checkout-recovery:${message.orderRef.toLowerCase()}`;
  await capture.writeOnce(key, { ...message });
  const committed = await capture.read(key);
  if (!committed) throw new Error('starter_private_capture_unavailable');
}

/** The original immutable capture is this application's frozen re-quote email source.
 * Missing, erased, malformed or foreign captures are never repaired from a profile. */
export async function readFrozenCheckoutEmail(orderRef: string, capture = createPrivateCapture()): Promise<string | null> {
  try {
    const value = await capture.read(`checkout-recovery:${orderRef.toLowerCase()}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'checkout-recovery' || value.orderRef !== orderRef.toLowerCase()
      || typeof value.email !== 'string' || value.email !== value.email.trim().toLowerCase()
      || value.email.length > 160 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email)) return null;
    return value.email;
  } catch { return null; }
}

import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import type { Pool } from 'pg';
import { createPostgresRoleFreeTransactionLane } from '@openlup/platform/data';
import { createCheckoutRecoveryInspection, createExpiredCheckoutRecoveryService, createPostgresCheckoutRecoveryOrderPort,
  createPostgresExpiredCheckoutRecoveryPort, createPostgresExpiredCheckoutDraftPort, createPostgresExpiredCheckoutRuntime,
  createPostgresExpiredCheckoutCompensation, checkoutRecoveryExecutionFingerprint, ExpiredCheckoutRecoveryError,
  classifyCheckoutRecoveryTokenState, type NativeCheckoutRecoveryOrder, type CheckoutRecoveryInspectionResult } from '@openlup/platform/commerce/server';
import { createPostgresSandboxExpiredCheckoutSafety, createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { createPostgresPurchaseReservationPort } from '@openlup/platform/inventory';
import { createNativeQuoteService } from './quote-composition.ts';
import { installedAcquisitionPredecessors, createAcquisitionRenewalBinding } from './acquisition-predecessors.ts';
import { createAcquisitionFinancialPolicy, checkoutLinkPolicy } from '../owned/acquisition-policy.ts';
import { isRecord } from '../shared/offer.ts';
import { sameUuid, isInitialCheckoutOrder } from './recurring-fence.ts';
import type { ApplicationBindings } from './bindings.ts';

/** Content-specific refusal stays in the application, before quote/provider/draft work. */
export function supportsRecovery(order: NativeCheckoutRecoveryOrder): boolean {
  const snapshot = order.quoteSnapshot;
  const context = isRecord(snapshot) && isRecord(snapshot.quote) && isRecord(snapshot.quote.context) ? snapshot.quote.context : null;
  return !(context?.offerVersion === 'sized.v1' && context.starterPack != null);
}

/** A stored attempt cannot widen the native inspection's current authority or terminal result. */
export function admitsRecreatedContinuation(result: CheckoutRecoveryInspectionResult, orderId: string): boolean {
  return result.recoverable && result.recoveryKind === 'retry_existing' && sameUuid(result.order.orderId, orderId);
}

export function composeExpiredRecovery(pool: Pool, connectionString: string, tokens: PurchaseRecovery['tokens'], keyring?: PromotionAcceptanceKeyring): ApplicationBindings['actions'] {
  const reader = createPostgresCheckoutRecoveryOrderPort(pool);
  const lane = createPostgresRoleFreeTransactionLane({ connectionString }, { poolFactory: () => pool });
  return { 'checkout.recovery': async (payload, context) => {
    const refuse = (reason: string) => ({ ok: false as const, code: `starter_recovery_${reason}` });
    if (Object.keys(payload).some(key => !['locale','token','action','orderRef','attemptRef','outcome'].includes(key))
      || typeof payload.token !== 'string' || !/^rcv_(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/.test(payload.token)
      || !['inspect','pay','simulate'].includes(String(payload.action))) return refuse('unavailable');
    const predecessors = installedAcquisitionPredecessors();
    const service = createExpiredCheckoutRecoveryService({
      supports: supportsRecovery,
      quoteRequest: order => order,
      quotePort: { async createQuote(order) {
        const frozen = order.quoteSnapshot!;
        const email = await readFrozenCheckoutEmail(order.recoveryRootOrderId ?? order.orderId);
        if (!email) throw new ExpiredCheckoutRecoveryError('unavailable');
        const mode = order.mode === 'subscription_cycle' ? 'subscription' : 'one_time';
        const result = await createNativeQuoteService(pool, predecessors, keyring).quote({ email,
          ...(mode === 'subscription' ? { acquisitionCapability: 'subscription-acquisition.v1' } : {}),
          cart: { schemaVersion: 1, configuration: context.config.id, mode, cadenceDays: order.cadenceDays,
            lines: frozen.quote.lines.map(line => ({ sku: line.sku, quantity: line.quantity })) } },
        { ...context, actor: { customerRef: null, operatorRef: null } });
        return result.snapshot;
      } },
      orderDraftPort: createPostgresExpiredCheckoutDraftPort(pool, predecessors.checkout(pool, {
        regionCode: context.config.market.country, financialPolicy: createAcquisitionFinancialPolicy(),
        isAcquisitionDiscount: discount => discount.promotionId === `demo-acquisition:${context.config.id}` })),
      recoveryPort: createPostgresExpiredCheckoutRecoveryPort(pool, checkoutLinkPolicy),
      paymentSafetyPort: createPostgresSandboxExpiredCheckoutSafety(pool),
      runtimePort: createPostgresExpiredCheckoutRuntime(lane, {
        stockSourceKey: `starter-demo:${context.config.id}`, reservationLifetimeMs: context.config.purchase.reservationMinutes * 60000,
        channelKey: 'sandbox', verifyPriorPayment: (input, db) => createPostgresSandboxExpiredCheckoutSafety(db).verifyPriorPayment(input),
        reserveOrderItems: (input, db) => createPostgresPurchaseReservationPort(db).reserveOrderItems(input),
        startPayment: (input, db) => createPostgresSandboxPaymentSimulator(db, context.config.purchase.sandbox).beginAttempt({
          idempotencyKey: input.idempotencyKey, settlementIntentId: input.settlementIntentId,
          requestFingerprint: checkoutRecoveryExecutionFingerprint(input), at: new Date().toISOString() }),
      }), compensationPort: createPostgresExpiredCheckoutCompensation(lane),
    });
    const inspection = createCheckoutRecoveryInspection({ tokenPort: tokens, orderPort: reader, validation: service,
      recoveryWindowMs: checkoutLinkPolicy.recoveryWindowMs,
      async clientHasLiveOrPendingSubscription({ clientId }) { return (await pool.query(
        "SELECT 1 FROM public.subscriptions WHERE client_id=$1 AND status IN ('active','paused','pending_activation') LIMIT 1", [clientId])).rows.length > 0; } });
    const bearer = await tokens.inspect(payload.token);
    if (!bearer || classifyCheckoutRecoveryTokenState(bearer.tokenState) === 'refused') return refuse('unavailable');
    const original = await reader.getRecoveryOrder({ orderId: bearer.orderId });
    const latest = await reader.getLatestRecoveryOrder!({ orderId: bearer.orderId });
    if (!original || !latest || !sameUuid(original.clientId, bearer.clientId) || !sameUuid(latest.clientId, bearer.clientId)) return refuse('unavailable');
    const lineage = { originalOrderRef: original.orderId, latestOrderRef: latest.orderId };
    // Native initial activation attaches a paid first cycle. Its authoritative paid presentation is distinct from renewal mutation admission.
    if (payload.action === 'inspect' && latest.paymentIntentStatus === 'succeeded'
      && ['paid','fulfillment_pending','fulfilled'].includes(latest.status)
      && await isInitialCheckoutOrder(pool, original.orderId) && await isInitialCheckoutOrder(pool, latest.orderId))
      return { ok: true, value: { ...lineage, recoverable: false, terminalStatus: 'paid' } };
    if (original.subscriptionCycleId !== null || latest.subscriptionCycleId !== null) return refuse('unavailable');
    if (payload.action === 'inspect') {
      const result = await inspection.inspect({ token: payload.token, capabilities: ['recreate_expired_order'] });
      const simulator = createPostgresSandboxPaymentSimulator(pool, context.config.purchase.sandbox);
      const attempt = admitsRecreatedContinuation(result, latest.orderId) && latest.recreatedFromOrderId && latest.paymentIntentId && latest.status === 'pending_payment'
        ? await simulator.readAttempt({ settlementIntentId: latest.paymentIntentId }) : null;
      const started = attempt?.requestKey === `checkout-recovery-recreate:${latest.recreatedFromOrderId}:payment-execution`;
      return { ok: true, value: { ...result, ...lineage,
        ...(started && attempt ? { recreatedAttempt: { latestOrderRef: latest.orderId, attemptRef: attempt.id, state: attempt.state } } : {}) } };
    }
    try {
      if (latest.recreatedFromOrderId && (payload.action === 'simulate' || latest.status === 'pending_payment')
        && !admitsRecreatedContinuation(await inspection.inspect({ token: payload.token, capabilities: ['recreate_expired_order'] }), latest.orderId))
        return refuse('unavailable');
      if (payload.action === 'pay') {
        if (latest.status === 'paid') return refuse('paid');
        // A pending replacement replays its predecessor's receipt; a later expired generation is recreated from that latest source.
        const source = latest.status === 'pending_payment' && latest.recreatedFromOrderId
          ? await reader.getRecoveryOrder({ orderId: latest.recreatedFromOrderId }) : latest;
        if (!source || !sameUuid(source.clientId, bearer.clientId) || source.subscriptionCycleId !== null
          || !['expired','cancelled'].includes(source.status) || !source.technicallyExpired) return refuse('unavailable');
        const attempt = await service.recreate({ order: source, clientId: bearer.clientId });
        const replacement = await reader.getLatestRecoveryOrder!({ orderId: original.orderId });
        if (!replacement || replacement.orderId === original.orderId) return refuse('unavailable');
        return { ok: true, value: { ...lineage, latestOrderRef: replacement.orderId, attemptRef: attempt.id, state: attempt.state } };
      }
      // Only the durable attempt started by expired recreation is eligible here. No attempt creation or retry.
      if (!latest.recreatedFromOrderId || !sameUuid(payload.orderRef, latest.orderId) || !latest.paymentIntentId) return refuse('unavailable');
      const simulator = createPostgresSandboxPaymentSimulator(pool, context.config.purchase.sandbox);
      const attempt = await simulator.readAttempt({ settlementIntentId: latest.paymentIntentId });
      if (!attempt || !sameUuid(payload.attemptRef, attempt.id)) return refuse('unavailable');
      if (attempt.requestKey !== `checkout-recovery-recreate:${latest.recreatedFromOrderId}:payment-execution`) return refuse('unavailable');
      if (!['captured','refused','expired','indeterminate'].includes(String(payload.outcome))) return refuse('unavailable');
      const outcome = payload.outcome as 'captured' | 'refused' | 'expired' | 'indeterminate';
      const observation = await simulator.recordObservation({ attemptId: attempt.id,
        idempotencyKey: `starter-recreated:${attempt.id}:${outcome}`, outcome, occurredAt: attempt.dispatchedAt });
      const accepted = await simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
        settlementIntentId: latest.paymentIntentId, attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: attempt.dispatchedAt });
      if (accepted.status !== 200) return refuse('unavailable');
      if (outcome === 'captured' && latest.mode === 'subscription_cycle') {
        const quote = latest.quoteSnapshot as Parameters<ReturnType<typeof createAcquisitionRenewalBinding>['activate']>[0]['acceptedQuote'];
        await createAcquisitionRenewalBinding(pool).activate({ orderId: latest.orderId, acceptedQuote: quote,
          capturedReference: latest.paymentIntentId, methodFacts: attempt.methodFacts,
          stockSourceKey: `starter-demo:${context.config.id}`, templateId: `starter:${context.config.id}` });
      }
      return { ok: true, value: { ...lineage, state: outcome } };
    } catch (error) {
      if (error instanceof ExpiredCheckoutRecoveryError) return refuse(error.reason);
      throw error;
    }
  } };
}
