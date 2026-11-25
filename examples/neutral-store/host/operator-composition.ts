import { z } from 'zod';
import { clearTimeout, setTimeout } from 'node:timers';
import { createPostgresCustomerSupportJourneyPort } from '@openlup/platform/account-support/postgres';
import { createPostgresBundleCatalogStore, createPostgresBundleAdminWriteStore,
  createPostgresCatalogDraftStoreV3, createCatalogDraftHandlerV3, createCatalogCandidateServiceWithPublication, CatalogCandidateError, BundleRpcError,
  buildCatalogReleaseDraftV3, evaluateBundleComposition, createPostgresCatalogPublicationCommands, createPostgresCatalogPublicationReads,
  type CatalogHeadRef, type CatalogPublicationCommand, type CatalogPublicationFailure, type CatalogDraftPayloadV3, type CatalogProductTypeRef } from '@openlup/platform/catalog';
import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from '@openlup/platform/data';
import { CATALOG_PRICE_SETUP_MAX_MINOR, catalogPriceSetupExpectedSchema, createCatalogPriceSetupHandler, createPostgresCatalogPriceSetupStore,
  deriveSubscriptionUnitPrice } from '@openlup/platform/pricing';
import { installationFinding } from '../shared/refusals.ts';
import { isRecord } from '../shared/offer.ts';
import { verifyStarterMedia } from './catalogue-media.ts';
import type { ActionBinding, ActionContext, ApplicationBindings } from './bindings.ts';
import { missingPackBuild, starterCatalogue, starterCatalogueType } from './editor-catalogue.ts';
import { demonstrationMarkerQuery, isDemonstrationMarker } from './demonstration-marker.ts';
import { catalogueFailedJobFilter } from './catalogue-readiness-jobs.ts';

const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
function publicationRefused({ reason: code, message, path, subject }: CatalogPublicationFailure, failedJobs?: string[]) {
  return { ...refused(code), ...(message === undefined ? {} : { message }), ...(path === undefined ? {} : { path }),
    ...(subject === undefined ? {} : { subject }),
    ...(code === 'publication_price_readiness' && subject !== undefined ? { reason: subject } : {}),
    ...(path === undefined ? {} : { issues: [{ code, path, message, subject, ...(failedJobs?.length ? { failedJobs } : {}) }] }) };
}

async function watchdogFailureEvidence(
  lane: PostgresRoleFreeTransactionLane<PgQueryExecutor>, filter: ReturnType<typeof catalogueFailedJobFilter>,
) {
  let deadline: NodeJS.Timeout | undefined;
  let expired = false;
  try {
    return await Promise.race([
      lane.run(async db => {
        if (expired) return;
        await db.query("SET LOCAL statement_timeout = '500ms'");
        await db.query("SET LOCAL lock_timeout = '500ms'");
        if (expired) return;
        const { rows } = await db.query(`SELECT r.metadata->'failedJobs' AS jobs FROM public.platform_job_controls c
          JOIN public.platform_job_runs r ON (r.id,r.job_name)=(c.last_run_id,c.job_name)
          WHERE c.job_name='platform-watchdog' AND c.enabled AND c.last_status='success'
            AND c.metadata->>'health'='degraded' AND c.metadata->'promotionReady'='false'::jsonb
            AND c.last_success_at BETWEEN statement_timestamp()-interval '6 hours' AND statement_timestamp()
            AND r.status='success' AND r.finished_at=c.last_success_at AND r.driver='scheduler'
            AND r.metadata->>'invocationSource'='starter-catalogue'`);
        const jobs = rows[0]?.jobs;
        return Array.isArray(jobs) && jobs.every(name => typeof name === 'string') ? filter(jobs) : [];
      }),
      new Promise<undefined>(resolve => {
        deadline = setTimeout(() => { expired = true; resolve(undefined); }, 500);
      }),
    ]);
  } catch { return undefined; }
  finally { clearTimeout(deadline); }
}
const text = (value: unknown, max = 200): value is string => typeof value === 'string'
  && value.trim() === value && value.length > 0 && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const publicationProductId = z.guid().refine(value => value === value.toLowerCase());
