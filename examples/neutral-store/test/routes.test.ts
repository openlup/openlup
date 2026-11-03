import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDestinations, resolveRoute, routes } from '../shared/routes.ts';
import { nativeLimits } from '../shared/limits.ts';
import { operations, isOperation } from '../shared/api.ts';
import { copy } from '../owned/copy.ts';

test('accepted method setup and saved account draft limitations retain named actions', () => {
  assert.ok(nativeLimits.find(limit => limit.id === 'N6')!.actions.includes('setupPaymentMethod'));
  assert.ok(nativeLimits.find(limit => limit.id === 'N9')!.actions.includes('resumeAccountDraft'));
});

test('every message destination resolves in Polish and English without collisions', () => {
  const seen = new Set<string>();
  for (const [key, locales] of Object.entries(routes)) {
    for (const locale of ['en', 'pl'] as const) {
      assert.equal(seen.has(locales[locale]), false, locales[locale]);
      seen.add(locales[locale]);
      assert.deepEqual(resolveRoute(locales[locale]), { key, locale });
    }
  }
  for (const destination of messageDestinations) {
    for (const locale of ['en', 'pl'] as const) {
      const route = resolveRoute(routes[destination.route][locale]);
      assert.equal(route.key, destination.route);
      assert.equal(route.locale, locale);
    }
  }
});

test('malformed path encoding is an unknown page, never an exception', () => {
  assert.deepEqual(resolveRoute('/products/%zz'), { key: 'notFound', locale: 'en' });
});

test('both locales supply every copy key and every named-limit action', () => {
  assert.deepEqual(Object.keys(copy.en).sort(), Object.keys(copy.pl).sort());
  assert.equal(nativeLimits.length, 10);
  for (const limit of nativeLimits) {
    assert.ok(limit.code.trim());
    for (const action of limit.actions) {
      assert.ok(copy.en[action]);
      assert.ok(copy.pl[action]);
    }
  }
});


test('all unavailable account preference and private-view actions retain the same explicit refusal', () => {
  const limit = nativeLimits.find(limit => limit.id === 'N5')!;
  assert.equal(limit.code, 'starter_account_preferences_unavailable');
  assert.deepEqual(limit.actions, ['savedAddresses', 'billing', 'deliveryPreference', 'paymentPreference', 'privateProfile', 'profileViews']);
});

test('operator select choices use copy keys present in both languages', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../client/pages/operator.ts', import.meta.url), 'utf8');
  function checkChoices(text: string): number {
    const choices = [...text.matchAll(/\{\s*value:\s*'[^']+',\s*text:\s*([^}]+)\}/g)];
    assert.ok(choices.length > 0, 'operator choices must be inspected');
    for (const choice of choices) {
      const key = /^context\.t\('([^']+)'\)\s*$/.exec(choice[1]!.trim())?.[1];
      assert.ok(key, 'operator option labels must use owned copy keys');
      for (const locale of ['en', 'pl'] as const) {
        assert.ok(Object.hasOwn(copy[locale], key), `${locale}: ${key}`);
        assert.ok(copy[locale][key as keyof typeof copy.en].trim());
      }
    }
    return choices.length;
  }
  assert.equal(checkChoices(source), 7);
  // Negative witness: a wire value planted as visible text must be rejected.
  assert.throws(() => checkChoices(source.replace("context.t('reviewPublish')", "'publish'")), /owned copy keys/);
});


test('the message intake destination opens the operator partner panel; support is static', () => {
  assert.deepEqual(messageDestinations.find(item => item.id === 'T07-12'),
    { id: 'T07-12', route: 'admin', hash: 'partners' });
  assert.deepEqual(messageDestinations.find(item => item.id === 'T07-13'),
    { id: 'T07-13', route: 'support' });
  for (const path of ['/inquiry', '/zapytanie']) assert.equal(resolveRoute(path).key, 'notFound');
  assert.equal(operations.length, 52);
  assert.equal(isOperation(['inquiry', 'submit'].join('.')), false);
});
