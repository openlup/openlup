import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { market } from '../owned/market.config.ts';
import { configurations } from '../owned/store.config.ts';
import type { StoreConfig } from '../shared/config.ts';
import { emptyCart, validateCart, type Cart, type OfferIssue } from '../shared/offer.ts';
import { routes } from '../shared/routes.ts';
import { supportedLocales } from '../shared/locales.ts';
import type { StarterCatalogueItem } from '../shared/catalogue-products.ts';
import { decideSelectionEntry, parseSelectionEntry, selectionEntryCopy, selectionEntryParameter, selectionEntryPath,
  settleCatalogueRequest, withoutSelectionEntry, type SelectionEntryCatalogue } from '../shared/selection-entry.ts';
import { range, set } from '../shared/subscription-offer.ts';

const root = new URL('..', import.meta.url).pathname;
const query = (path: string) => new URLSearchParams(path.slice(path.indexOf('?') + 1));
const locale = market.defaultLocale;
const codes = (issues: readonly OfferIssue[]) => issues.map(issue => issue.code);

/** The first offered cadence other than the default that `validateCart` admits for the lines, else the default. */
function admissibleCadence(config: StoreConfig, lines: Cart['lines']): number {
  const admits = (days: number) => validateCart(config, { schemaVersion: 1, configuration: config.id, mode: 'subscription', cadenceDays: days, lines }).ok;
  return config.offer.cadenceDays.find(days => days !== config.offer.defaultCadenceDays && admits(days)) ?? config.offer.defaultCadenceDays;
}

function selection(config: StoreConfig, mode: Cart['mode']): Cart {
  const [first, second] = config.offer.products;
  const lines = [{ sku: first!.sku, quantity: 1 }, ...(second ? [{ sku: second.sku, quantity: 1 }] : [])];
  return { schemaVersion: 1, configuration: config.id, mode,
    cadenceDays: mode === 'subscription' ? admissibleCadence(config, lines) : null, lines };
}

function decide(config: StoreConfig, path: string, cart: Cart = emptyCart(config),
  catalogue: SelectionEntryCatalogue = 'ready', products: readonly StarterCatalogueItem[] = config.offer.products) {
  return decideSelectionEntry(config, { query: query(path), cart, products, catalogue });
}

function refused(config: StoreConfig, path: string): OfferIssue[] {
  const parsed = parseSelectionEntry(config, query(path));
  if (parsed.kind === 'refused') return parsed.issues;
  if (parsed.kind === 'none') assert.fail(`not an entry: ${path}`);
  const validated = validateCart(config, parsed.candidate, 'checkout', config.offer.products);
  assert.equal(validated.ok, false, path);
  return validated.ok ? [] : validated.issues;
}

