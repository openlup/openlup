import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { launch, preflight, qualifyCard, qualifyTax, runChild } from '../host/provider-qualification.ts';
import { credentialRefusal, integrityRefusal, openTestProvider, sdkVersion, type VerifiedTestProvider } from '../host/provider-transport.ts';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const pin = Object.entries(manifest.providerQualification?.dependencies ?? manifest.dependencies)
  .find(([, version]) => version === sdkVersion);
assert.ok(pin, 'The installed SDK is the exact opt-in pin.');
const sdk = (await import(pin[0])).default;
const account = 'acct_OwnerSample01';
const keyName = 'PROVIDER_TEST_KEY';
const sentinel = ['sk', 'test', 'SyntheticDoNotLogFixture'].join('_');
const args = ['--run', '--test-mode', '--account', account, '--key-env', keyName];
const good = { object: 'account', id: account };
const testMode = { object: 'balance', livemode: false };
const reply = (body: object, status = 200) => Object.assign(new sdk.HttpClientResponse(status, {}), {
  toJSON: async () => structuredClone(body), getRawResponse: () => ({}),
});
type Wire = NonNullable<NonNullable<Parameters<typeof openTestProvider>[1]>['http']>;
const health: Wire = async (_host, _port, path) => {
  if (path === '/v1/account') return reply(good);
  assert.equal(path, '/v1/balance');
  return reply(testMode);
};
const open = (http: Wire, options: Omit<NonNullable<Parameters<typeof openTestProvider>[1]>, 'http'> = {}) =>
  openTestProvider({ secretKey: sentinel, accountRef: account }, { ...options, http });

test('owner tax bridge refuses invalid flag or execution context before reading credentials or launching', async () => {
  let reads = 0, launched = 0;
  const environment = new Proxy({ CI: 'true' }, { get(target, name, receiver) {
    if (name === keyName) { reads++; throw new Error(sentinel); }
    return Reflect.get(target, name, receiver);
  } });
  const spawn = (() => { launched++; throw new Error(sentinel); }) as unknown as NonNullable<Parameters<typeof launch>[1]>['spawn'];
  for (const [flags, interactive, context] of [
    [args, true, environment], [args, false, {}], [[...args, '--run'], true, {}],
    [args.slice(1), true, {}], [[...args.slice(0, -1), 'NODE_OPTIONS'], true, {}],
    [[...args.slice(0, 3), 'foreign', ...args.slice(4)], true, {}],
  ] as const) {
    assert.throws(() => launch([...flags], { interactive, environment: context, spawn }), /interactive session outside CI/);
    await assert.rejects(runChild([...flags], { interactive, environment: context, open: async () => { launched++; throw new Error(sentinel); } }),
      /interactive session outside CI/);
  }
  assert.equal(reads, 0);
  assert.equal(launched, 0);
  assert.deepEqual(preflight(args, true, {}), { accountRef: account, keyEnv: keyName });
});

test('only the test secret class and two independent scoped reads can open a transport', async () => {
  const http: Wire = async () => { assert.fail('Unexpected wire call.'); };
  for (const prefix of [['sk', 'live'], ['rk', 'live'], ['rk', 'test']]) {
    await assert.rejects(openTestProvider({ secretKey: [...prefix, 'Sample'].join('_'), accountRef: account }, { http }),
      new Error(credentialRefusal));
  }
  for (const [identity, balance] of [[{ ...good, id: 'acct_Foreign010' }, testMode], [{ id: account }, testMode],
    [good, { ...testMode, livemode: true }], [good, { ...testMode, livemode: 'false' }], [good, { livemode: false }]] as const) {
    await assert.rejects(open(async (_host, _port, path, method) => {
      assert.equal(method, 'GET');
      assert.ok(path === '/v1/account' || path === '/v1/balance');
      return reply(path === '/v1/account' ? identity : balance);
    }), new Error(integrityRefusal));
  }
  const paths: string[] = [];
  const provider = await open(async (...request) => {
    const [origin, , path, method, headers] = request;
    paths.push(path);
    assert.equal(method, 'GET');
    assert.equal(origin, 'api.' + pin[0] + '.com');
    assert.ok(!Object.entries(headers).some(([name, value]) => name.toLowerCase().endsWith('-account') && value));
    return health(...request);
  });
  assert.deepEqual(paths, ['/v1/account', '/v1/balance']);
  assert.deepEqual(provider.scope, { accountRef: account, mode: 'test' });
  assert.ok(Object.isFrozen(provider) && Object.isFrozen(provider.scope));
});

