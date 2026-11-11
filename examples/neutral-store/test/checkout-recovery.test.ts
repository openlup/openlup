import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';
import { createCheckoutRecoveryDelivery, type CheckoutRecoveryMessage } from '../host/checkout-recovery.ts';
import { captureCompletionEntry, currentPurchase, rememberPurchase, visiblePurchase } from '../client/purchase.ts';

test('recovery message values are typed configuration in both configurations and locales', async () => {
  for (const original of Object.values(configurations)) {
    const config = structuredClone(original);
    for (const locale of ['en', 'pl'] as const) {
      config.purchase.recoveryMessage = {
        subject: { en: 'Changed subject', pl: 'Zmieniony temat' }, body: { en: 'Changed body', pl: 'Zmieniona treść' },
        expiryLabel: { en: 'Until', pl: 'Do' }, orderLabel: { en: 'Reference', pl: 'Numer' },
      };
      assertConfig(config);
      const messages: CheckoutRecoveryMessage[] = [];
      await createCheckoutRecoveryDelivery('http://127.0.0.1:4319', async message => { messages.push(message); })({
        email: 'buyer@example.test', rawToken: 'private-value', orderRef: 'order-reference', expiresAt: '2030-01-01T00:00:00.000Z', locale,
        context: { config, actor: { customerRef: null, operatorRef: null }, commandKey: 'test-command' },
      });
      const message = messages[0]!;
      assert.equal(message.kind, 'checkout-recovery');
      assert.equal(message.subject, config.purchase.recoveryMessage.subject[locale]);
      assert.ok(message.body.includes(config.purchase.recoveryMessage.body[locale]));
      assert.ok(message.body.includes(config.purchase.recoveryMessage.expiryLabel[locale]));
      assert.ok(message.body.includes(config.purchase.recoveryMessage.orderLabel[locale]));
      assert.equal(new URL(message.completionUrl).origin, 'http://127.0.0.1:4319');
      assert.equal(new URL(message.completionUrl).searchParams.get('token'), 'private-value');
    }
    Reflect.deleteProperty(config.purchase.recoveryMessage, 'expiryLabel');
    assert.throws(() => assertConfig(config), /starter_recovery_message_invalid/);
    config.purchase.recoveryMessage.expiryLabel = { en: '', pl: 'Do' };
    assert.throws(() => assertConfig(config), /starter_recovery_message_invalid/);
  }
});

test('captured checkout mail is separate and private', async () => {
  const cwd = process.cwd(), directory = await mkdtemp(join(tmpdir(), 'starter-recovery-'));
  try {
    process.chdir(directory);
    await createCheckoutRecoveryDelivery('http://127.0.0.1:4319')({ email: 'buyer@example.test', rawToken: 'private-value',
      orderRef: 'order-reference', expiresAt: '2030-01-01T00:00:00.000Z', locale: 'en',
      context: { config: Object.values(configurations)[0]!, actor: { customerRef: null, operatorRef: null }, commandKey: 'test-command' } });
    const mailbox = join(directory, '.context/captured-messages');
    assert.equal((await stat(mailbox)).mode & 0o777, 0o700);
    assert.equal((await stat(join(mailbox, createHash('sha256').update('checkout-recovery:order-reference').digest('hex') + '.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(mailbox, createHash('sha256').update('checkout-recovery:order-reference').digest('hex') + '.json'), 'utf8')).record.kind, 'checkout-recovery');
    await assert.rejects(readFile(join(mailbox, 'identity.jsonl')), { code: 'ENOENT' });
  } finally { process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
});

test('entry removes URL token synchronously and retains a private reload convenience', () => {
  const saved = ['location', 'history', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const data = new Map<string, string>();
  const location = { pathname: '/account/complete-payment', search: '?token=private-value&other=kept', hash: '#anchor' };
  let replaced = '';
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
    Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: (_: unknown, __: string, url: string) => {
      replaced = url; location.search = '?other=kept';
    } } });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value),
    } });
    captureCompletionEntry();
    assert.equal(replaced, '/account/complete-payment?other=kept#anchor');
    // Rendering after bootstrap sees the redacted URL and must retain its entry.
    captureCompletionEntry();
    assert.deepEqual(currentPurchase('entry-test'), { token: 'private-value' });
    assert.ok([...data.values()].some(value => JSON.parse(value).token === 'private-value'));
    rememberPurchase('entry-test', { orderRef: 'other-order', token: 'other-token' });
    location.search = '?token=navigation-token';
    captureCompletionEntry();
    captureCompletionEntry();
    assert.deepEqual(currentPurchase('entry-test'), { token: 'navigation-token' });
    assert.deepEqual(visiblePurchase({ token: 'private-value', status: 'pending_payment' }), { status: 'pending_payment' });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});


