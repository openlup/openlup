import { composeOrderHolds } from './order-holds.ts';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createNativeQuoteService } from './quote-composition.ts';
import { installedAcquisitionPredecessors } from './acquisition-predecessors.ts';
import { quotesMatchForRecovery } from '@openlup/platform/commerce/server';
import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import type { CreateQuoteResponse } from '@openlup/platform/pricing';
import { createCustomerAccountMutationSchemas, createPostgresCustomerAccountMutationPort } from '@openlup/platform/account-support';
import { createAdminCheckoutPaymentLinkHandler, createPostgresOperatorCheckoutLinkStore, type OperatorCheckoutLinkOrder } from '@openlup/platform/commerce/server';
import { createPostgresFulfillmentOperatorPort } from '@openlup/platform/fulfillment/native';
import { CommerceFulfillmentConflictError } from '@openlup/platform/fulfillment';
import { customerAccountPolicy, checkoutLinkPolicy } from '../owned/acquisition-policy.ts';
import type { Pool } from 'pg';
import { evaluateCommerceFulfillmentEligibility, uuidSchema } from '@openlup/platform/commerce';
import { createInvoiceAccess } from '@openlup/platform/account-support';
import { createPostgresInvoiceAccountHistory, createCapturedPostgresInvoiceProvider } from '@openlup/platform/invoicing/postgres';
import { createPostgresFulfillmentCommerceReadPort, nativeFulfillmentCommerceResponseSchemas } from '@openlup/platform/fulfillment/native';
import type { ActionBinding, ActionContext, ApplicationBindings } from './bindings.ts';
import { readOperatorInvoiceSummary } from './e4-invoice-summary.ts';

const refused = (code: string) => ({ ok: false as const, code });
const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;

/** The existing native session service rechecks human membership on every call. */
export function composeE4Capabilities(pool: Pool, authorizeOperator: (context: ActionContext) => Promise<boolean>):
ApplicationBindings['actions'] {
  const shipmentRead = (detail: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorizeOperator(context)) return refused('operator_required');
    const fields = detail ? ['shipmentRef', 'fulfillmentOrderId', 'orderRef', 'orderId', 'locale']
      : ['page', 'pageSize', 'status', 'locale'];
    if (Object.keys(payload).some(key => !fields.includes(key))) return refused('starter_input_invalid');
    const fulfillmentOrderId = payload.shipmentRef ?? payload.fulfillmentOrderId;
    const orderId = payload.orderRef ?? payload.orderId;
    const page = Number(payload.page ?? 1), pageSize = Number(payload.pageSize ?? 25);
    const status = payload.status === undefined ? undefined
      : nativeFulfillmentCommerceResponseSchemas.order.shape.status.safeParse(payload.status);
    if (detail ? ((!fulfillmentOrderId && !orderId)
      || (fulfillmentOrderId !== undefined && !uuid(fulfillmentOrderId))
      || (orderId !== undefined && !uuid(orderId)))
      : (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1
        || pageSize > 100 || (status !== undefined && !status.success))) return refused('starter_input_invalid');
    const db = await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const port = createPostgresFulfillmentCommerceReadPort({ executor: db,
        destinations: { async read(_scope, id) {
          const result = await db.query('SELECT public.commerce_view_shipment_destination($1::uuid) AS value', [id]);
          return result.rows[0].value;
        } },
        policy: { evaluateCommerceFulfillmentEligibility },
        orderMode: ({ subscriptionCycleId, capturedMode }) =>
          subscriptionCycleId || capturedMode === 'subscription' ? 'subscription_cycle' : 'one_time',
      });
      const result = detail ? await port.getCommerceFulfillmentOrderDetail({
        ...(typeof fulfillmentOrderId === 'string' ? { fulfillmentOrderId } : {}),
        ...(typeof orderId === 'string' ? { orderId } : {}),
      }) : await port.listCommerceFulfillmentOrders({ page, pageSize,
        ...(status?.success ? { status: status.data } : {}) });
      const value = result === null ? null : (detail ? nativeFulfillmentCommerceResponseSchemas.detail
        : nativeFulfillmentCommerceResponseSchemas.list).parse(result);
      await db.query('COMMIT');
      return value === null ? refused('starter_shipment_not_found') : { ok: true, value };
    } finally {
      try { await db.query('ROLLBACK'); } finally { db.release(); }
    }
  };
  return {
    ...composeOrderHolds(pool, authorizeOperator),
    'operator.shipments': shipmentRead(false),
    'operator.shipment': shipmentRead(true),
    'account.invoice': async (payload, context) => {
      const accountRef = context.actor.principalRef;
      if (!accountRef || !context.actor.customerRef) return refused('customer_session_required');
      if (!uuid(payload.orderRef) || (payload.documentRef !== undefined && !uuid(payload.documentRef))) {
        return refused('starter_input_invalid');
      }
      const sandbox = createCapturedPostgresInvoiceProvider(pool, context.config.documents.sandbox);
      const access = createInvoiceAccess({ accountHistory: createPostgresInvoiceAccountHistory(pool), artifacts: sandbox.artifacts });
      const request = { accountRef, orderId: payload.orderRef };
      if (payload.documentRef === undefined) {
        const value = await access.history(request);
        return value.kind === 'found' ? { ok: true, value } : refused(`starter_invoice_${value.kind}`);
      }
      const value = await access.download({ ...request, documentRef: payload.documentRef });
      return value.kind === 'downloaded' ? { ok: true, value: { contentType: value.contentType,
        fileName: value.fileName, base64: Buffer.from(value.content).toString('base64') } }
        : refused(`starter_invoice_${value.kind}`);
    },
    'operator.invoice': async (payload, context) => {
      // Human authorization precedes even the order-existence query. Guest
      // orders retain their null customer principal in the local summary.
      if (!context.actor.operatorRef || !await authorizeOperator(context)) return refused('operator_required');
      if (!uuid(payload.orderRef)) return refused('starter_input_invalid');
      const db = await pool.connect();
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const value = await readOperatorInvoiceSummary(db, payload.orderRef);
        await db.query('COMMIT');
        return value.kind === 'found' ? { ok: true, value: value.summary } : refused(`starter_invoice_${value.kind}`);
      } catch {
        return refused('starter_invoice_unknown');
      } finally {
        try { await db.query('ROLLBACK'); } finally { db.release(); }
      }
    },
  };
}

