import { randomUUID } from 'node:crypto';
import { adminCommerceOrderPaymentLinkRequestSchema, adminCommerceOrderPaymentLinkResponseSchema,
  type AdminCommerceOrderPaymentLinkRefusal } from '../oms/omsContracts.js';
import { authorize } from './commerceOmsHandlers.js';
import type { OmsHandlerDeps, OmsHandlerRequest } from './handlerSupport.js';
import type { CheckoutRecoveryOrderSnapshot } from './checkoutRecoveryOrderPort.js';
import { createExpiredCheckoutRecoveryPolicy } from './checkoutExpiredRecoveryPolicy.js';
import { generateCheckoutRecoveryToken, hashCheckoutRecoveryToken } from './checkoutRecoveryToken.js';

export interface OperatorCheckoutLinkReceipt {
  operatorId: string;
  requestId: string;
  orderId: string;
  outcome: 'admitted' | 'succeeded' | 'failed';
  completedStage: 'none' | 'revoked' | 'minted' | 'email_queued';
  emailRequested: boolean;
  tokenId?: string;
}
export interface OperatorCheckoutLinkPolicy {
  operatorLifetimeMs: number;
  recoveryWindowMs: number;
}
export interface OperatorCheckoutLinkStore {
  recordReceipt(receipt: OperatorCheckoutLinkReceipt): Promise<void>;
  revokeActive(receipt: OperatorCheckoutLinkReceipt): Promise<void>;
  insert(input: { receipt: OperatorCheckoutLinkReceipt; clientId: string; tokenHash: string; expiresAt: string; issuedAt: string }): Promise<string>;
  enqueueRecoveryEmail(input: { receipt: OperatorCheckoutLinkReceipt; tokenId: string; rawToken: string; mode: string }): Promise<void>;
}
export type OperatorCheckoutLinkOrder = CheckoutRecoveryOrderSnapshot<unknown, unknown>;
export interface OperatorCheckoutLinkExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

class CheckoutLinkDeadlineElapsedError extends Error {}

/** Each call commits independently, retaining admission and the last completed effect on failure. */
export function createPostgresOperatorCheckoutLinkStore(executor: OperatorCheckoutLinkExecutor): OperatorCheckoutLinkStore & {
  authorize(eventId: string, claimToken: string): Promise<{ authorized: boolean; reason?: string }>;
} {
  async function call<T>(sql: string, values: unknown[]): Promise<T> {
    const row = (await executor.query(sql, values)).rows[0];
    if (!row || !Object.hasOwn(row, 'result')) throw new Error('checkout_payment_link_response_invalid');
    return row.result as T;
  }
  return {
    async recordReceipt(r) { await call('SELECT public.commerce_operator_link_receipt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::boolean,$7::uuid) AS result',
      [r.operatorId,r.requestId,r.orderId,r.outcome,r.completedStage,r.emailRequested,r.tokenId ?? null]); },
    async revokeActive(r) { await call('SELECT public.commerce_operator_link_revoke($1::uuid,$2::uuid) AS result', [r.operatorId,r.requestId]); },
    async insert({ receipt: r, clientId, tokenHash, expiresAt, issuedAt }) {
      let id: unknown;
      try {
        id = await call<unknown>(
          'SELECT public.commerce_operator_link_insert($1::uuid,$2::uuid,$3::uuid,$4::text,$5::timestamptz,$6::timestamptz) AS result',
          [r.operatorId,r.requestId,clientId,tokenHash,expiresAt,issuedAt]);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '22023'
          && 'message' in error && error.message === 'checkout_payment_link_deadline_elapsed') {
          throw new CheckoutLinkDeadlineElapsedError('checkout_payment_link_deadline_elapsed');
        }
        throw error;
      }
      if (typeof id !== 'string' || id === '') throw new Error('checkout_payment_link_insert_failed');
      return id;
    },
    async enqueueRecoveryEmail({ receipt: r, tokenId, rawToken, mode }) { await call(
      'SELECT public.commerce_operator_link_enqueue($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS result', [r.operatorId,r.requestId,tokenId,rawToken,mode]); },
    authorize: (eventId, claimToken) => call('SELECT public.commerce_operator_link_delivery_authorize($1::uuid,$2::text) AS result',[eventId,claimToken]),
  };
}

