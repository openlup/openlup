import { z } from 'zod';
import { createCommerceQuoteSchemas, type CreateQuoteResponse } from '../../pricing/index.js';
import { CommerceOrderDraftPriceChangedError } from '../orderDraftErrors.js';
import { createCheckoutRecoveryValidationPolicy, type NativeCheckoutRecoveryOrder } from './checkoutRecoveryInspection.js';
import { quotesMatchForRecovery } from './checkoutExpiredRecoveryPolicy.js';
import { isStockUnavailableCheckoutConflict } from './checkoutConflictClassifiers.js';

export type ExpiredCheckoutRecoveryOrder = NativeCheckoutRecoveryOrder & { quoteSnapshot: CreateQuoteResponse | null };
export interface ExpiredCheckoutPaymentSafetyPort {
  verifyPriorPayment(order: { orderId: string; totalMinor: number; currency: string }): Promise<'safe' | 'paid' | 'unavailable'>;
}
export interface ExpiredCheckoutRecoveryWritePort {
  prepareReplacement(input: { idempotencyKey: string; sourceOrderId: string; replacementOrderId: string }): Promise<{ replacementOrderId: string; replayed: boolean }>;
}
export class ExpiredCheckoutRecoveryError extends Error {
  constructor(readonly reason: 'paid' | 'order_changed' | 'unavailable' | 'execution_failed', readonly code?: 'native_prepared_attempt_store_unsupported', options?: ErrorOptions) {
    super(`expired_checkout_recovery_${reason}`,options); this.name = 'ExpiredCheckoutRecoveryError';
  }
}
const { createQuoteResponseSchema } = createCommerceQuoteSchemas({ currencySchema: z.string().regex(/^[A-Z]{3}$/),productSlugSchema: z.string().min(1),
  contextSchema: z.object({ mode: z.enum(['one_time','subscription']),cadenceDays:z.number().int().positive().max(120).nullable().optional(),promoCodes:z.array(z.string()).default([]) }).passthrough() });

function orderedJson(value:unknown):unknown {
 if(Array.isArray(value))return value.map(orderedJson);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,orderedJson(item)]));
 return value;
}
/** Internal normalization preserves JSON values across JSONB key ordering. */
export function parseRecoveryRecreationQuote(value:unknown):CreateQuoteResponse|null {
 const result=createQuoteResponseSchema.safeParse(value);if(!result.success)return null;
 try{return orderedJson(JSON.parse(JSON.stringify(result.data))) as CreateQuoteResponse;}catch{return null;}
}

