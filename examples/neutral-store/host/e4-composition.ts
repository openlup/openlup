import { createPostgresCustomerSavedAddressPort, createCustomerSavedAddressRequestSchemas, CustomerSavedAddressRefused, createPostgresCustomerPreferencePort, createCustomerPreferenceSchemas } from '@openlup/platform/shipping';
import { accountPreferencePolicy } from '../owned/renewal.config.ts';
import { savedAddressValidation, accountBillingSelection } from '../owned/acquisition-policy.ts';
import { createPostgresCommerceReturnsPort, createPostgresCommerceOmsPort, createPostgresCommerceOmsControlPlane } from '@openlup/platform/commerce/server/postgres';
import { createCommerceReturnsSchemas, returnApproveSchema, returnRejectSchema, adminCommerceOrderCancelRequestSchema, adminCommerceOrderMarkRefundedRequestSchema, CommerceOmsConflictError } from '@openlup/platform/commerce';
import { isUuid } from './recurring-fence.ts';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createNativeQuoteService } from './quote-composition.ts';
import { installedAcquisitionPredecessors } from './acquisition-predecessors.ts';
import { quotesMatchForRecovery } from '@openlup/platform/commerce/server';
import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import type { CreateQuoteResponse } from '@openlup/platform/pricing';
import { createCustomerAccountMutationSchemas, createPostgresCustomerAccountMutationPort } from '@openlup/platform/account-support';
import { createAdminCheckoutPaymentLinkHandler, createPostgresOperatorCheckoutLinkStore, type OperatorCheckoutLinkOrder } from '@openlup/platform/commerce/server';
import { createPostgresFulfillmentOperatorPort } from '@openlup/platform/fulfillment/native';
import { createAdminCommerceFulfillmentRecordLabelHandler, createAdminCommerceFulfillmentHandOffHandler, createAdminCommerceFulfillmentTrackingEventHandler, CommerceFulfillmentConflictError } from '@openlup/platform/fulfillment';
import { customerAccountPolicy, checkoutLinkPolicy } from '../owned/acquisition-policy.ts';
import type { Pool } from 'pg';
import { evaluateCommerceFulfillmentEligibility, uuidSchema } from '@openlup/platform/commerce';
import { createInvoiceAccess } from '@openlup/platform/account-support';
import { createPostgresInvoiceAccountHistory, createCapturedPostgresInvoiceProvider } from '@openlup/platform/invoicing/postgres';
import { createPostgresFulfillmentShipmentCommandPort, createPostgresFulfillmentCommerceReadPort, nativeFulfillmentCommerceResponseSchemas } from '@openlup/platform/fulfillment/native';
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
    ...composeOrderTransitions(pool, authorizeOperator),
    ...composeReturnCapabilities(pool, authorizeOperator),
    ...composeShipmentCapabilities(pool, authorizeOperator),
    ...composeAccountPreferences(pool),
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

/** Human admission and Commerce resolution are repeated before every native invocation, including replay. */
export function composeOrderHolds(pool: Pool, authorize: (context: ActionContext) => Promise<boolean>): ApplicationBindings['actions'] {
  const action = (release: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorize(context)) return { ok: false, code: 'operator_required' };
    const target = release ? payload.holdRef : payload.orderRef;
    if (Object.keys(payload).some(key => !['locale', release ? 'holdRef' : 'orderRef', ...(release ? [] : ['reason']), 'note'].includes(key))
      || !isUuid(target) || (payload.note !== undefined && (typeof payload.note !== 'string' || payload.note.length > 1000))
      || (!release && !context.config.orderControls.holdReasons.some(choice => choice.code === payload.reason))) return { ok: false, code: 'starter_input_invalid' };
    const actor = await createPostgresCommerceOmsControlPlane(pool).resolveOperator(context.actor.operatorRef);
    if (!actor) return { ok: false, code: 'operator_required' };
    const common = { actorUserId: actor, idempotencyKey: context.commandKey, note: payload.note as string | undefined };
    try {
      const port = createPostgresCommerceOmsPort(pool);
      const value = release ? await port.releaseHold({ ...common, holdId: target.toLowerCase() })
        : await port.createHold({ ...common, orderId: target.toLowerCase(), reason: payload.reason as Parameters<typeof port.createHold>[0]['reason'] });
      return { ok: true, value, replayed: value.replayed };
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) return { ok: false, code: 'starter_order_hold_conflict' };
      throw error;
    }
  };
  return { 'operator.hold': action(false), 'operator.release': action(true) };
}

