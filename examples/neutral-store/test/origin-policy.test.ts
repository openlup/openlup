import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConfig, assertPublicOrigin } from '../shared/config.ts';
import { configurations } from '../owned/store.config.ts';
import { createOriginPolicy, admitRequest } from '../host/origin-policy.ts';

const writeHeaders = (host: string, origin?: string) => ['Host', host,
  ...(origin === undefined ? [] : ['Origin', origin]), 'X-Starter-Request', '1', 'Content-Type', 'application/json'];
const local = createOriginPolicy({}, 4319);
const publicPolicy = createOriginPolicy({ publicOrigin: 'https://store.example.test' }, 4319);

for (const [value, canonical] of [
  ['https://store.example.test', 'https://store.example.test'],
  ['https://store.example.test:443/', 'https://store.example.test'],
  ['https://store.example.test:8443/', 'https://store.example.test:8443'],
  ['http://localhost:8080/', 'http://localhost:8080'],
  ['http://127.0.0.1:4319', 'http://127.0.0.1:4319'],
  ['https://[::1]:8443', 'https://[::1]:8443'],
  ['https://192.0.2.1', 'https://192.0.2.1'],
  ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
] as const) test(`canonical origin: ${value}`, () => {
  const config = { publicOrigin: value };
  assertPublicOrigin(config);
  assert.equal(config.publicOrigin, canonical);
});

test('explicit proxy ports and IP literals stay single exact authorities', () => {
  for (const value of ['http://localhost:8080', 'https://192.0.2.1:8443', 'https://[2001:db8::1]']) {
    const config = { publicOrigin: value };
    assertPublicOrigin(config);
    const policy = createOriginPolicy(config, 4319);
    const host = new URL(config.publicOrigin).host;
    assert.deepEqual(admitRequest(policy, 'POST', writeHeaders(host, config.publicOrigin)),
      { ok: true, origin: config.publicOrigin });
    assert.deepEqual(admitRequest(policy, 'GET', ['Host', 'localhost:4319']),
      { ok: false, code: 'starter_local_host_required' });
    assert.deepEqual(admitRequest(policy, 'GET', ['Host', host + '.evil.test']),
      { ok: false, code: 'starter_local_host_required' });
  }
});

for (const value of [null, 1, '', ' ', 'https://store.example.test ', 'https://store.example.test/other',
  'https://user:password@store.example.test', 'https://@store.example.test', 'https://store.example.test?',
  'https://store.example.test?query', 'https://store.example.test#', 'https://store.example.test#fragment',
  'https://*.example.test', 'ftp://store.example.test', 'https://Store.example.test',
  'https://bücher.example', 'https://store.example.test.', 'https://store.example.test/../',
  'https://store.example.test/./', 'https://store.example.test\\', 'https://%73tore.example.test',
  'https://127.1', 'https://store.example.test:0443', 'https://' + 'a'.repeat(250),
]) test(`invalid origin refuses: ${JSON.stringify(value)}`, () => {
  assert.throws(() => assertPublicOrigin({ publicOrigin: value as string }), /starter_public_origin_/);
});

test('plain non-local HTTP requires explicit typed opt-in at config validation', () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.publicOrigin = 'http://store.example.test';
  assert.throws(() => assertConfig(config), /starter_public_origin_tls_required/);
  config.allowInsecurePublicOrigin = true;
  assertConfig(config);
  assert.equal(config.publicOrigin, 'http://store.example.test');
  assert.throws(() => assertPublicOrigin({ allowInsecurePublicOrigin: 'true' as unknown as boolean }),
    /starter_public_origin_flag_invalid/);
});

for (const host of ['other.test', 'localhost.evil.test:4319', '127.0.0.1.evil.test:4319',
  'evillocalhost:4319', 'evil127.0.0.1:4319', 'localhost', 'LOCALHOST:4319', 'localhost:4320']) {
  test(`default unknown/lookalike Host refuses: ${host}`, () => {
    assert.deepEqual(admitRequest(local, 'GET', ['Host', host]), { ok: false, code: 'starter_local_host_required' });
  });
}
for (const host of ['store.example.test.evil.test', 'evilstore.example.test', 'store.example.test:443',
  'store.example.test:8443', 'STORE.example.test', 'localhost:4319']) {
  test(`configured unknown/lookalike Host refuses: ${host}`, () => {
    assert.deepEqual(admitRequest(publicPolicy, 'GET', ['Host', host]), { ok: false, code: 'starter_local_host_required' });
  });
}
for (const origin of [undefined, 'null', 'http://store.example.test', 'https://store.example.test:8443',
  'https://other.test', 'https://store.example.test/', 'https://store.example.test:443']) {
  test(`write Origin refuses: ${origin}`, () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.deepEqual(admitRequest(publicPolicy, method, writeHeaders('store.example.test', origin)),
        { ok: false, code: 'starter_same_origin_required' });
    }
  });
}

test('positive configured HTTPS and unchanged two loopback HTTP authorities', () => {
  assert.deepEqual(admitRequest(publicPolicy, 'POST', writeHeaders('store.example.test', 'https://store.example.test')),
    { ok: true, origin: 'https://store.example.test' });
  assert.equal(publicPolicy.secureCookies, true);
  assert.equal(local.secureCookies, false);
  for (const host of ['127.0.0.1:4319', 'localhost:4319']) {
    assert.deepEqual(admitRequest(local, 'POST', writeHeaders(host, `http://${host}`)), { ok: true, origin: `http://${host}` });
    assert.equal(admitRequest(local, 'HEAD', ['Host', host]).ok, true);
  }
});

test('duplicate/multi-valued headers refuse, and forwarding never supplies authority', () => {
  for (const headers of [
    ['Host', 'store.example.test', 'Host', 'store.example.test'],
    ['Host', 'store.example.test,evil.test'],
    ['Host', 'evil.test', 'X-Forwarded-Host', 'store.example.test'],
  ]) assert.deepEqual(admitRequest(publicPolicy, 'GET', headers), { ok: false, code: 'starter_local_host_required' });
  for (const headers of [
    [...writeHeaders('store.example.test', 'https://store.example.test'), 'Origin', 'https://store.example.test'],
    writeHeaders('store.example.test', 'https://store.example.test,https://evil.test'),
    [...writeHeaders('store.example.test'), 'Forwarded', 'proto=https;host=store.example.test', 'X-Forwarded-Origin', 'https://store.example.test'],
    ['Host', 'store.example.test', 'Origin', 'https://store.example.test', 'Content-Type', 'application/json'],
    ['Host', 'store.example.test', 'Origin', 'https://store.example.test', 'X-Starter-Request', '1', 'Content-Type', 'text/plain'],
  ]) assert.deepEqual(admitRequest(publicPolicy, 'POST', headers), { ok: false, code: 'starter_same_origin_required' });
});
