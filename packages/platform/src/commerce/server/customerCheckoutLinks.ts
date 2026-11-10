import { checkoutRecoveryStartRequestSchema,checkoutRecoveryStartResponseSchema,CHECKOUT_RECOVERY_START_CONTRACT_VERSION,
  type CheckoutRecoveryStartRequest,type CheckoutRecoveryStartResponse } from '../checkoutRecoveryStartSchemas.js';
import { resolveRecoveryDestination } from '../recoveryDestination.js';
import { generateCheckoutRecoveryToken,hashCheckoutRecoveryToken } from './checkoutRecoveryToken.js';
import type { CheckoutPaymentContinuationCodec } from './checkoutPaymentContinuationCredential.js';
import type { OmsHandlerRequest,OmsHandlerResponder } from './handlerSupport.js';

export interface CustomerCheckoutRecoveryContext {
  orderId: string | null;
  mode: 'subscription_cycle' | 'one_time_order' | null;
  subscriptionId: string | null;
  clientHasLiveOrPendingSubscription: boolean;
}
export interface CustomerCheckoutRecoveryPendingOrder extends CustomerCheckoutRecoveryContext {
  orderId: string;
  mode: 'subscription_cycle' | 'one_time_order';
  createdAt: string;
}
export interface CustomerCheckoutRecoveryStartPort {
  find(request: CheckoutRecoveryStartRequest): Promise<CustomerCheckoutRecoveryPendingOrder | null>;
  context(orderId: string): Promise<CustomerCheckoutRecoveryContext>;
  issue(input: { orderId: string; rawToken: string; expiresAt: string }): Promise<string>;
}
export interface CheckoutLinkQueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Expected terminal mint race, including an elapsed deadline. Storage failures stay distinct. */
export class CheckoutLinkNotRecoverableError extends Error {
  readonly reason = 'order_not_recoverable' as const;
  constructor() { super('checkout_link_order_not_recoverable'); }
}
export interface BuyerCheckoutLinkPolicy { lifetimeMs: number; sendBucketMs: number }
export interface BuyerCheckoutLinkPort {
  issue(input: { orderId: string; clientId: string; rawToken: string; requestedAt: string }): Promise<{ sent: true; queued: boolean }>;
}

/** Supply an executor bound to the authenticated customer's session, never a service lane. */
export function createPostgresCustomerCheckoutRecoveryStartPort(executor: CheckoutLinkQueryExecutor): CustomerCheckoutRecoveryStartPort {
  return {
    find: request => call(executor,'SELECT public.customer_checkout_recovery_find_as_actor($1::uuid,$2::uuid) AS result',
      ['orderId' in request ? request.orderId : null,'subscriptionId' in request ? request.subscriptionId : null]),
    context: orderId => call(executor,'SELECT public.customer_checkout_recovery_context_as_actor($1::uuid) AS result',[orderId]),
    async issue({ orderId,rawToken,expiresAt }) {
      const id = await call<unknown>(executor,'SELECT public.customer_checkout_recovery_token_issue_as_actor($1::uuid,$2::text,$3::timestamptz) AS result',
        [orderId,hashCheckoutRecoveryToken(rawToken),expiresAt]);
      if (typeof id !== 'string' || !id) throw new Error('checkout_link_response_invalid');
      return id;
    },
  };
}

/** Trusted service lane; the handler supplies only verified continuation-cookie claims. */
export function createPostgresBuyerCheckoutLinkPort(executor: CheckoutLinkQueryExecutor,policy: BuyerCheckoutLinkPolicy): BuyerCheckoutLinkPort & {
  authorize(eventId: string,claimToken: string): Promise<{ authorized: boolean; reason?: string }>;
} {
  lifetime(policy.lifetimeMs);
  if (!Number.isSafeInteger(policy.sendBucketMs) || policy.sendBucketMs<=0) throw new Error('checkout_link_policy_invalid');
  return {
    async issue({ orderId,clientId,rawToken,requestedAt }) {
      const value=await call<unknown>(executor,
      'SELECT public.commerce_buyer_checkout_link_issue($1::uuid,$2::uuid,$3::text,$4::bigint,$5::bigint,$6::timestamptz) AS result',
      [orderId,clientId,rawToken,policy.lifetimeMs,policy.sendBucketMs,requestedAt]);
      if (typeof value!=='object' || value===null || !('sent' in value) || value.sent!==true || !('queued' in value) || typeof value.queued!=='boolean') {
        throw new Error('checkout_link_response_invalid');
      }
      return {sent:true,queued:value.queued};
    },
    authorize: (eventId,claimToken) => call(executor,'SELECT public.commerce_buyer_checkout_link_delivery_authorize($1::uuid,$2::text) AS result',[eventId,claimToken]),
  };
}

