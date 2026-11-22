import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { env, execPath } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { launch, preflight, qualificationMessage, qualifyCard, qualifyTax, recoveryPrompt, runChild } from '../host/provider-qualification.ts';
import { CardRejection, credentialRefusal, integrityRefusal, openTestProvider, ProviderUnavailable, sdkVersion, TaxProviderRejection, type VerifiedTestProvider } from '../host/provider-transport.ts';

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

test('mutations use the verified SDK scope and key even with extra caller options', async () => {
  const sends: Parameters<Wire>[] = [];
  const provider = await open(async (...request) => {
    if (request[3] === 'GET') return health(...request);
    sends.push(request);
    return reply({ error: { type: 'api_error', message: sentinel } }, 503);
  });
  const options = { idempotencyKey: 'fixture-key', apiKey: 'alternate-fixture-key', apiVersion: 'alternate-version',
    maxNetworkRetries: 2, [pin[0] + 'Account']: 'acct_Foreign010' };
  await assert.rejects(provider.card.customer({}, options), ProviderUnavailable);
  assert.deepEqual(sends.map(request => request[2]), ['/v1/customers']);
  const actual = new Map(Object.entries(sends[0]![4]).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(actual.get('authorization'), 'Bearer ' + sentinel);
  assert.equal(actual.get(pin[0] + '-version'), '2026-07-29.dahlia');
  assert.ok(!actual.get(pin[0] + '-account'));
  assert.equal(actual.get('idempotency-key'), 'fixture-key');
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
  await assert.rejects(provider.card.capture('pi_Sample', key, 4_000), new Error(integrityRefusal));
  await provider.card.capture('pi_Sample', key, 3_000);
  assert.ok(isDeepStrictEqual(sent[0], sent[1]));
  assert.deepEqual(ages, [1_000]);
  now = 3_000;
  await assert.rejects(provider.card.capture('pi_Sample', key, 4_000), new Error(integrityRefusal));
  const tax = { idempotencyKey: 'tax-key' };
  const params = { calculation: 'taxcalc_fixture', reference: 'sale-reference' };
  await provider.tax.transactions.createFromCalculation(params, tax);
  now += 23 * 60 * 60 * 1_000;
  await assert.rejects(provider.tax.transactions.createFromCalculation(params, tax), new Error(integrityRefusal));
  assert.equal(sent.length, 3);
});

test('tax errors expose structural fixed fields and remedies', async () => {
  const cases = [
    ['customer_tax_location_invalid', '', 400, 'invalid_request_error', 'tax_invalid_input', '/input/destination/address', 'Supply a supported address.'],
    ['', 'tax_date', 400, 'invalid_request_error', 'tax_invalid_input', '/input/taxDate', 'Supply a whole-second instant within the calculation window.'],
    ['', 'posted_at', 400, 'invalid_request_error', 'tax_invalid_input', '/postedAt', 'Use a supported posting instant.'],
    ['', '', 400, 'invalid_request_error', 'tax_invalid_input', '/providerRequest', 'Check the documented inputs for this operation.'],
    ['', '', 400, 'idempotency_error', 'tax_reference_conflict', '/key', 'Reconcile the original request and reference.'],
    ['tax_calculation_expired', '', 400, 'invalid_request_error', 'tax_calculation_expired', '/calculationRef', 'Reconcile the original obligation.'],
    ['resource_missing', '', 404, 'invalid_request_error', 'tax_calculation_unusable', '/calculationRef', 'Re-obtain the original reference in the bound account.'],
  ] as const;
  for (const [code, param, status, type, result, field, remedy] of cases) {
    const provider = await open(async (...request) => request[3] === 'GET' ? health(...request)
      : reply({ error: { code, param, type, message: sentinel } }, status));
    await assert.rejects(provider.tax.transactions.createFromCalculation({ calculation: 'taxcalc_fixture', reference: 'reference' },
      { idempotencyKey: 'fixed' }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'TaxProviderRejection');
      assert.deepEqual([Reflect.get(error, 'code'), Reflect.get(error, 'field'), error.message], [result, field, remedy]);
      return true;
    });
    const output: string[] = [];
    await assert.rejects(runChild(args, { interactive: true, environment: { [keyName]: sentinel },
      open: async () => {
        await provider.tax.transactions.createFromCalculation({ calculation: 'taxcalc_fixture', reference: 'reference' },
          { idempotencyKey: 'terminal-fixed' });
        throw new Error('Unexpected reporting success.');
      },
      output: message => output.push(message) > 0,
      persist: async () => {},
    }), /qualification did not pass/);
    assert.equal(output[0], remedy + '\n');
    assert.doesNotMatch(output.join(''), /SyntheticDoNotLogFixture/u);
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

test('a missing secret-manager executable gives a fixed setup remedy', () => {
  const spawn = (() => ({ error: Object.assign(new Error(sentinel), { code: 'ENOENT' }),
    status: null, stderr: Buffer.from(sentinel) })) as unknown as NonNullable<Parameters<typeof launch>[1]>['spawn'];
  assert.throws(() => launch(args, { interactive: true, environment: { [keyName]: 'op://fixture/item/key' }, spawn }),
    new Error('Install the 1Password CLI and make it available on your PATH, then retry.'));
});

function cardFixture(fault?: 'uncertain-cancel' | 'invalid-receipt' | 'invalid-charge' | 'no-return') {
  type Card = VerifiedTestProvider['card'];
  type Row = Record<string, unknown> & { id: string; status: string; charge?: Record<string, unknown> };
  const unrelated = { id: 'pi_previous', status: 'requires_capture' };
  const rows = new Map<string, Row>([[unrelated.id, unrelated]]);
  const reads: string[] = [], notes: Array<Record<string, unknown>> = [];
  const sends: { operation: 'capture' | 'cancel'; id: string; state: string; key: string; before?: number }[] = [];
  let browserIntent: Row | undefined, confirms = 0, clock = 1, returnedAt: number | undefined;
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
    async confirm(id: string, values: { payment_method: string; return_url?: string; off_session?: boolean; error_on_requires_action?: boolean }) {
      confirms++;
      const row = rows.get(id)!;
      row.returnUrl = values.return_url;
      row.payment_method = values.payment_method.startsWith('pm_card_authentication') ? 'pm_attached' + confirms : values.payment_method;
      if (values.payment_method.startsWith('pm_card_authentication') || values.error_on_requires_action === false) {
        row.status = 'requires_action';
        row.next_action = { redirect_to_url: { url: 'https://example.invalid/challenge' } };
        browserIntent = row;
      } else hold(row);
      return row;
    },
    async retrieve(id: string) { const row = rows.get(id)!; reads.push(id); return { ...row, latest_charge: row.charge ?? null }; },
    async capture(id: string, options: { idempotencyKey: string }, before: number) {
      const row = rows.get(id)!;
      sends.push({ operation: 'capture', id, state: row.status, key: options.idempotencyKey, before });
      if (row.status !== 'requires_capture' && row.status !== 'succeeded') throw new CardRejection('payment_intent_unexpected_state');
      if (fault === 'invalid-receipt') return { ...row, status: 'succeeded', amount_received: 0, latest_charge: row.charge!.id };
      row.status = 'succeeded'; row.amount_capturable = 0; row.amount_received = 1000;
      row.charge = { ...row.charge, captured: true, amount_captured: fault === 'invalid-charge' ? 0 : 1000 };
      return { ...row, latest_charge: row.charge.id };
    },
    async cancel(id: string, options: { idempotencyKey: string }) {
      const row = rows.get(id)!;
      sends.push({ operation: 'cancel', id, state: row.status, key: options.idempotencyKey });
      if (fault === 'uncertain-cancel') throw new ProviderUnavailable();
      row.status = 'canceled'; row.amount_capturable = 0;
      return row;
    },
    async charges(id: string) { return { has_more: false, data: [rows.get(id)!.charge] }; },
  } as unknown as Card;
  const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
  const run = (realLoopback = false) => {
    let callback: Promise<void> | undefined;
    return qualifyCard(card, { hash, note: row => notes.push(row) }, () => {
      hold(browserIntent!);
      if (realLoopback) {
        const url = String(browserIntent!.returnUrl);
        callback = fetch(url + '?discard=' + sentinel, { redirect: 'manual' }).then(response => {
          assert.equal(response.status, 303);
          const location = response.headers.get('location');
          assert.equal(location, new URL(url).pathname.replace(/return$/u, 'done'));
        });
      } else if (fault !== 'no-return') returnedAt = clock;
    }, new AbortController().signal, realLoopback ? undefined : async () => ({
      returnUrl: 'http://127.0.0.1/return', startUrl: 'http://127.0.0.1/start', returnedAt: () => returnedAt,
      approve: () => { returnedAt = undefined; }, close: async () => {},
    }), async () => {
      await callback;
      clock += fault === 'no-return' && clock > 1 ? 300_000 : 1;
    }, realLoopback ? undefined : () => clock);
  };
  return { run, rows, sends, reads, notes, hash };
}

test('the card matrix observes the loopback return and witnesses exact capture sends and keys', async () => {
  const { run, sends, reads, rows, notes } = cardFixture();
  await run(true);
  const captures = sends.filter(send => send.operation === 'capture');
  assert.deepEqual(captures.map(send => send.state),
    ['requires_action', 'requires_capture', 'succeeded', 'canceled', 'requires_action', 'requires_capture']);
  const [early, first, replay, postCancel] = captures;
  assert.equal(early!.id, first!.id);
  assert.deepEqual({ ...first, state: replay!.state }, replay);
  assert.notEqual(early!.key, first!.key);
  assert.notEqual(postCancel!.key, first!.key);
  assert.equal(sends.filter(send => send.operation === 'cancel').length, 2);
  assert.equal(rows.get('pi_previous')?.status, 'requires_capture');
  assert.ok(!reads.includes('pi_previous') && sends.every(send => send.id !== 'pi_previous'));
  assert.equal(notes.filter(note => note.operation === 'challenge_return').length, 2);
  assert.ok(notes.some(note => note.operation === 'recovery_link'));
});

test('an uncertain cancellation is reconciled read-only and leaves a hashed unresolved hold', async () => {
  const fixture = cardFixture('uncertain-cancel');
  await assert.rejects(fixture.run(), /original test intent/);
  const [cancel, ...resends] = fixture.sends.filter(send => send.operation === 'cancel');
  assert.ok(cancel?.key);
  assert.deepEqual(resends, []);
  assert.ok(fixture.reads.filter(id => id === cancel.id).length >= 2);
  assert.equal(fixture.rows.get(cancel.id)?.status, 'requires_capture');
  assert.deepEqual(fixture.notes.filter(note => note.operation === 'unresolved_hold'),
    [{ operation: 'unresolved_hold', effect: 'unknown', intent: fixture.hash(cancel.id) }]);
});

test('a bad first capture receipt or charge prevents replay and cleanup cancels only current holds', async () => {
  for (const fault of ['invalid-receipt', 'invalid-charge'] as const) {
    const fixture = cardFixture(fault);
    await assert.rejects(fixture.run(), /original test intent/);
    const [early, first, ...resends] = fixture.sends.filter(send => send.operation === 'capture');
    assert.equal(early?.state, 'requires_action');
    assert.equal(first?.state, 'requires_capture');
    assert.deepEqual(resends, []);
    const cancels = fixture.sends.filter(send => send.operation === 'cancel');
    assert.deepEqual(cancels.map(send => send.id), fault === 'invalid-receipt' ? [first!.id] : []);
    if (fault === 'invalid-receipt') assert.notEqual(cancels[0]!.key, first!.key);
    assert.equal(fixture.rows.get('pi_previous')?.status, 'requires_capture');
    assert.ok(!fixture.reads.includes('pi_previous'));
  }
});

test('a provider hold without the current browser return fails and is cleaned up', async () => {
  const fixture = cardFixture('no-return');
  await assert.rejects(fixture.run(), /original test intent/);
  assert.deepEqual(fixture.sends.map(({ operation, state }) => [operation, state]),
    [['capture', 'requires_action'], ['cancel', 'requires_capture']]);
  assert.ok(!fixture.notes.some(note => note.operation === 'challenge_return'));
  assert.equal(fixture.rows.get('pi_previous')?.status, 'requires_capture');
});

test('tax evidence distinguishes shipping layouts, preserves remedies and recovers exact original references', async () => {
  type Tax = VerifiedTestProvider['tax'];
  type CalcParams = Parameters<Tax['calculations']['create']>[0];
  const scope = { accountRef: account, mode: 'test' } as const;
  for (const evidence of ['replay', 'scoped', 'foreign', 'missing', 'quote-recovery', 'reverse-recovery', 'absent-shipping',
    'missing-shipping', 'wrong-shipping', 'missing-shipping-breakdown', 'missing-line-breakdown', 'missing-header', 'missing-rate-type',
    'no-effect', 'port-refusal', 'posting-refusal']) {
    const calculations = new Map<string, { currency: string; tax_date: number; lines: object[]; shipping: object | null }>();
    const reports = new Map<string, { currency: string; tax_date: number; lines: object[]; shipping: object | null }>();
    const originals = new Map<string, object>();
    const quoteReceipts = new Map<string, object>();
    const sends: Array<{ data: { reference: string }; key: object }> = [], notes: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];
    let quoteReference: string | undefined, quoteId: string | undefined;
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
          if (evidence === 'port-refusal' && params.tax_date !== undefined) {
            throw new TaxProviderRejection('tax_invalid_input', '/input/taxDate');
          }
          const ca = params.customer_details?.address?.state === 'CA';
          const lines = params.line_items.map(line => {
            const component = summarize(line);
            return ca ? { ...component, amount_tax: 0, tax_breakdown: [{ ...assessed(line), amount: 0,
              taxability_reason: 'not_subject_to_tax', tax_rate_details: null }], id: 'item_' + id, livemode: false }
              : { ...component, id: 'item_' + id, livemode: false, object: 'tax.calculation_line_item' };
          });
          const cost = params.shipping_cost ? summarize(params.shipping_cost) : null;
          const shipping = ca && evidence === 'absent-shipping' ? null : ca && cost ? { ...cost, tax_breakdown: [] } : cost;
          const headers = [...lines, ...(shipping ? [shipping] : [])].flatMap(line => line.tax_breakdown.map(detail => ({
            ...detail, inclusive: false, tax_rate_details: ca ? { tax_type: null, percentage_decimal: '0', country: 'US', state: 'CA',
              flat_amount: null, rate_type: null } : { ...rate, country: 'US', state: 'NY', flat_amount: null, rate_type: 'percentage' },
          })));
          const tax_date = params.tax_date ?? at();
          const totals = [...lines, ...(shipping ? [shipping] : [])];
          calculations.set(id, { currency: params.currency, tax_date, lines, shipping });
          const result = { ...params, id, object: 'tax.calculation', livemode: false, tax_date, expires_at: at() + 3600,
            line_items: null, shipping_cost: shipping, tax_breakdown: headers, tax_amount_inclusive: 0,
            tax_amount_exclusive: totals.reduce((sum, line) => sum + line.amount_tax, 0),
            amount_total: totals.reduce((sum, line) => sum + (line.amount ?? 0) + line.amount_tax, 0) };
          if (ca) {
            if (evidence === 'missing-shipping') Reflect.deleteProperty(result, 'shipping_cost');
            if (evidence === 'wrong-shipping') Object.assign(shipping!, { amount: 50 });
            if (evidence === 'missing-shipping-breakdown') Reflect.deleteProperty(shipping!, 'tax_breakdown');
            if (evidence === 'missing-line-breakdown') Reflect.deleteProperty(lines[0]!, 'tax_breakdown');
            if (evidence === 'missing-header') Reflect.deleteProperty(result, 'tax_breakdown');
            if (evidence === 'missing-rate-type') Reflect.deleteProperty(headers[0]!.tax_rate_details, 'rate_type');
            if (evidence === 'quote-recovery') {
              quoteReference = params.line_items[0]!.reference;
              quoteId = id;
              quoteReceipts.set(id, result);
              throw new ProviderUnavailable();
            }
          }
          return result;
        },
        async listLineItems(id: string) { return list('/v1/tax/calculations/' + id + '/line_items', calculations.get(id)!.lines); },
        async retrieve(id: string) { return quoteReceipts.get(id); },
      },
      registrations: { async list() {
        if (evidence === 'no-effect') throw new ProviderUnavailable();
        return list('/v1/tax/registrations', [{ id: 'reg_fixture', object: 'tax.registration',
          country: 'US', country_options: { us: { state: 'NY', type: 'state_sales_tax' } }, active_from: at() - 60, expires_at: null, livemode: false }]);
      } },
      transactions: {
        async createFromCalculation(data: Parameters<Tax['transactions']['createFromCalculation']>[0], key: object) {
          sends.push({ data, key });
          if (evidence === 'posting-refusal') throw new TaxProviderRejection('tax_calculation_expired', '/calculationRef');
          const calc = calculations.get(data.calculation)!;
          const body = { ...calc, lines: calc.lines.map(line => ({ ...line,
            object: 'tax.transaction_line_item', id: 'taxline_sale', type: 'transaction', reversal: null })) };
          reports.set('tax_sale', body);
          const response = report('tax_sale', data, body, data.posted_at!);
          if (['scoped', 'foreign', 'missing'].includes(evidence)) throw new Error('Lost response.');
          return response;
        },
        async createReversal(data: Parameters<Tax['transactions']['createReversal']>[0], key: object) {
          sends.push({ data, key });
          const sale = reports.get(data.original_transaction)!;
          const opposite = (row: object) => ({ ...row, amount: -Reflect.get(row, 'amount') || 0, amount_tax: -Reflect.get(row, 'amount_tax') || 0 });
          const body = { ...sale, lines: sale.lines.map(line => ({ ...opposite(line), id: 'taxline_reverse',
            type: 'reversal', reversal: { original_line_item: Reflect.get(line, 'id') } })), shipping: opposite(sale.shipping!) };
          const response = report('tax_reverse', data, body, at(), data.original_transaction);
          if (evidence === 'reverse-recovery') throw new Error('Lost response.');
          return response;
        },
        async retrieve(id: string) { return originals.get(id); },
      },
    } as unknown as Tax;
    const provider = { scope, tax } as VerifiedTestProvider;
    const run = () => qualifyTax(provider, { hash: raw => createHash('sha256').update(raw).digest('hex'), note: row => notes.push(row) },
      async (operation, reference) => {
        assert.equal(reference, operation === 'quote' ? quoteReference : sends.at(-1)?.data.reference);
        prompts.push(recoveryPrompt(operation, reference));
        assert.match(prompts.at(-1)!, new RegExp('tax ' + operation + ' with reference ' + reference));
        assert.ok(!JSON.stringify(notes).includes(reference));
        if (operation === 'quote') return quoteId;
        if (operation === 'reverse') return 'tax_reverse';
        return evidence === 'scoped' ? 'tax_sale' : evidence === 'foreign' ? 'tax_other' : undefined;
      }, new AbortController().signal);
    if (['replay', 'scoped', 'quote-recovery', 'reverse-recovery', 'absent-shipping'].includes(evidence)) {
      await run();
      const posts = sends.filter(send => 'calculation' in send.data);
      const reversals = sends.filter(send => 'original_transaction' in send.data);
      if (evidence === 'scoped') assert.equal(posts.length, 1);
      else { assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]); }
      if (evidence === 'reverse-recovery') assert.equal(reversals.length, 1);
      else { assert.equal(reversals.length, 2); assert.deepEqual(reversals[0], reversals[1]); }
      assert.equal(prompts.length, ['quote-recovery', 'scoped', 'reverse-recovery'].includes(evidence) ? 1 : 0);
      assert.ok(notes.some(row => row.operation === 'tax_reporting'));
      assert.ok(notes.some(row => row.region === 'CA' && row.shippingShape === (evidence === 'absent-shipping' ? 'absent' : 'empty')));
      assert.ok(notes.some(row => row.region === 'CA' && row.shape === 'header' && row.rateType === null && row.taxability === 'not_subject_to_tax'));
      assert.ok(notes.some(row => row.region === 'CA' && row.shape === 'line' && row.hasRate === false));
      assert.ok(notes.some(row => row.region === 'NY' && row.shape === 'header' && row.rateType === 'percentage'));
    } else {
      const remedy = evidence === 'no-effect' ? 'No reporting effect was observed. Check tax configuration in the bound test account.'
        : evidence === 'port-refusal' ? 'Supply a whole-second instant within the calculation window.'
          : evidence === 'posting-refusal' ? 'Reconcile the original obligation.' : integrityRefusal;
      await assert.rejects(run(), error => {
        assert.equal(qualificationMessage(error), remedy, evidence);
        return true;
      });
      assert.equal(sends.length, ['foreign', 'missing', 'posting-refusal'].includes(evidence) ? 1 : 0);
      assert.equal(prompts.length, ['foreign', 'missing'].includes(evidence) ? 1 : 0);
    }
  }
});

