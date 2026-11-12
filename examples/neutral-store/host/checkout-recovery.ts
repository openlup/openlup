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
import type { SandboxPaymentAttempt } from '@openlup/platform/payments/contracts';
import type { PgGatewayClient, PostgresRoleFreeTransactionLane } from '@openlup/platform/data';
import { readAuthorizedPaymentRecovery, createPostgresPaymentRecoveryGuidancePort, createCheckoutRecoveryInspection, createExpiredCheckoutRecoveryService, createPostgresCheckoutRecoveryOrderPort,
  createPostgresExpiredCheckoutRecoveryPort, createPostgresExpiredCheckoutDraftPort, createPostgresExpiredCheckoutRuntime,
  createPostgresExpiredCheckoutCompensation, checkoutRecoveryExecutionFingerprint, ExpiredCheckoutRecoveryError,
  classifyCheckoutRecoveryTokenState, type NativeCheckoutRecoveryOrder, type CheckoutRecoveryInspectionResult } from '@openlup/platform/commerce/server';
import { normalizeSandboxPaymentRecoveryEvidence, createPostgresSandboxExpiredCheckoutSafety, createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
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

/** The dispatched replacement execution belongs to its lineage and durable receipt,
 * independently of the original order's continuation lifetime. */
export function matchesRecreatedPaymentReceipt(order: NativeCheckoutRecoveryOrder, attempt: SandboxPaymentAttempt | null): attempt is SandboxPaymentAttempt {
  return !!attempt && !!order.recreatedFromOrderId && sameUuid(attempt.orderId, order.orderId)
    && sameUuid(attempt.settlementIntentId, order.paymentIntentId)
    && attempt.requestKey === `checkout-recovery-recreate:${order.recreatedFromOrderId}:payment-execution`;
}
export function recreatedExecutionForInspection(order: NativeCheckoutRecoveryOrder, attempt: SandboxPaymentAttempt | null, result: CheckoutRecoveryInspectionResult) {
  if (('terminalStatus' in result && result.terminalStatus) || order.status !== 'pending_payment' || order.technicallyExpired
    || !matchesRecreatedPaymentReceipt(order, attempt) || attempt.state === 'captured' || attempt.latestObservation?.outcome === 'captured'
    || attempt.orderStatus !== 'pending_payment' || attempt.settlementStatus === 'succeeded') return null;
  return { latestOrderRef: order.orderId, attemptRef: attempt.id, state: attempt.state };
}

export function composeExpiredRecovery(pool: Pool, lane: Pick<PostgresRoleFreeTransactionLane, 'run'>, tokens: PurchaseRecovery['tokens'], keyring?: PromotionAcceptanceKeyring): ApplicationBindings['actions'] {
  const reader = createPostgresCheckoutRecoveryOrderPort(pool);
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
    const simulator = createPostgresSandboxPaymentSimulator(pool, context.config.purchase.sandbox);
    // Read the attempt before inspection: a later paid inspection must win over an earlier dispatched receipt.
    const executionAttempt = latest.recreatedFromOrderId && latest.paymentIntentId
      ? await simulator.readAttempt({ settlementIntentId: latest.paymentIntentId }) : null;
    if (payload.action === 'inspect') {
      const result = await inspection.inspect({ token: payload.token, capabilities: ['recreate_expired_order'] });
      const recreatedExecution = recreatedExecutionForInspection(latest, executionAttempt, result);
      return { ok: true, value: { ...result, ...lineage, ...(recreatedExecution ? { recreatedExecution } : {}) } };
    }
    try {
      if (payload.action === 'pay') {
        if (latest.status === 'paid' || executionAttempt?.state === 'captured') return refuse('paid');
        // A dispatched replacement replays its exact receipt, never another attempt or the source's continuation.
        if (latest.status === 'pending_payment' && latest.recreatedFromOrderId) {
          const receipt = recreatedExecutionForInspection(latest, executionAttempt, { recoverable: false, fallback: 'fresh_checkout' });
          return receipt ? { ok: true, replayed: true, value: { ...lineage, ...receipt } } : refuse('unavailable');
        }
        const admitted = await inspection.inspect({ token: payload.token, capabilities: ['recreate_expired_order'] });
        if (!admitted.recoverable || admitted.recoveryKind !== 'recreate_expired' || !sameUuid(admitted.order.orderId, latest.orderId))
          return refuse('terminalStatus' in admitted && admitted.terminalStatus === 'order_changed' ? 'order_changed' : 'unavailable');
        const attempt = await service.recreate({ order: latest, clientId: bearer.clientId });
        const replacement = await reader.getLatestRecoveryOrder!({ orderId: original.orderId });
        if (!replacement || replacement.orderId === original.orderId) return refuse('unavailable');
        return { ok: true, value: { ...lineage, latestOrderRef: replacement.orderId, attemptRef: attempt.id, state: attempt.state } };
      }
      // Only the durable attempt started by expired recreation is eligible here. No attempt creation or retry.
      if (!latest.recreatedFromOrderId || !sameUuid(payload.orderRef, latest.orderId) || !latest.paymentIntentId) return refuse('unavailable');
      const attempt = executionAttempt;
      if (!matchesRecreatedPaymentReceipt(latest, attempt) || !sameUuid(payload.attemptRef, attempt.id)
        || !recreatedExecutionForInspection(latest, attempt, { recoverable: false, fallback: 'fresh_checkout' })) return refuse('unavailable');
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
      if (payload.action === 'simulate') return refuse('unavailable');
      if (error instanceof ExpiredCheckoutRecoveryError) return refuse(error.reason);
      throw error;
    }
  } };
}