/** No persistence is constructed before the feature and customer-session guards. No mail port is used. */
export function createCheckoutRecoveryStartHandler<Response>(deps: {
  recoveryEnabled(): boolean;
  authenticateUser(): Promise<{ ok: true; userId: string } | { ok: false }>;
  createPort(session: { userId: string }): CustomerCheckoutRecoveryStartPort | Promise<CustomerCheckoutRecoveryStartPort>;
  respond: OmsHandlerResponder<Response>;
  lifetimeMs: number;
  generateToken?: () => string;
  now?: () => Date;
}) {
  lifetime(deps.lifetimeMs);
  const { respond } = deps;
  return async (req: OmsHandlerRequest,res: Response): Promise<void> => {
    if (req.method!=='POST') return respond.sendMethodNotAllowed(res,['POST']);
    if (!deps.recoveryEnabled()) return respond.sendBffError(res,'UPSTREAM_UNAVAILABLE','Checkout recovery is disabled',
      { details: { feature: 'checkout-recovery',reason: 'feature_flag_disabled' } });
    const parsed=checkoutRecoveryStartRequestSchema.safeParse(req.body);
    if (!parsed.success) return respond.sendBffError(res,'BAD_REQUEST','Invalid recovery start request');
    const auth=await deps.authenticateUser();
    if (!auth.ok || !auth.userId.trim()) return respond.sendBffError(res,'UNAUTHORIZED','Customer session required',
      { details: { reason: 'customer_session_required' } });
    const port=await deps.createPort({userId:auth.userId}),order=await port.find(parsed.data);
    const fallback=(facts?: CustomerCheckoutRecoveryContext) => {
      const destination=resolveRecoveryDestination({ state: 'unrecoverable',source: 'checkout_recovery',
        requestedSubscriptionContext: 'subscriptionId' in parsed.data,
        orderMode: facts?.mode,hasOrderSubscription: Boolean(facts?.subscriptionId),
        clientHasLiveOrPendingSubscription: facts?.clientHasLiveOrPendingSubscription });
      const response: CheckoutRecoveryStartResponse={ contractVersion: CHECKOUT_RECOVERY_START_CONTRACT_VERSION,recoverable: false,
        fallback: destination==='fresh_checkout' ? 'fresh_checkout' : 'customer_account' };
      respond.sendBffSuccess(res,response);
    };
    if (!order) return fallback('orderId' in parsed.data ? await port.context(parsed.data.orderId) : undefined);
    const expiresAt=new Date(Date.parse(order.createdAt)+deps.lifetimeMs).toISOString();
    const rawToken=(deps.generateToken??generateCheckoutRecoveryToken)();
    try { await port.issue({ orderId: order.orderId,rawToken,expiresAt }); }
    catch (error) { if (error instanceof CheckoutLinkNotRecoverableError) return fallback(order); throw error; }
    respond.sendBffSuccess(res,checkoutRecoveryStartResponseSchema.parse({ contractVersion: CHECKOUT_RECOVERY_START_CONTRACT_VERSION,
      recoverable: true,token: rawToken,mode: order.mode }));
  };
}

/** The cookie is the entire order/client authority; body identifiers and recipients are ignored. */
export function createCheckoutPaymentLinkHandler<Response>(deps: {
  codec: Pick<CheckoutPaymentContinuationCodec,'verifyCookieHeader'> | null;
  createPort(): BuyerCheckoutLinkPort | Promise<BuyerCheckoutLinkPort>;
  respond: OmsHandlerResponder<Response>;
  generateToken?: () => string;
  now?: () => Date;
}) {
  return async (req: OmsHandlerRequest & { headers?: { cookie?: unknown } },res: Response): Promise<void> => {
    if (req.method!=='POST') return deps.respond.sendMethodNotAllowed(res,['POST']);
    const claims=deps.codec?.verifyCookieHeader(req.headers?.cookie);
    if (!claims) return deps.respond.sendBffError(res,'UNAUTHORIZED','Checkout continuation required',
      { details: { feature: 'checkout-payment-link',reason: 'continuation_missing' } });
    try {
      const port=await deps.createPort();
      await port.issue({ orderId: claims.orderId,clientId: claims.clientId,rawToken: (deps.generateToken??generateCheckoutRecoveryToken)(),
        requestedAt: (deps.now??(()=>new Date()))().toISOString() });
      deps.respond.sendBffSuccess(res,{ sent: true });
    } catch (error) {
      if (error instanceof CheckoutLinkNotRecoverableError) return deps.respond.sendBffError(res,'CONFLICT','Checkout payment link refused',
        { details: { reason: 'order_not_recoverable' } });
      deps.respond.sendBffError(res,'UPSTREAM_UNAVAILABLE','Checkout payment link failed',
        { details: { feature: 'checkout-payment-link',reason: 'mint_failed' } });
    }
  };
}

function lifetime(ms: number) {
  if (!Number.isSafeInteger(ms) || ms<=0 || ms>86400000) throw new Error('checkout_link_policy_invalid');
}
async function call<T>(executor: CheckoutLinkQueryExecutor,sql: string,values: unknown[]): Promise<T> {
  try {
    const row=(await executor.query(sql,values)).rows[0];
    if (!row || !Object.hasOwn(row,'result')) throw new Error('checkout_link_response_invalid');
    return row.result as T;
  } catch (error) {
    if (typeof error==='object' && error!==null && 'code' in error && error.code==='22023' && 'message' in error
      && (error.message==='customer_checkout_recovery_order_not_recoverable' || error.message==='buyer_checkout_recovery_order_not_recoverable')) {
      throw new CheckoutLinkNotRecoverableError();
    }
    // Driver diagnostics may include raw outbox tokens or bound values.
    throw new Error('checkout_link_storage_failed');
  }
}