/** Host confirmation and human identity precede the package-owned order transitions. */
export function composeOrderTransitions(pool: Pool, authorize: (context: ActionContext) => Promise<boolean>): ApplicationBindings['actions'] {
  const action = (refund: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorize(context)) return refused('operator_required');
    if (Object.keys(payload).some(key => !['locale', 'orderRef', 'reason', 'confirmed'].includes(key)) || payload.confirmed !== true)
      return refused('starter_input_invalid');
    const schema = refund ? adminCommerceOrderMarkRefundedRequestSchema : adminCommerceOrderCancelRequestSchema;
    const input = schema.safeParse({ idempotencyKey: context.commandKey, orderId: payload.orderRef, reason: payload.reason });
    if (!input.success) return refused('starter_input_invalid');
    const actor = await createPostgresCommerceOmsControlPlane(pool).resolveOperator(context.actor.operatorRef);
    if (!actor) return refused('operator_required');
    try {
      const port = createPostgresCommerceOmsPort(pool);
      const request = { ...input.data, orderId: input.data.orderId.toLowerCase(), actorUserId: actor };
      const value = refund ? await port.markRefunded(request) : await port.cancelOrder(request);
      return { ok: true, value, replayed: value.replayed };
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) return refused('starter_order_transition_conflict');
      return refused('starter_order_transition_unavailable');
    }
  };
  return { 'operator.cancelUnpaid': action(false), 'operator.externalRefund': action(true) };
}

/** Native return intent only; identity and configured reasons belong to this host. */
export function composeReturnCapabilities(pool: Pool, authorize: (context: ActionContext) => Promise<boolean>): ApplicationBindings['actions'] {
  const port = createPostgresCommerceReturnsPort(pool);
  const request: ActionBinding = async (payload, context) => {
    if (!context.actor.principalRef || !context.actor.customerRef) return refused('customer_session_required');
    if (Object.keys(payload).some(key => !['locale','orderRef','lines','reasonCode','customerNote'].includes(key))
      || !Array.isArray(payload.lines) || payload.lines.some(line => !line || typeof line !== 'object' || Array.isArray(line)
        || Object.keys(line).some(key => !['orderItemId','quantity','sku','restockDisposition'].includes(key)))) return refused('starter_input_invalid');
    const reasons = context.config.returns.reasons.map(choice => choice.code);
    if (!reasons.length) return refused('starter_return_unavailable');
    const schema = createCommerceReturnsSchemas(reasons as [string, ...string[]]).returnRequestCreateSchema;
    const parsed = schema.safeParse({ ...payload, orderId: payload.orderRef, idempotencyKey: context.commandKey });
    if (!parsed.success) return refused('starter_input_invalid');
    try {
      const value = await port.createRequest({ ...parsed.data, requestedBy: context.actor.principalRef });
      return { ok: true, value, replayed: value.replayed };
    } catch { return refused('starter_return_refused'); }
  };
  const decision = (approve: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorize(context)) return refused('operator_required');
    if (Object.keys(payload).some(key => !['locale','returnRef','adminNote', ...(approve ? ['refundMode','refundAmountCents'] : [])].includes(key)))
      return refused('starter_input_invalid');
    const input = { ...payload, returnRequestId: payload.returnRef, idempotencyKey: context.commandKey };
    const parsed = approve ? returnApproveSchema.safeParse(input) : returnRejectSchema.safeParse(input);
    if (!parsed.success || (approve && 'refundMode' in parsed.data && parsed.data.refundMode === 'partial'
      && payload.refundAmountCents === undefined)) return refused('starter_input_invalid');
    const actorUserId = await createPostgresCommerceOmsControlPlane(pool).resolveOperator(context.actor.operatorRef);
    if (!actorUserId) return refused('operator_required');
    try {
      const value = approve ? await port.approve({ ...returnApproveSchema.parse(input), actorUserId })
        : await port.reject({ ...returnRejectSchema.parse(input), actorUserId });
      return { ok: true, value, replayed: value.replayed };
    } catch { return refused('starter_return_refused'); }
  };
  return { 'return.request': request, 'operator.returnApprove': decision(true), 'operator.returnReject': decision(false) };
}