const revision = z.int().min(1).max(2_147_483_647);
const headPin = z.strictObject({ publicationId: publicationProductId, revision,
  documentDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).nullable();
const only = (payload: Record<string, unknown>, keys: string[]) =>
  Object.keys(payload).every(key => key === 'locale' || keys.includes(key));

type PublicationLane = PostgresRoleFreeTransactionLane<PgQueryExecutor>;
type OperatorTransaction = <T>(actorId: string, work: (db: PgQueryExecutor) => Promise<T>) => Promise<T>;
const policySchema = z.object({ revisionId: publicationProductId, discountBps: z.int().min(0).max(10_000),
  roundingQuantumMinor: z.int().min(1).max(CATALOG_PRICE_SETUP_MAX_MINOR), roundingRule: z.literal('FLOOR_TO_QUANTUM') });
const priceIdentifiers = { variantId: publicationProductId, priceListId: publicationProductId };
const priceAmount = z.int().min(1).max(CATALOG_PRICE_SETUP_MAX_MINOR);
const priceAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('price-target') }),
  z.strictObject({ action: z.literal('price-preview'), ...priceIdentifiers, unitPriceMinor: priceAmount.optional() }),
  z.strictObject({ action: z.literal('price-apply'), ...priceIdentifiers,
    policyRevisionId: publicationProductId, unitPriceMinor: priceAmount, expected: catalogPriceSetupExpectedSchema.optional() }),
]);

async function effectivePriceTarget(lane: PublicationLane, marketCurrency: string) {
  const { rows: [target] } = await lane.run(async db => {
    await db.query('SET TRANSACTION READ ONLY');
    return db.query(`WITH list AS (
      SELECT id, region_code, currency, amount_basis FROM public.price_lists
      WHERE region_code=public.catalog_price_setup_region_code() AND currency=public.catalog_price_setup_settlement_currency()
        AND status='active' AND valid_from<=statement_timestamp() AND (valid_to IS NULL OR valid_to>statement_timestamp())
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) SELECT l.id AS "priceListId", l.currency, l.amount_basis AS basis, p.policies, p.valid FROM list l
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('revisionId', p.id, 'discountBps', p.discount_bps,
        'roundingQuantumMinor', p.rounding_quantum_minor, 'roundingRule', p.rounding_rule))
        AS policies, bool_and(p.digest=public.catalog_price_setup_policy_digest(
          p.id,p.revision_no,p.price_list_id,p.region_code,p.currency,p.channel,p.effective_from,
          CASE WHEN p.closed_from_open THEN NULL ELSE p.effective_to END,p.discount_bps,p.rounding_quantum_minor,p.rounding_rule)) AS valid
      FROM public.subscription_price_policy_revisions p
      WHERE (p.price_list_id,p.region_code,p.currency)=(l.id,l.region_code,l.currency) AND p.channel='D2C'
        AND p.effective_from<=statement_timestamp() AND (p.effective_to IS NULL OR p.effective_to>statement_timestamp())
    ) p`);
  });
  const priceListId = publicationProductId.safeParse(target?.priceListId).data;
  if (!priceListId || typeof target?.currency !== 'string') return refused('price_list_not_active');
  if (target.currency !== marketCurrency) return refused('starter_catalogue_currency_mismatch');
  if (target.basis === 'tax_exclusive') return refused('catalog_price_setup_basis_mismatch');
  const policies = z.array(policySchema).length(1).safeParse(target.policies).data;
  if (!policies || target.valid !== true) return refused('starter_catalogue_d2c_policy_required');
  return { ok: true as const, priceListId, currency: target.currency, policy: policies[0]! };
}

