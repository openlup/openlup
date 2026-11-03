import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessions } from '../host/sessions.ts';
import { createOriginPolicy } from '../host/origin-policy.ts';
import { parseHostArguments } from '../shared/config.ts';

const identity = { principalId: '11111111-1111-4111-8111-111111111111', email: 'customer@example.test' };
test('opaque sessions preserve native identity, expire, revoke and refuse invented/duplicate cookies', async () => {
  let now = Date.parse('2026-11-02T12:00:00Z');
  const sessions = createSessions(false, () => now);
  const issued = await sessions.issuer('customer').issue(identity);
  const request = { headers: { cookie: sessions.cookie(issued.accessToken).split(';')[0]! } };
  assert.deepEqual(sessions.read(request)?.session, { ...identity, kind: 'customer', expiresAt: issued.expiresAt });
  assert.equal(sessions.read({ headers: { cookie: 'starter_session=' + 'a'.repeat(43) } }), null);
  assert.equal(sessions.read({ headers: { cookie: request.headers.cookie + '; ' + request.headers.cookie } }), null);
  assert.equal(sessions.read({ headers: { cookie: 'customerRef=other; operatorRef=admin' } }), null);
  assert.equal(sessions.read({ headers: {} }), null);
  sessions.revoke(issued.accessToken);
  assert.equal(sessions.read(request), null);
  const operator = await sessions.issuer('operator').issue(identity);
  const operatorRequest = { headers: { cookie: 'starter_session=' + operator.accessToken } };
  assert.equal(sessions.read(operatorRequest)?.session.kind, 'operator');
  now += 3600_000;
  assert.equal(sessions.read(operatorRequest), null);
  sessions.close();
});

test('cookie is Secure exactly for configured HTTPS, host-only and limited to action paths', () => {
  for (const [config, expected] of [[{}, false], [{ publicOrigin: 'http://localhost:8080' }, false],
    [{ publicOrigin: 'https://store.example.test' }, true]] as const) {
    const sessions = createSessions(createOriginPolicy(config, 4319).secureCookies);
    const cookie = sessions.cookie('a'.repeat(43));
    assert.equal(cookie.includes('; Secure'), expected);
    assert.ok(cookie.includes('; HttpOnly; SameSite=Lax;'));
    assert.ok(cookie.includes('; Path=/api/actions;'));
    assert.equal(cookie.includes('Domain='), false);
    assert.ok(sessions.clearCookie().includes('Max-Age=0'));
    assert.equal(sessions.clearCookie().includes('; Secure'), expected);
  }
});

test('runtime URL argument accepts only the passwordless demonstration runtime identity', () => {
  const url = 'postgresql://starter_runtime@database:5432/neutral_store';
  assert.equal(parseHostArguments(['--database-url', url]).databaseUrl, url);
  for (const value of ['not-a-url', 'postgresql://starter_install@database/neutral_store',
    'postgresql://postgres@database/neutral_store', 'postgresql://starter_runtime:secret@database/neutral_store',
    'postgresql://starter_runtime@database/neutral_store?options=role', 'postgresql://starter_runtime@database/other']) {
    assert.throws(() => parseHostArguments(['--database-url', value]), /starter_runtime_connection_required/);
  }
});