test('all SDK early-retry errors and timeouts leave one attempt and a bound unknown effect', async () => {
  for (const code of [...sdk.HttpClient.CONNECTION_CLOSED_ERROR_CODES, sdk.HttpClient.TIMEOUT_ERROR_CODE]) {
    let writes = 0;
    const observed: object[] = [];
    const provider = await open(async (...request) => {
      if (request[3] === 'GET') return health(...request);
      writes++;
      assert.equal(request[7], 10_000);
      throw Object.assign(new Error(sentinel), { code });
    }, { record: row => observed.push(row) });
    const key = { idempotencyKey: 'mutation-key' };
    await assert.rejects(provider.card.customer({ metadata: { value: 'example' } }, key), /transport is unavailable/);
    await assert.rejects(provider.card.customer({ metadata: { value: 'changed' } }, key), new Error(integrityRefusal));
    assert.equal(writes, 1);
    assert.match(JSON.stringify(observed), /"effect":"unknown"/u);
    assert.doesNotMatch(JSON.stringify(observed), /mutation-key|SyntheticDoNotLogFixture/u);
  }
});

test('known replay retains the exact request and respects both deadlines', async () => {
  let now = 1_000;
  const sent: unknown[][] = [], ages: number[] = [];
  const provider = await open(async (...request) => {
    if (request[3] === 'GET') return health(...request);
    sent.push(request.slice(2, 6));
    return reply({ id: 'pi_Sample', amount_received: 1000 });
  }, { now: () => now, record: row => { if (row.replayAgeMs !== undefined) ages.push(row.replayAgeMs); } });
  const key = { idempotencyKey: 'capture-key' };
  await provider.card.capture('pi_Sample', key, 3_000);
  now = 2_000;
  await provider.card.capture('pi_Sample', key, 3_000);
  assert.ok(isDeepStrictEqual(sent[0], sent[1]));
  assert.deepEqual(ages, [1_000]);
  now = 3_000;
  await assert.rejects(provider.card.capture('pi_Sample', key, 3_000), new Error(integrityRefusal));
  const tax = { idempotencyKey: 'tax-key' };
  const params = { calculation: 'taxcalc_fixture', reference: 'sale-reference' };
  await provider.tax.transactions.createFromCalculation(params, tax);
  now += 23 * 60 * 60 * 1_000;
  await assert.rejects(provider.tax.transactions.createFromCalculation(params, tax), new Error(integrityRefusal));
  assert.equal(sent.length, 3);
});

test('tax errors expose structural fixed fields and remedies', async () => {
  const cases = [
    ['customer_tax_location_invalid', '', 400, 'invalid_request_error', 'tax_invalid_input', '/input/destination/address'],
    ['', 'tax_date', 400, 'invalid_request_error', 'tax_invalid_input', '/input/taxDate'],
    ['', 'posted_at', 400, 'invalid_request_error', 'tax_invalid_input', '/postedAt'],
    ['', '', 400, 'invalid_request_error', 'tax_invalid_input', '/providerRequest'],
    ['', '', 400, 'idempotency_error', 'tax_reference_conflict', '/key'],
    ['tax_calculation_expired', '', 400, 'invalid_request_error', 'tax_calculation_expired', '/calculationRef'],
    ['resource_missing', '', 404, 'invalid_request_error', 'tax_calculation_unusable', '/calculationRef'],
  ] as const;
  for (const [code, param, status, type, result, field] of cases) {
    const provider = await open(async (...request) => request[3] === 'GET' ? health(...request)
      : reply({ error: { code, param, type, message: sentinel } }, status));
    await assert.rejects(provider.tax.transactions.createFromCalculation({ calculation: 'taxcalc_fixture', reference: 'reference' },
      { idempotencyKey: 'fixed' }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'TaxProviderRejection');
      assert.ok(!error.message.includes(sentinel));
      assert.deepEqual([Reflect.get(error, 'code'), Reflect.get(error, 'field')], [result, field]);
      return true;
    });
  }
});

test('the launcher and runner never echo a synthetic credential from failures', async () => {
  const reference = 'op://fixture/item/key';
  const spawn = ((_program: string, command: string[], options: { env: Record<string, string> }) => {
    assert.ok(!command.includes(reference));
    assert.equal(options.env[keyName], reference);
    assert.equal(options.env.UNRELATED, undefined);
    throw new Error(sentinel);
  }) as unknown as NonNullable<Parameters<typeof launch>[1]>['spawn'];
  assert.throws(() => launch(args, { interactive: true, environment: { [keyName]: reference, UNRELATED: sentinel }, spawn }),
    error => error instanceof Error && !error.message.includes(sentinel));
  const environment = { [keyName]: sentinel };
  const outputs: string[] = [];
  let transcript = '';
  await assert.rejects(runChild(args, { interactive: true, environment,
    open: async () => { assert.equal(Object.hasOwn(environment, keyName), false); throw new Error(sentinel); },
    output: text => outputs.push(text) > 0,
    persist: async (_path, contents) => { transcript = String(contents); },
  }), error => error instanceof Error && !error.message.includes(sentinel));
  assert.doesNotMatch(outputs.join('') + transcript, /SyntheticDoNotLogFixture/u);
  assert.equal(JSON.parse(transcript).result, 'fail');
});

