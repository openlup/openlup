import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { createCheckoutAdmission } from '@openlup/platform/commerce/server';
import { createInterimCheckoutLimiter, admitCheckoutAttempt } from '../host/checkout-attempts.ts';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const settings = { windowMs: 100, retentionMs: 200, maxPerEmail: 1, maxPerRequester: 1, maxEntries: 3 };
const request = { headers: { 'x-forwarded-for': 'ignored.example.test' }, requesterKey: hash('peer') };
const intent = (key: string, email = 'person@example.test') => ({ idempotencyKey: key, contact: { email } });

// Characterizes the reference adopter's exact-attempt, fail-closed checkout rules.
test('exact replay precedes email then requester quota; denied attempts record nothing', async () => {
  const limiter = createInterimCheckoutLimiter(settings, () => 1);
  type NativeCallback = Parameters<ReturnType<typeof createCheckoutAdmission>['admitCheckoutRequest']>[0]['deps']['checkRateLimit'];
  const compatible: NativeCallback = limiter.checkRateLimit; assert.equal(typeof compatible, 'function');
  assert.deepEqual(await limiter.checkRateLimit(request, intent('Key'), 0), { allowed: true });
  const before = limiter.snapshot();
  assert.deepEqual(await limiter.checkRateLimit(request, intent('new'), 0), { allowed: false, reason: 'email_quota' });
  assert.deepEqual(await limiter.checkRateLimit(request, intent('new', 'other@example.test'), 0), { allowed: false, reason: 'ip_quota' });
  assert.deepEqual(limiter.snapshot(), before);
  assert.deepEqual(await limiter.checkRateLimit({ headers: {}, requesterKey: hash('other') }, intent('Key', 'changed@example.test'), 0), { allowed: true });
  assert.deepEqual(limiter.snapshot(), before);
  assert.deepEqual(await limiter.checkRateLimit(request, intent('key'), 0), { allowed: false, reason: 'email_quota' });
  assert.deepEqual(await limiter.checkRateLimit(request, intent('Key'), 1), { allowed: false, reason: 'email_quota' });
  assert.equal(before[0]!.key, hash('Key\0' + '0'));
  for (const raw of ['peer', 'person@example.test', 'Key', 'ignored.example.test']) assert.ok(!JSON.stringify(before).includes(raw));
});

test('synchronous critical section counts concurrent exact attempts once and limits concurrent identities', async () => {
  const limiter = createInterimCheckoutLimiter(settings, () => 1);
  assert.ok((await Promise.all(Array.from({ length: 20 }, () => limiter.checkRateLimit(request, intent('same'), 0)))).every(result => result.allowed));
  assert.equal(limiter.snapshot().length, 1);
  const other = createInterimCheckoutLimiter({ ...settings, maxPerEmail: 2, maxPerRequester: 2 }, () => 1);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => other.checkRateLimit(request, intent(String(i)), 0)));
  assert.equal(results.filter(result => result.allowed).length, 2); assert.equal(other.snapshot().length, 2);
});

test('retention expires entries; capacity fails closed without live eviction; restart resets', async () => {
  let now = 1;
  const limiter = createInterimCheckoutLimiter({ ...settings, maxEntries: 1 }, () => now);
  assert.equal((await limiter.checkRateLimit(request, intent('first'), 0)).allowed, true);
  now = 102;
  assert.deepEqual(await limiter.checkRateLimit(request, intent('second'), 0), { allowed: false });
  assert.equal(limiter.snapshot().length, 1);
  now = 202;
  assert.equal((await limiter.checkRateLimit(request, intent('second'), 0)).allowed, true);
  assert.equal(limiter.snapshot().length, 1);
  assert.equal((await createInterimCheckoutLimiter(settings, () => 1).checkRateLimit(request, intent('fresh'), 0)).allowed, true);
});

test('exceptions, absent and malformed callback replies fail closed without leaking inputs', async () => {
  assert.deepEqual(await createInterimCheckoutLimiter(settings, () => { throw new Error('private'); }).checkRateLimit(request, intent('secret'), 0), { allowed: false });
  assert.deepEqual(await createInterimCheckoutLimiter(settings).checkRateLimit({ headers: {} }, intent('secret'), 0), { allowed: false });
  for (const check of [async () => { throw new Error('private'); }, async () => undefined, async () => ({ allowed: 'yes' }), async () => ({ allowed: true, unexpected: 'private' }), async () => ({ allowed: true, reason: 'invalid' })]) {
    assert.equal(await admitCheckoutAttempt(check as Parameters<typeof admitCheckoutAttempt>[0], request, intent('secret'), 0), false);
  }
});

for (const original of Object.values(configurations)) test(`${original.id}: each attempt bound and contact default changes through owned inputs`, async () => {
  const config = structuredClone(original);
  config.purchase.attemptLimits = { windowMs: 40, retentionMs: 80, maxPerRequester: 2, maxPerEmail: 2, maxEntries: 2 };
  config.purchase.contact = { acquisitionSource: 'changed-example', lifecycleStage: 'inactive' };
  config.purchase.responseFloorMs = 20; config.purchase.inputLimits.name = 24; config.purchase.inputLimits.phone = 20;
  assertConfig(config);
  let now = 1; const limiter = createInterimCheckoutLimiter(config.purchase.attemptLimits, () => now);
  for (const key of ['one', 'two']) assert.equal((await limiter.checkRateLimit(request, intent(key), 0)).allowed, true);
  assert.equal((await limiter.checkRateLimit(request, intent('three'), 0)).allowed, false);
  now = 82; assert.equal((await limiter.checkRateLimit(request, intent('three'), 0)).allowed, true);
  for (const field of Object.keys(config.purchase.attemptLimits) as Array<keyof typeof config.purchase.attemptLimits>) {
    const invalid = structuredClone(config); invalid.purchase.attemptLimits[field] = 0;
    assert.throws(() => assertConfig(invalid), /starter_purchase_configuration_invalid/);
  }
  config.purchase.attemptLimits.retentionMs = 1;
  assert.throws(() => assertConfig(config), /starter_purchase_configuration_invalid/);
});

test('a retained exact replay precedes a later full window until retention expires', async () => {
  let now = 1;
  const limiter = createInterimCheckoutLimiter(settings, () => now);
  assert.equal((await limiter.checkRateLimit(request, intent('old'), 0)).allowed, true);
  now = 102;
  assert.equal((await limiter.checkRateLimit(request, intent('new'), 0)).allowed, true);
  const before = limiter.snapshot();
  assert.equal((await limiter.checkRateLimit(request, intent('old'), 0)).allowed, true);
  assert.deepEqual(limiter.snapshot(), before);
  assert.deepEqual(await limiter.checkRateLimit(request, intent('third'), 0), { allowed: false, reason: 'email_quota' });
});
