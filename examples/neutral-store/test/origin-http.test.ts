import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { configurations } from '../owned/store.config.ts';

const root = new URL('../', import.meta.url).pathname;
async function fixture(origin?: unknown, insecure?: boolean) {
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/origin-'));
  for (const path of ['host', 'shared', 'owned']) await cp(resolve(root, path), resolve(directory, path), { recursive: true });
  await cp(resolve(root, 'lifecycle.mjs'), resolve(directory, 'lifecycle.mjs'));
  await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
  const config = structuredClone(Object.values(configurations)[0]!);
  if (origin !== undefined) config.publicOrigin = origin as string;
  if (insecure !== undefined) config.allowInsecurePublicOrigin = insecure;
  await writeFile(resolve(directory, 'owned/store.config.ts'),
    `export const configurations = { demo: ${JSON.stringify(config)} };
export const defaultConfigurationId = 'demo';
export function selectConfiguration() { return configurations.demo; }
`);
  return directory;
}
async function start(directory: string) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'host/server.ts', '--port', String(port)],
    { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let diagnostic = '';
  child.stderr.on('data', value => { diagnostic += String(value); });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', () => reject(new Error(diagnostic || 'host exited before ready')));
  });
  const timeout = new AbortController();
  try { await Promise.race([ready, setTimeout(5000, undefined, { signal: timeout.signal }).then(() => { throw new Error('host readiness timeout'); })]); }
  catch (error) { child.kill(); await exited; throw error; }
  finally { timeout.abort(); }
  return { port, close: async () => { child.kill('SIGTERM'); await exited; } };
}
function http(port: number, method: string, path: string, headers: string[]) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let bytes = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('HTTP timeout')));
    socket.on('error', reject);
    socket.on('data', chunk => { bytes += String(chunk); });
    socket.on('end', () => {
      try { const split = bytes.indexOf('\r\n\r\n');
        resolve({ status: Number(bytes.split(' ')[1]), body: JSON.parse(bytes.slice(split + 4)) });
      } catch (error) { reject(error); }
    });
    socket.on('connect', () => socket.end(`${method} ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}`));
  });
}
const write = (host: string, origin?: string) => [`Host: ${host}`, ...(origin === undefined ? [] : [`Origin: ${origin}`]),
  'X-Starter-Request: 1', 'Content-Type: application/json', 'Idempotency-Key: origin-policy-test-123456'];

for (const configured of [false, true]) test(`real HTTP origin boundary: ${configured ? 'configured HTTPS' : 'default loopback'}`, async t => {
  const directory = await fixture(configured ? 'https://store.example.test' : undefined);
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(directory);
    const host = configured ? 'store.example.test' : `localhost:${server.port}`;
    const origin = configured ? 'https://store.example.test' : `http://${host}`;
    const action = '/api/actions/application.status';
    const positive = await http(server.port, 'POST', action, write(host, origin));
    assert.equal(positive.status, 200);
    assert.equal((positive.body as { ok: boolean }).ok, true);
    if (!configured) assert.equal((await http(server.port, 'GET', '/api/config', [`Host: 127.0.0.1:${server.port}`])).status, 200);
    for (const unknown of configured
      ? ['unknown.test', 'store.example.test.evil.test', 'evilstore.example.test', 'store.example.test:443']
      : [`unknown.test:${server.port}`, `localhost.evil.test:${server.port}`, `127.0.0.1.evil.test:${server.port}`,
        `evillocalhost:${server.port}`, `evil127.0.0.1:${server.port}`]) {
      await t.test(`Host refuses ${unknown}`, async () => {
        assert.deepEqual(await http(server!.port, 'GET', '/api/config', [`Host: ${unknown}`, `X-Forwarded-Host: ${host}`]),
          { status: 403, body: { ok: false, code: 'starter_local_host_required' } });
      });
    }
    const wrongPort = new URL(origin);
    wrongPort.port = '8443';
    for (const wrong of [undefined, 'null', origin.replace(/^https?/, configured ? 'http' : 'https'), wrongPort.origin, 'https://other.test']) {
      await t.test(`Origin refuses ${String(wrong)}`, async () => {
        assert.deepEqual(await http(server!.port, 'POST', action, write(host, wrong)),
          { status: 403, body: { ok: false, code: 'starter_same_origin_required' } });
      });
    }
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.deepEqual(await http(server.port, method, '/outside-actions', write(host)),
        { status: 403, body: { ok: false, code: 'starter_same_origin_required' } });
    }
    assert.deepEqual(await http(server.port, 'GET', '/api/config', [`Host: ${host}`, `Host: ${host}`]),
      { status: 403, body: { ok: false, code: 'starter_local_host_required' } });
    assert.deepEqual(await http(server.port, 'POST', action, [...write(host, origin), `Origin: ${origin}`]),
      { status: 403, body: { ok: false, code: 'starter_same_origin_required' } });
    assert.deepEqual(await http(server.port, 'POST', action, write(host, `${origin},${origin}`)),
      { status: 403, body: { ok: false, code: 'starter_same_origin_required' } });
    assert.deepEqual(await http(server.port, 'GET', '/api/config', [`Host: ${host}`, `Origin: ${origin}`, `Origin: ${origin}`]),
      { status: 403, body: { ok: false, code: 'starter_same_origin_required' } });
    for (const header of ['X-Starter-Request: 1', 'Content-Type: application/json']) {
      assert.equal((await http(server.port, 'POST', action, write(host, origin).filter(value => value !== header))).status, 403);
    }
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('host and lifecycle both refuse invalid origin before listening or Docker', async () => {
  const directory = await fixture('http://store.example.test');
  try {
    const bin = resolve(directory, 'bin');
    await mkdir(bin);
    await writeFile(resolve(bin, 'docker'), '#!/bin/sh\nprintf invoked > "$0.called"\nexit 91\n', { mode: 0o755 });
    for (const args of [['--experimental-strip-types', 'host/server.ts'], ['lifecycle.mjs', 'up']]) {
      assert.throws(() => execFileSync(process.execPath, args, { cwd: directory, stdio: 'pipe', timeout: 5000, env: { PATH: bin } }),
        error => String((error as { stderr?: Buffer }).stderr).includes('starter_public_origin_tls_required'));
    }
    await assert.rejects(access(resolve(bin, 'docker.called')));
  } finally { await rm(directory, { recursive: true, force: true }); }
  const allowed = await fixture('http://store.example.test', true);
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try { server = await start(allowed);
    assert.equal((await http(server.port, 'POST', '/api/actions/application.status', write('store.example.test', 'http://store.example.test'))).status, 200);
  } finally { await server?.close(); await rm(allowed, { recursive: true, force: true }); }
});