test('the card matrix verifies raw state, scoped capture and current-run cleanup', async () => {
  type Card = VerifiedTestProvider['card'];
  type Row = Record<string, unknown> & { id: string; status: string; charge?: Record<string, unknown> };
  const rows = new Map<string, Row>();
  const reads: string[] = [], cancellations: string[] = [], notes: object[] = [];
  let browserIntent: Row | undefined, confirms = 0;
  const hold = (row: Row) => {
    row.status = 'requires_capture';
    row.amount_capturable = 1000;
    row.charge = { id: 'ch_' + row.id, livemode: false, payment_intent: row.id, created: Math.floor(Date.now() / 1000),
      currency: 'usd', captured: false, amount_captured: 0, payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 3600 } } };
  };
  const card = {
    async customer(values: object) { return { ...values, id: 'cus_Sample', livemode: false }; },
    async create(values: object) {
      const id = 'pi_fixture' + rows.size;
      const row = { ...values, id, livemode: false, status: 'requires_confirmation', amount_received: 0, amount_capturable: 0 };
      rows.set(id, row);
      return row;
    },
    async confirm(id: string, values: { payment_method: string; off_session?: boolean; error_on_requires_action?: boolean }) {
      confirms++;
      const row = rows.get(id)!;
      row.payment_method = values.payment_method.startsWith('pm_card_authentication') ? 'pm_attached' + confirms : values.payment_method;
      if (values.payment_method.startsWith('pm_card_authentication') || values.error_on_requires_action === false) {
        row.status = 'requires_action';
        row.next_action = { redirect_to_url: { url: 'https://example.invalid/challenge' } };
        browserIntent = row;
      } else hold(row);
      return row;
    },
    async retrieve(id: string) { const row = rows.get(id)!; reads.push(id); return { ...row, latest_charge: row.charge ?? null }; },
    async capture(id: string) {
      const row = rows.get(id)!;
      if (row.status !== 'requires_capture' && row.status !== 'succeeded') {
        const { CardRejection } = await import('../host/provider-transport.ts');
        throw new CardRejection('payment_intent_unexpected_state');
      }
      row.status = 'succeeded'; row.amount_capturable = 0; row.amount_received = 1000;
      row.charge = { ...row.charge, captured: true, amount_captured: 1000 };
      return { ...row, latest_charge: row.charge.id };
    },
    async cancel(id: string) { const row = rows.get(id)!; row.status = 'canceled'; row.amount_capturable = 0; cancellations.push(id); return row; },
    async charges(id: string) { return { has_more: false, data: [rows.get(id)!.charge] }; },
  } as unknown as Card;
  const signal = new AbortController();
  await qualifyCard(card, { hash: raw => 'hashed-' + raw.length, note: row => notes.push(row) }, () => hold(browserIntent!),
    signal.signal, async () => ({ returnUrl: 'http://127.0.0.1/return', startUrl: 'http://127.0.0.1/start',
      approve: () => {}, close: async () => {} }), async () => {});
  assert.equal(cancellations.length, 2);
  assert.ok(reads.every(id => rows.has(id)));
  assert.ok(notes.some(note => Reflect.get(note, 'operation') === 'recovery_link'));
});

