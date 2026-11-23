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
import { CardRejection, credentialRefusal, integrityRefusal, openTestProvider, ProviderUnavailable, sdkVersion, TaxProviderRejection, transportStringBytes, type VerifiedTestProvider } from '../host/provider-transport.ts';

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

test('all transport entries reject invalid string inputs before sending', async () => {
  const sends: string[] = [];
  const provider = await open(async (...request) => {
    if (request[2] === '/v1/account' || request[2] === '/v1/balance') return health(...request);
    sends.push(request[2]);
    return reply({});
  });
  type Options = Parameters<typeof provider.card.customer>[1];
  const key = { idempotencyKey: 'fixture-key' };
  const mutations = [
    (options: Options) => provider.card.customer({}, options),
    (options: Options) => provider.card.create({ amount: 1000, currency: 'usd' }, options),
    (options: Options) => provider.card.confirm('pi_Sample', { payment_method: 'pm_Sample' }, options),
    (options: Options) => provider.card.capture('pi_Sample', options, Date.now() + 10_000),
    (options: Options) => provider.card.cancel('pi_Sample', options),
    (options: Options) => provider.tax.calculations.create({ currency: 'usd', line_items: [{ amount: 1000, reference: 'item' }] }, options),
    (options: Options) => provider.tax.transactions.createFromCalculation({ calculation: 'taxcalc_sample', reference: 'sale' }, options),
    (options: Options) => provider.tax.transactions.createReversal({ original_transaction: 'tax_sample', reference: 'reverse', mode: 'full' }, options),
  ];
  const bodyAndTarget = [
    (value: string) => provider.card.customer({ metadata: { qualification: value } }, key),
    (value: string) => provider.card.create({ amount: 1000, currency: value }, key),
    (value: string) => provider.card.create({ amount: 1000, currency: 'usd', payment_method_types: [value] }, key),
    (value: string) => provider.card.confirm('pi_Sample', { return_url: value }, key),
    (value: string) => provider.card.retrieve(value),
    (value: string) => provider.card.capture(value, key, Date.now() + 10_000),
    (value: string) => provider.tax.calculations.create({ currency: 'usd', line_items: [{ amount: 1000, reference: value }] }, key),
    (value: string) => provider.tax.calculations.create({ currency: 'usd', line_items: [{ amount: 1000, reference: 'item' }],
      customer_details: { address_source: 'shipping', address: { line1: value, country: 'US' } } }, key),
    (value: string) => provider.tax.calculations.listLineItems('taxcalc_sample', { expand: [value] }),
    (value: string) => provider.tax.registrations.list({ starting_after: value }),
    (value: string) => provider.tax.transactions.createFromCalculation({ calculation: 'taxcalc_sample', reference: value }, key),
    (value: string) => provider.tax.transactions.createReversal({ original_transaction: value, reference: 'reverse', mode: 'full' }, key),
    (value: string) => provider.tax.transactions.retrieve(value),
  ];
  const invalid = [
    { name: 'empty', value: '' }, { name: 'whitespace', value: ' \t' }, { name: 'number', value: 123 },
    { name: 'null', value: null }, { name: 'undefined', value: undefined }, { name: 'object', value: { text: 'sample' } },
    { name: 'over bound', value: 'x'.repeat(transportStringBytes + 1) },
    { name: 'over byte bound', value: 'é'.repeat(transportStringBytes) },
  ];
  for (const { name, value } of invalid) {
    for (const mutate of mutations) await assert.rejects(mutate({ idempotencyKey: value } as Options), new Error(integrityRefusal), name);
    for (const send of bodyAndTarget) await assert.rejects(send(value as string), new Error(integrityRefusal), name);
    assert.deepEqual(sends, [], name);
  }
  await assert.rejects(mutations[0]!({} as Options), new Error(integrityRefusal));
  await assert.rejects(mutations[0]!(undefined as unknown as Options), new Error(integrityRefusal));
  assert.deepEqual(sends, []);
  const atLimit = 'x'.repeat(transportStringBytes);
  await provider.card.customer({ metadata: { qualification: atLimit } }, { idempotencyKey: atLimit });
  assert.deepEqual(sends, ['/v1/customers']);
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

function cardFixture(fault?: 'uncertain-cancel' | 'invalid-receipt' | 'invalid-charge' | 'no-return'
  | 'invalid-first-captured-type' | 'invalid-replay-captured-type' | 'missing-early-zero' | 'missing-recovery-zero') {
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
        if ((fault === 'missing-early-zero' && confirms === 1)
          || (fault === 'missing-recovery-zero' && values.error_on_requires_action === false)) {
          row.charge = { id: 'ch_' + id, livemode: false, payment_intent: id, captured: false };
        }
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
    async charges(id: string) {
      const charge = rows.get(id)!.charge;
      const replay = sends.some(send => send.id === id && send.operation === 'capture' && send.state === 'succeeded');
      const wrongType = replay ? fault === 'invalid-replay-captured-type' : fault === 'invalid-first-captured-type';
      return { has_more: false, data: [wrongType ? { ...charge, captured: 'false' } : charge] };
    },
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

test('a string captured flag fails the first capture proof or the final replay proof', async () => {
  for (const fault of ['invalid-first-captured-type', 'invalid-replay-captured-type'] as const) {
    const fixture = cardFixture(fault);
    await assert.rejects(fixture.run(), /original test intent/);
    const captures = fixture.sends.filter(send => send.operation === 'capture');
    const beforeReplay = ['requires_action', 'requires_capture'];
    assert.deepEqual(captures.map(send => send.state),
      fault === 'invalid-first-captured-type' ? beforeReplay : [...beforeReplay, 'succeeded']);
    assert.ok(!fixture.notes.some(note => note.operation === 'capture' && note.verdict === 'pass'));
  }
});

test('a present charge with no captured amount cannot prove a capture refusal or recovery', async () => {
  for (const fault of ['missing-early-zero', 'missing-recovery-zero'] as const) {
    const fixture = cardFixture(fault);
    await assert.rejects(fixture.run(), /original test intent/);
    if (fault === 'missing-early-zero') {
      assert.deepEqual(fixture.sends.map(({ operation, state }) => [operation, state]), [['capture', 'requires_action']]);
      assert.ok(!fixture.notes.some(note => note.operation === 'capture_refused'));
    } else {
      assert.equal(fixture.notes.filter(note => note.operation === 'capture').length, 2);
      assert.ok(!fixture.notes.some(note => note.operation === 'recovery_link'));
    }
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

test('tax observations reconcile returned totals and bind reporting effects', async () => {
  type Tax = VerifiedTestProvider['tax'];
  const scope = { accountRef: account, mode: 'test' } as const;
  const successful = ['replay', 'quote-recovery', 'post-recovery', 'reverse-recovery', 'absent-shipping', 'varied-layout'];
  const cases = [...successful, 'shipping-tax-mismatch', 'line-tax-mismatch', 'fractional-row', 'header-tax-mismatch', 'live', 'foreign-account', 'foreign-page',
    'foreign-recovery', 'missing-recovery', 'wrong-original', 'different-replay', 'no-effect', 'quote-refusal', 'posting-refusal'];
  for (const scenario of cases) {
    const notes: Record<string, unknown>[] = [], prompts: string[] = [];
    const sends: { ref: string; key: object; original?: string }[] = [];
    const calculations = new Map<string, { result: object; lines: object[] }>();
    const transactions = new Map<string, { receipt: object; lines: object[] }>();
    const list = (path: string, data: object[]) => ({ url: '/v1/tax/' + path + '/line_items', data, has_more: false });
    const store = (id: string, ref: string, original: string | null) => {
      const type = original === null ? 'transaction' : 'reversal';
      const receipt = { id, reference: ref, livemode: false, type, shipping_cost: { amount_tax: 0 },
        reversal: original === null ? null : { original_transaction: scenario === 'wrong-original' ? 'tax_other' : original } };
      const lines = [{ id: original === null ? 'taxline_sale' : 'taxline_reverse', reference: 'unused', livemode: false, type,
        amount_tax: original === null ? 12 : -12, reversal: original === null ? null : { original_line_item: 'taxline_sale' } }];
      transactions.set(id, { receipt, lines });
      return receipt;
    };
    const tax = {
      scope,
      calculations: {
        async create(params: Parameters<Tax['calculations']['create']>[0]) {
          if (scenario === 'quote-refusal') throw new TaxProviderRejection('tax_invalid_input', '/input/taxDate');
          const id = 'taxcalc_' + (calculations.size + 1), second = calculations.size === 1;
          const taxability_reason = scenario === 'varied-layout' ? 'UnrecognizedProviderFixture' : 'standard_rated';
          const detail = { amount: 12, taxable_amount: 1000, taxability_reason, tax_rate_details: { percentage_decimal: '1.2' } };
          const lines = [{ reference: params.line_items[0]!.reference, livemode: false, amount_tax: 12, tax_breakdown: [detail] }];
          const headers = [{ ...detail, inclusive: false, tax_rate_details: { rate_type: 'percentage' } }];
          if (second && scenario === 'varied-layout') headers.push({ ...detail, amount: 2, inclusive: true,
            tax_rate_details: { rate_type: 'UnrecognizedProviderFixture' } });
          if (second && scenario === 'line-tax-mismatch') lines[0]!.amount_tax = 11;
          if (second && scenario === 'fractional-row') detail.amount = 12.5;
          const result = { id, livemode: scenario === 'live', account: scenario === 'foreign-account' ? 'acct_Foreign010' : account,
            expires_at: Math.floor(Date.now() / 1000) + 3600, amount_total: 1012,
            tax_amount_inclusive: second && scenario === 'varied-layout' ? 2 : 0,
            tax_amount_exclusive: second && scenario === 'header-tax-mismatch' ? 13 : 12, tax_breakdown: headers,
            shipping_cost: scenario === 'absent-shipping' ? null
              : { amount_tax: second && scenario === 'shipping-tax-mismatch' ? 27 : 0, tax_breakdown: [] } };
          calculations.set(id, { result, lines });
          if (second && ['quote-recovery', 'no-effect'].includes(scenario)) throw new ProviderUnavailable();
          return result;
        },
        async listLineItems(id: string) {
          return { ...list('calculations/' + id, calculations.get(id)!.lines),
            ...(scenario === 'foreign-page' ? { account: 'acct_Foreign010' } : {}) };
        },
        async retrieve(id: string) { return calculations.get(id)?.result; },
      },
      transactions: {
        async createFromCalculation(data: Parameters<Tax['transactions']['createFromCalculation']>[0], key: object) {
          sends.push({ ref: data.reference, key });
          if (scenario === 'posting-refusal') throw new TaxProviderRejection('tax_calculation_expired', '/calculationRef');
          const id = scenario === 'different-replay' && sends.length === 2 ? 'tax_other' : 'tax_sale';
          const receipt = store(id, data.reference, null);
          Reflect.set(transactions.get(id)!.lines[0]!, 'reference', Reflect.get(calculations.get(data.calculation)!.lines[0]!, 'reference'));
          if (['post-recovery', 'foreign-recovery', 'missing-recovery'].includes(scenario)) throw new ProviderUnavailable();
          return receipt;
        },
        async createReversal(data: Parameters<Tax['transactions']['createReversal']>[0], key: object) {
          sends.push({ ref: data.reference, key, original: data.original_transaction });
          const receipt = store('tax_reverse', data.reference, data.original_transaction);
          if (scenario === 'reverse-recovery') throw new ProviderUnavailable();
          return receipt;
        },
        async retrieve(id: string) { return transactions.get(id)?.receipt; },
        async listLineItems(id: string) { return list('transactions/' + id, transactions.get(id)!.lines); },
      },
    } as unknown as Tax;
    const run = () => qualifyTax({ scope, tax } as VerifiedTestProvider,
      { hash: raw => createHash('sha256').update(raw).digest('hex'), note: row => notes.push(row) }, async (operation, ref) => {
        prompts.push(operation);
        assert.ok(recoveryPrompt(operation, ref).includes(ref));
        assert.ok(!JSON.stringify(notes).includes(ref));
        if (operation === 'quote') {
          assert.equal(ref, Reflect.get(calculations.get('taxcalc_2')!.lines[0]!, 'reference'));
          return scenario === 'quote-recovery' ? 'taxcalc_2' : undefined;
        }
        assert.equal(ref, sends.at(-1)?.ref);
        if (operation === 'reverse') return 'tax_reverse';
        return scenario === 'post-recovery' ? 'tax_sale' : scenario === 'foreign-recovery' ? 'tax_other' : undefined;
      }, new AbortController().signal);
    if (successful.includes(scenario)) {
      await run();
      const posts = sends.filter(send => send.original === undefined), reversals = sends.filter(send => send.original === 'tax_sale');
      assert.deepEqual(posts, scenario === 'post-recovery' ? [posts[0]] : [posts[0], posts[0]]);
      assert.deepEqual(reversals, scenario === 'reverse-recovery' ? [reversals[0]] : [reversals[0], reversals[0]]);
      assert.notEqual(posts[0]?.ref, reversals[0]?.ref);
      assert.deepEqual(prompts, scenario.endsWith('-recovery') ? [scenario.split('-')[0]] : []);
      assert.ok(notes.some(row => row.operation === 'tax_reporting'));
      assert.doesNotMatch(JSON.stringify(notes), /UnrecognizedProviderFixture|taxcalc_2|tax_sale|tax_reverse/);
    } else {
      const remedy = scenario === 'no-effect' ? 'No reporting effect was observed. Check tax configuration in the bound test account.'
        : scenario === 'quote-refusal' ? 'Supply a whole-second instant within the calculation window.'
          : scenario === 'posting-refusal' ? 'Reconcile the original obligation.' : integrityRefusal;
      await assert.rejects(run(), error => qualificationMessage(error) === remedy, scenario);
      const expectedSends: Record<string, number> = {
        'wrong-original': 3, 'different-replay': 2, 'foreign-recovery': 1, 'missing-recovery': 1, 'posting-refusal': 1,
      };
      assert.equal(sends.length, expectedSends[scenario] ?? 0, scenario);
      assert.ok(!notes.some(row => row.operation === 'tax_reporting'), scenario);
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
