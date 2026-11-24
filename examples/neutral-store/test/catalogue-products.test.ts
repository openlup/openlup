import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectPublishedCatalogOfferPage, type CatalogStorefrontPageResult } from '@openlup/platform/catalog';
import { configurations } from '../owned/store.config.ts';
import { mapStarterPresentation } from '../shared/catalogue-presentation.ts';
import { publishedToStarterProducts, readStarterProducts, selectCatalogueProduct } from '../shared/catalogue-products.ts';
import { validateCart } from '../shared/offer.ts';
import type { Product } from '../shared/config.ts';

type Page = Extract<CatalogStorefrontPageResult, { protocol: 'governed' }>;
const config = configurations.coffee;
const byLocale = Object.fromEntries(config.market.locales.map(locale => [locale, 'Article']));
const presentation = { title: 'Article', name: byLocale, description: byLocale, mediaAlt: byLocale,
  media: '/media/article-1.svg', extra: { publicCopy: true } };
const typeRef = { key: 'starter:item', version: 2 };
const digest = 'a'.repeat(64);
const attribute = (key: string, scope: 'product' | 'variant', outward = true) => ({
  key, scope, public: outward, required: false, valueType: { kind: 'text' as const, maxLength: 30 },
  cardinality: { min: 0, max: 1 }, facetable: false, filterable: false, displayOrder: 0, labels: {},
});
const receipt = { digest, type: { ...typeRef, attributes: [attribute('product', 'product'), attribute('variant', 'variant'),
  attribute('private', 'product', false), attribute('inherited', 'product')] } };
const row: Page['products'][number]['skus'][number] = {
  skuId: '00000000-0000-4000-8000-000000000001', skuCode: 'ARTICLE-ONE', title: 'First variant', minQuantity: 2,
  skuRevision: { skuId: '00000000-0000-4000-8000-000000000001', revision: 1,
    revisionId: '00000000-0000-4000-8000-000000000002', digest },
  options: { finish: { kind: 'choice', value: 'matte' } }, attributes: { variant: 'gloss', product: 'wrong scope' },
  netContent: { dimension: 'mass', unit: 'openlup:g', scale: 0, unscaled: '100' },
  primaryUnitIdentifier: { scheme: 'gs1:gtin', issuer: 'fixture', value: '5901234123457' },
  sell: { oneTime: true, subscription: true },
  price: { oneTime: { amountMinor: 2700, currency: config.market.currency, amountBasis: 'tax_inclusive' }, subscription: null },
};
const raw: Page = { protocol: 'governed', headDigest: digest, nextCursor: null, products: [{
  productId: '00000000-0000-4000-8000-000000000003', slug: 'article', name: 'Raw name', typeRef, definitionDigest: digest,
  attributes: Object.assign(Object.create({ inherited: 'prototype' }), { product: 'public', variant: 'wrong scope', private: 'hidden' }),
  presentation, skus: [row, { ...row, skuCode: 'ARTICLE-TWO', title: 'Second variant' }],
}] };
const project = (definitions: Parameters<typeof projectPublishedCatalogOfferPage>[1], seal = raw.products[0]!.definitionDigest) =>
  projectPublishedCatalogOfferPage({ ...raw, products: [{ ...raw.products[0]!, definitionDigest: seal }] }, definitions);

test('only exact receipt-backed public attributes reach the offer, and presentation passes through', () => {
  for (const seal of [digest, null]) {
    const offer = project([receipt], seal);
    assert.deepEqual(offer.products[0]!.attributes, { product: 'public' });
    assert.deepEqual(offer.products[0]!.skus[0]!.attributes, { variant: 'gloss' });
    assert.deepEqual(offer.products[0]!.presentation, presentation);
    assert.equal('options' in offer.products[0]!.skus[0]!, false);
    assert.equal('definitionDigest' in offer.products[0]!, false);
  }
  const conflict = { ...receipt, digest: 'b'.repeat(64) };
  const conflictingScope = { ...receipt, type: { ...typeRef, attributes: [attribute('product', 'variant')] } };
  for (const [definitions, seal] of [
    [[], digest], [[{ ...receipt, digest: '' }], null], [[{ ...receipt, type: { ...receipt.type, version: 1 } }], null],
    [[receipt], conflict.digest], [[receipt, conflict], digest], [[conflict, receipt], digest],
    [[receipt, conflictingScope], digest], [[conflictingScope, receipt], digest],
  ] as const) {
    const offer = project(definitions, seal);
    assert.deepEqual(offer.products[0]!.attributes, {});
    assert.deepEqual(offer.products[0]!.skus[0]!.attributes, {});
  }
});