test('continuation keeps same-order credentials across replay without transferring them to another order', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const data = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value),
    } });
    const configuration = 'continuation-replay';
    rememberPurchase(configuration, { orderRef: 'first', token: 'first-token' });
    rememberPurchase(configuration, { orderRef: 'first' });
    assert.deepEqual(currentPurchase(configuration), { orderRef: 'first', token: 'first-token' });
    assert.deepEqual(JSON.parse(data.get(`neutral-store:purchase:v2:${configuration}`)!), currentPurchase(configuration));
    rememberPurchase(configuration, { orderRef: 'second' });
    assert.deepEqual(currentPurchase(configuration), { orderRef: 'second' });
    rememberPurchase(configuration, { orderRef: 'second', token: 'new-token' });
    assert.deepEqual(currentPurchase(configuration), { orderRef: 'second', token: 'new-token' });
    rememberPurchase(configuration, { token: 'entry-token' });
    assert.deepEqual(currentPurchase(configuration), { token: 'entry-token' });
    const storedConfiguration = 'continuation-storage-only';
    data.set(`neutral-store:purchase:v2:${storedConfiguration}`, JSON.stringify({ orderRef: 'stored', token: 'stored-token' }));
    rememberPurchase(storedConfiguration, { orderRef: 'stored' });
    assert.deepEqual(currentPurchase(storedConfiguration), { orderRef: 'stored', token: 'stored-token' });
    rememberPurchase(storedConfiguration, {});
    assert.deepEqual(currentPurchase(storedConfiguration), {});
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});


test('second submit continues through completion and a cold module reload without UI assets', async () => {
  const saved = ['location', 'history', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const data = new Map<string, string>();
  const location = { pathname: '/account/complete-payment', search: '', hash: '' };
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
    Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => { location.search = ''; } } });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value),
    } });
    const configuration = 'completion-reload';
    rememberPurchase(configuration, { orderRef: 'created', token: 'creating-token' });
    rememberPurchase(configuration, { orderRef: 'created' });
    captureCompletionEntry();
    assert.deepEqual(currentPurchase(configuration), { orderRef: 'created', token: 'creating-token' });
    const reloaded = await import(new URL('../client/purchase.ts?continuation-reload', import.meta.url).href);
    reloaded.captureCompletionEntry();
    assert.deepEqual(reloaded.currentPurchase(configuration), { orderRef: 'created', token: 'creating-token' });
    reloaded.rememberPurchase(configuration, { orderRef: 'different' });
    assert.deepEqual(reloaded.currentPurchase(configuration), { orderRef: 'different' });
    reloaded.rememberPurchase(configuration, { orderRef: 'different', token: 'replacement-token' });
    assert.deepEqual(reloaded.currentPurchase(configuration), { orderRef: 'different', token: 'replacement-token' });
    location.search = '?token=entry-token';
    reloaded.captureCompletionEntry();
    assert.deepEqual(reloaded.currentPurchase(configuration), { token: 'entry-token' });
    assert.equal(location.search, '');
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