async function cataloguePrice(payload: Record<string, unknown>, context: ActionContext, actorId: string,
  lane: PublicationLane, asOperator?: OperatorTransaction): Promise<Awaited<ReturnType<ActionBinding>>> {
  const { locale: _locale, ...request } = payload;
  const parsed = priceAction.safeParse(request);
  if (!parsed.success) return refused('starter_input_invalid');
  if (!asOperator) return refused('host_binding_required');
  const input = parsed.data;
  const target = await effectivePriceTarget(lane, context.config.market.currency);
  if (!target.ok) return target;
  const { priceListId, currency, policy } = target;
  if (input.action === 'price-target') return success({ actorId, priceListId, currency, policy });
  const query = { variantId: input.variantId, priceListId: input.priceListId };
  if (input.action === 'price-apply' && query.priceListId !== priceListId) return refused('price_list_not_active');
  return asOperator(actorId, async db => {
    const handler = createCatalogPriceSetupHandler({ store: createPostgresCatalogPriceSetupStore(db),
      authorizeOperator: async () => ({ actorId }) });
    const priceSetup = await handler.preview(input.action === 'price-preview' && input.unitPriceMinor !== undefined
      ? { ...query, unitPriceMinor: input.unitPriceMinor } : query, context);
    if ('reason' in priceSetup) return { ...refused(priceSetup.reason), ...(priceSetup.reasons && {
      issues: priceSetup.reasons.map(code => ({ code, path: 'basePrices' })),
    }) };
    if (input.action === 'price-preview') return success({ listEffective: query.priceListId === priceListId, currency, priceSetup });
    if (typeof input.expected?.entryId === 'string' && priceSetup.inGate !== true)
      return refused('starter_catalogue_reprice_requires_active');
    const subscription = priceSetup.subscription;
    if (subscription.kind !== 'derived' || subscription.revisionId !== input.policyRevisionId)
      return refused('starter_catalogue_d2c_policy_required');
    if (deriveSubscriptionUnitPrice(input.unitPriceMinor, { ...subscription, roundingRule: 'FLOOR_TO_QUANTUM' }) <= 0)
      return refused('starter_catalogue_derived_price_zero');
    const result = await handler.apply({ ...query, schemaVersion: 1, commandKey: context.commandKey,
      mode: 'one_time', minQty: 1, amountKind: 'gross', unitPriceMinor: input.unitPriceMinor,
      expected: input.expected ?? { entryId: null, unitPriceMinor: null } }, context);
    if ('reason' in result) return { ...refused(result.reason), ...(result.reasons && {
      issues: result.reasons.map(code => ({ code, path: 'basePrices' })),
    }) };
    return { ...success({ currency, ...result }), ...(result.outcome === 'replayed' ? { replayed: true } : {}) };
  });
}

function publicationExample(type: CatalogProductTypeRef): CatalogDraftPayloadV3 {
  const title = 'Fictional item';
  return buildCatalogReleaseDraftV3({ namespace: 'starter', type: { key: type.key, version: type.version },
    slug: 'fictional-item', name: title, presentation: { title }, skus: [
      { code: 'STARTER-EXAMPLE', title, options: {}, netContent: { dimension: 'mass', unit: 'openlup:g', unscaled: '100', scale: 0 },
        identifiers: [{ scheme: 'gs1:gtin', issuer: 'starter:example', value: '5901234123457', packagingLevel: 'unit' }],
        sell: { oneTime: true, subscription: false } },
    ] }).release.payload;
}

