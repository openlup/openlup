import type { Pool } from 'pg';
import { createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore,
  computeEditState, editCutoff, isCustomerVisibleSubscription, recurringPrice } from '@openlup/platform/account-support';
import { createPostgresPackageEditor, createPostgresSizedEditor, createOfferDispatchedSubscriptionEditor, mapSizedEditError,
  type PackageEditActor, type SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';
import type { EditorCandidate, EditorSubscription } from '../shared/subscription-edit.ts';
import type { ActionContext, ApplicationBindings, VerifiedActor } from './bindings.ts';
import { isRecord } from '../shared/offer.ts';
import { editorProducts } from './editor-catalogue.ts';
import { editorQuotePorts, sizedHostPorts } from './editor-ports.ts';

const success = (value: unknown) => ({ ok: true as const,value });
const refused = (code: string, status: 400 | 403 | 409 | 503 = 409) => ({ ok: false as const,code,status });
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const unavailable = () => { throw new Error('starter_account_projection_binding_required'); };

/** Narrow account projection, using the package's owned sources and eligibility functions. */
export async function readEditorSubscriptions(db: SubscriptionQueryExecutor, actor: VerifiedActor): Promise<EditorSubscription[]> {
  if (!actor.customerRef || !actor.principalRef) throw new Error('customer_session_required');
  const scope = { clientId: actor.customerRef,principalId: actor.principalRef };
  const sources = createPostgresAccountReadSources(db, { ...scope,now: () => new Date().toISOString(),
    additional: { readExtension: unavailable,readNextCharges: unavailable },
    orders: createPostgresCustomerOrderHistoryReadStore(db, { ...scope,readInvoiceSummaries: unavailable }),
    orderProjection: { automaticHoldSource: '',automaticReleaseSource: '',orderReference: unavailable,
      fulfillmentEvidence: unavailable,presentation: { display: unavailable } } });
  const rows = (await sources.readSubscriptionRows(scope.clientId,50)).filter(isCustomerVisibleSubscription);
  const ids = rows.map(row => String(row.id)), cycles = new Map(rows.map(row => [String(row.id),typeof row.next_cycle_at === 'string' ? row.next_cycle_at : null]));
  const [lines,blockers,methods] = await Promise.all([sources.readSubscriptionLines(ids),sources.readSubscriptionBlockers(ids,cycles),sources.readPaymentEvidence(ids)]);
  return rows.map(row => {
    const id = String(row.id), nextCycleAt = cycles.get(id) ?? null, cutoff = editCutoff(nextCycleAt,Number(row.edit_window_hours));
    if (row.configured_offer_version !== 'classic' && row.configured_offer_version !== 'sized.v1') throw new Error('subscription_edit_invalid_offer_binding');
    const items = lines.get(id) ?? [];
    const state = computeEditState({ subscriptionId: id,status: row.status as 'active',nextCycleAt,editCutoffAt: cutoff,
      paymentMethodKind: 'native',paymentMethodRefPresent: methods.get(id)?.healthState === 'healthy' },blockers,() => true);
    const templatePresent = items.some(line => !line.isAddon) && typeof row.price_list_id === 'string' && typeof row.currency_code === 'string';
    return { subscriptionId: id,status: String(row.status),cadenceDays: Number(row.cadence_days),nextCycleAt,editCutoffAt: cutoff,
      templateVersion: Number(row.template_version),compositionConstraint: isRecord(row.size_constraint) ? row.size_constraint : null,
      offerVersion: row.configured_offer_version,canEditUpcomingPackage: state.canEdit && templatePresent,
      editBlockedReason: state.reason ?? (templatePresent ? null : 'starter_subscription_template_unavailable'),
      recurringTotal: recurringPrice(items)?.totalGross ?? null,
      lines: items.map(line => ({ lineId: line.lineId,variantId: line.variantId,qty: line.qty,isAddon: line.isAddon,sortOrder: line.sortOrder,
        sku: line.sku,title: line.title,unitPrice: line.unitPrice ?? null,lineSubtotal: line.lineSubtotal ?? null })) };
  });
}

/** Session actor/client, command header and time never come from the editor's JSON. */
export function composeSubscriptionEditors(pool: Pool): ApplicationBindings['actions'] {
  const withConnection = async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => {
    const db = await pool.connect();
    try { return await work(db); } finally { db.release(); }
  };
  const owned = async (db: SubscriptionQueryExecutor, context: ActionContext, id: string,lock = false) => {
    const actor = context.actor;
    if (!actor.customerRef || !actor.principalRef) throw new Error('customer_session_required');
    const row = (await db.query(`SELECT s.configured_offer_version FROM public.subscriptions s JOIN public.clients c ON c.id=s.client_id
      WHERE s.id=$1::uuid AND s.client_id=$2::uuid AND c.principal_id=$3::uuid ${lock ? 'FOR UPDATE OF s' : ''}`, [id,actor.customerRef,actor.principalRef])).rows[0];
    if (!row) throw new Error('subscription_command_forbidden');
    if (row.configured_offer_version !== 'classic' && row.configured_offer_version !== 'sized.v1') throw new Error('subscription_edit_invalid_offer_binding');
    return row.configured_offer_version;
  };
  const compose = (db: SubscriptionQueryExecutor, context: ActionContext,id: string) => {
    const config = context.config, now = () => new Date().toISOString();
    const transaction = (classic: boolean) => async <T>(work: (connection: SubscriptionQueryExecutor) => Promise<T>) => {
      await db.query('BEGIN');
      try {
        // Dispatch can race an accepted opt-in. Check the branch under the apply connection's subscription lock.
        const binding = await owned(db,context,id,true);
        if (classic && binding !== 'classic') throw new Error('subscription_reprice_configured_offer_action_mismatch');
        const result = await work(db); await db.query('COMMIT'); return result;
      }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    };
    const ports = editorQuotePorts(db,config), values = config.subscriptionEditing;
    const classic = createPostgresPackageEditor({ ...ports,withTransaction: transaction(true),now,
      limits: { maximumPlanDays: Math.max(...values.planDays),maximumBaseLines: values.maximumBaseLines,
        maximumAddonLines: values.maximumAddonLines,maximumQuantity: values.maximumQuantity } });
    const sized = createPostgresSizedEditor({ ...sizedHostPorts(config,now),quotePort: ports.quotePort,policy: values.sized,withTransaction: transaction(false),now });
    const dispatched = createOfferDispatchedSubscriptionEditor({ classic,sized,
      readBinding: (_actor,id) => owned(db,context,id) });
    return { ...dispatched,sized,ports };
  };
  const actor = (context: ActionContext): PackageEditActor => ({ actorId: context.actor.principalRef!,clientId: context.actor.customerRef! });
  const execute = (phase: 'preview' | 'apply'): NonNullable<ApplicationBindings['actions']['subscription.command']> => async (payload,context) => {
    if (!context.actor.customerRef || !context.actor.principalRef) return refused('customer_session_required',403);
    if (Object.keys(payload).some(key => !['request','locale'].includes(key)) || !isRecord(payload.request) || !uuid(payload.request.subscriptionId)) return refused('starter_input_invalid',400);
    const request = payload.request;
    try {
      return await withConnection(async db => {
        await owned(db,context,request.subscriptionId as string);
        if (request.action === 'update_plan_length' || request.action === 'update_portion'
          || request.action === 'resize_bundle' && isRecord(request.resizeLever) && request.resizeLever.kind === 'portionMode') {
          return refused('starter_subscription_resize_unconfigured');
        }
        const editor = compose(db,context,request.subscriptionId as string);
        return success(phase === 'preview' ? await editor.preview(actor(context),request as { subscriptionId: string })
          : await editor.apply(actor(context),context.commandKey,request as { subscriptionId: string }));
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'subscription_command_forbidden') return refused(error.message,403);
      const mapped = mapSizedEditError(error,phase,typeof request.action === 'string' ? request.action : undefined);
      return refused(mapped.reason ?? (phase === 'preview' ? 'starter_subscription_preview_unavailable' : 'starter_subscription_save_unavailable'),mapped.status);
    }
  };
  return {
    'subscription.preview': execute('preview'),
    'subscription.command': execute('apply'),
    'subscription.catalog': async (payload,context) => {
      if (!context.actor.customerRef || !context.actor.principalRef) return refused('customer_session_required',403);
      if (!uuid(payload.subscriptionRef) || !['classic','sized'].includes(String(payload.mode))
        || payload.optIn !== undefined && typeof payload.optIn !== 'boolean'
        || Object.keys(payload).some(key => !['subscriptionRef','mode','optIn','locale'].includes(key))) return refused('starter_input_invalid',400);
      try {
        return await withConnection(async db => {
          const id = payload.subscriptionRef as string, binding = await owned(db,context,id), editor = compose(db,context,id);
          const products = editorProducts(context.config);
          const name = (sku: string) => products.find(product => product.sku === sku)?.name ?? { en: sku,pl: sku };
          if (payload.mode === 'classic') {
            if (binding !== 'classic') return refused('subscription_reprice_configured_offer_action_mismatch',400);
            const candidates: EditorCandidate[] = (await editor.ports.quoteCatalogReadPort.listQuoteCatalogItems())
              .filter(item => item.sellability.subscription && !item.isAddon).map(item => ({ variantId: item.variantId,sku: item.skuCode,
                groupId: products.find(product => product.sku === item.skuCode)?.groupKey ?? item.productSlug,name: name(item.skuCode),
                isAddon: false,sellable: true,selectable: true,physicalSize: item.netWeightG,demandPerUnit: 0,sellableNow: null }));
            return success({ candidates });
          }
          if (binding === 'classic' && payload.optIn !== true) return refused('subscription_reprice_configured_offer_action_mismatch',400);
          const result = await editor.sized.candidates(actor(context),id,payload.optIn === true);
          return success({ context: result.context,candidates: result.catalog.map(item => ({ ...item,name: name(item.sku) })) });
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'subscription_command_forbidden') return refused(error.message,403);
        const mapped = mapSizedEditError(error,'preview'); return refused(mapped.reason ?? 'starter_subscription_catalog_unavailable',mapped.status);
      }
    },
  };
}
