import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { NativeCheckoutQuery } from '@openlup/platform/commerce/server/native-checkout';
import type { createCheckoutAdmission } from '@openlup/platform/commerce/server';
import { createPostgresCheckoutRateLimit, createCheckoutAttemptBindings, admitCheckoutAttempt, admitCheckoutReplay } from '../host/checkout-attempts.ts';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const settings = { windowMs: 100, retentionMs: 200, maxPerEmail: 2, maxPerRequester: 1, maxEntries: 3 };
const request = { headers: { 'x-forwarded-for': 'ignored.example.test' }, requesterKey: hash('peer') };
const intent = (key: string, email = 'person@example.test') => ({ idempotencyKey: key, contact: { email } });

test('passes only ordered digests and policy to the installed limiter', async () => {
  const replies = [{ allowed: true }, { allowed: false }, { allowed: false, reason: 'email_quota' }, { allowed: false, reason: 'ip_quota' }];
  const calls: Parameters<NativeCheckoutQuery['query']>[] = [];
  const check = createPostgresCheckoutRateLimit({ async query(...args) {
    calls.push(args);
    return { rows: [{ result: replies[calls.length - 1] }] };
  } }, settings);
  type NativeCallback = Parameters<ReturnType<typeof createCheckoutAdmission>['admitCheckoutRequest']>[0]['deps']['checkRateLimit'];
  const compatible: NativeCallback = check;
  assert.equal(typeof compatible, 'function');
  const attempts = [['Key', undefined], ['Key', 0], ['key', 0], ['Key', 1]] as const;
  for (const [index, [key, sequence]] of attempts.entries()) {
    assert.deepEqual(await check(request, intent(key, ' Person@EXAMPLE.test '), sequence), replies[index]);
    assert.equal(calls.length, index + 1);
  }
  assert.deepEqual(calls, attempts.map(([key, sequence]) => [
    'SELECT public.commerce_record_checkout_attempt($1::text,$2::text,$3::text,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint) AS result',
    [hash(`${key}\0${sequence ?? 0}`), request.requesterKey, hash('person@example.test'), 100, 200, 2, 1, 3],
  ]));
});

test('invalid inputs, replies and query errors fail closed', async () => {
  const denied = { allowed: false };
  let calls = 0;
  const db = { async query() { calls++; return { rows: [{ result: { allowed: true } }] }; } };
  const check = createPostgresCheckoutRateLimit(db, settings);
  for (const [attemptRequest, attemptIntent, sequence] of [
    [{ headers: {} }, intent('Key'), 0],
    [{ ...request, requesterKey: request.requesterKey.toUpperCase() }, intent('Key'), 0],
    [{ ...request, requesterKey: request.requesterKey + '\n' }, intent('Key'), 0],
    [request, intent(''), 0],
    [request, intent('Key', '  '), 0],
    [request, intent('Key'), -1],
    [request, intent('Key'), 0.5],
    [request, intent('Key'), Number.MAX_SAFE_INTEGER + 1],
  ] satisfies Parameters<typeof check>[]) {
    assert.deepEqual(await check(attemptRequest, attemptIntent, sequence), denied);
  }
  for (const field of Object.keys(settings) as (keyof typeof settings)[]) {
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(await createPostgresCheckoutRateLimit(db, { ...settings, [field]: value })(request, intent('Key'), 0), denied);
    }
  }
  assert.deepEqual(await createPostgresCheckoutRateLimit(db, { ...settings, retentionMs: 99 })(request, intent('Key'), 0), denied);
  assert.equal(calls, 0);

  for (const rows of [[], [{ result: { allowed: true } }, { result: { allowed: true } }], [{}],
    ...[null, 'true', [{ allowed: true }], { allowed: 'true' }, { allowed: true, extra: 'private' },
      { allowed: true, reason: undefined }, { allowed: true, reason: 'email_quota' },
      { allowed: false, reason: 'other' }, { reason: 'email_quota' },
      { allowed: false, reason: 'ip_quota', extra: 'private' }].map(result => [{ result }])]) {
    assert.deepEqual(await createPostgresCheckoutRateLimit({ async query() { return { rows }; } }, settings)(request, intent('Key'), 0), denied);
  }
  const malformed = { 0: { result: { allowed: true } }, length: 1 } as unknown as Awaited<ReturnType<NativeCheckoutQuery['query']>>['rows'];
  assert.deepEqual(await createPostgresCheckoutRateLimit({ async query() { return { rows: malformed }; } }, settings)(request, intent('Key'), 0), denied);
  assert.deepEqual(await createPostgresCheckoutRateLimit({ async query() { throw new Error('private'); } }, settings)(request, intent('Key'), 0), denied);
});

