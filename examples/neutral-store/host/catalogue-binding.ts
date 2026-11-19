import { buildCatalogAdmissionFromServing, createCatalogRuntimeBinding, createPostgresCatalogAdmission, hasInstalledSubscriptionProfile,
  createCatalogDraftHandlerV5, createPostgresCatalogDraftStoreV5, createPostgresCatalogAdoption, createPostgresCatalogPublication, observeCatalogSubscriptionCadenceBound,
  observePostgresCatalogPrivileges, type CatalogAdmissionPort, type CatalogPublicationDependencies,
  type CatalogRuntimeObservation, type CatalogServingReadPortV2, type NeutralSkuEnvelopeV2 } from '@openlup/platform/catalog';
import type { CatalogAdmissionInput, CatalogAcceptedReferenceV2 } from '@openlup/platform/catalog/contracts';
import type { PgQueryExecutor } from '@openlup/platform/data';
import { createCatalogSubscriptionProfileBinding, type CatalogProfileLine, type CatalogSubscriptionPolicyBinding,
  type CatalogSubscriptionProfileSelection, type SizedCatalogFact, type createPostgresSuccessorStore } from '@openlup/platform/subscriptions';
import { CommerceQuoteCatalogReadError, type CommerceQuoteCatalogItemV2, type CreateQuoteResponse } from '@openlup/platform/pricing';
import type { ActionContext, ApplicationBindings } from './bindings.ts';
import type { StarterCatalogueSelection } from './catalogue-selection.ts';
import { choices } from '../shared/subscription-offer.ts';
import { isRecord } from '../shared/offer.ts';
import { bindStockWaitReads } from './stock-wait-reads.ts';

type Publication = ReturnType<typeof createPostgresCatalogPublication<ActionContext>>;
type Adoption = ReturnType<typeof createPostgresCatalogAdoption<ActionContext>>;
type Drafts = ReturnType<typeof createCatalogDraftHandlerV5<ActionContext>>;
type Successor = ReturnType<typeof createPostgresSuccessorStore>;
type Observe = () => Promise<CatalogRuntimeObservation>;

export interface StarterCatalogueOptions {
  registration: StarterCatalogueSelection;
  readEnabled(): boolean;
  writerEnabled(): boolean;
  observePublication?(db: PgQueryExecutor): Promise<boolean>;
  publication: Omit<CatalogPublicationDependencies<ActionContext>, 'registry' | 'authorizeHuman' | 'subscriptionProfiles'>;
  adoptionTransaction?: Parameters<typeof createPostgresCatalogAdoption<ActionContext>>[0]['transaction'];
  successor?: Successor;
  profilePolicies?: readonly CatalogSubscriptionPolicyBinding[];
  profileLine?(line: CatalogProfileLine, item: CommerceQuoteCatalogItemV2): Pick<CatalogProfileLine, 'demand' | 'swapGroupKey'>;
  sizedFacts?(item: NeutralSkuEnvelopeV2): Pick<SizedCatalogFact, 'physicalSize' | 'demandPerUnit' | 'exclusions'>;
}

export interface StarterCatalogueQuoteBinding {
  serving: Pick<CatalogServingReadPortV2, 'listQuoteCatalogItems' | 'listEditorSkus'>;
  offerVersion: string;
  admission: CatalogAdmissionPort;
  sizedFacts?: StarterCatalogueOptions['sizedFacts'];
  buildAdmission(quote: CreateQuoteResponse, roster: readonly CommerceQuoteCatalogItemV2[],
    input: Pick<CatalogAdmissionInput, 'mode' | 'purpose' | 'offerEvidence'> & { cadenceDays: number | null }): Promise<CatalogAdmissionInput>;
}

const state = (state: CatalogRuntimeObservation['state']): CatalogRuntimeObservation =>
  ({ schemaCompatible: state !== 'unsupported', privilegeGranted: state !== 'unsupported', state });
const refused = (code: string) => ({ ok: false as const, code });
const success = (value: unknown) => ({ ok: true as const, value });
const operations = {
  shopper: ['offer.validate', 'checkout.create'],
  settlement: ['checkout.read', 'checkout.tokenPay', 'checkout.inlineRetry', 'checkout.payment', 'checkout.paymentLink', 'payment.simulate', 'payment.recover', 'checkout.recovery'],
  account: ['account.read', 'account.orders'],
  editor: ['subscription.catalog', 'subscription.preview', 'subscription.command'],
} as const;

