import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureRecoveryEntry, currentRecoveryToken } from '../client/recovery-session.ts';
import { demoRecoveryConfiguration } from '../shared/recovery-config.ts';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';

test('repair entry captures before requests and login, cleans history and survives same-tab navigation', () => {
  const names = ['location', 'history', 'sessionStorage'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const storage = new Map<string, string>();
  const secret = 'A'.repeat(43);
  const order: string[] = [];
  const location = { pathname: '/account/payment/recover', search: `?token=${secret}&other=kept`, hash: '' };
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      setItem: (key: string, value: string) => { order.push('capture'); storage.set(key, value); },
      getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key),
    } });
    Object.defineProperty(globalThis, 'history', { configurable: true, value: {
      replaceState: (_: unknown, __: string, path: string) => {
        order.push('history'); assert.ok(!path.includes(secret)); location.search = '?other=kept';
      },
    } });
    captureRecoveryEntry();
    order.push('request');
    assert.deepEqual(order, ['capture', 'history', 'request']);
    location.pathname = '/auth/sign-in';
    assert.equal(currentRecoveryToken() === secret, true);
    location.pathname = '/pl/auth/sign-in';
    captureRecoveryEntry();
    assert.equal(currentRecoveryToken() === secret, true);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('recovery copy is typed and changeable in each demo configuration', () => {
  for (const original of Object.values(configurations)) {
    const config = structuredClone(original);
    config.recovery = structuredClone(demoRecoveryConfiguration);
    config.recovery.states.authorized_retry.en = 'Changed pending retry copy';
    assertConfig(config);
    config.recovery.message.subject.en = '';
    assert.throws(() => assertConfig(config), /starter_recovery_configuration_invalid/);
  }
});
