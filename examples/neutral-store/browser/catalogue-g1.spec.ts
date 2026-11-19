import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  catalogAcceptedReferenceV2Schema, catalogDefinitionDigest, catalogPackManifest, createCatalogCandidateService, createCatalogDraftHandlerV5,
  createPostgresCatalogDraftStoreV5, createPostgresCatalogPublication, installCatalogDefinitions,
  observeCatalogDefinitionReadiness,
  type CatalogPublicationTransactions,
} from '@openlup/platform/catalog';
import type { CatalogDraftPayloadV4, CatalogDraftPayloadV5, CatalogHeadRef } from '@openlup/platform/catalog/contracts';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { createPostgresAccountLinkStore, createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
import { createCatalogSubscriptionProfileBinding, createNativeCatalogRenewalCodecV2, createPostgresSuccessorStore } from '@openlup/platform/subscriptions';
import { bindRegisteredCatalogue, starterCatalogue } from '../host/catalogue-selection.ts';
import { installStarterCatalogueDefinitions } from '../installation/install.ts';
import { initialDrafts, initialPublications, successor, withdrawal } from '../owned/catalog-packs/supplements/catalogue.ts';
import { runScheduledRenewal } from '../host/scheduled-renewal.ts';
import { readAccountRenewal } from '../host/account-renewal.ts';
import { isRecord } from '../shared/offer.ts';
import { productPath, routes } from '../shared/routes.ts';
import { catalogueG1Expectations as expected } from './catalogue-g1.expectations.ts';

interface Fixture {
  id: string;
  baseURL: string;
  ownerUrl: string;
  runtimeUrl: string;
  state: string;
  cataloguePublication: true;
}

function transactions(pool: pg.Pool): CatalogPublicationTransactions {
  return {
    async run(work) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const value = await work(db);
        await db.query('COMMIT');
        return value;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    },
  };
}

const money = (amountMinor: number) => ({ amountMinor, currency: expected.currency });
const lines = [expected.capsules, expected.powder];
const skuCodes = [...lines, expected.successor].map(line => line.sku);

