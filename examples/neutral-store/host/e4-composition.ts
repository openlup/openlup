import type { Pool } from 'pg';
import { uuidSchema } from '@openlup/platform/commerce';
import { createInvoiceAccess } from '@openlup/platform/account-support';
import { createPostgresInvoiceAccountHistory, createCapturedPostgresInvoiceProvider } from '@openlup/platform/invoicing/postgres';
import type { ActionContext, ApplicationBindings } from './bindings.ts';
import { readOperatorInvoiceSummary } from './e4-invoice-summary.ts';

const refused = (code: string) => ({ ok: false as const, code });
const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;

/** The existing native session service rechecks human membership on every call. */
export function composeE4Capabilities(pool: Pool, authorizeOperator: (context: ActionContext) => Promise<boolean>):
ApplicationBindings['actions'] {
  return {
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
