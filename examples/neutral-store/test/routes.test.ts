import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDestinations, resolveRoute, routes } from '../shared/routes.ts';
import { nativeLimits } from '../shared/limits.ts';
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