/** A trusted host binds owned order context and the adopter's opaque quote-request extensions. */
export function createExpiredCheckoutRecoveryService<Request, Draft extends { orderId: string }, Result>(deps: {
  supports(order: NativeCheckoutRecoveryOrder): boolean;
  quoteRequest(order: ExpiredCheckoutRecoveryOrder): Request;
  quotePort: { createQuote(request: Request, options: { clientId: string; pricingPolicy?: unknown; offerVersion?: unknown }): Promise<CreateQuoteResponse> };
  orderDraftPort: { createOrderDraft(request: { idempotencyKey: string; quoteSnapshot: CreateQuoteResponse }, options: { clientId: string }): Promise<{ orderDraft: Draft }> };
  recoveryPort: ExpiredCheckoutRecoveryWritePort;
  paymentSafetyPort: ExpiredCheckoutPaymentSafetyPort;
  runtimePort: { startRuntime(input: { idempotencyKey: string; orderDraft: Draft; quoteSnapshot: CreateQuoteResponse; source: ExpiredCheckoutRecoveryOrder; clientId: string }): Promise<Result> };
  compensationPort: {
    cancelAbandonedOrder(input: { idempotencyKey: string; orderId: string; reason: string }): Promise<unknown>;
    cancelUnstartedPromotionOrder(input: { idempotencyKey: string; orderId: string; reason: string }): Promise<unknown>;
  };
}) {
  function frozen(order: NativeCheckoutRecoveryOrder): ExpiredCheckoutRecoveryOrder {
    if (order.subscriptionCycleId !== null) throw new ExpiredCheckoutRecoveryError('unavailable');
    const quote = parseRecoveryRecreationQuote(order.quoteSnapshot);
    if (!quote) throw new ExpiredCheckoutRecoveryError('unavailable');
    return { ...order,quoteSnapshot:quote };
  }
  async function freshMatchingQuote(order: ExpiredCheckoutRecoveryOrder) {
    if (!order.quoteSnapshot) throw new ExpiredCheckoutRecoveryError('unavailable');
    const context = order.quoteSnapshot.quote.context as Record<string,unknown> | undefined;
    const fresh = parseRecoveryRecreationQuote(await deps.quotePort.createQuote(deps.quoteRequest(order),{clientId:order.clientId,
      ...(context?.pricingPolicy ? { pricingPolicy:context.pricingPolicy } : {}),...(context?.offerVersion ? { offerVersion:context.offerVersion } : {})}));
    if(!fresh)throw new ExpiredCheckoutRecoveryError('unavailable');
    if (!quotesMatchForRecovery(order.quoteSnapshot,fresh)) throw new ExpiredCheckoutRecoveryError('order_changed');
    if (!context?.offerVersion) return fresh;
    if (!fresh.quote.context) throw new ExpiredCheckoutRecoveryError('unavailable');
    return {...fresh,quote:{...fresh.quote,context:{...fresh.quote.context,offerVersion:context.offerVersion,
      ...(context.offerEvidence ? { offerEvidence:context.offerEvidence } : {})}}};
  }
  const validation = createCheckoutRecoveryValidationPolicy<NativeCheckoutRecoveryOrder>({supports:deps.supports,validation:{
    async validate(order){try{await freshMatchingQuote(frozen(order));return true;}catch(error){if(error instanceof ExpiredCheckoutRecoveryError)return false;throw error;}}
  }});
  return {
    validate: validation.validate,
    async recreate(input: { order: NativeCheckoutRecoveryOrder; clientId: string }): Promise<Result> {
      // The same adopter predicate fences validation and recreation, preserving
      // false versus unavailable without consulting quote/draft/provider owners.
      if (!deps.supports(input.order)) throw new ExpiredCheckoutRecoveryError('unavailable');
      const order=frozen(input.order);
      if (!order.quoteSnapshot || !order.shippingAddressId || input.clientId!==order.clientId) throw new ExpiredCheckoutRecoveryError('unavailable');
      let safety: 'safe' | 'paid' | 'unavailable';
      try{safety=await deps.paymentSafetyPort.verifyPriorPayment(order);}catch(error){
        if(error instanceof Error && error.message==='native_prepared_attempt_store_unsupported')throw new ExpiredCheckoutRecoveryError('unavailable','native_prepared_attempt_store_unsupported');
        throw new ExpiredCheckoutRecoveryError('unavailable');
      }
      if(safety!=='safe')throw new ExpiredCheckoutRecoveryError(safety);
      const quoteSnapshot=await freshMatchingQuote(order),idempotencyKey=`checkout-recovery-recreate:${order.orderId}`;
      let replacementOrderId: string | null=null,runtimeStarted=false;
      try{
        const draft=await deps.orderDraftPort.createOrderDraft({idempotencyKey,quoteSnapshot},{clientId:input.clientId});
        replacementOrderId=draft.orderDraft.orderId.replace(/^order_/,'');
        await deps.recoveryPort.prepareReplacement({idempotencyKey,sourceOrderId:order.orderId,replacementOrderId});
        runtimeStarted=true;
        return await deps.runtimePort.startRuntime({idempotencyKey,orderDraft:draft.orderDraft,quoteSnapshot,source:order,clientId:input.clientId});
      }catch(error){
        if(replacementOrderId){
          const cleanup={idempotencyKey,orderId:replacementOrderId,reason:'expired_checkout_recovery_failed'};
          if(runtimeStarted)await deps.compensationPort.cancelAbandonedOrder(cleanup).catch(()=>undefined);
          await deps.compensationPort.cancelUnstartedPromotionOrder(cleanup).catch(()=>undefined);
        }
        if(error instanceof ExpiredCheckoutRecoveryError)throw error;
        if(error instanceof Error&&error.message==='native_prepared_attempt_store_unsupported')throw new ExpiredCheckoutRecoveryError('unavailable','native_prepared_attempt_store_unsupported');
        if(error instanceof CommerceOrderDraftPriceChangedError || isStockUnavailableCheckoutConflict(error))throw new ExpiredCheckoutRecoveryError('order_changed');
        throw new ExpiredCheckoutRecoveryError('execution_failed',undefined,{cause:error});
      }
    },
  };
}
