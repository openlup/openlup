import { demoRecoveryConfiguration } from '../shared/recovery-config.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { configurations } from '../owned/store.config.ts';
import { copy } from '../owned/copy.ts';
import { editorCopy } from '../owned/editor-copy.ts';
import { quoteCopy, quoteRefusalCopy } from '../owned/quote-copy.ts';
import { assertConfig, type StoreConfig } from '../shared/config.ts';
import { assertLocaleCopy, assertLocaleMarket, resolveLocale, type LocaleMarket } from '../shared/locales.ts';
import { resolveRoute, routes } from '../shared/routes.ts';

const original = Object.values(configurations)[0]!;
const market = original.market;
const firstLocale = market.locales[0]!;

test('D: configured routes and unknown-path locale choices retain their results', () => {
  for (const [key, translations] of Object.entries(routes)) {
    for (const locale of market.locales) {
      assert.deepEqual(resolveRoute(translations[locale], market), { key, locale });
      if (translations[locale].length > 1) assert.deepEqual(resolveRoute(translations[locale] + '/', market), { key, locale });
      assert.deepEqual(resolveRoute(`${routes.catalog[locale]}/item%20one`, market), { key: 'product', locale, slug: 'item one' });
      assert.deepEqual(resolveRoute(`${routes.catalog[locale]}/%zz`, market), { key: 'notFound', locale });
    }
  }
  assert.deepEqual(resolveRoute('/unknown', market), { key: 'notFound', locale: market.defaultLocale });
  const polish = market.locales.find(locale => routes.home[locale].startsWith('/pl'));
  for (const path of ['/pl/unknown', '/plausible']) {
    assert.deepEqual(resolveRoute(path, market), { key: 'notFound', locale: polish ?? market.defaultLocale });
  }
});

test('configured UI, editor, quote and email translations satisfy startup validation', () => {
  for (const config of Object.values(configurations)) {
    assert.doesNotThrow(() => assertConfig(config), config.id);
  }
});

test('R: empty, duplicate, unsupported and excluded-default locales have named refusals', () => {
  for (const [invalid, message] of [
    [{ locales: [], defaultLocale: firstLocale }, 'starter_locales_invalid'],
    [{ locales: [firstLocale, firstLocale], defaultLocale: firstLocale }, 'starter_locales_invalid'],
    [{ locales: [firstLocale, 'de'], defaultLocale: firstLocale }, 'starter_locale_unsupported: de'],
    [{ locales: [firstLocale], defaultLocale: 'de' }, 'starter_default_locale_invalid'],
  ] as const) {
    const config = structuredClone(original);
    Object.assign(config.market, invalid);
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
    config.subscriptionEditing.catalogue = structuredClone(config.subscriptionEditing.catalogue);
    Reflect.deleteProperty(select(config), firstLocale);
    assert.throws(() => assertConfig(config), { message: `starter_locale_copy_missing: ${path} (${firstLocale})` });
  }
  const config = structuredClone(original);
  Reflect.deleteProperty(config.renewal.notices.copy[firstLocale].paid, 'subject');
  assert.throws(() => assertConfig(config), { message: `starter_locale_copy_missing: renewal.notices.copy.paid.subject (${firstLocale})` });
});

test('R: required UI/editor/quote keys refuse even when absent from every translation', () => {
  for (const [registry, key, path] of [
    [copy, 'cart', 'copy.cart'], [editorCopy, 'close', 'editorCopy.close'],
    [quoteCopy, 'loading', 'quoteCopy.loading'], [quoteRefusalCopy, 'cadence_unavailable', 'quoteRefusalCopy.cadence_unavailable'],
  ] as const) {
    // Include inactive translations: no surviving translation can supply the required key.
    const translations = Object.values(registry);
    const saved = translations.map(translation => Object.getOwnPropertyDescriptor(translation, key)!);
    try {
      for (const translation of translations) Reflect.deleteProperty(translation, key);
      assert.throws(() => assertConfig(original), { message: `starter_locale_copy_missing: ${path} (${firstLocale})` });
    } finally {
      translations.forEach((translation, index) => Object.defineProperty(translation, key, saved[index]!));
    }
  }
  assert.throws(() => assertLocaleCopy({ [firstLocale]: { paid: { subject: '' } } },
    [firstLocale], 'mail', ['paid.subject']), { message: `starter_locale_copy_missing: mail.paid.subject (${firstLocale})` });
});

test('a single configured locale needs no other localized fields and supplies the fallback', () => {
  const config = structuredClone(original);
  config.market.locales = [firstLocale]; config.market.defaultLocale = firstLocale;
  function removeOtherLocales(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (firstLocale in value) for (const locale of market.locales) {
      if (locale !== firstLocale) Reflect.deleteProperty(value, locale);
    }
    for (const child of Object.values(value)) removeOtherLocales(child);
  }
  removeOtherLocales(config);
  assert.doesNotThrow(() => assertConfig(config));
  for (const product of buildDemoSeed(config).products) {
    assert.ok(product.name.trim()); assert.ok(product.description.trim());
  }
  assert.equal(resolveLocale('unknown', config.market), firstLocale);
  assert.equal(resolveLocale(undefined, config.market), firstLocale);
  assert.deepEqual(resolveRoute(routes.catalog[firstLocale], config.market), { key: 'catalog', locale: firstLocale });
  assert.deepEqual(resolveRoute('/unknown', config.market), { key: 'notFound', locale: firstLocale });
  assertLocaleCopy({ [firstLocale]: { only: 'Configured copy' } }, config.market.locales, 'copy', ['only']);
});

test('reordering configured locales preserves explicit routes and uses the chosen default', () => {
  const reordered: LocaleMarket = { locales: [...market.locales].reverse(), defaultLocale: market.locales.at(-1)! };
  assertLocaleMarket(reordered);
  const config = structuredClone(original);
  Object.assign(config.market, reordered);
  assert.doesNotThrow(() => assertConfig(config));
  for (const locale of reordered.locales) {
    assert.equal(resolveLocale(locale, reordered), locale);
    assert.deepEqual(resolveRoute(routes.catalog[locale], reordered), { key: 'catalog', locale });
  }
  assert.equal(resolveLocale('unknown', reordered), reordered.defaultLocale);
  assert.deepEqual(resolveRoute('/unknown', reordered), { key: 'notFound', locale: reordered.defaultLocale });
});

test('R: a recovery state removed from every translation refuses against the independent inventory', () => {
  const config = structuredClone(original);
  if (!config.recovery) config.recovery = structuredClone(demoRecoveryConfiguration);
  Reflect.deleteProperty(config.recovery.states, 'support');
  assert.throws(() => assertConfig(config), { message: `starter_locale_copy_missing: recovery.states.support (${firstLocale})` });
});
