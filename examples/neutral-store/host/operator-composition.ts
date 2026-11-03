import { createPostgresCustomerSupportJourneyPort } from '@openlup/platform/account-support/postgres';
import { createPostgresBundleCatalogStore, createPostgresBundleAdminWriteStore,
  createPostgresCatalogDraftStore, createCatalogDraftHandler, BundleRpcError,
  evaluateBundleComposition } from '@openlup/platform/catalog';
import type { PgQueryExecutor } from '@openlup/platform/data';
import { catalogDraftRegistry } from '../owned/catalogue.ts';
import type { ActionBinding, ActionContext, ApplicationBindings } from './bindings.ts';

const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
const text = (value: unknown, max = 200): value is string => typeof value === 'string'
  && value.trim() === value && value.length > 0 && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const only = (payload: Record<string, unknown>, keys: string[]) =>
  Object.keys(payload).every(key => key === 'locale' || keys.includes(key));

/** Operator identity is established by native request authentication before dispatch. */
export function composeOperatorCapabilities(input: { executor: PgQueryExecutor; connectionString: string }):
Pick<ApplicationBindings, 'actions' | 'close'> {
  const catalog = createPostgresBundleCatalogStore(input.executor);
  const writer = createPostgresBundleAdminWriteStore({ connectionString: input.connectionString });
  const drafts = createCatalogDraftHandler<ActionContext>({
    store: createPostgresCatalogDraftStore(input.executor), registry: catalogDraftRegistry,
    authorizeOperator: async context => context.actor.operatorRef ? { actorId: context.actor.operatorRef } : null,
  });
  const actions: ApplicationBindings['actions'] = {};
  const support = (detail: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    if (!only(payload, [detail ? 'customerRef' : 'query'])
      || (detail ? !uuid(payload.customerRef) : !text(payload.query))) return refused('starter_input_invalid');
    // The factory fixes operatorId. Never cache a human's authority or pool.
    const port = createPostgresCustomerSupportJourneyPort({ connectionString: input.connectionString,
      operatorId: context.actor.operatorRef });
    try {
      const value = detail ? await port.getCustomerJourney({ subjectId: payload.customerRef as string, pageSize: 10 })
        : await port.searchCustomerJourney({ query: payload.query as string, pageSize: 10 });
      return value === null ? refused('starter_customer_not_found') : success(value);
    } catch (error) {
      // The native adapter deliberately erases the underlying SQLSTATE. Do not
      // mislabel every read failure as a known missing roster row.
      if (error instanceof Error && error.message === 'customer_support_read_failed') return refused(error.message);
      throw error;
    } finally { await port.close(); }
  };
  actions['operator.customerSearch'] = support(false);
  actions['operator.customer'] = support(true);
  actions['operator.bundles'] = async (payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    if (!only(payload, [])) return refused('starter_input_invalid');
    return success(await catalog.listBundles({ status: 'all', limit: 30, offset: 0 }));
  };
  actions['operator.bundle'] = async (payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    if (!only(payload, ['bundleCode']) || !text(payload.bundleCode, 120)) return refused('starter_input_invalid');
    const value = await catalog.getBundle({ code: payload.bundleCode, currency: context.config.market.currency });
    return value ? success(value) : refused('starter_bundle_not_found');
  };
  actions['operator.bundleCommand'] = async (payload, context) => {
    const actor = context.actor.operatorRef;
    if (!actor) return refused('operator_required');
    if (!text(payload.bundleCode, 120) || !text(payload.action)) return refused('starter_input_invalid');
    const command = { code: payload.bundleCode, mode: 'commit' as const, idempotencyKey: context.commandKey };
    const allowed = (fields: string[]) => only(payload, ['action', 'bundleCode', ...fields]);
    try {
      let value;
      switch (payload.action) {
        case 'create':
          if (!allowed(['title']) || !text(payload.title)) return refused('starter_input_invalid');
          value = await writer.upsertDraft(actor, { ...command,
            bundle: { code: command.code, title: payload.title, fulfillmentMode: 'virtual' } });
          break;
        case 'set_composition': {
          if (!allowed(['components']) || !Array.isArray(payload.components) || payload.components.length > 100)
            return refused('starter_input_invalid');
          const components = [];
          for (const [index, entry] of payload.components.entries()) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return refused('starter_input_invalid');
            const item = entry as Record<string, unknown>;
            if (!only(item, ['sku', 'quantity', 'isAddon']) || 'locale' in item || !text(item.sku, 160)
              || !Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1 || Number(item.quantity) > 10000
              || typeof item.isAddon !== 'boolean') return refused('starter_input_invalid');
            components.push({ sku: item.sku, quantity: Number(item.quantity), isAddon: item.isAddon, sortOrder: index });
          }
          if (!evaluateBundleComposition(components).ok) return refused('starter_input_invalid');
          value = await writer.setComposition(actor, { ...command, components });
          break;
        }
        case 'set_target_price':
          if (!allowed(['amountMinor']) || !Number.isSafeInteger(payload.amountMinor)
            || Number(payload.amountMinor) < 1 || Number(payload.amountMinor) > 2147483647) return refused('starter_input_invalid');
          value = await writer.setTargetPrice(actor, { ...command, price: { mode: 'any',
            targetPriceMinor: Number(payload.amountMinor), currency: context.config.market.currency, amountKind: 'gross' } });
          break;
        case 'clone':
          if (!allowed(['newCode']) || !text(payload.newCode, 120)) return refused('starter_input_invalid');
          value = await writer.cloneDraft(actor, { ...command, sourceCode: command.code, code: payload.newCode });
          break;
        case 'activate': case 'deactivate': case 'archive': case 'restore':
          if (!allowed([])) return refused('starter_input_invalid');
          value = await writer[payload.action](actor, command);
          break;
        default: return refused('starter_input_invalid');
      }
      return { ...success(value), ...(value.idempotent ? { replayed: true } : {}) };
    } catch (error) {
      if (error instanceof BundleRpcError) return refused(error.sqlstate === '42501' ? 'bundle_forbidden'
        : error.sqlstate === 'P0002' ? 'bundle_not_found' : error.sqlstate === 'P0001' ? 'bundle_rule_conflict' : 'bundle_write_failed');
      throw error;
    }
  };
  actions['operator.catalogDrafts'] = async (payload, context) => {
    if (!context.actor.operatorRef) return refused('operator_required');
    const fields = payload.action === undefined ? [] : payload.action === 'get' ? ['action', 'draftId']
      : ['action', 'draftId', 'expectedRevision', 'payload'];
    if (!only(payload, fields)) return refused('starter_input_invalid');
    const result = payload.action === undefined ? await drafts.list({ limit: 30 }, context)
      : payload.action === 'get' ? await drafts.get({ draftId: payload.draftId }, context)
        : await drafts.execute({ schemaVersion: 1, action: payload.action, draftId: payload.draftId,
          expectedRevision: payload.expectedRevision, ...(payload.payload === undefined ? {} : { payload: payload.payload }),
          commandKey: context.commandKey }, context);
    if ('reason' in result) return refused(`catalog_${result.reason}`);
    return { ...success(result), ...(result.outcome === 'replayed' ? { replayed: true } : {}) };
  };
  return { actions, close: () => writer.close() };
}