test('localized presentation and gross price map to exact eligible sibling selections', () => {
  assert.equal(mapStarterPresentation(presentation)?.contents, '');
  assert.deepEqual(mapStarterPresentation(presentation)?.details, Object.fromEntries(config.market.locales.map(locale => [locale, ''])));
  assert.equal('extra' in mapStarterPresentation(presentation)!, false);
  for (const media of ['/media/a.svg\n', '/media/.svg', '/media/a/b.svg', '//media/a.svg', '/media/a%20.svg'])
    assert.equal(mapStarterPresentation({ ...presentation, media }), undefined);
  assert.equal(mapStarterPresentation({ ...presentation, name: {} }), undefined);
  assert.equal(mapStarterPresentation({ ...presentation, title: '   ' }), undefined);
  const towardsStore = publishedToStarterProducts(project([receipt]), config);
  const ownedCardInput: Product = towardsStore[1]!;
  assert.deepEqual(ownedCardInput.unitPrice, { amountMinor: 2700, currency: config.market.currency });
  assert.deepEqual(towardsStore[1]!.attributes, { product: 'public', variant: 'gloss' });
  assert.equal(selectCatalogueProduct(towardsStore, 'article', null)?.sku, 'ARTICLE-ONE');
  assert.equal(selectCatalogueProduct(towardsStore, 'article', 'ARTICLE-TWO')?.variantTitle, 'Second variant');
  assert.equal(selectCatalogueProduct(towardsStore, 'other', 'ARTICLE-TWO'), undefined);
  assert.equal(selectCatalogueProduct([...towardsStore, towardsStore[1]!], 'article', 'ARTICLE-TWO'), undefined);
  const offer = project([receipt]);
  assert.equal(offer.protocol, 'governed');
  const product = offer.products[0]!;
  const missing = { ...product.skus[0]!, price: { oneTime: null, subscription: null } };
  const net = { ...product.skus[1]!, price: { oneTime: { ...product.skus[1]!.price.oneTime!, amountBasis: 'tax_exclusive' as const }, subscription: null } };
  assert.deepEqual(readStarterProducts({ ...offer, products: [{ ...product, skus: [missing, net] }, {
    ...product, presentation: null, skus: [{ ...product.skus[0]!, skuCode: 'BAD-COPY' }],
  }] }, config), { products: [], exclusions: [
    { code: 'starter_catalogue_price_missing', subject: 'ARTICLE-ONE' },
    { code: 'starter_catalogue_price_basis_unsupported', subject: 'ARTICLE-TWO' },
    { code: 'starter_catalogue_presentation_invalid', subject: 'BAD-COPY' },
  ] });
});

