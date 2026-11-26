import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storefrontAnchor } from '@openlup/platform/storefront';
import { checkoutFieldAnchors, checkoutStateAnchors, paymentAttemptAnchor } from '../client/pages/checkout.ts';

const root = new URL('..', import.meta.url).pathname;
const files = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
});

// K1: the checkout field map is total over storefrontAnchor.field, and each value is one of its members.
// `npm run typecheck` proves the map's `satisfies` clause; this row proves totality at run time.
test('the checkout field map names every storefront field anchor exactly once', () => {
  const values: string[] = Object.values(checkoutFieldAnchors);
  const members: string[] = Object.values(storefrontAnchor.field);
  for (const value of values) assert.ok(members.includes(value), `${value} is not a storefrontAnchor.field member`);
  assert.equal(new Set(values).size, values.length, 'one control per field anchor');
  assert.deepEqual([...values].sort(), [...members].sort());
  // Each mapped field of the form renders its anchor.
  const page = readFileSync(join(root, 'client/pages/checkout.ts'), 'utf8');
  for (const name of Object.keys(checkoutFieldAnchors))
    assert.ok(page.includes(`{ name: '${name}', anchor: checkoutFieldAnchors.${name},`), `${name} control carries its anchor`);
});

// K3: the payment-status page names a state only for the attempt states it can show.
test('the payment-status page maps attempt states to storefront state anchors', () => {
  assert.equal(paymentAttemptAnchor('refused'), storefrontAnchor.state.declined);
  assert.equal(paymentAttemptAnchor('dispatched'), storefrontAnchor.state.awaiting_authority);
  assert.equal(paymentAttemptAnchor('indeterminate'), storefrontAnchor.state.awaiting_authority);
  for (const other of ['captured', 'expired', null, undefined, 'unknown']) assert.equal(paymentAttemptAnchor(other), null, String(other));
});

// K4: no anchor value is written by hand in the starter's page code. Anchors are markup, so the scan covers `client/`;
// `shared/storefront-bindings.ts` names outcome classes such as `awaiting_authority`, which are not anchors.
test('anchor values are read from storefrontAnchor, never written as literals', () => {
  // Only names that are anchors and nothing else; plain words such as `email` or `paid` are also field names and statuses.
  const names = [...Object.values(storefrontAnchor.action), ...Object.values(storefrontAnchor.state),
    ...Object.values(storefrontAnchor.field)].filter(name => name.includes('_'));
  const literal = new RegExp(`['"\`](?:${names.join('|')})['"\`]`);
  const found = files(join(root, 'client'))
    .filter(path => literal.test(readFileSync(path, 'utf8')));
  assert.deepEqual(found, []);
  const page = readFileSync(join(root, 'client/pages/checkout.ts'), 'utf8');
  for (const read of ['storefrontAnchor.action.place_order', 'storefrontAnchor.action.retry_payment', 'storefrontAnchor.attribute.state'])
    assert.ok(page.includes(read), read);
});

// K2: one create path. Only the bindings module sends `checkout.create`; `shared/api.ts` lists the operation.
// Browser rows assert that every create's Idempotency-Key equals the stored record's `id`.
test('only the checkout bindings name checkout.create as a request', () => {
  const allowed = [join(root, 'shared/api.ts'), join(root, 'shared/storefront-bindings.ts')];
  const found = [...files(join(root, 'client')), ...files(join(root, 'shared'))]
    .filter(path => !allowed.includes(path) && /['"`]checkout\.create['"`]/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(found, []);
  assert.match(readFileSync(join(root, 'shared/storefront-bindings.ts'), 'utf8'), /act\('checkout\.create'/);
});

// K5: the status map is typed `satisfies Record<PurchaseContinuationSnapshot['status'], …>`, so `npm run typecheck`
// proves it covers every status; at run time every state anchor is the value of some status.
test('the checkout status map names every storefront state anchor', () => {
  const values = Object.values(checkoutStateAnchors).filter(value => value !== null);
  assert.deepEqual([...new Set(values)].sort(), Object.values(storefrontAnchor.state).sort());
  assert.equal(checkoutStateAnchors.idle, null);
  assert.equal(checkoutStateAnchors.unknown, null);
});