const installedOrigin = manifest.providerQualification === undefined
  ? JSON.parse(await readFile(new URL('../.starter-origin.json', import.meta.url), 'utf8')) : undefined;
test('the installed npm entry passes control to the child and keeps both output streams clean',
  { skip: installedOrigin?.mode !== 'candidate' && 'Run this witness from the extracted opt-in candidate.' }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'provider-entry-'));
    try {
      const app = fileURLToPath(new URL('../', import.meta.url));
      const entry = new URL('../host/provider-qualification.ts', import.meta.url).href;
      const transport = new URL('../host/provider-transport.ts', import.meta.url).href;
      const parent = join(fixture, 'parent.mjs'), child = join(fixture, 'child.mjs'), wrapper = join(fixture, 'wrapper.mjs');
      // Keep the test-only injection in the subprocess, without an application flag or environment override.
      const processFixture = "import { stdin } from 'node:process';\n"
        + "import https from 'node:https';\nimport { syncBuiltinESMExports } from 'node:module';\n"
        + "Object.defineProperty(stdin, 'isTTY', { value: true });\nhttps.request = () => { process.exit(97); };\nsyncBuiltinESMExports();\n";
      await writeFile(parent, processFixture);
      await writeFile(child, processFixture + `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === ${JSON.stringify(entry)}) return { url: ${JSON.stringify(pathToFileURL(wrapper).href)}, shortCircuit: true };
  return next(specifier, context);
} });
`);
      await writeFile(wrapper, `
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runChild as actual } from ${JSON.stringify(entry + '?fixture')};
import { openTestProvider } from ${JSON.stringify(transport)};
export async function runChild(argv) {
  assert.deepEqual(argv, ${JSON.stringify(args)});
  const wire = [];
  return actual(argv, {
    open: (input, options) => {
      assert.deepEqual(input, { accountRef: ${JSON.stringify(account)}, secretKey: ${JSON.stringify(sentinel)} });
      assert.equal(Object.hasOwn(env, ${JSON.stringify(keyName)}), false);
      return openTestProvider(input, { ...options, http: async (_host, _port, path) => {
        wire.push(path);
        if (path === '/v1/customers') throw new Error(${JSON.stringify(sentinel)});
        const body = path === '/v1/account' ? ${JSON.stringify(good)} : ${JSON.stringify(testMode)};
        return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: async () => body };
      } });
    },
    persist: (path, content, options) => {
      assert.deepEqual(wire, ['/v1/account', '/v1/balance', '/v1/customers']);
      return writeFile(join(${JSON.stringify(fixture)}, path), content, options);
    },
  });
}
`);
      await writeFile(join(fixture, 'op'), `#!/bin/sh
[ "$1" = run ] && [ "$2" = -- ] || exit 96
[ "$PROVIDER_TEST_KEY" = 'op://fixture/item/key' ] || exit 96
[ -z "$NODE_OPTIONS" ] || exit 96
shift 2
runner="$1"
shift
printf '%s\\n' '${sentinel}' >&2
PROVIDER_TEST_KEY='${sentinel}' exec "$runner" --import "${pathToFileURL(child).href}" "$@"
`, { mode: 0o700 });
      const result = spawnSync('npm', ['run', 'provider:qualify', '--', ...args], { cwd: app, encoding: 'utf8', timeout: 30_000,
        env: { PATH: [fixture, dirname(execPath), env.PATH ?? ''].join(delimiter), HOME: env.HOME,
          NODE_OPTIONS: '--import=' + pathToFileURL(parent).href, [keyName]: 'op://fixture/item/key' } });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, /SyntheticDoNotLogFixture|op:\/\/fixture/u);
      assert.match(result.stdout, /Qualification could not verify the original operation/);
      assert.match(result.stderr, /Provider qualification did not complete/);
      const transcripts = (await readdir(fixture)).filter(name => /^provider-qualification-.*\.json$/u.test(name));
      assert.equal(transcripts.length, 1);
      const name = transcripts[0]!;
      assert.match(result.stdout, new RegExp(basename(name)));
      const content = await readFile(join(fixture, name), 'utf8');
      assert.doesNotMatch(content, /SyntheticDoNotLogFixture|acct_OwnerSample01/u);
      const transcript = JSON.parse(content);
      assert.equal(transcript.result, 'fail');
      assert.equal(transcript.apiVersion, '2026-07-29.dahlia');
      assert.deepEqual(transcript.records.map((row: { operation: string; effect: string }) => [row.operation, row.effect]),
        [['customer', 'unknown']]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