/** Optional exact-order guidance. Absence or failure preserves the ordinary reader. */
export async function readCheckoutGuidance(pool: Pool, tokens: PurchaseRecovery['tokens'], rawToken: string,
  order: { id: string; client_id: string }) {
  try {
    const intent = (await pool.query("SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1 AND channel_key='sandbox'", [order.id])).rows[0];
    if (!intent) return undefined;
    const result = await readAuthorizedPaymentRecovery({ request: { orderId: order.id, clientId: order.client_id, paymentIntentId: intent.id },
      claims: null, authorization: `Bearer ${rawToken}`, deps: { tokenPort: tokens,
        port: createPostgresPaymentRecoveryGuidancePort(pool, normalizeSandboxPaymentRecoveryEvidence) } });
    return result?.guidance ?? undefined;
  } catch { return undefined; }
}


import { createCheckoutRecoveryTokenPay, createCheckoutRecoveryPayService, withCheckoutRecoveryPaymentHold,
  createCheckoutInlineRecovery, createCheckoutPaymentContinuationCodec, mintPaymentContinuationOnFreshAction,
  createCheckoutPaymentLinkHandler, createPostgresBuyerCheckoutLinkPort } from '@openlup/platform/commerce/server';
import type { SandboxMethodFacts } from '@openlup/platform/payments/contracts';
import { createPostgresSandboxCheckoutRecoveryAttemptPort, createPostgresSandboxInlineRecoveryAttemptPort } from '@openlup/platform/payments';
import { sandboxRecoveryPolicy } from '../owned/acquisition-policy.ts';
import { portalResponder } from './e4-composition.ts';
import { isUuid } from './recurring-fence.ts';

type DemoMethod = typeof sandboxRecoveryPolicy.methodKeys[number];
export function sandboxRecoveryMethod(facts: SandboxMethodFacts): DemoMethod | null {
  return sandboxRecoveryPolicy.methodKeys.find(key => facts.methodRef === `sandbox:demo:${key}`
    && facts.methodEvidenceRef === `sandbox:demo:${key}:evidence`) ?? null;
}
function sandboxRecoveryFacts(order: NativeCheckoutRecoveryOrder, key: DemoMethod): SandboxMethodFacts {
  return { authorizationRef: `sandbox:demo:${order.orderId}`, unattendedChargeAuthorizedAt: order.createdAt,
    payerAccountRef: null, methodRef: `sandbox:demo:${key}`, methodEvidenceRef: `sandbox:demo:${key}:evidence` };
}