/** Narrow account and operator bindings; installed ports own writes and receipts. */
export function composePortalCapabilities(pool: Pool, authorizeOperator: (context: ActionContext) => Promise<boolean>, keyring?: PromotionAcceptanceKeyring): ApplicationBindings['actions'] {
  const accountSchemas = createCustomerAccountMutationSchemas(customerAccountPolicy);
  const account = (correction: boolean): ActionBinding => async (payload, context) => {
    const { principalRef, customerRef } = context.actor;
    if (!principalRef || !customerRef) return refused('customer_session_required');
    const { locale: _locale, ...fields } = payload;
    const input = { ...fields, idempotencyKey: context.commandKey };
    // Reject caller-supplied identity and command keys rather than silently replacing them.
    if (Object.hasOwn(fields, 'idempotencyKey')) return refused('starter_input_invalid');
    const schema = correction ? accountSchemas.correctionRequest : accountSchemas.profileRequest;
    if (!schema.safeParse(input).success) return refused('starter_input_invalid');
    const port = createPostgresCustomerAccountMutationPort(pool, { principalId: principalRef, clientId: customerRef }, accountSchemas, () => new Date().toISOString());
    // Intentionally separate native calls: profile writes and account-event append are not atomic.
    const value = correction ? await port.requestInvoiceCorrection(principalRef, accountSchemas.correctionRequest.parse(input))
      : await port.updateProfile(principalRef, accountSchemas.profileRequest.parse(input));
    return value ? { ok: true, value } : refused(correction ? 'starter_invoice_not_found' : 'customer_session_required');
  };
  const mutation = (replacement: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorizeOperator(context)) return refused('operator_required');
    const allowed = replacement ? ['orderRef', 'reason', 'confirmed', 'locale'] : ['shipmentRef', 'reason', 'confirmed', 'locale'];
    if (Object.keys(payload).some(key => !allowed.includes(key)) || payload.confirmed !== true
      || !uuid(replacement ? payload.orderRef : payload.shipmentRef)
      || typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.trim().length > 240
      || (replacement && !['damaged', 'lost', 'returned_undelivered', 'other'].includes(payload.reason))) return refused('starter_input_invalid');
    const port = createPostgresFulfillmentOperatorPort(pool, { providerRef: context.config.purchase.stock.providerRef,
      stockSourceKey: `starter-demo:${context.config.id}` });
    const base = { actorUserId: context.actor.operatorRef, idempotencyKey: context.commandKey, metadata: { source: 'operator_ui' } };
    try {
      const value = replacement ? await port.requestReplacementShipment({ ...base, orderId: payload.orderRef as string,
        reason: payload.reason as 'damaged' | 'lost' | 'returned_undelivered' | 'other' })
        : await port.cancelCommerceFulfillmentOrder({ ...base, fulfillmentOrderId: payload.shipmentRef as string, reason: payload.reason.trim() });
      return { ok: true, value, replayed: value.replayed };
    } catch (error) {
      if (error instanceof CommerceFulfillmentConflictError) {
        const detail = error.details as { reason?: unknown } | undefined;
        return refused(typeof detail?.reason === 'string' ? `starter_fulfillment_${detail.reason}` : 'starter_fulfillment_conflict');
      }
      throw error;
    }
  };
  return {
    'account.profile': account(false), 'account.invoiceCorrection': account(true),
    'operator.replacement': mutation(true), 'operator.cancelFulfillment': mutation(false),
    'operator.paymentLink': async (payload, context) => {
      if (!context.actor.operatorRef || !await authorizeOperator(context)) return refused('operator_required');
      if (Object.keys(payload).some(key => !['orderRef', 'delivery', 'locale'].includes(key)) || !uuid(payload.orderRef)
        || !['copy', 'email'].includes(String(payload.delivery))) return refused('starter_input_invalid');
      const response: { result: Awaited<ReturnType<ActionBinding>> } = { result: refused('starter_payment_link_unavailable') };
      const handler = createAdminCheckoutPaymentLinkHandler<typeof response>({
        authorizeAdmin: async () => ({ ok: true, userId: context.actor.operatorRef!, isMachineActor: false }),
        respond: portalResponder, orderPort: { getRecoveryOrder: ({ orderId }) => readRecoveryOrder(pool, orderId) },
        tokenStore: createPostgresOperatorCheckoutLinkStore(pool), policy: checkoutLinkPolicy,
        async validateRecreate(order) {
          try {
            const frozen = order.quoteSnapshot as CreateQuoteResponse;
            const mode = order.mode === 'subscription_cycle' ? 'subscription' : 'one_time';
            const fresh = await createNativeQuoteService(pool, installedAcquisitionPredecessors(), keyring).quote({
              email: order.customerEmail, configuration: context.config.id, country: context.config.market.country,
              ...(mode === 'subscription' ? { acquisitionCapability: 'subscription-acquisition.v1' } : {}),
              cart: { schemaVersion: 1, configuration: context.config.id, mode, cadenceDays: order.cadenceDays,
                lines: frozen.quote.lines.map(line => ({ sku: line.sku, quantity: line.quantity })) },
            }, context);
            return quotesMatchForRecovery(orderedRecoveryQuote(frozen), orderedRecoveryQuote(fresh.snapshot));
          } catch { return false; }
        },
      });
      await handler({ method: 'POST', body: { orderId: payload.orderRef, delivery: payload.delivery } }, response);
      return response.result;
    },
  };
}