for (const config of Object.values(configurations)) {
  test(`${config.id}: a built selection reads back as the same cart in both purchase modes`, () => {
    for (const mode of ['one_time', 'subscription'] as const) {
      const offered = selection(config, mode);
      assert.equal(validateCart(config, offered).ok, true, mode);
      const path = selectionEntryPath(locale, offered);
      assert.ok(path.startsWith(`${routes.cart[locale]}?`));
      const parsed = parseSelectionEntry(config, query(path));
      assert.equal(parsed.kind, 'read');
      if (parsed.kind === 'read') assert.deepEqual(parsed.candidate, offered);
    }
  });

  test(`${config.id}: price-like parameters are ignored and never read`, () => {
    const offered = selection(config, 'one_time');
    const path = selectionEntryPath(locale, offered);
    const priced = `${path}&price=1&amount=1&unit_amount=1&total=1&currency=XXX&discount=100`;
    const parsed = parseSelectionEntry(config, query(priced));
    assert.equal(parsed.kind, 'read');
    if (parsed.kind !== 'read') return;
    assert.deepEqual(parsed.ignored, ['price', 'amount', 'unit_amount', 'total', 'currency', 'discount']);
    assert.deepEqual(parsed.candidate, offered);
    const fields = JSON.stringify(parsed.candidate);
    for (const name of ['price', 'amount', 'total', 'currency', 'discount']) assert.equal(fields.includes(name), false, name);
    const { ignored: pricedIgnored, ...withPrice } = decide(config, priced) as { ignored?: unknown };
    const { ignored: bareIgnored, ...without } = decide(config, path) as { ignored?: unknown };
    assert.deepEqual(withPrice, without);
    assert.deepEqual([pricedIgnored, bareIgnored], [parsed.ignored, []]);
  });

  test(`${config.id}: refusals use the cart's own codes and echo nothing unread`, () => {
    const sku = config.offer.products[0]!.sku, encoded = encodeURIComponent(sku);
    const one = (value: string) => `?mode=one_time&line=${value}`;
    assert.deepEqual(refused(config, one('UNKNOWN-SKU-0%3A1')), [{ code: 'unknown_sku', sku: 'UNKNOWN-SKU-0' }]);
    for (const quantity of ['0', '-1', '1.5', '02', '', '1234567890']) {
      assert.deepEqual(refused(config, one(`${encoded}%3A${quantity}`)), [{ code: 'quantity_invalid', sku }], quantity);
    }
    const over = config.offer.products.map(product => `line=${encodeURIComponent(product.sku)}%3A${config.offer.maxUnits}`).join('&');
    assert.ok(codes(refused(config, `?${over}`)).includes('maximum_units'));
    assert.deepEqual(codes(refused(config, `?line=${encoded}%3A1&line=${encoded}%3A1`)), ['duplicate_sku']);
    const fiftyOne = Array.from({ length: 51 }, (_, index) => `line=S${index}%3A1`).join('&');
    for (const path of [one('nocolon'), one('%3A1'), one(''), one(`${'A'.repeat(129)}%3A1`), one('%3Cb%3E%3A1'),
      `?${fiftyOne}`, `?mode=one_time&mode=one_time&line=${encoded}%3A1`, `?mode=weekly&line=${encoded}%3A1`,
      `?mode=subscription&cadence=28&cadence=28&line=${encoded}%3A1`, `?line=a+b%3A1`]) {
      assert.deepEqual(refused(config, path), [{ code: 'cart_invalid' }], path);
    }
    const offered = Math.max(...config.offer.cadenceDays);
    for (const cadence of [String(offered + 1), '007', '%2B7', '0', '-7']) {
      assert.deepEqual(codes(refused(config, `?mode=subscription&cadence=${cadence}&line=${encoded}%3A2`)), ['cadence_unavailable'], cadence);
    }
    const oneTimeOnly = structuredClone(config);
    oneTimeOnly.offer.products[0]!.permittedPurchaseModes = ['one_time'];
    const modeEntry = parseSelectionEntry(oneTimeOnly, query(`?mode=subscription&line=${encoded}%3A2`));
    assert.equal(modeEntry.kind, 'read');
    if (modeEntry.kind === 'read') {
      assert.equal(modeEntry.candidate.cadenceDays, config.offer.defaultCadenceDays);
      const result = validateCart(oneTimeOnly, modeEntry.candidate);
      assert.ok(!result.ok && codes(result.issues).includes('purchase_mode_unavailable'));
    }
    const ignoredCadence = parseSelectionEntry(config, query(`?cadence=x&mode=one_time&cadence=7&line=${encoded}%3A1`));
    assert.equal(ignoredCadence.kind, 'read');
    if (ignoredCadence.kind === 'read') assert.equal(ignoredCadence.candidate.cadenceDays, null);
    const flood = Array.from({ length: 5000 }, () => `line=${encoded}%3A1`).join('&');
    assert.deepEqual(refused(config, `?${flood}`), [{ code: 'cart_invalid' }]);
  });

  test(`${config.id}: the decision replaces only an empty cart and asks otherwise`, () => {
    const oneTime = selection(config, 'one_time'), subscription = selection(config, 'subscription');
    const oneTimePath = selectionEntryPath(locale, oneTime), subscriptionPath = selectionEntryPath(locale, subscription);
    assert.deepEqual(decide(config, routes.cart[locale]), { kind: 'none' });
    assert.deepEqual(decide(config, '?mode=subscription&cadence=28'), { kind: 'none' });
    assert.deepEqual(decide(config, oneTimePath), { kind: 'apply', cart: oneTime, ignored: [] });
    assert.deepEqual(decide(config, subscriptionPath), { kind: 'apply', cart: subscription, ignored: [] });
    assert.deepEqual(decide(config, subscriptionPath, oneTime), { kind: 'ask', cart: subscription, ignored: [] });
    assert.deepEqual(decide(config, oneTimePath, subscription), { kind: 'ask', cart: oneTime, ignored: [] });
    assert.deepEqual(decide(config, oneTimePath, oneTime), { kind: 'same', ignored: [] });
    assert.equal(decide(config, oneTimePath, { ...oneTime, lines: [...oneTime.lines].reverse() }).kind, 'same');
    const otherLines = { ...oneTime, lines: [{ sku: oneTime.lines[0]!.sku, quantity: 3 }] };
    assert.equal(decide(config, oneTimePath, otherLines).kind, 'ask');
    assert.deepEqual(decide(config, '?line=UNKNOWN-SKU-0%3A1', oneTime),
      { kind: 'refuse', issues: [{ code: 'unknown_sku', sku: 'UNKNOWN-SKU-0' }], ignored: [] });
    const minimum = structuredClone(config);
    minimum.offer.minUnits = 2;
    const below = `?line=${encodeURIComponent(config.offer.products[0]!.sku)}%3A1`;
    assert.deepEqual(decide(minimum, below), { kind: 'refuse', issues: [{ code: 'minimum_units', limit: 2 }], ignored: [] });
    assert.deepEqual(decide(config, oneTimePath, oneTime, 'loading'), { kind: 'wait' });
    assert.deepEqual(decide(config, oneTimePath, emptyCart(config), 'unavailable'), { kind: 'catalogue_unavailable' });
    assert.deepEqual(decide(config, oneTimePath, emptyCart(config), 'unbound', []), { kind: 'apply', cart: oneTime, ignored: [] });
  });

  test(`${config.id}: a link valid only against the configured products follows the catalogue state`, () => {
    const offered = selection(config, 'one_time');
    const path = selectionEntryPath(locale, offered);
    const live = config.offer.products.map(product => ({ ...product, sku: `${product.sku}-LIVE` }));
    assert.equal(decide(config, path, emptyCart(config), 'ready', live).kind, 'refuse');
    assert.deepEqual(decide(config, path, emptyCart(config), 'unbound', live), { kind: 'apply', cart: offered, ignored: [] });
  });
}

