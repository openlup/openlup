import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import { assertConfig, parseHostArguments, type StoreConfig } from '../shared/config.ts';
import { evaluateOffer, type Cart } from '../shared/offer.ts';
import { createBrowserCart } from '../client/cart.ts';

function cart(config: StoreConfig): Cart {
  return { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
    lines: [{ sku: config.offer.products[0]!.sku, quantity: 2 }] };
}

// Managed algorithm tests own their rule boundaries; adopter settings remain mutable.
function offerFixture(original: StoreConfig): StoreConfig {
  const config = structuredClone(original);
  Object.assign(config.offer, { minUnits: 1, maxUnits: 12, shippingMinor: 0,
    freeShippingFromMinor: 0, subscriptionDiscountBps: 500, subscriptionRoundingQuantumMinor: 10,
    cadenceDays: [14, 28, 56], defaultCadenceDays: 28 });
  config.offer.products = config.offer.products.map(product => ({ ...product,
    unitPrice: { amountMinor: 3901, currency: config.market.currency },
    permittedPurchaseModes: ['one_time', 'subscription'],
  }));
  return config;
}

for (const config of Object.values(configurations).map(offerFixture)) {
  test(`${config.id}: one-time offer uses integer money and configured shipping`, () => {
    assertConfig(config);
    const result = evaluateOffer(config, cart(config));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const products = config.offer.products[0]!.unitPrice.amountMinor * 2;
    assert.equal(result.quote.subtotalMinor, products);
    assert.equal(result.quote.discountMinor, 0);
    assert.equal(result.quote.totalMinor, products + config.offer.shippingMinor);
    assert.equal(result.quote.cadenceDays, null);
  });

  test(`${config.id}: the same evaluator applies subscription cadence and rounding`, () => {
    const input = { ...cart(config), mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays };
    const result = evaluateOffer(config, input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.quote.discountMinor, 0);
    assert.equal(result.quote.lines[0]!.unitMinor, 3700);
    assert.equal(result.quote.subtotalMinor, 7400);
    assert.equal(result.quote.modeDiscountMinor, 402);
    assert.equal(result.quote.cadenceDays, config.offer.defaultCadenceDays);
    assert.equal(result.cart.mode, 'subscription');
  });

  test(`${config.id}: client-supplied prices are ignored`, () => {
    const original = cart(config);
    const tampered = { ...original, totalMinor: 1, discountMinor: 99999,
      lines: [{ ...original.lines[0], unitMinor: 1, lineMinor: 1 }] };
    assert.deepEqual(evaluateOffer(config, tampered), evaluateOffer(config, original));
  });

  for (const quantity of [-1, 0, 1.5, NaN, Infinity, 13]) {
    test(`${config.id}: refuses unsafe quantity ${quantity}`, () => {
      const input = cart(config);
      input.lines[0]!.quantity = quantity;
      const result = evaluateOffer(config, input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'quantity_invalid'));
    });
  }

  test(`${config.id}: duplicate SKU cannot evade limits`, () => {
    const input = cart(config);
    input.lines.push({ ...input.lines[0]! });
    const result = evaluateOffer(config, input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'duplicate_sku'));
  });

  test(`${config.id}: unknown SKU, wrong configuration and unavailable cadence refuse`, () => {
    assert.equal(evaluateOffer(config, { ...cart(config), configuration: 'other' }).ok, false);
    assert.equal(evaluateOffer(config, { ...cart(config), lines: [{ sku: 'UNKNOWN', quantity: 1 }] }).ok, false);
    assert.equal(evaluateOffer(config, { ...cart(config), mode: 'subscription', cadenceDays: 999 }).ok, false);
  });

  test(`${config.id}: initial and recurring offers charge zero shipping`, () => {
    for (const mode of ['one_time', 'subscription'] as const) {
      const result = evaluateOffer(config, { ...cart(config), mode, cadenceDays: mode === 'subscription' ? 28 : null });
      assert.ok(result.ok);
      assert.equal(result.quote.shippingMinor, 0);
      assert.equal(result.quote.totalMinor, result.quote.subtotalMinor - result.quote.discountMinor);
    }
  });
}

test('customization changes one rule without separate browser/server validators', () => {
  const custom: StoreConfig = offerFixture(Object.values(configurations)[0]!);
  custom.brand.name = 'Fictional Workshop';
  custom.offer.layout = 'cards';
  custom.offer.minUnits = 3;
  assertConfig(custom);
  const result = evaluateOffer(custom, cart(custom));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'minimum_units' && issue.limit === 3));
});

test('malformed input and a configuration with unsafe money refuse', () => {
  for (const input of [null, [], '', {}, { lines: [] }]) {
    assert.equal(evaluateOffer(Object.values(configurations)[0]!, input).ok, false);
  }
  const custom: StoreConfig = offerFixture(Object.values(configurations)[0]!);
  custom.offer.products[0]!.unitPrice.amountMinor = Number.MAX_SAFE_INTEGER;
  assert.equal(evaluateOffer(custom, cart(custom)).ok, false);
});

