import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configurations } from '../owned/store.config.ts';
import { copy } from '../owned/copy.ts';
import { editorCopy } from '../owned/editor-copy.ts';
import { quoteCopy, quoteRefusalCopy } from '../owned/quote-copy.ts';
import { renewalNoticeCopy } from '../owned/renewal-copy.ts';
import { assertConfig, type StoreConfig } from '../shared/config.ts';
import { assertLocaleCopy, assertLocaleMarket, resolveLocale, type LocaleMarket } from '../shared/locales.ts';
import { resolveRoute, routes } from '../shared/routes.ts';

const original = Object.values(configurations)[0]!;
const demoMarket = { locales: ['en', 'pl'], defaultLocale: 'en' } as const;

test('D: all demo routes and unknown-path locale choices retain their previous results', () => {
  for (const [key, translations] of Object.entries(routes)) {
    for (const locale of demoMarket.locales) {
      assert.deepEqual(resolveRoute(translations[locale], demoMarket), { key, locale });
      if (translations[locale] !== '/') assert.deepEqual(resolveRoute(translations[locale] + '/', demoMarket), { key, locale });
    }
  }
  for (const [path, locale] of [['/unknown', 'en'], ['/pl/unknown', 'pl'], ['/plausible', 'pl']] as const) {
    assert.deepEqual(resolveRoute(path, demoMarket), { key: 'notFound', locale });
  }
  assert.deepEqual(resolveRoute('/products/item%20one', demoMarket), { key: 'product', locale: 'en', slug: 'item one' });
  assert.deepEqual(resolveRoute('/produkty/item%20one', demoMarket), { key: 'product', locale: 'pl', slug: 'item one' });
  assert.deepEqual(resolveRoute('/products/%zz', demoMarket), { key: 'notFound', locale: 'en' });
});

test('D: UI, editor, quote and email text retain the en/pl baseline bytes', () => {
  // JSON digests captured from 81016c600, before the registry change.
  for (const [registry, digest] of [
    [copy, '6fdb965b5997d0e5f78114d319e5f44f53aedadea87a8682b9d2f8d0a16a651e'],
    [editorCopy, 'c864648bcbd81c3da28e949a0fe51a70868461ace9aa14e5038f0fb8dcf1d35a'],
    [quoteCopy, 'e25f98c2b233dd6c9c0a3d94ddcc13462e18906e63d3d7d9ac6fd3b0bee9e33d'],
    [quoteRefusalCopy, 'bbd25b6270f15cb36b4f0d78de4ef39c360c2a42952d4d900ea01cb69a523582'],
    [renewalNoticeCopy, '6ca9c7528d3047ee7d2645041c0207c1bf8e0f1fc2f429d6aa67d0d2f533d302'],
  ] as const) assert.equal(createHash('sha256').update(JSON.stringify(registry)).digest('hex'), digest);
});

test('R: empty, duplicate, unsupported and excluded-default locales have named refusals', () => {
  for (const [market, message] of [
    [{ locales: [], defaultLocale: 'en' }, 'starter_locales_invalid'],
    [{ locales: ['en', 'en'], defaultLocale: 'en' }, 'starter_locales_invalid'],
    [{ locales: ['en', 'de'], defaultLocale: 'en' }, 'starter_locale_unsupported: de'],
    [{ locales: ['pl'], defaultLocale: 'en' }, 'starter_default_locale_invalid'],
  ] as const) {
    const config = structuredClone(original);
    Object.assign(config.market, market);
    assert.throws(() => assertConfig(config), { message });
  }
});

