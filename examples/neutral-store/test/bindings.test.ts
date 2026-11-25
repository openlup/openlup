import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import type { StoreConfig } from '../shared/config.ts';
import { dispatchAction, pendingBindings, requesterKeyFor, type ActionContext } from '../host/bindings.ts';
import { createHash } from 'node:crypto';
import { composeNativeBindings } from '../host/native-composition.ts';
import type { IncomingMessage } from 'node:http';

const context: ActionContext = {
  commandKey: 'test-command-123456', actor: { customerRef: null, operatorRef: null }, config: Object.values(configurations)[0]!,
};

test('operator and account actions refuse before touching an injected store', async () => {
  let called = 0;
  const bindings = pendingBindings();
  bindings.actions['operator.orders'] = async () => { called++; return { ok: true, value: [] }; };
  bindings.actions['account.orders'] = async () => { called++; return { ok: true, value: [] }; };
  assert.deepEqual(await dispatchAction(bindings, 'operator.orders', {}, context), { ok: false, code: 'operator_required' });
  assert.deepEqual(await dispatchAction(bindings, 'account.orders', {}, context), { ok: false, code: 'customer_session_required' });
  assert.equal(called, 0);
});

test('missing native checkout binding cannot produce a fake order', async () => {
  const config = context.config;
  const input = { cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
    lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }] },
  termsAccepted: true, termsRevision: config.legal.revision };
  assert.deepEqual(await dispatchAction(pendingBindings(), 'checkout.create', input, context),
    { ok: false, code: 'host_binding_required' });
});

test('malformed cart identity refuses before delegating to a checkout binding', async () => {
  let called = 0;
  const bindings = pendingBindings();
  bindings.actions['checkout.create'] = async () => { called++; return { ok: true, value: null }; };
  const result = await dispatchAction(bindings, 'checkout.create', { cart: { schemaVersion: 1,
    configuration: context.config.id, mode: 'one_time', lines: [{ sku: 'UNKNOWN', quantity: 0 }] },
  termsAccepted: true, termsRevision: context.config.legal.revision }, context);
  assert.equal(result.ok, false);
  assert.equal(called, 0);
});

test('declared customer identifiers in browser payload do not establish a session', async () => {
  const result = await dispatchAction(pendingBindings(), 'account.read',
    { customerRef: 'somebody-else', operatorRef: 'administrator' }, context);
  assert.deepEqual(result, { ok: false, code: 'customer_session_required' });
});

for (const original of Object.values(configurations)) {
  test(`${original.id}: checkout delegates current membership to the receipt-aware binding`, async () => {
    const config: StoreConfig = structuredClone(original);
    config.offer.minUnits = 3;
    let called = 0;
    const bindings = pendingBindings();
    bindings.actions['checkout.create'] = async () => { called++; return { ok: false, code: 'fixture_receipt_binding' }; };
    const result = await dispatchAction(bindings, 'checkout.create', {
      cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
        lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] },
      termsAccepted: true, termsRevision: config.legal.revision,
    }, { ...context, config });
    assert.deepEqual(result, { ok: false, code: 'fixture_receipt_binding' });
    assert.equal(called, 1);
  });
}

test('only a structured published quote request resolves a fresh private catalogue', async () => {
  const config = context.config;
  const seedProducts = config.offer.products;
  const getBindings = () => {
    const bindings = pendingBindings();
    bindings.actions['offer.validate'] = async (_input, bound) => ({
      ok: true, value: bound.quoteProducts?.map(({ sku }) => sku) ?? 'seed-only',
    });
    return bindings;
  };
  const baseline = getBindings(), bindings = getBindings();
  let walks = 0;
  bindings.resolveCatalogue = async () => {
    walks++;
    return { ok: true, value: { products: [...seedProducts, { ...seedProducts[0]!, sku: 'ARTICLE-SIBLING' }] } };
  };
  const cart = { schemaVersion: 1, configuration: config.id, mode: 'one_time',
    lines: [{ sku: seedProducts[0]!.sku, quantity: config.offer.minUnits }] };
  for (const input of [{ cart }, { cart: { ...cart, lines: [{ sku: 'ARTICLE-SIBLING', quantity: 0 }] } }, { cart: null }]) {
    assert.equal(JSON.stringify(await dispatchAction(bindings, 'offer.validate', input, context)),
      JSON.stringify(await dispatchAction(baseline, 'offer.validate', input, context)));
  }
  assert.equal(walks, 0);
  const result = await dispatchAction(bindings, 'offer.validate', {
    cart: { ...cart, lines: [{ sku: 'ARTICLE-SIBLING', quantity: config.offer.minUnits }] },
  }, context);
  assert.deepEqual(result, { ok: true, value: [...seedProducts.map(item => item.sku), 'ARTICLE-SIBLING'] });
  assert.equal(walks, 1);
  assert.equal(context.quoteProducts, undefined);
  assert.deepEqual(await dispatchAction(bindings, 'storefront.catalogue', {}, context), { ok: false, code: 'host_binding_required' });
});

test('the requester key is the socket peer digest unless replaced', () => {
  const peer = (remoteAddress: string | undefined) => ({ socket: { remoteAddress } }) as IncomingMessage;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  assert.equal(requesterKeyFor(peer('127.0.0.1')), digest('127.0.0.1'));
  assert.equal(requesterKeyFor(peer('::FFFF:127.0.0.1')), digest('::ffff:127.0.0.1'));
  assert.equal(requesterKeyFor(peer('2001:DB8::1')), digest('2001:db8::1'));
  assert.equal(requesterKeyFor(peer(undefined)), undefined);
  // The replacement reaching the limiter is proved against PostgreSQL, where the native host is composed.
});

test('a requester key replacement that is not a function refuses at composition with a fix', async () => {
  await assert.rejects(composeNativeBindings('postgresql://unused.invalid/none', {} as never, context.config, undefined, undefined,
    { requesterKey: 'peer' as never }), /OPENLUP_E_STARTER_REQUESTER_KEY_INVALID[\s\S]*Fix: /);
});