test('published subscriptions use checkout cadence, line minimum and plan and store caps', () => {
  const copy = structuredClone(config);
  const set = (value: number) => ({ kind: 'set' as const, values: [value] });
  const plan = copy.subscriptionOffers.classic;
  plan.maximumUnits = 3;
  plan.checkoutMinimumBaseUnits = 1;
  plan.bySku = { 'ARTICLE-ONE': [{ days: set(plan.defaultDays), quantities: set(2) }] };
  plan.checkoutDays = set(plan.defaultDays);
  const offer = project([receipt]);
  const products = publishedToStarterProducts(offer, copy);
  assert.deepEqual(products.map(item => item.permittedPurchaseModes), [['one_time', 'subscription'], ['one_time']]);
  const request = { schemaVersion: 1, configuration: copy.id, mode: 'subscription', cadenceDays: plan.defaultDays,
    lines: [{ sku: 'ARTICLE-ONE', quantity: 2 }] };
  assert.equal(validateCart(copy, request, 'checkout', products).ok, true);
  plan.checkoutDays = set(plan.defaultDays + 1);
  assert.deepEqual(publishedToStarterProducts(offer, copy)[0]!.permittedPurchaseModes, ['one_time']);
  assert.equal(validateCart(copy, request, 'checkout', products).ok, false);
  assert.equal(validateCart(copy, request, 'graduation', products).ok, true);
  plan.checkoutDays = set(plan.defaultDays);
  for (const cap of [plan, copy.offer]) {
    const key = 'maximumUnits' in cap ? 'maximumUnits' : 'maxUnits';
    Object.assign(cap, { [key]: 1 });
    assert.deepEqual(publishedToStarterProducts(offer, copy)[0]!.permittedPurchaseModes, ['one_time']);
    Object.assign(cap, { [key]: 3 });
  }
});

const internalCases = {
  bad_check_digit: '5901234123458', rcn8_zero: '01234565', rcn8_two: '21234569', gtin8_demo: '95212340', gtin8_reserved: '97712343',
  rcn13_02: '0212345678909', rcn13_04: '0412345678903', rcn13_20: '2012345678903', rcn13_29: '2912345678906',
  upc12_rcn: '212345678909', gtin14_zero_rcn: '00212345678909', indicator_one_rcn: '10212345678906',
  indicator_eight_rcn: '82012345678909', indicator_nine: '95901234123450', reserved_05: '0512345678900',
  epc_951: '9511234567890', demo_952: '9521234567899', refund_980: '9801234567892', coupon_981: '9811234567891',
  reserved_984: '9841234567898', coupon_990: '9901234567899', local_upc: '001000123454', indicator_over_unused_body: '10000001234562',
};
const globalCases = { global_8: '95010939', global_12: '036000291452', global_13: '5901234123457', global_14: '15901234123454' };
function projectedIdentifier(value: string, scheme = 'gs1:gtin') {
  return projectPublishedCatalogOfferPage({ ...raw, products: [{ ...raw.products[0]!,
    skus: [{ ...row, primaryUnitIdentifier: { scheme, issuer: 'fixture', value } }],
  }] }, []).products[0]!.skus[0]!.primaryUnitIdentifier;
}
for (const [fixtures, internal] of [[internalCases, true], [globalCases, false]] as const) {
  for (const [name, authored] of Object.entries(fixtures)) test(name, () => {
    for (const value of [authored, authored.padStart(14, '0')])
      assert.deepEqual(projectedIdentifier(value), { scheme: 'gs1:gtin', issuer: 'fixture', value, internal });
  });
}
test('invalid identifier scheme, length and non-digit values are internal', () => {
  for (const [value, scheme] of [['5901234123457', 'local:ref'], ['5', 'gs1:gtin'], ['590123412345x', 'gs1:gtin']])
    assert.equal(projectedIdentifier(value!, scheme)?.internal, true);
});