/** Exact native attempt execution. No browser assertion establishes payment truth. */
export function composeSandboxRecoveryPayments(pool: Pool, lane: Pick<PostgresRoleFreeTransactionLane,'run'>,
  tokens: PurchaseRecovery['tokens'], keyring?: PromotionAcceptanceKeyring): ApplicationBindings['actions'] {
  const codec = createCheckoutPaymentContinuationCodec(keyring?.current, { cookieName: sandboxRecoveryPolicy.cookieName,
    executionRails: sandboxRecoveryPolicy.rails });
  const reader = createPostgresCheckoutRecoveryOrderPort(pool);
  const refused = (code = 'starter_recovery_unavailable') => ({ ok: false as const, code });
  const paymentFailure = (error: unknown): import('../shared/api.ts').ActionResult => {
    const kind = error instanceof Error && 'kind' in error ? error.kind : null;
    return { ...refused(error instanceof Error && error.message.includes('native_prepared_attempt_store_unsupported') ? 'native_prepared_attempt_store_unsupported' : undefined),
      status: kind === 'upstream_unavailable' ? 503 : kind === 'unauthorized' ? 403 : kind === 'bad_request' ? 400 : 409 };
  };
  const fields = (payload: Record<string,unknown>, allowed: string[]) => Object.keys(payload).every(key => key === 'locale' || allowed.includes(key));
  const method = (value: unknown): value is DemoMethod => sandboxRecoveryPolicy.methodKeys.some(key => key === value);
  const hold = { readHolds: async () => [], classify: (_input: unknown) => null, offeredMethods: (_kind: string) => new Set<string>() };
  return {
    'checkout.tokenPay': async (payload, context) => {
      if (!fields(payload,['token','methodKey','executionRail']) || typeof payload.token !== 'string' || !method(payload.methodKey)) return refused('starter_input_invalid');
      if (payload.executionRail !== undefined && payload.executionRail !== 'sandbox') return refused('native_prepared_attempt_store_unsupported');
      try {
        const base = createCheckoutRecoveryPayService(createPostgresSandboxCheckoutRecoveryAttemptPort(pool,context.config.purchase.sandbox));
        const service = createCheckoutRecoveryTokenPay({ tokenPort: tokens, orderPort: reader, payService: withCheckoutRecoveryPaymentHold(base,hold) });
        // Resolve method facts only from the token's real order, never supplied identities.
        const bearer = await tokens.inspect(payload.token);
        if (!bearer || classifyCheckoutRecoveryTokenState(bearer.tokenState) !== 'continuation') return refused();
        const order = await reader.getLatestRecoveryOrder!({ orderId: bearer.orderId });
        if (!order || order.clientId !== bearer.clientId) return refused();
        const result = await service.pay({ token: payload.token, followLatest: true, idempotencyKey: `starter-token-pay:${context.commandKey}`,
          method: sandboxRecoveryFacts(order,payload.methodKey) });
        mintSandboxContinuation(context,keyring,{ ...result, replayed:result.replayed });
        return { ok: true, value: { orderRef: result.orderId, attemptRef: result.paymentAttemptId, state: result.status }, replayed: result.replayed };
      } catch (error) { return paymentFailure(error); }
    },
    'checkout.inlineRetry': async (payload, context) => {
      if (!fields(payload,['orderRef','expectedAttemptRef','retryRequestId','methodKey','executionRail'])
        || !isUuid(payload.orderRef) || !isUuid(payload.expectedAttemptRef) || !isUuid(payload.retryRequestId) || !method(payload.methodKey)) return refused('starter_input_invalid');
      const claims = codec?.verifyCookieHeader(context.requestCookie);
      if (!codec || !claims || claims.orderId !== payload.orderRef || claims.paymentAttemptId !== payload.expectedAttemptRef) return refused('starter_continuation_required');
      try {
        const order = await reader.getRecoveryOrder({ orderId: claims.orderId });
        if (!order) return refused();
        const result = await createCheckoutInlineRecovery({ codec, guidance: { port: createPostgresPaymentRecoveryGuidancePort(pool,normalizeSandboxPaymentRecoveryEvidence) },
          orderPort: reader, attemptPort: createPostgresSandboxInlineRecoveryAttemptPort(pool,{ ...context.config.purchase.sandbox, methodKeyFor: sandboxRecoveryMethod }),
          executionAllowed: input => input.executionRail === 'sandbox' && method(input.methodKey), hold,
        }).retry({ headers: { cookie: context.requestCookie }, orderId: claims.orderId, clientId: claims.clientId,
          paymentIntentId: claims.paymentIntentId, journeyId: claims.journeyId, expectedPaymentAttemptId: payload.expectedAttemptRef,
          retryRequestId: payload.retryRequestId, executionRail: typeof payload.executionRail === 'string' ? payload.executionRail : 'sandbox',
          methodKey: payload.methodKey, method: sandboxRecoveryFacts(order,payload.methodKey) });
        context.setCookie?.(result.setCookie);
        return { ok: true, value: { orderRef: result.result.orderId, attemptRef: result.result.paymentAttemptId, state: result.result.status,
          clientAction: result.result.clientAction }, replayed: result.result.replayed };
      } catch (error) { return paymentFailure(error); }
    },
    'checkout.payment': async (payload, context) => {
      if (!fields(payload,['action','orderRef','token','attemptRef','outcome']) || !isUuid(payload.orderRef)
        || !['inspect','simulate'].includes(String(payload.action))) return refused('starter_input_invalid');
      const claims = codec?.verifyCookieHeader(context.requestCookie);
      const bound = claims?.orderId === payload.orderRef ? claims : null;
      const inspected = typeof payload.token === 'string' ? await tokens.inspect(payload.token) : null;
      const bearer = inspected && classifyCheckoutRecoveryTokenState(inspected.tokenState) === 'continuation' ? inspected : null;
      if (!bound && !bearer) return refused('starter_continuation_required');
      try {
        const order = await reader.getRecoveryOrder({ orderId: payload.orderRef });
        if (!order || order.subscriptionCycleId !== null || !order.paymentIntentId
          || order.clientId !== (bound?.clientId ?? bearer?.clientId)) return refused();
        const latest = bearer ? await reader.getLatestRecoveryOrder!({orderId:bearer.orderId}) : null;
        const original = bearer ? await reader.getRecoveryOrder({orderId:bearer.orderId}) : null;
        const tokenBound = !!bearer && !!original && original.subscriptionCycleId === null && original.clientId === order.clientId
          && latest?.orderId === order.orderId && latest.clientId === order.clientId;
        if (!bound && !tokenBound) return refused();
        const simulator = createPostgresSandboxPaymentSimulator(pool,context.config.purchase.sandbox);
        const attempt = await simulator.readAttempt({ settlementIntentId: order.paymentIntentId });
        if (!tokenBound && (!bound || bound.paymentIntentId !== attempt?.settlementIntentId || bound.paymentAttemptId !== attempt?.id)) return refused('starter_continuation_required');
        if (payload.action === 'inspect') {
          const recovery = await readAuthorizedPaymentRecovery({ request: { orderId: order.orderId, clientId: order.clientId,
            paymentIntentId: order.paymentIntentId, ...(bound ? { journeyId: bound.journeyId } : {}) }, claims: bound,
            authorization: bearer ? `Bearer ${String(payload.token)}` : undefined,
            deps: { tokenPort: tokens, port: createPostgresPaymentRecoveryGuidancePort(pool,normalizeSandboxPaymentRecoveryEvidence) } });
          const paymentBlocked = order.status !== 'pending_payment' || order.technicallyExpired || attempt?.state === 'captured'
            || attempt?.latestObservation?.outcome === 'captured' || recovery?.snapshot.observedSuccess === true;
          const current = !paymentBlocked && !!attempt && bound?.paymentAttemptId === attempt.id && bound.paymentIntentId === attempt.settlementIntentId;
          const key = attempt ? sandboxRecoveryMethod(attempt.methodFacts) : null;
          return { ok: true, value: { orderRef: order.orderId, attemptRef: attempt?.id ?? null, state: attempt?.state ?? null,
            paymentBlocked, canTokenPay: !paymentBlocked && tokenBound, continuationAvailable: current, methodKey: key, canInlineRetry: current && !!key && attempt?.state === 'refused'
              && !!recovery?.guidance && recovery.guidance.actions.some(action => ['change_instrument','correct_data','change_method'].includes(action)),
            ...(recovery?.guidance ? { recoveryGuidance: recovery.guidance } : {}) } };
        }
        if (!attempt || !sameUuid(payload.attemptRef,attempt.id) || order.status !== 'pending_payment' || order.technicallyExpired
          || attempt.state === 'captured' || attempt.latestObservation?.outcome === 'captured'
          || !['captured','refused','expired','indeterminate'].includes(String(payload.outcome))) return refused();
        const outcome = payload.outcome as 'captured'|'refused'|'expired'|'indeterminate';
        const observation = await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: `starter-execution:${attempt.id}:${outcome}`,
          outcome, occurredAt: attempt.dispatchedAt });
        const accepted = await simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({ settlementIntentId: order.paymentIntentId,
          attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: attempt.dispatchedAt });
        if (accepted.status !== 200) return refused();
        if (outcome === 'captured' && order.mode === 'subscription_cycle') await createAcquisitionRenewalBinding(pool).activate({ orderId: order.orderId,
          acceptedQuote: order.quoteSnapshot as Parameters<ReturnType<typeof createAcquisitionRenewalBinding>['activate']>[0]['acceptedQuote'],
          capturedReference: order.paymentIntentId, methodFacts: attempt.methodFacts, stockSourceKey: `starter-demo:${context.config.id}`, templateId: `starter:${context.config.id}` });
        return { ok: true, value: { orderRef: order.orderId, attemptRef: attempt.id, state: outcome } };
      } catch { return refused(); }
    },
    'checkout.paymentLink': async (payload, context) => {
      if (!fields(payload,[])) return refused('starter_input_invalid');
      const response = { result: refused() as Awaited<ReturnType<NonNullable<ApplicationBindings['actions']['checkout.paymentLink']>>> };
      const handler = createCheckoutPaymentLinkHandler<typeof response>({ codec, respond: portalResponder,
        createPort: () => ({ issue: input => lane.run(db => createPostgresBuyerCheckoutLinkPort(db as PgGatewayClient,{ lifetimeMs: sandboxRecoveryPolicy.buyerLifetimeMs,
          sendBucketMs: sandboxRecoveryPolicy.buyerSendBucketMs }).issue(input)) }) });
      await handler({ method: 'POST', headers: { cookie: context.requestCookie }, body: {} },response);
      return response.result;
    },
  };
}


/** Called only after the native owner returned a dispatched attempt. */
export function mintSandboxContinuation(context: ActionContext, keyring: PromotionAcceptanceKeyring | undefined,
  result: { orderId:string;clientId:string;paymentIntentId:string;paymentAttemptId:string;replayed:boolean }) {
  const codec=createCheckoutPaymentContinuationCodec(keyring?.current,{cookieName:sandboxRecoveryPolicy.cookieName,executionRails:sandboxRecoveryPolicy.rails});
  if (!codec) return;
  mintPaymentContinuationOnFreshAction({mint:(_res,input)=>context.setCookie?.(codec.issue(input).setCookie),res:{setHeader(){}},
    journeyId:`checkout:${result.orderId}`,clientId:result.clientId,requestRail:'sandbox',
    response:{status:'processing',clientAction:{kind:'none'}},result:{...result,executionRail:'sandbox',continuationActionOrigin:result.replayed?null:'fresh_execution'}},sandboxRecoveryPolicy.rails);
}
