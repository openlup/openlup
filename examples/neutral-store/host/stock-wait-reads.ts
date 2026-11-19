import { createPostgresStockWaitReads, type SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';
import type { ActionContext, ApplicationBindings, ActionBinding } from './bindings.ts';
import type { StarterCatalogueOptions } from './catalogue-binding.ts';
import { isUuid } from './recurring-fence.ts';

const states = ['all', 'waiting', 'stock_secured', 'resumed', 'closed'] as const;
type State = typeof states[number];
const allowedState = (value: unknown): value is State => states.some(state => state === value);
const refuse = (code: string, status: 400 | 403 | 409 | 503) => ({ ok: false as const, code, status });
const success = (value: unknown) => ({ ok: true as const, value });

/** Bind the owner's case projections to a verified human or the authenticated account. */
export function bindStockWaitReads(options: StarterCatalogueOptions,
  authorizeHuman: Parameters<typeof import('./catalogue-binding.ts').bindStarterCatalogue>[0]['authorizeHuman']): ApplicationBindings['actions'] {
  const transactions = options.publication.transactions;
  const readers = (context: ActionContext, subscriptionRef?: string) => {
    const verifyOperator = async () => {
      const authorization = await authorizeHuman(context);
      return authorization.ok && authorization.role === 'admin' && authorization.isMachineActor === false;
    };
    return createPostgresStockWaitReads({
      graph: 'native',
      withReadSnapshot: <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => transactions.run(async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return work(db);
      }),
      authorizeOperator: verifyOperator,
      authorizeEvidence: verifyOperator,
      async readOwnedAccount() {
        const { principalRef: principalId, customerRef: clientId } = context.actor;
        if (!principalId || !clientId) return null;
        return transactions.run(async db => {
          const { rows } = await db.query(`SELECT ARRAY(SELECT id FROM public.subscriptions
            WHERE client_id=c.id AND ($3::uuid IS NULL OR id=$3::uuid) ORDER BY id) AS subscriptions
            FROM public.clients c WHERE c.id=$1::uuid AND c.principal_id=$2::uuid`, [clientId, principalId, subscriptionRef ?? null]);
          const subscriptionIds = rows[0]?.subscriptions as string[] | undefined;
          return subscriptionIds && (!subscriptionRef || subscriptionIds.length === 1)
            ? { principalId, clientId, subscriptionIds } : null;
        });
      },
    });
  };
  const scoped = (read: ActionBinding): ActionBinding => async (payload, context) => {
    if (context.config.id !== options.registration.configuration.id || !options.readEnabled()) return refuse('catalog_capability_unsupported', 409);
    try { return await read(payload, context); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['stock_wait_operator_forbidden', 'stock_wait_evidence_forbidden', 'stock_wait_customer_forbidden'].includes(code)) return refuse(code, 403);
      return refuse('starter_stock_wait_read_unavailable', 503);
    }
  };
  return {
    'operator.stockWait': scoped(async (payload, context) => {
      const { view, state = 'waiting', page = 1, pageSize = 30 } = payload;
      if (Object.keys(payload).some(key => !['view', 'state', 'page', 'pageSize', 'locale'].includes(key))
        || !allowedState(state) || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1
        || typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isSafeInteger((page - 1) * pageSize)) return refuse('starter_input_invalid', 400);
      const read = readers(context);
      if (view === 'summary') return success(await read.readOperatorSummary(state));
      if (view === 'evidence') return success(await read.listEvidence());
      if (view === 'admin') return success(await read.listAdmin({ state, page, pageSize }));
      return refuse('starter_input_invalid', 400);
    }),
    'subscription.stockWait': scoped(async (payload, context) => {
      const { subscriptionRef } = payload;
      if (Object.keys(payload).some(key => !['subscriptionRef', 'locale'].includes(key))
        || subscriptionRef !== undefined && !isUuid(subscriptionRef)) return refuse('starter_input_invalid', 400);
      return success(await readers(context, subscriptionRef).listCustomer());
    }),
  };
}