for (const original of Object.values(configurations)) {
  test(`${original.id}: partial browser selections survive reload and storage events below the checkout minimum`, () => {
    const config: StoreConfig = structuredClone(original);
    config.offer.minUnits = 3;
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: key => values.get(key) ?? null,
      key: index => [...values.keys()][index] ?? null,
      removeItem: key => { values.delete(key); },
      setItem: (key, value) => { values.set(key, value); },
    };
    const events = new EventTarget();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      localStorage: storage,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    const notices: string[] = [];
    const key = `neutral-store:cart:v1:${config.id}`;
    const selected = cart(config);
    const first = createBrowserCart(config, kind => notices.push(kind));
    let restored: ReturnType<typeof createBrowserCart> | undefined;
    try {
      first.set(selected);
      first.close();
      restored = createBrowserCart(config, kind => notices.push(kind));
      assert.deepEqual(restored.get(), selected);
      assert.equal(notices.includes('cartReset'), false);
      assert.equal(evaluateOffer(config, restored.get()).ok, false);

      const oneUnit = { ...selected, lines: [{ ...selected.lines[0]!, quantity: 1 }] };
      // Extra client prices must not survive canonical restoration of a partial selection.
      const incoming = { ...oneUnit, totalMinor: 1,
        lines: [{ ...oneUnit.lines[0], unitMinor: 1 }] };
      events.dispatchEvent(Object.assign(new Event('storage'), {
        key, storageArea: storage, newValue: JSON.stringify(incoming),
      }));
      assert.deepEqual(restored.get(), oneUnit);
      assert.equal(notices.includes('cartReset'), false);
      assert.ok(notices.includes('storageChanged'));

      events.dispatchEvent(Object.assign(new Event('storage'), {
        key, storageArea: storage, newValue: JSON.stringify({ ...oneUnit,
          lines: [{ sku: 'UNKNOWN', quantity: 1 }] }),
      }));
      assert.deepEqual(restored.get().lines, []);
      assert.ok(notices.includes('cartReset'));
    } finally {
      first.close();
      restored?.close();
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

for (const original of Object.values(configurations)) {
  test(`${original.id}: owned minimum three and threshold 10000 need no managed test edits`, () => {
    const config = offerFixture(original);
    config.offer.minUnits = 3;
    config.offer.freeShippingFromMinor = 10000;
    assertConfig(config);
    const below = evaluateOffer(config, cart(config));
    assert.equal(below.ok, false);
    if (!below.ok) assert.deepEqual(below.issues, [{ code: 'minimum_units', limit: 3 }]);
    const selected = cart(config);
    selected.lines[0]!.quantity = 3;
    const result = evaluateOffer(config, selected);
    assert.ok(result.ok);
    assert.equal(result.quote.subtotalMinor, 11703);
    assert.equal(result.quote.shippingMinor, 0);
    const recurring = evaluateOffer(config, { ...selected, mode: 'subscription', cadenceDays: 28 });
    assert.ok(recurring.ok);
    assert.equal(recurring.quote.discountMinor, 0);
    assert.equal(recurring.quote.modeDiscountMinor, 603);
    assert.equal(recurring.quote.totalMinor, 11100);
  });
}


for (const id of ['', 'Upper', 'two words', '../escape', '-prefix', 'suffix-', 'two--dashes', 'x'.repeat(81)]) {
  test(`configuration refuses a non-slug identity: ${id}`, () => {
    const config = offerFixture(Object.values(configurations)[0]!);
    config.id = id;
    assert.throws(() => assertConfig(config), { message: 'starter_configuration_invalid' });
  });
}

test('configuration accepts a third fictional slug without changing the shared type', () => {
  const config = offerFixture(Object.values(configurations)[0]!);
  config.id = 'harbor-objects';
  assertConfig(config);
  assert.ok(evaluateOffer(config, cart(config)).ok);
});


test('host arguments have a non-secret loopback default and explicit configuration, port and listen', () => {
  assert.deepEqual(parseHostArguments([]), { configuration: undefined, port: 4319, listen: '127.0.0.1' });
  assert.deepEqual(parseHostArguments(['--configuration', 'harbor-objects', '--port', '4321', '--listen', '0.0.0.0']),
    { configuration: 'harbor-objects', port: 4321, listen: '0.0.0.0' });
});

for (const [args, code] of [
  [['--unknown', 'value'], 'starter_argument_unknown'],
  [['--port'], 'starter_argument_value_required'],
  [['--configuration', '--port', '4319'], 'starter_argument_value_required'],
  [['--port', 'NaN'], 'starter_port_invalid'],
  [['--port', '4e3'], 'starter_port_invalid'],
  [['--port', '4319.5'], 'starter_port_invalid'],
  [['--port', '80'], 'starter_port_invalid'],
  [['--port', '65536'], 'starter_port_invalid'],
  [['--listen', '192.0.2.1'], 'starter_listen_invalid'],
  [['--port', '4319', '--port', '4320'], 'starter_argument_duplicate'],
] as const) {
  test(`host arguments refuse ${args.join(' ')}`, () => {
    assert.throws(() => parseHostArguments(args), { message: code });
  });
}

test('fictional market formats validate without a named deployment market', () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.market = { country: 'ZZ', currency: 'XTS', timezone: 'UTC', locales: ['en', 'pl'] };
  for (const product of config.offer.products) product.unitPrice.currency = 'XTS';
  assertConfig(config);
  for (const market of [{ ...config.market, currency: 'bad' }, { ...config.market, country: 'bad' },
    { ...config.market, timezone: 'Invalid/Timezone' }]) {
    assert.throws(() => assertConfig({ ...config, market }), { message: 'starter_market_invalid' });
  }
});