test('installed catalogue publication, purchase, renewal and successor consent', async ({ page, request, baseURL }, info) => {
  const entries: Fixture[] = JSON.parse(await readFile('.context/care-browser/fixtures.json', 'utf8'));
  const fixture = entries.find(entry => entry.id === info.project.name && entry.baseURL === baseURL);
  if (entries.length !== 1 || !fixture?.cataloguePublication) throw new Error('starter_catalogue_g1_fixture_required');
  const material = fixture;
  expect(material.id).toBe(expected.configurationId);
  const owner = new pg.Pool({ connectionString: material.ownerUrl });
  const runtime = new pg.Pool({ connectionString: material.runtimeUrl });
  const operators = createPostgresOperatorIdentityStore({ connectionString: material.runtimeUrl });
  const accounts = createPostgresAccountLinkStore({ connectionString: material.runtimeUrl });
  try {
    const registration = starterCatalogue.select(material.id);
    const { configuration, pack, types, scope } = registration;
    if (!pack || !scope) throw new Error('starter_catalogue_registration_invalid');
    const definition = types.resolve(expected.type);
    if (!definition) throw new Error('starter_catalogue_g1_type_required');
    const binding = await bindRegisteredCatalogue(registration, transactions(owner));
    const profiles = createCatalogSubscriptionProfileBinding({
      profiles: pack.subscriptionProfileDefinitions ?? [], policies: binding.profilePolicies ?? [],
    });
    const action = async (client: APIRequestContext, operation: string, data: Record<string, unknown>, key = randomUUID()) =>
      (await client.post(`/api/actions/${operation}`, {
        data, headers: { Origin: material.baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': key },
      })).json();
    async function signIn(client: APIRequestContext, kind: 'operator' | 'customer', email: string) {
      expect((await action(client, kind === 'operator' ? 'auth.operator' : 'auth.request', { email })).ok).toBe(true);
      const mailbox = resolve(material.state, '.context/captured-messages/identity.jsonl');
      const token = (await readFile(mailbox, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        .findLast(message => message.email === email)?.token;
      if (typeof token !== 'string') throw new Error('starter_browser_identity_challenge_required');
      expect((await action(client, kind === 'operator' ? 'auth.operator' : 'auth.verify', { token })).ok).toBe(true);
    }
    const publicList = () => request.get('/api/catalogue');
    const catalogueCounts = async () => (await owner.query(`SELECT
      (SELECT count(*)::int FROM public.catalog_products WHERE id=ANY($1::uuid[])) AS products,
      (SELECT count(*)::int FROM public.catalog_skus WHERE sku=ANY($2::text[])) AS skus,
      (SELECT count(*)::int FROM public.price_entries WHERE variant_id=ANY($3::uuid[])) AS prices,
      (SELECT count(*)::int FROM public.catalog_publications WHERE product_id=ANY($1::uuid[])) AS publications`,
    [[...initialDrafts, successor].map(draft => draft.payload.product.id), skuCodes,
      [...initialDrafts, successor].map(draft => draft.skuId)])).rows[0];
    const emptyCatalogue = { products: 0, skus: 0, prices: 0, publications: 0 };

    await test.step('03 install definitions and observe readiness before publication', async () => {
      const config = await (await request.get('/api/config')).json();
      expect(config).toMatchObject({ catalogueAuthority: 'publication', catalogueDraftType: expected.type,
        config: { id: expected.configurationId, market: { country: expected.market, currency: expected.currency },
          offer: { freeShippingFromMinor: expected.money.freeShippingThresholdMinor }, purchase: { tax: { vatRateBps: 0 } } } });
      expect(definition.taxClass).toBe(expected.taxClassKey);
      expect((await runtime.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
        .toEqual([{ role: 'starter_runtime', rolsuper: false, rolbypassrls: false }]);
      expect(await catalogueCounts()).toEqual(emptyCatalogue);
      const receipt = await installStarterCatalogueDefinitions(owner, material.id);
      expect(receipt.manifestDigest).toBe(catalogPackManifest(pack).digest);
      expect(await installCatalogDefinitions(owner, pack)).toEqual(receipt);
      await expect(installCatalogDefinitions(owner, { ...pack, capabilities: { ...pack.capabilities, quantities: false } }))
        .rejects.toMatchObject({ code: '23505', message: 'catalog_definition_install_conflict' });
      await expect(installCatalogDefinitions(runtime, pack)).rejects.toMatchObject({ code: '42501' });
      expect(await observeCatalogDefinitionReadiness(owner, types, 'neutral_store', profiles))
        .toEqual({ database: 'neutral_store', complete: true, referencedVersions: [] });
      expect((await owner.query('SELECT status FROM public.catalog_tax_classes WHERE key=$1', [expected.taxClassKey])).rows)
        .toEqual([{ status: 'active' }]);
      expect(await catalogueCounts()).toEqual(emptyCatalogue);
    });

    let verifiedOperator: string | null = null;
    const authorizeHuman = async (principal: string | null) => {
      const membership = principal && principal === verifiedOperator ? await operators.findMembership(principal) : null;
      return membership?.role === 'admin' && membership.membershipState === 'active'
        ? { ok: true as const, userId: membership.principalId, role: 'admin' as const, isMachineActor: false }
        : { ok: false as const };
    };
    const draftHandler = createCatalogDraftHandlerV5({
      store: createPostgresCatalogDraftStoreV5(owner), registry: types,
      async authorizeOperator(principal: string | null) {
        const auth = await authorizeHuman(principal);
        return auth.ok ? { actorId: auth.userId } : null;
      },
    });
    const publisher = createPostgresCatalogPublication({
      transactions: binding.publication.transactions, rules: binding.publication.rules,
      verifyMedia: binding.publication.verifyMedia, registry: types, authorizeHuman, subscriptionProfiles: profiles,
      // The installed publisher already checks SKU readiness in its transaction. These
      // host callbacks check the installed definition and delegate active sale to its price owner.
      async readiness(db) {
        const row = (await db.query('SELECT definition_digest FROM public.catalog_type_versions WHERE type_key=$1 AND version=$2',
          [expected.type.key, expected.type.version])).rows[0];
        const ready = row?.definition_digest === catalogDefinitionDigest(definition);
        return { ready, reasons: ready ? [] : ['catalog_definition_drift'] };
      },
      async globalReadiness(db) {
        const result = (await db.query('SELECT public.commerce_offer_policy_v2_readiness() AS result')).rows[0]?.result;
        if (!isRecord(result) || typeof result.ready !== 'boolean' || !Array.isArray(result.reasons)
          || result.reasons.some(reason => typeof reason !== 'string')) throw new Error('starter_catalogue_g1_price_readiness_required');
        return { ready: result.ready, reasons: result.reasons };
      },
    });

    await test.step('04 reject guests, store and replay drafts while the storefront is dark', async () => {
      const email = 'catalogue-operator@example.test';
      const operator = await operators.bootstrapFirstAdministrator({ email });
      await signIn(page.request, 'operator', email);
      verifiedOperator = operator.principalId;
      for (const [i, draft] of initialDrafts.entries()) {
        const prediction = lines[i]!;
        const command = { schemaVersion: 3, action: 'create', draftId: draft.draftId,
          commandKey: randomUUID(), expectedRevision: 0, payload: draft.payload };
        expect(await draftHandler.execute(command, null)).toEqual({ outcome: 'unauthorized', reason: 'draft_operator_required' });
        expect(await draftHandler.get({ draftId: draft.draftId }, verifiedOperator)).toEqual({ outcome: 'found', record: null });
        const first = await draftHandler.execute(command, verifiedOperator);
        expect(first).toMatchObject({ outcome: 'committed', record: { revision: 1, payload: {
          product: { type: expected.type },
          skus: [{ code: prediction.sku, attributes: { format: prediction.format }, netContent: {
            unit: prediction.net.unit, unscaled: String(prediction.net.amount), scale: 0,
          }, priceOperations: [{ unitPriceMinor: prediction.unitPriceMinor, minQty: prediction.quantity }] }],
        } } });
        if (!('record' in first)) throw new Error('starter_catalogue_g1_draft_required');
        expect(await draftHandler.get({ draftId: draft.draftId, revision: 1 }, verifiedOperator))
          .toEqual({ outcome: 'found', record: first.record });
        expect(await draftHandler.execute(command, verifiedOperator)).toEqual({ outcome: 'replayed', record: first.record });
        expect((await request.get(`/api/catalogue/${draft.payload.product.slug}`)).status()).toBe(404);
      }
      const draftList = await draftHandler.list({ limit: 10 }, verifiedOperator);
      expect(draftList).toMatchObject({ outcome: 'listed', page: { items: initialDrafts.map(({ draftId }) => ({ draftId })) } });
      expect(await catalogueCounts()).toEqual(emptyCatalogue);
    });

    const candidateService = createCatalogCandidateService({
      async readDraft(draftId, revision) {
        const result = await draftHandler.get({ draftId, ...(revision === undefined ? {} : { revision }) }, verifiedOperator);
        return 'record' in result ? result.record : null;
      },
      registry: types,
      async installedDefinitionDigest(ref) {
        return (await owner.query('SELECT definition_digest FROM public.catalog_type_versions WHERE type_key=$1 AND version=$2',
          [ref.key, ref.version])).rows[0]?.definition_digest ?? null;
      },
      currentHead: publisher.reads.current,
      async resolveHead({ publicationId, revision }) {
        const row = (await owner.query(`SELECT p.id AS "publicationId", p.revision, d.digest AS "documentDigest"
          FROM public.catalog_publications p JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id
          WHERE p.id=$1 AND p.revision=$2`, [publicationId, revision])).rows[0];
        return row ?? null;
      },
    });
    async function preparePublication(draftId: string, payload: CatalogDraftPayloadV4 | CatalogDraftPayloadV5,
      draftRevision: number, expectedHead: CatalogHeadRef | null, variantRevision: number, state: 'active' | 'withdrawn') {
      const saved = await draftHandler.execute({ schemaVersion: payload.schemaVersion, draftId,
        action: draftRevision === 0 ? 'create' : 'revise', commandKey: randomUUID(), expectedRevision: draftRevision, payload }, verifiedOperator);
      expect(saved).toMatchObject({ outcome: 'committed', record: { revision: draftRevision + 1 } });
      const { candidateRef, candidateDigest } = await candidateService.prepareCandidate({ draftId, draftRevision: draftRevision + 1, expectedHead });
      const productId = payload.product.id;
      const actor = await publisher.authorize(verifiedOperator);
      if (!actor) throw new Error('starter_catalogue_g1_verified_operator_required');
      const command = { productId, commandKey: randomUUID(), candidateRef, candidateDigest, expectedHead,
        changes: [{ variantId: payload.skus[0]!.id, expectedRevision: variantRevision, state }] };
      expect(await publisher.decision({ schemaVersion: 2, action: 'approve', productId, commandKey: randomUUID(),
        candidateRef, candidateDigest, reason: 'Approve the exact sandbox fixture' }, actor)).toMatchObject({ outcome: 'committed' });
      return { command, actor };
    }
    const published = await test.step('05 publish both verified candidates and recover their receipts', async () => {
      const results = [];
      for (const [i, draft] of initialDrafts.entries()) {
        const { command, actor } = await preparePublication(draft.draftId, initialPublications[i]!, 1, null, 0, 'active');
        const before = await catalogueCounts();
        expect(await publisher.authorize(null)).toBeNull();
        expect(await publisher.publish(command, {} as typeof actor)).toEqual({ outcome: 'unauthorized', reason: 'publisher_not_authorized' });
        expect(await catalogueCounts()).toEqual(before);
        const result = await publisher.publish(command, actor);
        expect(result).toMatchObject({ outcome: 'committed' });
        if (!('receipt' in result)) throw new Error('starter_catalogue_g1_publication_required');
        expect(await publisher.publish(command, actor)).toEqual({ outcome: 'replayed', receipt: result.receipt });
        expect(await publisher.receipt({ productId: command.productId, commandKey: command.commandKey }, actor))
          .toEqual({ outcome: 'found', receipt: result.receipt });
        expect(await publisher.reads.current(command.productId)).toMatchObject({ outcome: 'found', head: result.receipt.head });
        expect(await publisher.reads.history(command.productId, null)).toMatchObject({ outcome: 'page', receipts: [{ head: result.receipt.head }] });
        const full = await publisher.readbackV3(result.receipt.head);
        expect(full).toMatchObject({ outcome: 'page', items: [{ facts: { code: lines[i]!.sku, lifecycleState: 'active' } }] });
        results.push({ ...result.receipt, full });
      }
      expect(await catalogueCounts()).toEqual({ products: 2, skus: 2, prices: 2, publications: 2 });
      return results;
    });

    await test.step('06 list current products and read both details with independent facts', async () => {
      const listing = await (await publicList()).json();
      expect(listing.items.map((item: { sku: { code: string } }) => item.sku.code).sort()).toEqual(lines.map(line => line.sku).sort());
      await page.goto(routes.catalog.en);
      for (const [i, draft] of initialDrafts.entries()) {
        const prediction = lines[i]!;
        const slug = draft.payload.product.slug!;
        const title = draft.payload.product.sharedContent.document?.title;
        if (typeof title !== 'string') throw new Error('starter_catalogue_g1_title_required');
        const href = productPath(slug, 'en');
        await expect(page.locator(`main a[href="${href}"]`)).toBeVisible();
        const detail = await request.get(`/api/catalogue/${slug}`);
        expect(detail.status()).toBe(200);
        const result = await detail.json();
        expect(result.items).toMatchObject([{ publication: published[i]!.head,
          sku: { code: prediction.sku, netContent: { unit: prediction.net.unit, unscaled: String(prediction.net.amount), scale: 0 },
            grossMass: { dimension: 'mass', unit: 'openlup:g' }, attributes: { format: prediction.format },
            options: { format: { kind: 'choice', value: prediction.format } } } }]);
        expect(Number(result.items[0].sku.grossMass.unscaled)).toBeGreaterThan(0);
        const full = published[i]!.full;
        expect(full).toMatchObject({ product: { document: { digest: published[i]!.head.documentDigest },
          content: { document: { adultsOnly: true, serving: { perContainer: prediction.servings } } } },
          items: [{ facts: { code: prediction.sku } }] });
        await page.locator(`main a[href="${href}"]`).click();
        await expect(page.locator('main h1')).toHaveText(title);
        await page.goto(routes.catalog.en);
      }
      const prices = await owner.query(`SELECT s.sku, p.unit_price_minor AS price, p.min_qty AS tier
        FROM public.price_entries p JOIN public.catalog_skus s ON s.id=p.variant_id
        WHERE s.sku=ANY($1::text[]) AND p.active ORDER BY s.sku`, [lines.map(line => line.sku)]);
      expect(prices.rows).toEqual(lines.map(line => ({ sku: line.sku, price: line.unitPriceMinor, tier: line.quantity })));
    });

    const stock = createPostgresFulfillmentStockSyncPort(owner, {
      sourceKey: `starter-demo:${material.id}`, readLocalInventoryStock: async () => [],
    });
    async function stockSku(sku: string) {
      const { providerRef, collectedAt, staleAfter, syncRunId } = configuration.purchase.stock;
      await stock.recordProviderStockCurrent({ requestKey: `starter-stock:${sku}`, snapshot: {
        providerRef, collectedAt, syncRunId, skuRef: sku, sourceRevision: null, revisionSource: 'collection',
        quantityKind: 'snapshot', totalQuantity: 10, forSaleQuantity: 10, reservedOrUnavailableQuantity: 0,
      }, inventoryClass: 'sellable', lastSyncedAt: collectedAt, staleAfter });
    }
    const email = 'catalogue-buyer@example.test';
    const principalId = randomUUID();
    const customer = await accounts.createAccount({ email, principalId, acquisitionSource: 'local-demonstration', lifecycleStage: 'customer' });
    const purchaseData = {
      email, locale: 'en', configuration: expected.configurationId, country: expected.market, termsAccepted: true,
      termsRevision: configuration.legal.revision, acquisitionCapability: 'subscription-acquisition.v1',
      firstName: 'Example', lastName: 'Buyer', phone: '000000000', line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
      cart: { schemaVersion: 1, configuration: expected.configurationId, mode: expected.mode,
        cadenceDays: expected.cadenceDays, lines: lines.map(({ sku, quantity }) => ({ sku, quantity })) },
    };
    const orderCount = async () => Number((await owner.query('SELECT count(*) FROM public.commerce_orders')).rows[0]!.count);
    const quote = await test.step('07 quote both lines and refuse a cadence that cannot cover them', async () => {
      for (const { sku } of lines) await stockSku(sku);
      const refused = await action(request, 'offer.validate', { ...purchaseData, cart: { ...purchaseData.cart, cadenceDays: 35 } });
      expect(refused.ok).toBe(false);
      expect(await orderCount()).toBe(0);
      const accepted = await action(request, 'offer.validate', purchaseData);
      expect(accepted.ok ? 'accepted' : accepted.code).toBe('accepted');
      const snapshot = accepted.value.quote.quote;
      expect(accepted.value.expectedTotal).toEqual(money(expected.money.purchaseTotalMinor));
      expect(snapshot).toMatchObject({
        subtotalGross: money(expected.money.purchaseSubtotalMinor), taxTotal: money(expected.money.taxMinor),
        discountTotalGross: money(expected.money.adjustmentMinor), context: { cadenceDays: expected.cadenceDays },
        lines: lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitPriceGross: money(line.unitPriceMinor) })),
      });
      expect((snapshot.shippingGross?.amountMinor ?? 0) - (snapshot.shippingDiscountGross?.amountMinor ?? 0)).toBe(expected.money.shippingMinor);
      const admission = accepted.value.quote.catalogAdmission;
      expect(admission).toMatchObject({ mode: 'subscription', skuRevisions: initialDrafts.map((draft, i) => ({
        quantity: lines[i]!.quantity, reference: { skuId: draft.skuId, typeRef: expected.type,
          publicationHead: published[i]!.head, definitionDigest: catalogDefinitionDigest(definition),
          optionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), subscriptionProfile: { digest: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
      })), priceContextVersions: initialDrafts.map(draft => ({ skuId: draft.skuId, entryId: expect.any(String) })) });
      for (const selection of admission.skuRevisions) {
        const line = lines.find(item => item.sku === selection.reference.skuCode)!;
        const net = selection.reference.netContent;
        expect(Number(net.unscaled) * selection.quantity / (10 ** net.scale * line.dailyAmount)).toBe(line.coverageDays);
      }
      expect(typeof accepted.value.quoteAcceptance).toBe('string');
      expect(await orderCount()).toBe(0);
      return accepted.value;
    });

    const agreement = await test.step('08 buy in the sandbox and verify durable acceptance and replay', async () => {
      const key = randomUUID();
      const data = { ...purchaseData, quoteAcceptance: quote.quoteAcceptance, expectedTotal: quote.expectedTotal };
      const created = await action(request, 'checkout.create', data, key);
      expect(created.ok ? 'created' : created.code).toBe('created');
      const { orderRef, token } = created.value;
      expect((await action(request, 'checkout.create', data, key)).value?.orderRef).toBe(orderRef);
      const payment = { orderRef, token, outcome: 'captured' };
      const captureKey = randomUUID();
      expect((await action(request, 'payment.simulate', payment, captureKey)).ok).toBe(true);
      expect((await action(request, 'payment.simulate', payment, captureKey)).ok).toBe(true);
      const activation = (await runtime.query(`SELECT s.id,s.client_id,s.status,s.next_cycle_at,s.cadence_days,
        o.total_amount_minor,o.currency_code,o.catalog_acceptance
        FROM public.subscriptions s JOIN public.subscription_activations a ON a.subscription_id=s.id
        JOIN public.commerce_orders o ON o.id=a.order_id WHERE o.id=$1`, [orderRef])).rows[0];
      expect(activation).toMatchObject({ client_id: customer.id, status: 'active', cadence_days: expected.cadenceDays, currency_code: expected.currency });
      expect(Number(activation.total_amount_minor)).toBe(expected.money.purchaseTotalMinor);
      expect(activation.catalog_acceptance).toMatchObject({ schemaVersion: 2, lines: initialDrafts.map((draft, i) => ({
        skuId: draft.skuId, publicationHead: published[i]!.head, typeRef: expected.type,
      })) });
      expect(await orderCount()).toBe(1);
      return activation;
    });

    const subscriptionId = String(agreement.id);
    const clientId = String(agreement.client_id);
    const scheduledAt = agreement.next_cycle_at as Date;
    const nextAnchor = new Date(scheduledAt.getTime() + expected.cadenceMilliseconds);
    const accountScope = { principalId, clientId };
    const template = async () => (await runtime.query(`SELECT s.next_cycle_at,s.cadence_days,s.template_version,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sort_order) FROM public.subscription_lines l WHERE l.subscription_id=s.id) AS lines,
      (SELECT catalog_acceptance FROM public.subscription_renewal_terms t WHERE t.subscription_id=s.id) AS references
      FROM public.subscriptions s WHERE s.id=$1`, [subscriptionId])).rows[0];
    const renewalRows = async () => (await runtime.query(`SELECT r.id,r.state,r.cycle_snapshot,r.operation_fingerprint,
      o.id AS order_id,o.total_amount_minor,o.currency_code,o.status
      FROM public.subscription_renewal_operations r
      LEFT JOIN public.commerce_settlement_intents i ON i.renewal_operation_id=r.id
      LEFT JOIN public.commerce_orders o ON o.id=i.order_id WHERE r.subscription_id=$1 ORDER BY r.scheduled_at`, [subscriptionId])).rows;
    const codec = createNativeCatalogRenewalCodecV2(reference => catalogAcceptedReferenceV2Schema.parse(reference));
    await test.step('09 run and replay the scheduled renewal at the recorded due instant', async () => {
      const before = await template();
      expect(before).toMatchObject({ cadence_days: expected.cadenceDays, next_cycle_at: scheduledAt, references: agreement.catalog_acceptance });
      await runScheduledRenewal(material.runtimeUrl, configuration, () => scheduledAt.toISOString());
      const renewed = await renewalRows();
      expect(renewed).toHaveLength(1);
      const operation = renewed[0]!;
      expect(operation).toMatchObject({ state: 'succeeded', status: 'paid', currency_code: expected.currency });
      expect(Number(operation.total_amount_minor)).toBe(expected.money.renewalTotalMinor);
      const frozen = codec.decode(operation.cycle_snapshot);
      expect(codec.fingerprint(frozen)).toBe(operation.operation_fingerprint);
      expect(frozen).toMatchObject({ lines: lines.map(({ sku, quantity }) => ({ sku, quantity })),
        pricingSnapshot: { currency: expected.currency, totalAmountMinor: expected.money.renewalTotalMinor } });
      expect(await template()).toEqual({ ...before, next_cycle_at: nextAnchor });
      await runScheduledRenewal(material.runtimeUrl, configuration, () => scheduledAt.toISOString());
      expect(await renewalRows()).toEqual(renewed);
      expect(await orderCount()).toBe(2);
      const account = await readAccountRenewal(runtime, accountScope);
      const own = account.subscriptions.find(row => row.subscriptionId === subscriptionId);
      expect(own?.nextCharge).toMatchObject(money(expected.money.renewalTotalMinor));
      expect(Date.parse(String(own?.nextCharge?.chargeAt))).toBe(nextAnchor.getTime());
    });

    await test.step('10 withdraw the predecessor, retain history and refuse archive with obligations', async () => {
      const capsule = initialDrafts[0];
      const before = await template();
      const frozen = await renewalRows();
      const { command, actor } = await preparePublication(capsule.draftId, withdrawal, 2, published[0]!.head, 1, 'withdrawn');
      const result = await publisher.publish(command, actor);
      expect(result).toMatchObject({ outcome: 'committed' });
      if (!('receipt' in result)) throw new Error('starter_catalogue_g1_withdrawal_required');
      expect(await publisher.readbackV3(result.receipt.head)).toMatchObject({ outcome: 'page',
        items: [{ facts: { code: expected.capsules.sku, lifecycleState: 'withdrawn' } }] });
      expect(await publisher.readbackV3(published[0]!.head)).toEqual(published[0]!.full);
      expect((await request.get(`/api/catalogue/${withdrawal.product.slug}`)).status()).toBe(404);
      expect((await (await publicList()).json()).items).toMatchObject([{ sku: { code: expected.powder.sku } }]);
      expect((await action(request, 'offer.validate', purchaseData)).ok).toBe(false);
      expect(await orderCount()).toBe(2);
      const archive = { ...withdrawal, publication: { ...withdrawal.publication, operations: [{
        op: 'set_product_lifecycle' as const, productSlug: withdrawal.product.slug!, expectedState: 'withdrawn' as const,
        state: 'archived' as const, children: [{ skuCode: expected.capsules.sku, expectedState: 'withdrawn' as const }],
      }] } };
      const archiveAttempt = await preparePublication(capsule.draftId, archive, 3, result.receipt.head, 2, 'withdrawn');
      expect(await publisher.publish(archiveAttempt.command, archiveAttempt.actor)).toMatchObject({
        reason: 'catalog_archive_refuses_outstanding_obligations',
      });
      expect(await publisher.reads.current(command.productId)).toMatchObject({ outcome: 'found', head: result.receipt.head });
      expect(await template()).toEqual(before);
      expect(await renewalRows()).toEqual(frozen);
    });

    const successorStore = createPostgresSuccessorStore({
      withTransaction: transactions(runtime).run,
      codec,
      previews: { async prepare(db, input) {
        const { rows } = await db.query(`SELECT request_payload,quote_snapshot FROM public.subscription_quote_previews
          WHERE id=$1 AND subscription_id=$2 AND actor_id=$3 AND status='previewed'`,
        [input.previewId, input.subscriptionId, input.actor.actorId]);
        if (rows.length !== 1) throw new Error('starter_catalogue_g1_preview_required');
        const { request_payload: edit, quote_snapshot: snapshot } = rows[0]!;
        if (!isRecord(edit) || !isRecord(snapshot)) throw new Error('starter_catalogue_g1_preview_invalid');
        return { cycleSnapshot: null, applyPayload: { ...edit, ...snapshot, request: edit } };
      } },
    });
    const customerContext = await page.context().browser()!.newContext({ baseURL: material.baseURL });
    try {
      const proposal = await test.step('11 publish the successor and offer the disclosed edit without applying it', async () => {
        const before = await template();
        const { command, actor } = await preparePublication(successor.draftId, successor.payload, 0, null, 0, 'active');
        const result = await publisher.publish(command, actor);
        expect(result).toMatchObject({ outcome: 'committed' });
        if (!('receipt' in result)) throw new Error('starter_catalogue_g1_successor_required');
        const publicationId = result.receipt.head.publicationId;
        expect((await owner.query(`SELECT predecessor_sku_id,successor_sku_id FROM public.catalog_sku_successors
          WHERE publication_id=$1`, [publicationId])).rows).toEqual([{
          predecessor_sku_id: initialDrafts[0].skuId, successor_sku_id: successor.skuId,
        }]);
        await stockSku(expected.successor.sku);
        await signIn(customerContext.request, 'customer', email);
        const edit = { subscriptionId, action: 'swap_base_line', fromVariantId: initialDrafts[0].skuId, toVariantId: successor.skuId };
        const response = await action(customerContext.request, 'subscription.preview', { request: edit });
        expect(response.ok ? 'previewed' : response.code).toBe('previewed');
        expect(response.value).toMatchObject({
          preview: { canApply: true },
          currentTotal: money(expected.money.purchaseTotalMinor), newTotal: money(expected.money.successorTotalMinor),
          editConsent: { currency: expected.currency, agreedTotalMinor: expected.money.purchaseTotalMinor,
            newTotalMinor: expected.money.successorTotalMinor, lines: expect.arrayContaining([
              { kind: 'removed', sku: expected.capsules.sku, agreedUnitMinor: expected.capsules.unitPriceMinor,
                newUnitMinor: null, agreedQuantity: expected.capsules.quantity, newQuantity: null },
              { kind: 'added', sku: expected.successor.sku, agreedUnitMinor: null,
                newUnitMinor: expected.successor.unitPriceMinor, agreedQuantity: null, newQuantity: expected.successor.quantity },
            ].map(line => expect.objectContaining(line))) },
        });
        const preview = (await runtime.query(`SELECT id,created_at FROM public.subscription_quote_previews
          WHERE subscription_id=$1 AND client_id=$2 AND quote_hash=$3 AND status='previewed'`,
        [subscriptionId, clientId, response.value.quoteHash])).rows[0];
        if (!preview) throw new Error('starter_catalogue_g1_preview_required');
        const proposalId = randomUUID();
        const offered = await successorStore.offer({ actorId: accountScope.principalId, clientId }, {
          proposalId, subscriptionId, publicationId, predecessorSkuId: initialDrafts[0].skuId, successorSkuId: successor.skuId,
          previewId: preview.id, sourceBinding: { kind: 'ordinary_edit' }, lane: 'exact', action: edit.action,
          now: preview.created_at.toISOString(),
        });
        expect(offered).toMatchObject({ id: proposalId, state: 'offered', consent: null, publication_id: publicationId,
          quote_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          preview: { id: preview.id, quote_hash: response.value.quoteHash } });
        expect(await template()).toEqual(before);
        expect(await orderCount()).toBe(2);
        return { id: proposalId, offered, now: preview.created_at.toISOString() as string };
      });

      await test.step('12 require owner identity and the exact disclosed hash before consent', async () => {
        const before = await template();
        const wrongHash = { proposalId: proposal.id, decision: 'accepted' as const,
          commandKey: randomUUID(), quoteHash: '0'.repeat(64), now: proposal.now };
        await expect(successorStore.decide({ actorId: randomUUID(), clientId }, wrongHash))
          .rejects.toThrow('subscription_command_forbidden');
        await expect(successorStore.decide({ actorId: accountScope.principalId, clientId }, wrongHash))
          .rejects.toThrow('successor_proposal_binding_changed');
        expect(await template()).toEqual(before);
        expect((await owner.query('SELECT state,consent,accepted_receipt,quote_hash FROM public.subscription_successor_proposals WHERE id=$1',
          [proposal.id])).rows).toEqual([{ state: 'offered', consent: null, accepted_receipt: null, quote_hash: proposal.offered.quote_hash }]);
        expect(await orderCount()).toBe(2);
        const reads = await import('@openlup/platform/subscriptions');
        if (!('createPostgresStockWaitReads' in reads) || typeof reads.createPostgresStockWaitReads !== 'function') {
          throw new Error('starter_catalogue_g1_lc10r_reads_required');
        }
        const wait = reads.createPostgresStockWaitReads({
          graph: 'native',
          withReadSnapshot: <T>(work: Parameters<CatalogPublicationTransactions['run']>[0]) => transactions(runtime).run(async db => {
            await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            return await work(db) as T;
          }),
          authorizeOperator: async () => (await authorizeHuman(verifiedOperator)).ok,
          authorizeEvidence: async () => (await authorizeHuman(verifiedOperator)).ok,
          readOwnedAccount: async () => ({ ...accountScope, subscriptionIds: [subscriptionId] }),
        });
        expect(await wait.readOperatorSummary('waiting')).toEqual({ totalCount: 0, productTotals: [] });
        expect(await wait.listAdmin({ state: 'waiting', page: 1, pageSize: 10 })).toEqual({
          totalCount: 0, productTotals: [], cases: [], page: 1, pageSize: 10,
        });
        expect(await wait.listCustomer()).toEqual([]);
      });
    } finally {
      await customerContext.close();
    }
  } finally {
    await Promise.all([owner.end(), runtime.end(), operators.close(), accounts.close()]);
  }
});