test('tax qualification replays exact reports and recovers a lost response only from the scoped original', async () => {
  type Tax = VerifiedTestProvider['tax'];
  type CalcParams = Parameters<Tax['calculations']['create']>[0];
  const scope = { accountRef: account, mode: 'test' } as const;
  for (const evidence of ['replay', 'scoped', 'foreign', 'missing']) {
    const calculations = new Map<string, { currency: string; tax_date: number; lines: object[]; shipping: object | null }>();
    const reports = new Map<string, { currency: string; tax_date: number; lines: object[]; shipping: object | null }>();
    const originals = new Map<string, object>();
    const sends: object[] = [], notes: object[] = [];
    let next = 0;
    const at = () => Math.floor(Date.now() / 1000);
    const rate = { tax_type: 'sales_tax', percentage_decimal: '10.0' };
    const jurisdiction = { country: 'US', state: 'NY', level: 'state', display_name: 'New York' };
    const assessed = (line: { amount?: number }) => ({
      taxable_amount: line.amount ?? 0, taxability_reason: 'standard_rated',
      amount: Math.round((line.amount ?? 0) / 10), jurisdiction, sourcing: 'destination', tax_rate_details: rate,
    });
    const list = (url: string, data: object[]) => ({ object: 'list', url, data, has_more: false });
    const summarize = (line: { amount?: number }) => {
      const detail = assessed(line);
      return { ...line, amount_tax: detail.amount, tax_breakdown: [detail] };
    };
    function report(id: string, wire: { reference: string; metadata?: object }, data: NonNullable<ReturnType<typeof reports.get>>,
      posted_at: number, original?: string) {
      const { lines, shipping, ...values } = data;
      const row = { id, object: 'tax.transaction', type: original ? 'reversal' : 'transaction', livemode: false,
        reference: wire.reference, metadata: wire.metadata, ...values, created: posted_at, posted_at,
        reversal: original ? { original_transaction: original } : null, shipping_cost: shipping,
        line_items: list('/v1/tax/transactions/' + id + '/line_items', lines) };
      originals.set(id, row);
      return row;
    }
    const tax = {
      scope,
      calculations: {
        async create(params: CalcParams) {
          const id = 'taxcalc_' + ++next;
          const lines = params.line_items.map(line => ({ ...summarize(line), id: 'item_' + id, livemode: false, object: 'tax.calculation_line_item' }));
          const shipping = params.shipping_cost ? summarize(params.shipping_cost) : null;
          const headers = [...lines, ...(shipping ? [shipping] : [])].flatMap(line => line.tax_breakdown.map(detail => ({
            ...detail, inclusive: false, tax_rate_details: { ...rate, country: 'US', state: 'NY', flat_amount: null, rate_type: 'percentage' },
          })));
          const tax_date = params.tax_date ?? at();
          const totals = [...lines, ...(shipping ? [shipping] : [])];
          calculations.set(id, { currency: params.currency, tax_date, lines, shipping });
          return { ...params, id, object: 'tax.calculation', livemode: false, tax_date, expires_at: at() + 3600,
            line_items: null, shipping_cost: shipping, tax_breakdown: headers, tax_amount_inclusive: 0,
            tax_amount_exclusive: totals.reduce((sum, line) => sum + line.amount_tax, 0),
            amount_total: totals.reduce((sum, line) => sum + (line.amount ?? 0) + line.amount_tax, 0) };
        },
        async listLineItems(id: string) { return list('/v1/tax/calculations/' + id + '/line_items', calculations.get(id)!.lines); },
      },
      registrations: { async list() { return list('/v1/tax/registrations', [{ id: 'reg_fixture', object: 'tax.registration',
        country: 'US', country_options: { us: { state: 'NY', type: 'state_sales_tax' } }, active_from: at() - 60, expires_at: null, livemode: false }]); } },
      transactions: {
        async createFromCalculation(data: Parameters<Tax['transactions']['createFromCalculation']>[0], key: object) {
          sends.push({ data, key });
          const calc = calculations.get(data.calculation)!;
          const body = { ...calc, lines: calc.lines.map(line => ({ ...line,
            object: 'tax.transaction_line_item', id: 'taxline_sale', type: 'transaction', reversal: null })) };
          reports.set('tax_sale', body);
          const response = report('tax_sale', data, body, data.posted_at!);
          if (evidence !== 'replay') throw new Error('Lost response.');
          return response;
        },
        async createReversal(data: Parameters<Tax['transactions']['createReversal']>[0], key: object) {
          sends.push({ data, key });
          const sale = reports.get(data.original_transaction)!;
          const opposite = (row: object) => ({ ...row, amount: -Reflect.get(row, 'amount') || 0, amount_tax: -Reflect.get(row, 'amount_tax') || 0 });
          const body = { ...sale, lines: sale.lines.map(line => ({ ...opposite(line), id: 'taxline_reverse',
            type: 'reversal', reversal: { original_line_item: Reflect.get(line, 'id') } })), shipping: opposite(sale.shipping!) };
          return report('tax_reverse', data, body, at(), data.original_transaction);
        },
        async retrieve(id: string) { return originals.get(id); },
      },
    } as unknown as Tax;
    const provider = { scope, tax } as VerifiedTestProvider;
    const run = () => qualifyTax(provider, { hash: raw => createHash('sha256').update(raw).digest('hex'), note: row => notes.push(row) },
      async () => evidence === 'scoped' ? 'tax_sale' : evidence === 'foreign' ? 'tax_other' : undefined, new AbortController().signal);
    if (evidence === 'replay' || evidence === 'scoped') {
      await run();
      if (evidence === 'replay') assert.deepEqual(sends.shift(), sends.shift());
      else sends.shift();
      assert.deepEqual(sends[0], sends[1]);
      assert.ok(notes.some(row => Reflect.get(row, 'operation') === 'tax_reporting'));
    } else {
      await assert.rejects(run(), new Error(integrityRefusal));
      assert.equal(sends.length, 1);
    }
  }
});
