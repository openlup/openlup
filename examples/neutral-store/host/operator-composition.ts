import { z } from 'zod';
import { createPostgresCustomerSupportJourneyPort } from '@openlup/platform/account-support/postgres';
import { createPostgresBundleCatalogStore, createPostgresBundleAdminWriteStore,
  createPostgresCatalogDraftStoreV3, createCatalogDraftHandlerV3, createCatalogCandidateServiceWithPublication, CatalogCandidateError, BundleRpcError,
  buildCatalogReleaseDraftV3, evaluateBundleComposition, createPostgresCatalogPublicationCommands, createPostgresCatalogPublicationReads,
  type CatalogHeadRef, type CatalogPublicationCommand, type CatalogPublicationFailure, type CatalogDraftPayloadV3, type CatalogProductTypeRef } from '@openlup/platform/catalog';
import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from '@openlup/platform/data';
import { starterCatalogue, starterCatalogueType } from './editor-catalogue.ts';
import { isRecord } from '../shared/offer.ts';
import type { ActionBinding, ActionContext, ApplicationBindings } from './bindings.ts';

const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
function publicationRefused({ reason: code, message, path, subject }: CatalogPublicationFailure) {
  return { ...refused(code), ...(message === undefined ? {} : { message }), ...(path === undefined ? {} : { path }),
    ...(subject === undefined ? {} : { subject }), ...(path === undefined ? {} : { issues: [{ code, path, message, subject }] }) };
}
const text = (value: unknown, max = 200): value is string => typeof value === 'string'
  && value.trim() === value && value.length > 0 && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const publicationProductId = z.guid().refine(value => value === value.toLowerCase());
const only = (payload: Record<string, unknown>, keys: string[]) =>
  Object.keys(payload).every(key => key === 'locale' || keys.includes(key));

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
  executor: PgQueryExecutor; connectionString: string; publication?: PostgresRoleFreeTransactionLane<PgQueryExecutor> | undefined;
}):
Pick<ApplicationBindings, 'actions' | 'close'> {
  const catalogue = starterCatalogue();
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
  });
  const publication = input.publication && createPostgresCatalogPublicationReads({ transactions: input.publication, authorizeHuman });
  if (commands && publication) actions['operator.catalogPublication'] = async (payload, context) => {
    if (!(await authorizeHuman(context)).ok) return refused('operator_required');
    if (payload.action === 'approve' || payload.action === 'publish') {
      const { locale: _locale, ...command } = payload;
      if (Object.hasOwn(command, 'commandKey')) return refused('starter_input_invalid');
      const capability = await commands.authorize(context);
      if (!capability) return refused('operator_required');
      // The native runner strictly parses the command after attaching the transport key.
      const result = await commands.execute({ ...command, commandKey: context.commandKey } as CatalogPublicationCommand, capability);
      return 'reason' in result ? publicationRefused(result) : { ...success(result), ...(result.outcome === 'replayed' ? { replayed: true } : {}) };
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
    const fields = payload.action === undefined ? [] : payload.action === 'example' ? ['action'] : payload.action === 'get' ? ['action', 'draftId']
      : ['action', 'draftId', 'expectedRevision', 'payload'];
    if (!only(payload, fields)) return refused('starter_input_invalid');
    if (payload.action === 'example') {
      if (installed) return success(publicationExample(installed));
      return { ...refused('starter_catalogue_rules_required'), ...(current ? { issues: [rulesVersionIssue(current.version)] } : {}) };
    }
    if (payload.action === 'prepare') {
      if (!uuid(payload.draftId) || !Number.isSafeInteger(payload.expectedRevision) || Number(payload.expectedRevision) < 1 || 'payload' in payload)
        return refused('starter_input_invalid');
      if (commands && publicationLane) {
        const capability = await commands.authorize(context);
        if (!capability) return refused('operator_required');
        const draftRevision = Number(payload.expectedRevision);
        const saved = await drafts.get({ draftId: payload.draftId, revision: draftRevision }, context);
        if ('reason' in saved) return publicationRefused(saved);
        if (!saved.record) return refused('draft_not_found');
        const { productId } = saved.record;
        // The native candidate runner decides whether the draft can repair live drift.
        const { rows: [lineage] } = await publicationLane.run(db => db.query(`SELECT
          (SELECT public.catalog_publication_head_ref(product_id,publication_id)
            FROM public.catalog_publication_heads WHERE product_id=$1) AS head,
          EXISTS (SELECT 1 FROM public.catalog_products WHERE id=$1) AS live,
          public.catalog_publication_assert_head($1,false)`, [productId]));
        if (!lineage || (lineage.head === null && lineage.live !== false)) return refused('catalog_publication_lineage_unknown');
        const expectedHead = lineage.head as CatalogHeadRef | null;
        const preview = await commands.prepareCandidate({ draftId: payload.draftId, draftRevision, expectedHead }, capability);
        return 'reason' in preview ? publicationRefused(preview) : success({ ...preview, expectedHead });
      }
      let rulesVersion: number | undefined;
      const service = createCatalogCandidateServiceWithPublication({ registry: catalogue.registry,
        async readDraft(draftId, revision) {
          const result = await drafts.get({ draftId, ...(revision === undefined ? {} : { revision }) }, context);
          const record = 'record' in result ? result.record : null;
          if (revision !== undefined && record?.payload.product.type.key === starterCatalogueType.key)
            rulesVersion = record.payload.product.type.version;
          return record;
        },
        installedDefinitionDigest: async ref => catalogue.readInstalled(ref)?.digest ?? null,
        async currentHead() { return { outcome: 'unsupported', reason: 'publication_not_supported' }; },
        async resolveHead() { return null; },
      }, { async readEvidence() { return null; } });
      try {
        const preview = await service.prepareCandidate({ draftId: payload.draftId, draftRevision: Number(payload.expectedRevision), expectedHead: null });
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
      : payload.action === 'get' ? await drafts.get({ draftId: payload.draftId }, context)
        : await drafts.execute({ schemaVersion: isRecord(authored) && [2, 3].includes(Number(authored.schemaVersion)) ? authored.schemaVersion : 1,
          action: payload.action, draftId: payload.draftId,
          expectedRevision: payload.expectedRevision, ...(authored === undefined ? {} : { payload: authored }),
          commandKey: context.commandKey }, context);
    if ('reason' in result) {
      const issues = 'issues' in result && Array.isArray(result.issues) ? result.issues : [];
      const type = isRecord(authored) && isRecord(authored.product) && isRecord(authored.product.type) ? authored.product.type : undefined;
      const detail = issues.map(issue => issue.code === 'type_not_installed' && type && Number.isSafeInteger(type.version)
        ? { ...issue, ...rulesVersionIssue(Number(type.version)) } : issue);
      return { ...refused(`catalog_${result.reason}`), ...(detail.length ? { issues: detail } : {}) };
    }
    return { ...success(result), ...(result.outcome === 'replayed' ? { replayed: true } : {}) };
  };
  return { actions, close: () => writer.close() };
}