export class StarterCatalogueRefusal extends Error {}

export function bindStarterCatalogue(input: {
  options: StarterCatalogueOptions;
  db: PgQueryExecutor;
  actions: ApplicationBindings['actions'];
  authorizeHuman: CatalogPublicationDependencies<ActionContext>['authorizeHuman'];
}) {
  const { db, options } = input;
  const { registration, readEnabled, writerEnabled } = options;
  if (!registration.pack || !registration.scope) throw new Error('starter_catalogue_registration_invalid');
  const { scope, types } = registration;
  const config = registration.configuration;
  const profiles = createCatalogSubscriptionProfileBinding({ profiles: registration.pack.subscriptionProfileDefinitions ?? [],
    ...(options.profilePolicies ? { policies: options.profilePolicies } : {}) });
  const publisher = createPostgresCatalogPublication({ ...options.publication, registry: types, authorizeHuman: input.authorizeHuman, subscriptionProfiles: profiles });
  const serving = publisher.serving(scope);
  const adoption = options.adoptionTransaction && createPostgresCatalogAdoption({
    authorizeHuman: input.authorizeHuman, transaction: options.adoptionTransaction,
  });
  const drafts = createCatalogDraftHandlerV5({ store: createPostgresCatalogDraftStoreV5(db), registry: types,
    authorizeOperator: async (context: ActionContext) => {
      const actor = await input.authorizeHuman(context);
      return actor.ok && actor.role === 'admin' && actor.isMachineActor === false ? { actorId: actor.userId } : null;
    },
  });
  Object.assign(input.actions, bindStockWaitReads(options, input.authorizeHuman));
  return bindCataloguePorts({ serving, publisher, adoption, drafts, successor: options.successor, readEnabled, writerEnabled,
    actions: input.actions, configId: config.id,
    observeRead: async () => {
      try {
        const installed = await options.publication.transactions.run(async executor => {
          const { rows } = await executor.query(`SELECT has_schema_privilege('public','USAGE')
            AND has_table_privilege(to_regclass('public.catalog_publication_heads'),'SELECT') AS ready`);
          return rows[0]?.ready === true;
        });
        if (!installed) return state('unsupported');
        await serving.list({ cursor: null, limit: 1 });
        return state('ready');
      }
      catch (error) {
        if (error instanceof CommerceQuoteCatalogReadError && error.code === 'catalog_authority_unsupported') return state('unadopted');
        return state('dependency_unavailable');
      }
    },
    observeWriter: () => options.publication.transactions.run(async executor => {
      const ready = await observePostgresCatalogPrivileges(executor, {
        columns: [{ relation: 'public.catalog_publications', column: 'source_kind' }],
        functions: ['public.platform_human_membership_is_administrator(uuid)',
          ...(options.publication.bindHumanTransaction ? ['public.catalog_price_setup_require_human_admin()',
            'public.catalog_publication_sku_reasons(uuid,boolean)', 'public.commerce_offer_policy_v2_readiness()'] : [])],
      });
      if (!ready) return state('unsupported');
      const { rows } = await executor.query(`SELECT
        has_table_privilege('public.catalog_publications','INSERT')
        AND has_table_privilege('public.catalog_products','INSERT')
        AND has_table_privilege('public.catalog_products','UPDATE')
        AND has_table_privilege('public.catalog_publication_heads','INSERT')
        AND has_table_privilege('public.catalog_operator_receipts','INSERT') AS ready`);
      const installed = rows[0]?.ready === true && (await options.observePublication?.(executor) ?? true);
      return state(installed ? 'ready' : 'unsupported');
    }),
    observeAdmission: async () => state(await observePostgresCatalogPrivileges(db, { functions: [
      'public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text)',
    ] }) ? 'ready' : 'unsupported'),
    observeSettlement: async () => state(await observePostgresCatalogPrivileges(db, { functions: [
      'public.commerce_open_settlement_intent(text,uuid,text,bigint,text,jsonb,timestamp with time zone)',
    ], columns: [
      { relation: 'public.commerce_orders', column: 'catalog_acceptance' },
    ] }) ? 'ready' : 'unsupported'),
    observeAccount: async () => state(await observePostgresCatalogPrivileges(db, { columns: [
      { relation: 'public.subscription_renewal_terms', column: 'catalog_acceptance' },
    ] }) ? 'ready' : 'unsupported'),
    observeSuccessor: async () => state(await observePostgresCatalogPrivileges(db, { functions: [
      'public.subscription_successor_proposal_offer_v2(uuid,uuid,jsonb,timestamp with time zone)',
      'public.subscription_successor_proposal_decide_v2(uuid,uuid,text,text,text,timestamp with time zone)',
    ], columns: [
      { relation: 'public.subscription_successor_proposals', column: 'preview' },
    ] }) ? 'ready' : 'unsupported'),
    observeProfiles: async () => {
      const selected = scope.types.flatMap(type => {
        const ref = types.resolve(type)?.subscriptionProfileRef;
        return ref ? [ref] : [];
      });
      if (!selected.length) return state('unsupported');
      const cadence = await observeCatalogSubscriptionCadenceBound(db);
      for (const ref of selected) {
        const profile = profiles.resolve(ref);
        if (!profile?.bound || cadence === null || profile.profile.allowedCadenceDays.some(days => days > cadence)
          || !await hasInstalledSubscriptionProfile(db, ref, profile)) return state('unsupported');
      }
      return state('ready');
    },
    quote: { serving, offerVersion: scope.offerVersion, admission: createPostgresCatalogAdmission(),
      ...(options.sizedFacts ? { sizedFacts: options.sizedFacts } : {}),
      async buildAdmission(quote, roster, purpose) {
        if (!await observePostgresCatalogPrivileges(db, { functions: [
          'public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text)',
        ] })) throw new StarterCatalogueRefusal('catalog_capability_unsupported');
        const lines = quote.quote.lines.map(line => {
          const item = roster.find(item => item.skuCode === line.sku);
          const facts = line.catalogFacts;
          if (!item || !facts || facts.skuId !== item.variantId || facts.documentRevisionId !== item.documentRevision.id
            || facts.documentDigest !== item.documentRevision.digest) throw new Error('catalog_authority_changed');
          const entryId = facts.version === 'catalog_facts_v2' ? facts.basePriceEntryId : facts.resolvedPriceEntryId;
          return { item, quantity: line.quantity, entryId };
        });
        let accepted = new Map<string, CatalogAcceptedReferenceV2>();
        if (purpose.mode === 'subscription') {
          const lineItems = lines.map(({ item, quantity }) => {
            const documentRevisionId = item.documentRevision.id;
            if (!documentRevisionId) throw new Error('catalog_authority_changed');
            const typeRef = item.acceptedReference.typeRef;
            const profileRef = types.resolve(typeRef)?.subscriptionProfileRef;
            const profileDigest = profileRef && profiles.resolve(profileRef)?.digest;
            const line: CatalogProfileLine = { id: item.variantId, typeRef, quantity, addon: item.isAddon,
              sellable: item.sellability.subscription, capacity: item.netContent,
              publication: { reference: item.acceptedReference, productId: item.productId, documentRevisionId },
              ...(profileRef ? { profileRef } : {}), ...(profileDigest ? { profileDigest } : {}) };
            return { ...line, ...options.profileLine?.(line, item) };
          });
          const selected: CatalogSubscriptionProfileSelection = { lineItems, cadenceDays: purpose.cadenceDays ?? 0,
            storeCadenceDays: choices(config.subscriptionOffers[purpose.offerEvidence.lane === 'sized' ? 'sized' : 'classic'].days),
            ...(lineItems.some(line => line.profileRef) ? { installedCadenceBound: await observeCatalogSubscriptionCadenceBound(db) ?? 0 } : {}) };
          const decision = profiles.bindAcceptance(selected);
          if (decision.kind === 'refused') throw new StarterCatalogueRefusal(decision.issue.code);
          for (const attachment of decision.kind === 'profiled' ? decision.attachments : []) {
            const installed = profiles.resolve(attachment.profileRef);
            if (!installed || !await hasInstalledSubscriptionProfile(db, attachment.profileRef, installed)) {
              throw new StarterCatalogueRefusal('policy_binding_missing');
            }
          }
          if (decision.kind === 'profiled') accepted = new Map(decision.acceptance.lines.map(line => [line.skuId, line]));
        }
        const entries = await db.query('SELECT id,price_list_id,variant_id,to_jsonb(p) AS entry FROM public.price_entries p WHERE id=ANY($1::uuid[])', [lines.map(line => line.entryId)]);
        const priceContextVersions = lines.map(({ item, entryId }) => {
          const selected = entries.rows.find(row => row.id === entryId && row.variant_id === item.variantId);
          if (!selected || typeof selected.price_list_id !== 'string' || !isRecord(selected.entry)) throw new Error('catalog_authority_changed');
          return { skuId: item.variantId, entryId, priceListId: selected.price_list_id, entry: selected.entry };
        });
        return buildCatalogAdmissionFromServing({ mode: purpose.mode, purpose: purpose.purpose, offerEvidence: purpose.offerEvidence, priceContextVersions,
          lines: lines.map(({ item, quantity }) => ({ quantity, item: {
            productId: item.productId, acceptedReference: accepted.get(item.variantId) ?? item.acceptedReference,
          } })) });
      },
    },
  });
}