test('the native walk shares quote capacity, binds cursor and head, and counts off-offer rows', async () => {
  const { composeCatalogueStorefront } = await import('../host/catalogue-storefront.ts');
  const { editorProducts } = await import('../host/editor-catalogue.ts');
  const { starterQuoteCatalogMaxItems } = await import('../shared/offer.ts');
  const budget = starterQuoteCatalogMaxItems - new Set(editorProducts(config).map(item => item.sku)).size;
  assert.ok(budget < starterQuoteCatalogMaxItems - config.offer.products.length);
  const pages = Math.ceil(budget / 24);
  let census = starterQuoteCatalogMaxItems, censusCalls = 0;
  const transactions = { run: async <T>(work: (db: import('@openlup/platform/data').PgQueryExecutor) => Promise<T>) =>
    work({ async query(sql, args) {
      censusCalls++;
      assert.match(sql, /FROM public\.catalog_skus/u);
      assert.deepEqual(args, [501]);
      return { rows: [{ count: census }] };
    } }) };
  const make = (size: number, fault?: 'repeat' | 'head' | 'page' | 'head-refusal' | 'unpublished' | 'input-refusal' | 'offline') => {
    let calls = 0;
    let previous: Page['nextCursor'] = null;
    const counts: number[] = [];
    const cause = new Error('private probe detail');
    const read = composeCatalogueStorefront(transactions, async (_runner, input) => {
      assert.equal(input.limit, 24);
      assert.equal(input.offerVersion, 'classic');
      assert.equal(input.channel, 'D2C');
      assert.deepEqual(input.cursor, previous);
      const offset = calls++ * 24;
      if (fault === 'offline') throw cause;
      if (fault === 'unpublished' || fault === 'input-refusal') return {
        outcome: 'validation_issue', reason: 'catalog_offer_memberships_page_input_invalid', message: 'Invalid request',
        ...(fault === 'unpublished' ? { issue: 'offer_unpublished' as const } : {}),
      };
      if (fault === 'head-refusal' && calls === 2) return {
        outcome: 'conflict', reason: 'catalog_publication_head_moved', retryable: true, message: 'Read again.',
      };
      const rows = Array.from({ length: Math.min(24, size - offset) }, (_, index) => ({
        ...row, skuCode: `A-${offset + index}`, skuId: String(offset + index).padStart(10, '0'),
      }));
      const more = offset + rows.length < size || fault === 'page';
      const next = more ? { skuId: rows.at(-1)!.skuId, headDigest: digest, offerVersion: 'classic', mode: null } : null;
      previous = fault === 'repeat' && calls === 2 ? previous : next;
      return { ...raw, headDigest: fault === 'head' && calls === 2 ? 'b'.repeat(64) : digest, nextCursor: previous,
        products: [{ ...raw.products[0]!, skus: rows }] };
    }, () => ({ current: undefined, registry: { resolve: () => undefined }, lookupBuild: () => ({ outcome: 'out_of_scope' }),
      readInstalled: () => { counts.push(calls); return undefined; } }));
    return { read: () => read.resolveCatalogue(config), calls: () => calls, counts, cause };
  };
  const exact = make(budget);
  const success = await exact.read();
  assert.equal(success.ok, true);
  if (!success.ok) return;
  assert.deepEqual(Object.keys(success.value), ['products']);
  assert.deepEqual(success.value.products.slice(0, config.offer.products.length), config.offer.products);
  assert.equal(success.value.products.at(-1)?.sku, `A-${budget - 1}`);
  assert.equal(exact.calls(), pages);
  assert.deepEqual(exact.counts, [1]);
  assert.equal(censusCalls, 1);
  for (const [size, fault, code] of [
    [budget + 1, undefined, 'starter_catalogue_page_limit'], [budget - 1, 'page', 'starter_catalogue_page_limit'],
    [65, 'repeat', 'starter_catalogue_cursor_invalid'], [50, 'head', 'catalog_publication_head_moved'],
    [50, 'head-refusal', 'catalog_publication_head_moved'], [0, 'input-refusal', 'catalog_offer_memberships_page_input_invalid'],
    [0, 'offline', 'starter_catalogue_read_unavailable'],
  ] as const) {
    const fixture = make(size, fault);
    const answer = await fixture.read();
    assert.equal(answer.ok, false);
    if (answer.ok) continue;
    assert.equal(answer.code, code);
    assert.ok(fixture.calls() <= pages);
    if (fault === 'offline') assert.deepEqual(Object.getOwnPropertyDescriptor(answer, 'cause'), {
      value: fixture.cause, configurable: false, writable: false, enumerable: false,
    });
  }
  assert.deepEqual(await make(0, 'unpublished').read(), { ok: true, value: { products: config.offer.products } });
  census++;
  const offOffer = await make(1).read();
  assert.equal(offOffer.ok ? null : offOffer.code, 'starter_catalogue_page_limit');
});