test('R: startup names the absent localized key and configured locale', () => {
  for (const [path, select] of [
    ['brand.strapline', (c: StoreConfig) => c.brand.strapline],
    ['copy.heroTitle', (c: StoreConfig) => c.copy.heroTitle],
    ['media.heroAlt', (c: StoreConfig) => c.media.heroAlt],
    ['offer.products[0].name', (c: StoreConfig) => c.offer.products[0]!.name],
    ['subscriptionEditing.catalogue[0].description', (c: StoreConfig) => c.subscriptionEditing.catalogue[0]!.description],
    ['purchase.recoveryMessage.subject', (c: StoreConfig) => c.purchase.recoveryMessage.subject],
    ['returns.reasons[0].label', (c: StoreConfig) => c.returns.reasons[0]!.label],
    ['orderControls.holdReasons[0].label', (c: StoreConfig) => c.orderControls.holdReasons[0]!.label],
    ['recovery.states.support', (c: StoreConfig) => c.recovery!.states.support],
  ] as const) {
    const config = structuredClone(original);
    config.market = { ...config.market, ...demoMarket };
    config.subscriptionEditing.catalogue = structuredClone(config.subscriptionEditing.catalogue);
    Reflect.deleteProperty(select(config), 'pl');
    assert.throws(() => assertConfig(config), { message: `starter_locale_copy_missing: ${path} (pl)` });
  }
  const config = structuredClone(original);
  Reflect.deleteProperty(config.renewal.notices.copy.pl.paid, 'subject');
  assert.throws(() => assertConfig(config), { message: 'starter_locale_copy_missing: renewal.notices.copy.paid.subject (pl)' });
});

test('R: missing owned UI/editor/quote copy refuses through the startup validator', () => {
  for (const [registry, key, path] of [
    [copy.pl, 'cart', 'copy.cart'], [editorCopy.pl, 'close', 'editorCopy.close'],
    [quoteCopy.pl, 'loading', 'quoteCopy.loading'], [quoteRefusalCopy.pl, 'cadence_unavailable', 'quoteRefusalCopy.cadence_unavailable'],
  ] as const) {
    const value = registry[key as keyof typeof registry];
    try {
      Reflect.deleteProperty(registry, key);
      const config = structuredClone(original);
      config.market = { ...config.market, ...demoMarket };
      assert.throws(() => assertConfig(config), { message: `starter_locale_copy_missing: ${path} (pl)` });
    } finally { Reflect.set(registry, key, value); }
  }
  assert.throws(() => assertLocaleCopy({ en: { paid: { subject: 'Paid' } }, pl: { paid: { subject: '' } } },
    demoMarket.locales, 'mail'), { message: 'starter_locale_copy_missing: mail.paid.subject (pl)' });
});

test('a Polish-only configuration needs no English localized fields and falls back to Polish', () => {
  const config = structuredClone(original);
  config.market.locales = ['pl']; config.market.defaultLocale = 'pl';
  function removeEnglish(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if ('pl' in value) Reflect.deleteProperty(value, 'en');
    for (const child of Object.values(value)) removeEnglish(child);
  }
  removeEnglish(config);
  assert.doesNotThrow(() => assertConfig(config));
  assert.equal(resolveLocale('en', config.market), 'pl');
  assert.equal(resolveLocale(undefined, config.market), 'pl');
  assert.deepEqual(resolveRoute('/produkty', config.market), { key: 'catalog', locale: 'pl' });
  assert.deepEqual(resolveRoute('/products', config.market), { key: 'notFound', locale: 'pl' });
  assert.deepEqual(resolveRoute('/unknown', config.market), { key: 'notFound', locale: 'pl' });
  assertLocaleCopy({ pl: { only: 'Tylko polski' } }, config.market.locales, 'copy');
});

test('the supplied bilingual locale literal preserves explicit routes and uses Polish for the fallback', () => {
  const market: LocaleMarket = { locales: ['pl', 'en'], defaultLocale: 'pl' };
  assertLocaleMarket(market);
  const config = structuredClone(original);
  Object.assign(config.market, market);
  assert.doesNotThrow(() => assertConfig(config));
  assert.equal(resolveLocale('en', market), 'en');
  assert.equal(resolveLocale('unknown', market), 'pl');
  assert.deepEqual(resolveRoute('/products', market), { key: 'catalog', locale: 'en' });
  assert.deepEqual(resolveRoute('/produkty', market), { key: 'catalog', locale: 'pl' });
  assert.deepEqual(resolveRoute('/unknown', market), { key: 'notFound', locale: 'pl' });
});