test('a SKU with a colon and a dot splits at the last colon; the builder refuses a SKU outside the grammar', () => {
  const config = Object.values(configurations)[0]!;
  const parsed = parseSelectionEntry(config, query(selectionEntryPath(locale, { mode: 'one_time', lines: [{ sku: 'a:b.c', quantity: 2 }] })));
  assert.equal(parsed.kind, 'read');
  if (parsed.kind === 'read') assert.deepEqual(parsed.candidate.lines, [{ sku: 'a:b.c', quantity: 2 }]);
  for (const sku of ['', 'a b', 'a<b', 'A'.repeat(129), 'a+b']) {
    assert.throws(() => selectionEntryPath(locale, { mode: 'one_time', lines: [{ sku, quantity: 1 }] }), /starter_selection_entry_sku_invalid/, sku);
  }
});

test('only the three read parameters leave the address; every other pair keeps its bytes, order and the hash', () => {
  assert.equal(withoutSelectionEntry('/cart', '?mode=one_time&line=a%3A1&price=1&utm_source=x&q=a%20b', '#h'),
    '/cart?price=1&utm_source=x&q=a%20b#h');
  assert.equal(withoutSelectionEntry('/cart', '?mode=one_time&line=a%3A1&cadence=7', ''), '/cart');
  assert.equal(withoutSelectionEntry('/cart', '?mode=one_time&cadence=7&line=a%3A1&cadence=14&x=%7E', ''), '/cart?x=%7E');
  assert.equal(withoutSelectionEntry('/cart', '?li%6Ee=a%3A1&keep', ''), '/cart?keep');
  assert.deepEqual(Object.values(selectionEntryParameter).sort(), ['cadence', 'line', 'mode']);
});

