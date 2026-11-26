import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storefrontAnchor } from '@openlup/platform/storefront';
import { checkoutFieldAnchors, paymentAttemptAnchor } from '../client/pages/checkout.ts';

const root = new URL('..', import.meta.url).pathname;

// K1: the checkout field map is total over storefrontAnchor.field, and each value is one of its members.
// `npm run typecheck` proves the map's `satisfies` clause; this row proves totality at run time.
test('the checkout field map names every storefront field anchor exactly once', () => {
  const values: string[] = Object.values(checkoutFieldAnchors);
  const members: string[] = Object.values(storefrontAnchor.field);
  for (const value of values) assert.ok(members.includes(value), `${value} is not a storefrontAnchor.field member`);
  assert.equal(new Set(values).size, values.length, 'one control per field anchor');
  assert.deepEqual([...values].sort(), [...members].sort());
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
  const files = (directory: string): string[] => readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
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
