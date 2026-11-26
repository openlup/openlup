import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { env } from 'node:process';
import { applicationHealthcheck } from '../host/healthcheck.ts';
import { parseHostArguments } from '../shared/config.ts';
import { configurations } from '../owned/store.config.ts';

const root = new URL('../', import.meta.url).pathname;
function execute(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe' });
  return once(child, 'exit').then(([code]) => code);
}

test('the direct host explains how to correct a refused port flag', () => {
  assert.equal(parseHostArguments(['--port', '6000', '--listen', '0.0.0.0']).port, 6000);
  const direct = spawnSync(process.execPath, ['host/server.ts', '--port', '1023'], {
    cwd: root, env: { ...env, OPENLUP_STARTER_PORT: '4320' }, encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(direct.error);
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /starter_port_invalid\nFix: Pass a valid `--port <1024–65535>`/u);
  assert.doesNotMatch(direct.stderr, /OPENLUP_STARTER_PORT|lifecycle up/u);
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
      await Promise.race([ready, setTimeout(20_000, undefined, { signal: timeout.signal }).then(() => { throw new Error('host readiness timeout'); })]);
    } finally { timeout.abort(); }
    const probe = applicationHealthcheck(config.publicOrigin, port)!;
    assert.deepEqual(probe.test.slice(0, 3), ['CMD', 'node', '-e']);
    assert.equal(await execute(probe.test[3]!), 0);
    assert.notEqual(await execute(applicationHealthcheck('https://wrong.example.test', port)!.test[3]!), 0);
    await close(); close = undefined;
    assert.notEqual(await execute(probe.test[3]!), 0);
  } finally { await close?.(); await rm(directory, { recursive: true, force: true }); }
});

test('Compose interpolates the listener, loopback mapping and working probe together', {
  skip: env.PATH === undefined && 'The raw extracted starter suite has an empty environment',
}, async () => {
  for (const value of [undefined, '', '4320']) {
    const expected = value || '4319';
    const output = execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.yaml', 'config', '--no-env-resolution', '--format', 'json'],
      { cwd: root, env: { ...env, OPENLUP_STARTER_PORT: value, OPENLUP_STARTER_PREFLIGHT_HANDOFF: "/dev/null" }, encoding: 'utf8' });
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
  const home = await mkdtemp(resolve(await realpath(tmpdir()), 'healthcheck-home-'));
  try {
    for (const path of ['host', 'shared', 'owned', 'installation', 'lifecycle.mjs', 'lifecycle-refusals.mjs', 'browser-groups.mjs'])
      await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
    const config = structuredClone(Object.values(configurations)[0]!);
    const bin = resolve(directory, 'bin');
    await mkdir(bin);
    await writeFile(resolve(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$OPENLUP_STARTER_PORT" >> calls
if [ "$2" = config ]; then printf '{"name":"healthcheck"}'; exit 0; fi
if [ "$4" = "-f" ]; then /bin/cat > override.json; fi
if [ "$4" = run ]; then printf '{"formatVersion":1,"state":"satisfied","exitCode":0,"configuration":"%s","packs":[],"findings":[]}\\n' "${config.id}"; fi
if [ "$4" = exec ] && [ "${'$'}{PROBE_FAILURE:-}" = 1 ]; then printf 'starter_runtime_database_auth_failed\\n'; exit 2; fi
`, { mode: 0o755 });
    const up = (value?: string, ...args: string[]) => spawnSync(process.execPath, ['lifecycle.mjs', 'up', ...args],
      { cwd: directory, env: { PATH: bin, HOME: home, OPENLUP_STARTER_PORT: value }, encoding: 'utf8' });
    for (const value of ['--bad', '1023', '65536', '1e4', '6000', '06000']) {
      const refused = up(value);
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /starter_port_invalid\nFix: .*OPENLUP_STARTER_PORT.*1024 to 65535.*lifecycle up/u);
      assert.doesNotMatch(refused.stderr, /--port/u);
      const structured = up(value, '--json');
      assert.equal(structured.status, 2);
      const { code, path, fix } = JSON.parse(structured.stdout).findings[0];
      assert.equal(code, 'starter_port_invalid');
      assert.equal(path, '/arguments');
      assert.equal(refused.stderr, `${code}\nFix: ${fix}\n`);
      await assert.rejects(readFile(resolve(directory, 'calls')), { code: 'ENOENT' });
      await assert.rejects(readFile(resolve(directory, '.context/compose-project')), { code: 'ENOENT' });
    }
    const refusal = spawnSync(process.execPath, ['lifecycle.mjs', 'up', '--json'],
      { cwd: directory, env: { PATH: bin, HOME: home, PROBE_FAILURE: '1' }, encoding: 'utf8' });
    assert.equal(refusal.status, 2);
    assert.equal(JSON.parse(refusal.stdout).findings[0].code, 'starter_runtime_database_auth_failed');
    // Database startup can have changed the selected project before the fresh read fails.
    assert.equal(await readFile(resolve(directory, '.context/compose-project'), 'utf8'), 'healthcheck\n');
    for (const [value, publicOrigin] of [[undefined, undefined], ['', undefined], ['04320', undefined], ['6000', 'https://store.example.test:4443']]) {
      await writeFile(resolve(directory, 'owned/store.config.ts'), `export function selectConfiguration() { return ${JSON.stringify({ ...config, publicOrigin })}; }`);
      await writeFile(resolve(directory, 'calls'), '');
      const result = up(value);
      assert.equal(result.status, 0, result.stderr);
      const port = value ? Number(value) : 4319;
      assert.deepEqual((await readFile(resolve(directory, 'calls'), 'utf8')).trim().split('\n'), Array(6).fill(String(port)));
      assert.equal(await readFile(resolve(directory, '.context/compose-project'), 'utf8'), 'healthcheck\n');
      const { services: { application } } = JSON.parse(await readFile(resolve(directory, 'override.json'), 'utf8'));
      assert.deepEqual(application.command.slice(0, 4), ['node', '--experimental-strip-types', 'lifecycle.mjs', 'serve-demo']);
      assert.equal(application.command[application.command.indexOf('--port') + 1], String(port));
      assert.equal(Object.hasOwn(application, 'environment'), false);
      assert.deepEqual(application.healthcheck, applicationHealthcheck(publicOrigin, port));
      if (publicOrigin) assert.match(application.healthcheck.test[3], /port:6000,.*Host:"store\.example\.test:4443"/u);
    }
  } finally { await Promise.all([directory, home].map(path => rm(path, { recursive: true, force: true }))); }
});