test('exceptions, absent and malformed callback replies fail closed without leaking inputs', async () => {
  for (const check of [async () => { throw new Error('private'); }, async () => undefined, async () => ({ allowed: 'yes' }), async () => ({ allowed: true, unexpected: 'private' }), async () => ({ allowed: true, reason: 'invalid' })]) {
    assert.equal(await admitCheckoutAttempt(check as Parameters<typeof admitCheckoutAttempt>[0], request, intent('secret'), 0), false);
  }
});

test('a repeat is a distinct ledger attempt for the requester and the key', async () => {
  const calls: unknown[][] = [];
  const check = createPostgresCheckoutRateLimit({ async query(...args) {
    calls.push(args[1] as unknown[]);
    return { rows: [{ result: { allowed: true } }] };
  } }, settings);
  const key = `checkout:${hash('derived')}`;
  assert.equal(await admitCheckoutReplay(check, request, key), true);
  assert.equal(await admitCheckoutReplay(check, request, key), true);
  const [first, second] = calls as [unknown[], unknown[]];
  assert.notEqual(first[0], second[0]);
  // A separate requester bucket, and one contact bucket per derived key that no e-mail can produce.
  assert.deepEqual([first[1], first[2]], [hash(`replay:${request.requesterKey}`), hash(`replay:${key}`)]);
  assert.deepEqual([second[1], second[2]], [first[1], first[2]]);
  assert.notEqual(first[1], request.requesterKey);
  const seen: Parameters<Parameters<typeof admitCheckoutReplay>[0]>[] = [];
  await admitCheckoutReplay(async (...input) => { seen.push(input); return { allowed: true }; }, request, key);
  assert.match(seen[0]![1].idempotencyKey, new RegExp(`^${key}:replay:[0-9a-f-]{36}$`));
  assert.deepEqual([seen[0]![1].contact, seen[0]![2]], [{ email: `replay:${key}` }, 0]);
  for (const reply of [async () => { throw new Error('private'); }, async () => ({ allowed: false }), async () => ({ allowed: true, extra: 1 })]) {
    assert.equal(await admitCheckoutReplay(reply as Parameters<typeof admitCheckoutReplay>[0], request, key), false);
  }
  // A missing or malformed requester stays malformed, so the default limiter still refuses it.
  calls.length = 0;
  assert.equal(await admitCheckoutReplay(check, { headers: {} }, key), false);
  assert.equal(await admitCheckoutReplay(check, { ...request, requesterKey: 'raw-peer' }, key), false);
  assert.equal(calls.length, 0);
});

for (const original of Object.values(configurations)) test(`${original.id}: each attempt bound and contact default changes through owned inputs`, () => {
  const config = structuredClone(original);
  config.purchase.attemptLimits = { windowMs: 40, retentionMs: 80, maxPerRequester: 2, maxPerEmail: 2, maxEntries: 2 };
  config.purchase.contact = { acquisitionSource: 'changed-example', lifecycleStage: 'inactive' };
  config.purchase.responseFloorMs = 20; config.purchase.inputLimits.name = 24; config.purchase.inputLimits.phone = 20;
  assertConfig(config);
  for (const field of Object.keys(config.purchase.attemptLimits) as Array<keyof typeof config.purchase.attemptLimits>) {
    const invalid = structuredClone(config); invalid.purchase.attemptLimits[field] = 0;
    assert.throws(() => assertConfig(invalid), /starter_purchase_configuration_invalid/);
  }
  config.purchase.attemptLimits.retentionMs = 1;
  assert.throws(() => assertConfig(config), /starter_purchase_configuration_invalid/);
});

test('host key binding rejects changed identities independently of the quota callback', async () => {
  const bindings = createCheckoutAttemptBindings(settings, () => 1);
  const first = bindings.bind('Key', 'Person@Example.test', request.requesterKey);
  assert.ok(first);
  assert.equal(bindings.bind('Key', ' person@example.test ', request.requesterKey), first);
  assert.equal(bindings.bind('Key', 'other@example.test', request.requesterKey), null);
  assert.equal(bindings.bind('Key', 'person@example.test', hash('other')), null);
  const results = await Promise.all(Array.from({ length: 20 }, async (_, index) =>
    bindings.bind('concurrent', `person-${index}@example.test`, request.requesterKey)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('host bindings expire, fail closed at capacity and require a valid requester', () => {
  let now = 1;
  const bindings = createCheckoutAttemptBindings({ ...settings, maxEntries: 1 }, () => now);
  const first = bindings.bind('one', 'person@example.test', request.requesterKey);
  assert.ok(first);
  assert.equal(bindings.bind('two', 'other@example.test', request.requesterKey), null);
  now = 202;
  assert.ok(bindings.bind('two', 'other@example.test', request.requesterKey));
  assert.equal(bindings.bind('two', 'other@example.test', undefined), null);
  assert.equal(bindings.bind('two', 'other@example.test', 'raw-peer'), null);
  assert.equal(createCheckoutAttemptBindings(settings, () => NaN).bind('key', 'person@example.test', request.requesterKey), null);
});