/** The host validates the active administrator seat; identity comes only from that session. */
export function createAdminCheckoutPaymentLinkHandler<Response>({
  authorizeAdmin, respond, orderPort, tokenStore, policy, validateRecreate,
  generateToken = generateCheckoutRecoveryToken, now = () => new Date(),
}: Pick<OmsHandlerDeps<Response>, 'authorizeAdmin' | 'respond'> & {
  orderPort: { getRecoveryOrder(input: { orderId: string }): Promise<OperatorCheckoutLinkOrder | null> };
  tokenStore: OperatorCheckoutLinkStore;
  policy: OperatorCheckoutLinkPolicy;
  validateRecreate?: (order: OperatorCheckoutLinkOrder) => Promise<boolean>;
  generateToken?: () => string;
  now?: () => Date;
}) {
  if (![policy.operatorLifetimeMs,policy.recoveryWindowMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('checkout_payment_link_policy_invalid');
  }
  const { classifyOrderRecoveryEligibility } = createExpiredCheckoutRecoveryPolicy<OperatorCheckoutLinkOrder>({
    admitsSubscriptionSubject: () => false, recoveryWindowMs: policy.recoveryWindowMs,
  });
  return async (req: OmsHandlerRequest, res: Response): Promise<void> => {
    if (req.method !== 'POST') return respond.sendMethodNotAllowed(res,['POST']);
    const auth = await authorize(req,res,authorizeAdmin,respond);
    if (!auth) return;
    if (!auth.userId?.trim() || auth.isMachineActor === true) {
      respond.sendBffError(res,'FORBIDDEN','Admin operator identity required'); return;
    }
    const request = adminCommerceOrderPaymentLinkRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      respond.sendBffError(res,'BAD_REQUEST','Invalid admin commerce payment link request',{ details: request.error.flatten() }); return;
    }
    const refuse = (reason: AdminCommerceOrderPaymentLinkRefusal) => respond.sendBffError(res,reason === 'order_not_found' ? 'NOT_FOUND' : 'CONFLICT',
      'Admin commerce payment link refused',{ details: { reason } });
    let receipt: OperatorCheckoutLinkReceipt | undefined;
    let admitted = false;
    try {
      const order = await orderPort.getRecoveryOrder({ orderId: request.data.orderId });
      if (!order) return refuse('order_not_found');
      // Native initial activations have no cycle; renewal payment cases have a separate issuer.
      if (order.subscriptionCycleId !== null) return refuse('order_not_recoverable');
      const at = now();
      if (order.status === 'paid') return refuse('order_paid');
      if (order.status !== 'pending_payment') {
        const eligibility = classifyOrderRecoveryEligibility(order,at);
        if (eligibility.kind !== 'eligible') return refuse(eligibility.kind === 'cancelled' ? 'order_cancelled' : 'order_not_recoverable');
        if (validateRecreate && !await validateRecreate(order)) return refuse('order_changed');
      }
      const expiresAtMs = Math.min(at.getTime()+policy.operatorLifetimeMs,Date.parse(order.createdAt)+policy.recoveryWindowMs);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= at.getTime()) return refuse('order_not_recoverable');
      const expiresAt = new Date(expiresAtMs).toISOString(), rawToken = generateToken();
      receipt = { operatorId: auth.userId, requestId: randomUUID(), orderId: order.orderId,
        outcome: 'admitted', completedStage: 'none', emailRequested: request.data.delivery === 'email' };
      await tokenStore.recordReceipt({ ...receipt }); admitted = true;
      await tokenStore.revokeActive({ ...receipt }); receipt.completedStage = 'revoked';
      const tokenId = await tokenStore.insert({ receipt: { ...receipt }, clientId: order.clientId,
        tokenHash: hashCheckoutRecoveryToken(rawToken), expiresAt, issuedAt: at.toISOString() });
      receipt.tokenId = tokenId; receipt.completedStage = 'minted';
      if (receipt.emailRequested) {
        await tokenStore.enqueueRecoveryEmail({ receipt: { ...receipt }, tokenId, rawToken, mode: order.mode === 'subscription_cycle' ? 'subscription_cycle' : 'one_time' });
        receipt.completedStage = 'email_queued';
      }
      const response = adminCommerceOrderPaymentLinkResponseSchema.safeParse({ token: rawToken,expiresAt,orderRef: order.orderRef,emailQueued: receipt.emailRequested });
      if (!response.success) {
        await tokenStore.recordReceipt({ ...receipt,outcome: 'failed' });
        respond.sendBffError(res,'INVALID_RESPONSE','Admin commerce payment link returned invalid response'); return;
      }
      await tokenStore.recordReceipt({ ...receipt,outcome: 'succeeded' });
      respond.sendBffSuccess(res,response.data);
    } catch (error) {
      if (admitted && receipt) {
        try { await tokenStore.recordReceipt({ ...receipt,outcome: 'failed' }); } catch { /* Durable admission retains an unknown outcome. */ }
      }
      if (error instanceof CheckoutLinkDeadlineElapsedError) return refuse('order_not_recoverable');
      respond.sendBffError(res,'UPSTREAM_UNAVAILABLE','Admin commerce payment link failed');
    }
  };
}
