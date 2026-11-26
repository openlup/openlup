import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { env } from 'node:process';
import { applicationHealthcheck } from '../host/healthcheck.ts';
import { configurations } from '../owned/store.config.ts';

const root = new URL('../', import.meta.url).pathname;
function execute(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe' });
  return once(child, 'exit').then(([code]) => code);
}

test('npm start explains how to correct a refused port flag', () => {
  for (const port of ['1023', '6000']) {
    const direct = spawnSync('npm', ['start', '--', '--port', port], {
      cwd: root, env: { ...env, PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter),
        OPENLUP_STARTER_PORT: '4320' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(direct.error);
    assert.equal(direct.status, 1);
    assert.match(direct.stderr, /starter_port_invalid\nFix: Pass a valid `--port <1024–65535>`/u);
    assert.doesNotMatch(direct.stderr, /OPENLUP_STARTER_PORT|lifecycle up/u);
  }
});

test('real lifecycle probe sends the configured Host; wrong Host and connection errors fail', async () => {
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/healthcheck-'));
  let close: (() => Promise<void>) | undefined;
  try {
    for (const path of ['host', 'shared', 'owned']) await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
    const config = { ...structuredClone(Object.values(configurations)[0]!), publicOrigin: 'https://store.example.test' };
    await writeFile(resolve(directory, 'owned/store.config.ts'),
      `export function selectConfiguration() { return ${JSON.stringify(config)}; }`);
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const child = spawn(process.execPath, ['--experimental-strip-types', 'host/server.ts', '--port', String(port)],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    close = async () => { child.kill('SIGTERM'); await exited; };
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic += String(bytes); });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', () => reject(new Error(diagnostic || 'host exited before ready')));
    });
    const timeout = new AbortController();
    try {
      await Promise.race([ready, setTimeout(5000, undefined, { signal: timeout.signal }).then(() => { throw new Error('host readiness timeout'); })]);
    } finally { timeout.abort(); }
    const probe = applicationHealthcheck(config.publicOrigin, port)!;
    assert.deepEqual(probe.test.slice(0, 3), ['CMD', 'node', '-e']);
    assert.equal(await execute(probe.test[3]!), 0);
    assert.notEqual(await execute(applicationHealthcheck('https://wrong.example.test', port)!.test[3]!), 0);
    await close(); close = undefined;
    assert.notEqual(await execute(probe.test[3]!), 0);
  } finally { await close?.(); await rm(directory, { recursive: true, force: true }); }
});

test('Compose interpolates the listener, loopback mapping and working probe together', async () => {
  for (const value of [undefined, '', '4320']) {
    const expected = value || '4319';
    const output = execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.yaml', 'config', '--format', 'json'],
      { cwd: root, env: { ...env, OPENLUP_STARTER_PORT: value }, encoding: 'utf8' });
    const app = JSON.parse(output).services.application;
    assert.equal(app.command[app.command.indexOf('--port') + 1], expected);
    assert.deepEqual(app.ports.map(({ host_ip, published, target }: Record<string, unknown>) => [host_ip, published, target]),
      [['127.0.0.1', expected, Number(expected)]]);
    assert.equal(await execute(`globalThis.fetch = async url => ({ok: url === 'http://127.0.0.1:${expected}/api/config'});\n${app.healthcheck.test[3]}`), 0);
  }
});

test('lifecycle passes the resolved port to Compose and configures the probe authority separately', async () => {
  assert.equal(applicationHealthcheck(), undefined);
  // Exercise lifecycle's real override construction, without invoking Docker.
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/healthcheck-default-'));
  try {
    for (const path of ['host', 'shared', 'owned', 'installation', 'lifecycle.mjs', 'lifecycle-refusals.mjs', 'browser-groups.mjs'])
      await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
    const config = structuredClone(Object.values(configurations)[0]!);
    const bin = resolve(directory, 'bin');
    await mkdir(bin);
    await writeFile(resolve(bin, 'docker'), '#!/bin/sh\nif [ "$4" = "-f" ]; then /bin/cat > override.json; fi\nprintf "%s\\n" "$OPENLUP_STARTER_PORT" >> calls\n', { mode: 0o755 });
    const up = (value?: string, ...args: string[]) => spawnSync(process.execPath, ['lifecycle.mjs', 'up', ...args],
      { cwd: directory, env: { PATH: bin, OPENLUP_STARTER_PORT: value }, encoding: 'utf8' });
    for (const value of ['--bad', '1023', '65536', '1e4', '6000', '06000']) {
      const refused = up(value);
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /starter_port_invalid\nFix: .*OPENLUP_STARTER_PORT.*1024 to 65535.*lifecycle up/u);
      const structured = up(value, '--json');
      assert.equal(structured.status, 2);
      const { code, path, fix } = JSON.parse(structured.stdout).findings[0];
      assert.equal(code, 'starter_port_invalid');
      assert.equal(path, '/arguments');
      assert.equal(refused.stderr, `${code}\nFix: ${fix}\n`);
      await assert.rejects(readFile(resolve(directory, 'calls')), { code: 'ENOENT' });
    }
    for (const [value, publicOrigin] of [[undefined, undefined], ['', undefined], ['04320', undefined], ['4320', 'https://store.example.test:4443']]) {
      await writeFile(resolve(directory, 'owned/store.config.ts'), `export function selectConfiguration() { return ${JSON.stringify({ ...config, publicOrigin })}; }`);
      await writeFile(resolve(directory, 'calls'), '');
      const result = up(value);
      assert.equal(result.status, 0, result.stderr);
      const port = value ? Number(value) : 4319;
      assert.deepEqual((await readFile(resolve(directory, 'calls'), 'utf8')).trim().split('\n'), Array(4).fill(String(port)));
      const { services: { application } } = JSON.parse(await readFile(resolve(directory, 'override.json'), 'utf8'));
      assert.deepEqual(application.command.slice(0, 4), ['node', '--experimental-strip-types', 'lifecycle.mjs', 'serve-demo']);
      assert.equal(application.command[application.command.indexOf('--port') + 1], String(port));
      assert.equal(Object.hasOwn(application, 'environment'), false);
      assert.deepEqual(application.healthcheck, applicationHealthcheck(publicOrigin, port));
      if (publicOrigin) assert.match(application.healthcheck.test[3], /port:4320,.*Host:"store\.example\.test:4443"/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