test('managed texts exist in English and Polish, and the documented examples are what the builder writes', () => {
  for (const [key, texts] of Object.entries(selectionEntryCopy)) {
    for (const language of supportedLocales) assert.ok(texts[language].trim().length > 0, `${key}.${language}`);
  }
  const page = readFileSync(join(root, 'docs/customization.md'), 'utf8');
  for (const example of [
    { mode: 'one_time' as const, lines: [{ sku: 'EXAMPLE-SKU-1', quantity: 2 }] },
    { mode: 'subscription' as const, cadenceDays: 28, lines: [{ sku: 'EXAMPLE-SKU-1', quantity: 2 }, { sku: 'EXAMPLE:SKU.2', quantity: 1 }] },
  ]) {
    const path = selectionEntryPath(locale, example);
    assert.ok(page.includes(path.slice(path.indexOf('?'))), path);
  }
});

test('the checkout action anchor is named only through storefrontAnchor', () => {
  const files = (directory: string): string[] => readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
  const literal = [...files(join(root, 'client')), ...files(join(root, 'shared'))]
    .filter(path => /['"`]proceed_to_checkout['"`]/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(literal, []);
  assert.ok(readFileSync(join(root, 'client/pages/storefront.ts'), 'utf8').includes('storefrontAnchor.action.proceed_to_checkout'));
});

test('a store that offers a 7-day cadence still refuses a cadence with leading zeros or zero', () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  const plan = config.subscriptionOffers.classic;
  plan.days = set(7, 14, 28); plan.defaultDays = 14; delete plan.checkoutDays;
  plan.bySku = Object.fromEntries(config.offer.products.map(product => [product.sku, [{ days: plan.days, quantities: range(1, 99, 1) }]]));
  Object.assign(config.offer, { cadenceDays: [7, 14, 28], defaultCadenceDays: 14 });
  const sku = encodeURIComponent(config.offer.products[0]!.sku);
  const seven = parseSelectionEntry(config, query(`?mode=subscription&cadence=7&line=${sku}%3A2`));
  assert.equal(seven.kind, 'read');
  if (seven.kind === 'read') assert.equal(validateCart(config, seven.candidate).ok, true);
  for (const cadence of ['007', '07', '0', '%2B7', '7.0']) {
    assert.deepEqual(parseSelectionEntry(config, query(`?mode=subscription&cadence=${cadence}&line=${sku}%3A2`)),
      { kind: 'refused', issues: [{ code: 'cadence_unavailable' }], ignored: [] }, cadence);
  }
});

test('a catalogue request that rejects, or whose answer cannot be applied, settles as unavailable', async () => {
  const applied: unknown[] = [];
  assert.equal(await settleCatalogueRequest(async () => ({ ok: true as const, products: ['p'] }), result => { applied.push(result); }), undefined);
  assert.deepEqual(applied, [{ ok: true, products: ['p'] }]);
  assert.equal(await settleCatalogueRequest(async () => ({ ok: false as const, code: 'host_binding_required' }), () => undefined), undefined);
  assert.equal(await settleCatalogueRequest(() => Promise.reject(new Error('lost')), () => undefined), 'starter_catalogue_unavailable');
  assert.equal(await settleCatalogueRequest(async () => ({ ok: true as const, products: [] }), () => { throw new Error('reconcile'); }),
    'starter_catalogue_unavailable');
});