/** No raw driver diagnostics or private bearer values become error messages. */
export const portalResponder = {
  sendMethodNotAllowed(res: { result: Awaited<ReturnType<ActionBinding>> }) { res.result = refused('method_not_allowed'); },
  sendBffSuccess(res: { result: Awaited<ReturnType<ActionBinding>> }, value: unknown) { res.result = { ok: true, value }; },
  sendBffError(res: { result: Awaited<ReturnType<ActionBinding>> }, code: string, _message: string, options?: { details: unknown }) {
    const details = options?.details as { reason?: unknown } | undefined;
    res.result = refused(typeof details?.reason === 'string' ? `starter_checkout_${details.reason}` : `starter_checkout_${code.toLowerCase()}`);
  },
};

async function readRecoveryOrder(pool: Pool, id: string): Promise<OperatorCheckoutLinkOrder | null> {
  const row = (await pool.query(`SELECT o.*,c.email,c.first_name,a.id AS activation_id,a.cadence_days,
    i.id AS intent_id,i.status AS intent_status FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id
    LEFT JOIN LATERAL (SELECT id,status FROM public.commerce_settlement_intents WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) i ON true
    WHERE o.id=$1::uuid`, [id])).rows[0];
  if (!row) return null;
  let destinationId: string | null = null;
  try { destinationId = (await createPostgresDestinationPort(pool).read('order', row.id)).destinationId; }
  catch (error) { if (!(error instanceof Error) || error.message !== 'commerce_destination_unavailable') throw error; }
  return { orderId: row.id, orderRef: row.id, orderNumber: row.source_order_ref ?? row.id, clientId: row.client_id,
    status: row.status, mode: row.activation_id ? 'subscription_cycle' : 'one_time_order', totalMinor: Number(row.total_amount_minor),
    currency: row.currency_code, cadenceDays: row.cadence_days ?? null, createdAt: new Date(row.created_at).toISOString(),
    customerEmail: row.email, customerName: row.first_name, paymentIntentId: row.intent_id ?? null,
    paymentIntentStatus: row.intent_status ?? null, subscriptionId: row.activation_id ?? null,
    subscriptionCycleId: row.subscription_cycle_id, shippingAddressId: destinationId,
    quoteSnapshot: row.metadata?.quoteSnapshot, technicallyExpired: row.status === 'expired' || row.metadata?.subscriptionActivation === 'abandoned' };
}


/** JSON object key order is not commercial data. Preserve all values and array ordering. */
function orderedRecoveryQuote(snapshot: CreateQuoteResponse): CreateQuoteResponse {
  const order = (value: unknown): unknown => Array.isArray(value) ? value.map(order)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, order(item)])) : value;
  return order(JSON.parse(JSON.stringify(snapshot))) as CreateQuoteResponse;
}