export function bindCataloguePorts(input: {
  serving: CatalogServingReadPortV2; publisher: Pick<Publication, 'authorize' | 'publish' | 'decision' | 'reads'>;
  adoption: Adoption | undefined; drafts?: Drafts; successor: Successor | undefined; quote: StarterCatalogueQuoteBinding;
  actions: ApplicationBindings['actions']; configId: string; readEnabled(): boolean; writerEnabled(): boolean;
  observeRead: Observe; observeWriter: Observe; observeAdmission: Observe; observeSettlement: Observe;
  observeAccount: Observe; observeSuccessor: Observe; observeProfiles: Observe;
}) {
  const lane = <T>(port: T, observe: Observe) => ({ port, enabled: input.readEnabled, observe });
  const admissionReady: Observe = async () => {
    const observed = await input.observeAdmission();
    return observed.state === 'ready' ? input.observeRead() : observed;
  };
  const runtime = createCatalogRuntimeBinding({ writerEnabled: input.writerEnabled, ports: {
    publicationRead: lane(input.serving, input.observeRead),
    publish: lane(input.publisher, input.observeWriter),
    lifecycleWrite: lane(input.publisher, input.observeWriter),
    shopper: lane(input.quote, admissionReady),
    settlement: lane(input.actions, input.observeSettlement),
    account: lane(input.actions, input.observeAccount),
    editor: lane(input.quote, admissionReady),
    renewal: lane(input.actions, input.observeAccount),
    ...(input.successor && { successor: lane(input.successor, input.observeSuccessor) }),
  } });
  const seated = (context: ActionContext) => context.config.id === input.configId && input.readEnabled() === true;
  for (const laneName of Object.keys(operations) as (keyof typeof operations)[]) {
    for (const name of operations[laneName]) {
      const action = input.actions[name];
      if (!action) continue;
      input.actions[name] = async (payload, context) => {
        if (!seated(context)) return action(payload, context);
        // The durable checkout owns completed replay and the SQL write fence.
        const selected = laneName === 'shopper' && name === 'checkout.create' ? 'settlement' : laneName;
        const result = await runtime.use(selected, () => action(payload, {
          ...context, catalogueQuote: input.quote,
        }));
        return result.outcome === 'ready' ? result.value : refused(result.reason);
      };
    }
  }

  input.actions['operator.catalogPublication'] = async (payload, context) => {
    if (!seated(context)) return refused('catalog_capability_unsupported');
    if (!['draft', 'preflight', 'adopt', 'receipt', 'decide', 'publish', 'current'].includes(String(payload.action))
      || !isRecord(payload.command)) return refused('starter_input_invalid');
    const command = { ...payload.command, commandKey: context.commandKey };
    if (payload.action === 'draft') {
      if (!input.drafts) return refused('catalog_capability_unsupported');
      const draft = input.drafts;
      const result = await runtime.use('publish', () => draft.execute(command, context));
      return result.outcome !== 'ready' ? refused(result.reason) : 'reason' in result.value ? refused(result.value.reason) : success(result.value);
    }
    if (payload.action === 'preflight' || payload.action === 'adopt' || payload.action === 'receipt') {
      const owner = input.adoption;
      if (!owner || (payload.action === 'adopt' && !input.writerEnabled())) return refused('catalog_capability_unsupported');
      const { productId, documentText } = payload.command as Parameters<Adoption['preflight']>[0];
      const outcome = payload.action === 'preflight' ? await owner.preflight({ productId, ...(documentText === undefined ? {} : { documentText }) }, context)
        : payload.action === 'receipt' ? await owner.receipt({ productId, commandKey: context.commandKey }, context)
          : await owner.adopt(command as Parameters<Adoption['adopt']>[0], context);
      return 'reason' in outcome ? refused(outcome.reason) : success(outcome);
    }
    const actor = await input.publisher.authorize(context);
    if (!actor) return refused('publisher_not_authorized');
    if (payload.action === 'current') {
      const result = await input.publisher.reads.current(String(payload.command.productId));
      return 'reason' in result ? refused(result.reason) : success(result);
    }
    const result = await runtime.use(payload.action === 'decide' ? 'publish' : 'lifecycleWrite', async authority => {
      if (payload.action === 'decide') return authority.decision(command as Parameters<Publication['decision']>[0], actor);
      const published = await authority.publish(command as Parameters<Publication['publish']>[0], actor);
      if (published.outcome === 'committed') input.serving.invalidateProduct(published.receipt.productId);
      return published;
    });
    return result.outcome !== 'ready' ? refused(result.reason) : 'reason' in result.value ? refused(result.value.reason) : success(result.value);
  };
  input.actions['subscription.successor'] = async (payload, context) => {
    if (!seated(context) || !context.actor.customerRef || !context.actor.principalRef) return refused('catalog_capability_unsupported');
    const actor = { actorId: context.actor.principalRef, clientId: context.actor.customerRef };
    if (!isRecord(payload.command)) return refused('starter_input_invalid');
    if (payload.action !== 'offer' && payload.action !== 'resolve'
      && (payload.action !== 'decide' || !['accepted', 'declined'].includes(String(payload.command.decision)))) {
      return refused('starter_input_invalid');
    }
    const { historicalBinding: _internal, ...clientCommand } = payload.command;
    const command = { ...clientCommand, now: new Date().toISOString(), commandKey: context.commandKey } as Record<string, unknown>;
    const result = await runtime.use('successor', store => {
      if (payload.action === 'offer') return store.offer(actor, command as unknown as Parameters<Successor['offer']>[1]);
      if (payload.action === 'resolve') return store.resolve(actor, command as unknown as Parameters<Successor['resolve']>[1]);
      return store.decide(actor, command as Parameters<Successor['decide']>[1]);
    });
    return result.outcome === 'ready' ? success(result.value) : refused(result.reason);
  };
  function read<K extends 'list' | 'detail' | 'listQuoteCatalogItems' | 'listEditorSkus'>(method: K): CatalogServingReadPortV2[K] {
    return (async (...args: [never]) => {
      const observed = await runtime.observe('publicationRead');
      if (observed !== 'ready') throw new CommerceQuoteCatalogReadError(observed === 'dependency_unavailable'
        ? 'catalog_authority_unavailable' : 'catalog_authority_unsupported');
      return input.serving[method](...args);
    }) as CatalogServingReadPortV2[K];
  }
  return {
    catalogue: { list: read('list'), detail: read('detail'), listQuoteCatalogItems: read('listQuoteCatalogItems'),
      listEditorSkus: read('listEditorSkus'), invalidateProduct: input.serving.invalidateProduct },
    catalogueEnabled: input.readEnabled,
    async catalogueStatus() {
      const [capabilities, profiles, publicationRead, shopper, settlement, account, editor, successor, renewal] = await Promise.all([
        runtime.capabilities(), input.readEnabled() ? input.observeProfiles().then(result => result.state === 'ready'
          && result.schemaCompatible && result.privilegeGranted, () => false) : false,
        runtime.observe('publicationRead'),
        runtime.observe('shopper'), runtime.observe('settlement'), runtime.observe('account'), runtime.observe('editor'),
        runtime.observe('successor'), runtime.observe('renewal'),
      ]);
      return { capabilities, publicationRead, shopper, settlement, account, editor, successor, renewal,
        profiledAcquisition: profiles && shopper === 'ready' && settlement === 'ready',
        profiledEditor: profiles && editor === 'ready',
        profiledRenewal: profiles && renewal === 'ready' };
    },
  };
}
