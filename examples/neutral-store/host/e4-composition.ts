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