/** Operator identity is established by native request authentication before dispatch. */
export function composeOperatorCapabilities(input: {
  executor: PgQueryExecutor; connectionString: string; publication?: PublicationLane | undefined;
  asOperator?: OperatorTransaction;
  watchdogEvidence?: PostgresRoleFreeTransactionLane<PgQueryExecutor> | undefined;
}):
Pick<ApplicationBindings, 'actions' | 'close'> {
  const catalogue = starterCatalogue();
  function registerBuildCheck(context: ActionContext, ref: unknown) {
    context.registerCatalogueBuildCheck?.(() => {
      const found = catalogue.lookupBuild(ref);
      return found.outcome === 'missing' ? installationFinding(missingPackBuild(found.pair, found.path)) : undefined;
    });
  }
  const current = catalogue.current;
  const installed = current && catalogue.readInstalled(current)?.type;
  const rulesVersionIssue = (version: number) => ({ path: 'product.type', code: 'type_not_installed',
    message: `rules version ${version} is not installed; run ./lifecycle up` });
  const catalog = createPostgresBundleCatalogStore(input.executor);
  const writer = createPostgresBundleAdminWriteStore({ connectionString: input.connectionString });
  const drafts = createCatalogDraftHandlerV3<ActionContext>({
    store: createPostgresCatalogDraftStoreV3(input.executor),
    registry: catalogue.registry,
    authorizeOperator: async context => context.actor.operatorRef ? { actorId: context.actor.operatorRef } : null,
  });
  const actions: ApplicationBindings['actions'] = {};
  // Native request authentication has already verified the operator session and active admin membership.
  const authorizeHuman = async ({ actor }: ActionContext) => actor.operatorRef && actor.sessionToken
    ? { ok: true as const, userId: actor.operatorRef, role: 'admin', isMachineActor: false } : { ok: false as const };
  const publicationLane = input.publication;
  const commands = publicationLane && createPostgresCatalogPublicationCommands({
    catalogPublicationOwner: publicationLane, authorizeHuman, registry: catalogue.registry,
    verifyMedia: (_db, claim) => verifyStarterMedia(claim),
  });
  const publication = input.publication && createPostgresCatalogPublicationReads({ transactions: input.publication, authorizeHuman });
  const filterFailedJobs = catalogueFailedJobFilter();
  if (publicationLane) actions['catalogue.demoTarget'] = (payload, context) => {
    if (Object.keys(payload).length !== 0) return Promise.resolve(refused('starter_input_invalid'));
    return publicationLane.run(async db => {
      await db.query('SET TRANSACTION READ ONLY');
      await db.query("SET LOCAL statement_timeout = '1s'");
      const { rows: [result] } = await db.query(demonstrationMarkerQuery);
      return success({ marked: isDemonstrationMarker(result?.marker), configurationId: context.config.id });
    });
  };
  if (commands && publication && publicationLane) actions['operator.catalogPublication'] = async (payload, context) => {
    const human = await authorizeHuman(context);
    if (!human.ok) return refused('operator_required');
    if (typeof payload.action === 'string' && payload.action.startsWith('price-'))
      return cataloguePrice(payload, context, human.userId, publicationLane, input.asOperator);
    if (payload.action === 'approve' || payload.action === 'publish') {
      const { locale: _locale, ...command } = payload;
      if (Object.hasOwn(command, 'commandKey')) return refused('starter_input_invalid');
      const capability = await commands.authorize(context);
      if (!capability) return refused('operator_required');
      // The native runner strictly parses the command after attaching the transport key.
      const result = await commands.execute({ ...command, commandKey: context.commandKey } as CatalogPublicationCommand, capability);
      if ('reason' in result) return publicationRefused(result, payload.action === 'publish'
        && result.reason === 'publication_price_readiness' && result.subject === 'promotion_watchdog_not_ready' && input.watchdogEvidence
        ? await watchdogFailureEvidence(input.watchdogEvidence, filterFailedJobs) : undefined);
      return { ...success(result), ...(result.outcome === 'replayed' ? { replayed: true } : {}) };
    }
    const { action, head, commandKey, cursor = null } = payload;
    if (cursor !== null && typeof cursor !== 'string') return refused('starter_input_invalid');
    if (action === 'exact' && only(payload, ['action', 'head', 'cursor']) && isRecord(head)) {
      const result = await publication.readbackV2(head as unknown as Parameters<typeof publication.readbackV2>[0], cursor);
      return 'reason' in result ? publicationRefused(result) : success(result);
    }
    const productId = publicationProductId.safeParse(payload.productId).data;
    if (!productId) return refused('starter_input_invalid');
    if (action === 'receipt' && only(payload, ['action', 'productId', 'commandKey']) && text(commandKey)) {
      const capability = await publication.authorize(context);
      if (!capability) return refused('operator_required');
      const result = await publication.receipt({ productId, commandKey }, capability);
      return 'reason' in result ? publicationRefused(result) : success(result);
    }
    const result = action === 'current' && only(payload, ['action', 'productId']) ? await publication.reads.current(productId)
      : action === 'history' && only(payload, ['action', 'productId', 'cursor']) ? await publication.reads.history(productId, cursor) : null;
    return result ? ('reason' in result ? publicationRefused(result) : success(result)) : refused('starter_input_invalid');
  };
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
          const components: { sku: string; quantity: number; isAddon: boolean; sortOrder: number }[] = [];
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
    const fields = payload.action === undefined ? [] : payload.action === 'example' ? ['action'] : payload.action === 'get'
      ? ['action', 'draftId', 'revision'] : ['action', 'draftId', 'expectedRevision', payload.action === 'prepare' ? 'expectedHead' : 'payload'];
    if (!only(payload, fields)) return refused('starter_input_invalid');
    if (payload.action === 'example') {
      if (installed) return success(publicationExample(installed));
      return { ...refused('starter_catalogue_rules_required'), ...(current ? { issues: [rulesVersionIssue(current.version)] } : {}) };
    }
    if (payload.action === 'prepare') {
      const draftId = publicationProductId.safeParse(payload.draftId).data;
      const draftRevision = revision.safeParse(payload.expectedRevision).data;
      const pin = Object.hasOwn(payload, 'expectedHead') ? headPin.safeParse(payload.expectedHead) : undefined;
      if (!draftId || draftRevision === undefined || pin?.success === false)
        return refused('starter_input_invalid');
      if (commands && publicationLane) {
        const capability = await commands.authorize(context);
        if (!capability) return refused('operator_required');
        const saved = await drafts.get({ draftId, revision: draftRevision }, context);
        if ('reason' in saved) return publicationRefused(saved);
        if (!saved.record) return refused('draft_not_found');
        registerBuildCheck(context, saved.record.payload.product.type);
        const { productId } = saved.record;
        // The native candidate runner decides whether the draft can repair live drift.
        const { rows: [lineage] } = await publicationLane.run(db => db.query(`SELECT
          (SELECT public.catalog_publication_head_ref(product_id,publication_id)
            FROM public.catalog_publication_heads WHERE product_id=$1) AS head,
          EXISTS (SELECT 1 FROM public.catalog_products WHERE id=$1) AS live,
          public.catalog_publication_assert_head($1,false)`, [productId]));
        if (!lineage || (lineage.head === null && lineage.live !== false)) return refused('catalog_publication_lineage_unknown');
        const expectedHead = pin ? pin.data : lineage.head as CatalogHeadRef | null;
        const preview = await commands.prepareCandidate({ draftId, draftRevision, expectedHead }, capability);
        return 'reason' in preview ? publicationRefused(preview) : success({ ...preview, expectedHead });
      }
      if (pin) return refused('host_binding_required');
      let rulesVersion: number | undefined;
      const service = createCatalogCandidateServiceWithPublication({ registry: catalogue.registry,
        async readDraft(draftId, revision) {
          const result = await drafts.get({ draftId, ...(revision === undefined ? {} : { revision }) }, context);
          const record = 'record' in result ? result.record : null;
          if (revision !== undefined && record?.payload.product.type.key === starterCatalogueType.key)
            rulesVersion = record.payload.product.type.version;
          if (revision !== undefined && record) registerBuildCheck(context, record.payload.product.type);
          return record;
        },
        installedDefinitionDigest: async ref => catalogue.readInstalled(ref)?.digest ?? null,
        async currentHead() { return { outcome: 'unsupported', reason: 'publication_not_supported' }; },
        async resolveHead() { return null; },
      }, { async readEvidence() { return null; } });
      try {
        const preview = await service.prepareCandidate({ draftId, draftRevision, expectedHead: null });
        return success(preview.preparation ?? { structural: { outcome: 'unknown', issues: preview.issues } });
      } catch (error) {
        if (error instanceof CatalogCandidateError)
          return { ...refused(error.code), ...(error.code === 'catalog_definition_drift' && rulesVersion !== undefined && rulesVersion > 1
            ? { issues: [rulesVersionIssue(rulesVersion)] } : {}) };
        throw error;
      }
    }
    let authored = payload.payload;
    if (current && isRecord(authored) && isRecord(authored.product) && isRecord(authored.product.type)
      && authored.product.type.key === current.key && authored.product.type.version === starterCatalogueType.version && uuid(payload.draftId)) {
      // Old forms used a placeholder. Reconstruct the submitted command using
      // its authorized receipt pin before the handler checks its fingerprint.
      const receipt = await drafts.get({ draftId: payload.draftId, commandKey: context.commandKey }, context);
      const original = 'record' in receipt && receipt.record?.actorId === context.actor.operatorRef ? receipt.record : null;
      const saved = !original && payload.action === 'revise' ? await drafts.get({ draftId: payload.draftId, revision: payload.expectedRevision }, context) : null;
      const pin = original?.payload.product.type ?? (saved && 'record' in saved ? saved.record?.payload.product.type : undefined);
      authored = { ...authored, product: { ...authored.product, type: { ...authored.product.type, version: pin?.version ?? current.version } } };
    }
    const result = payload.action === undefined ? await drafts.list({ limit: 30 }, context)
      : payload.action === 'get' ? await drafts.get({ draftId: payload.draftId,
        ...(Object.hasOwn(payload, 'revision') && { revision: payload.revision }) }, context)
        : await drafts.execute({ schemaVersion: isRecord(authored) && [2, 3].includes(Number(authored.schemaVersion)) ? authored.schemaVersion : 1,
          action: payload.action, draftId: payload.draftId,
          expectedRevision: payload.expectedRevision, ...(authored === undefined ? {} : { payload: authored }),
          commandKey: context.commandKey }, context);
    if ('reason' in result) {
      const issues = 'issues' in result && Array.isArray(result.issues) ? result.issues : [];
      const type = isRecord(authored) && isRecord(authored.product) && isRecord(authored.product.type) ? authored.product.type : undefined;
      if (result.reason === 'draft_dependency_unavailable') registerBuildCheck(context, type);
      const detail = issues.map(issue => issue.code === 'type_not_installed' && type && Number.isSafeInteger(type.version)
        ? { ...issue, ...rulesVersionIssue(Number(type.version)) } : issue);
      return { ...refused(`catalog_${result.reason}`), ...(detail.length ? { issues: detail } : {}) };
    }
    return { ...success(result), ...(result.outcome === 'replayed' ? { replayed: true } : {}) };
  };
  return { actions, close: () => writer.close() };
}