/** Human-admin evidence only. Native commands own the READ COMMITTED transaction's effects. */
export function composeShipmentCapabilities(pool: Pool, authorize: (context: ActionContext) => Promise<boolean>): ApplicationBindings['actions'] {
  const command = (kind: 'label' | 'handoff' | 'tracking'): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorize(context)) return refused('operator_required');
    const fields = kind === 'label' ? ['providerKind','providerTrackingId','labelUrl','deliveryEstimateDays','rawProviderPayload']
      : kind === 'tracking' ? ['status','providerTrackingId','rawEvent'] : [];
    if (payload.confirmed !== true || Object.keys(payload).some(key => !['locale','shipmentRef','confirmed','metadata', ...fields].includes(key)))
      return refused('starter_input_invalid');
    const { locale: _locale, shipmentRef, confirmed: _confirmed, ...input } = payload;
    type Response = { result: Awaited<ReturnType<ActionBinding>> };
    const response: Response = { result: refused('starter_shipment_unavailable') };
    const respond = {
      sendMethodNotAllowed(res: Response) { res.result = refused('method_not_allowed'); },
      sendBffSuccess(res: Response, value: unknown) { res.result = { ok: true, value,
        ...(value && typeof value === 'object' && 'replayed' in value && typeof value.replayed === 'boolean' ? { replayed: value.replayed } : {}) }; },
      sendBffError(res: Response, code: string, _message: string, options?: { details: unknown }) {
        const detail = options?.details as { reason?: unknown } | undefined;
        const reason = typeof detail?.reason === 'string' && /^[a-z_]+$/.test(detail.reason) ? detail.reason : 'conflict';
        res.result = refused(code === 'BAD_REQUEST' ? 'starter_input_invalid'
          : code === 'CONFLICT' ? `starter_shipment_${reason}` : 'starter_shipment_unavailable');
      },
    };
    // Public handlers validate before the lazy port opens a connection. The host
    // admission above is fresh for this invocation, including native receipt replay.
    let db: import('pg').PoolClient | undefined;
    const port = async () => {
      db = await pool.connect();
      await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      return createPostgresFulfillmentShipmentCommandPort(db);
    };
    // Handler ports are synchronous factories; validate in the public handler,
    // and acquire the transaction only inside the selected mutation method.
    const fulfillmentPort = {
      async recordCommerceFulfillmentLabel(request: Parameters<ReturnType<typeof createPostgresFulfillmentShipmentCommandPort>['recordCommerceFulfillmentLabel']>[0]) {
        return (await port()).recordCommerceFulfillmentLabel(request);
      },
      async handOffCommerceFulfillmentOrder(request: Parameters<ReturnType<typeof createPostgresFulfillmentShipmentCommandPort>['handOffCommerceFulfillmentOrder']>[0]) {
        return (await port()).handOffCommerceFulfillmentOrder(request);
      },
      async recordCommerceFulfillmentTrackingEvent(request: Parameters<ReturnType<typeof createPostgresFulfillmentShipmentCommandPort>['recordCommerceFulfillmentTrackingEvent']>[0]) {
        return (await port()).recordCommerceFulfillmentTrackingEvent(request);
      },
    };
    const deps = { respond, fulfillmentPort, authorizeAdmin: async () => ({ ok: true as const, userId: context.actor.operatorRef! }) };
    const handler = kind === 'label' ? createAdminCommerceFulfillmentRecordLabelHandler(deps)
      : kind === 'handoff' ? createAdminCommerceFulfillmentHandOffHandler(deps) : createAdminCommerceFulfillmentTrackingEventHandler(deps);
    try {
      await handler({ method: 'POST', query: {}, body: { ...input, fulfillmentOrderId: shipmentRef, idempotencyKey: context.commandKey } }, response);
      if (db) await db.query(response.result.ok ? 'COMMIT' : 'ROLLBACK');
      return response.result;
    } finally {
      if (db) { try { await db.query('ROLLBACK'); } finally { db.release(); } }
    }
  };
  return { 'operator.label': command('label'), 'operator.handoff': command('handoff'), 'operator.delivery': command('tracking') };
}


/** This selected adapter represents an unbound billing store, never a failed-read fallback.
 * Only address rows are exposed; no billing/profile/default-hint action is mounted. */
const unselectedBillingRows = async () => {
  if (accountBillingSelection !== 'not_selected') throw new Error('starter_billing_reader_required');
  return [];
};
export function composeAccountPreferences(pool: Pool): ApplicationBindings['actions'] {
  const action = (kind: 'addresses' | 'payment' | 'delivery' | 'selection'): ActionBinding => async (payload, context) => {
    const { principalRef, customerRef } = context.actor;
    if (!principalRef || !customerRef) return refused('customer_session_required');
    const fields = kind === 'addresses' ? ['action','addressId','kind','label','recipientName','contactPhone','companyName','taxId','line1','line2','city','postalCode','country','isDefault','deliveryNotes','courierInstructions']
      : kind === 'payment' ? ['action','scope','methodKind']
        : kind === 'delivery' ? ['action','scope','deliveryKind','providerKind','carrierKind','carrierCode','serviceCode','pickupPoint']
          : ['subscriptionRef','savedAddressId','reason'];
    if (Object.keys(payload).some(key => key !== 'locale' && !fields.includes(key))) return refused('starter_input_invalid');
    const { locale: _locale, action: verb, ...input } = payload;
    const scope = { principalId: principalRef, clientId: customerRef };
    try {
      if (kind === 'selection') {
        if (!uuid(input.subscriptionRef) || typeof input.savedAddressId !== 'string'
          || (input.reason !== undefined && typeof input.reason !== 'string')) return refused('starter_input_invalid');
        // Do not parse the saved ID here: native admitted-key replay precedes that parsing.
        const value = await createPostgresDestinationPort(pool).selectSavedShippingAddress({ actorId: principalRef, clientId: customerRef,
          subscriptionId: input.subscriptionRef, savedAddressId: input.savedAddressId, idempotencyKey: context.commandKey,
          ...(typeof input.reason === 'string' ? { reason: input.reason } : {}), now: new Date().toISOString() });
        return { ok: true, value, replayed: value.status === 'replayed' };
      }
      if (kind === 'addresses') {
        if (!['read','upsert','delete'].includes(String(verb)) || (verb === 'read' && Object.keys(input).length)) return refused('starter_input_invalid');
        const validation = savedAddressValidation(context.config.market.country);
        const schemas = createCustomerSavedAddressRequestSchemas(validation);
        const parsed = verb === 'upsert' ? schemas.customerAddressUpsertRequestSchema.safeParse({ ...input, idempotencyKey: context.commandKey })
          : verb === 'delete' ? schemas.customerAddressDeleteRequestSchema.safeParse({ ...input, idempotencyKey: context.commandKey }) : null;
        if (parsed && !parsed.success) return refused('starter_input_invalid');
        const port = createPostgresCustomerSavedAddressPort(pool, scope, { validation, now: () => new Date().toISOString(),
          readOrdererProfiles: unselectedBillingRows, inUseMessage: 'Saved address is used by an active subscription' });
        const request = { ...input, idempotencyKey: context.commandKey };
        const book = verb === 'read' ? await port.getAddressBook(principalRef)
          : verb === 'delete' ? await port.deleteAddress(principalRef, { addressId: String(input.addressId), idempotencyKey: context.commandKey })
            : await port.upsertAddress(principalRef, request as Parameters<typeof port.upsertAddress>[1]);
        return book ? { ok: true, value: { addresses: book.addresses, billingProfilesAvailable: false } } : refused('customer_session_required');
      }
      if (!['read','save'].includes(String(verb)) || (verb === 'read' && Object.keys(input).length)) return refused('starter_input_invalid');
      const schemas = createCustomerPreferenceSchemas(accountPreferencePolicy);
      const parsed = kind === 'payment' ? schemas.payment.safeParse(input) : schemas.delivery.safeParse(input);
      if (verb === 'save' && !parsed.success) return refused('starter_input_invalid');
      const port = createPostgresCustomerPreferencePort(pool, scope, accountPreferencePolicy,
        { now: () => new Date().toISOString(), readOrdererHints: unselectedBillingRows });
      const value = verb === 'read' ? kind === 'payment' ? await port.listPaymentPreferences(principalRef) : await port.listDeliveryPreferences(principalRef)
        : kind === 'payment' ? await port.upsertPaymentPreference(principalRef, schemas.payment.parse(input))
          : await port.upsertDeliveryPreference(principalRef, schemas.delivery.parse(input));
      return value === null ? refused('customer_session_required') : { ok: true, value: verb === 'read' ? { preferences: value } : { preference: value } };
    } catch (error) {
      if (error instanceof CustomerSavedAddressRefused) return refused(`starter_${error.code}`);
      const message = error instanceof Error ? error.message : '';
      if (error && typeof error === 'object' && 'code' in error && error.code === '22P02') return refused('starter_address_invalid');
      const reasons: Record<string, string> = { customer_self_service_invalid_address: 'address_invalid', customer_self_service_forbidden: 'subscription_forbidden',
        customer_self_service_not_found: 'subscription_not_found', customer_self_service_payment_blocked: 'payment_blocked',
        customer_self_service_invalid_idempotency_key: 'input_invalid' };
      return refused(reasons[message] ? `starter_${reasons[message]}` : 'starter_account_data_unavailable');
    }
  };
  return { 'account.addresses': action('addresses'), 'account.paymentPreference': action('payment'),
    'account.deliveryPreference': action('delivery'), 'subscription.savedAddress': action('selection') };
}
