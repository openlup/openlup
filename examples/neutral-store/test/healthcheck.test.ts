import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { applicationHealthcheck } from '../host/healthcheck.ts';
import { configurations } from '../owned/store.config.ts';

const root = new URL('../', import.meta.url).pathname;
function execute(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe' });
  return once(child, 'exit').then(([code]) => code);
}

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

test('default lifecycle leaves compose.yaml healthcheck in place', async () => {
  assert.equal(applicationHealthcheck(), undefined);
  const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
  assert.ok(compose.includes("fetch('http://127.0.0.1:4319/api/config')"));
  // Exercise lifecycle's real override construction, without invoking Docker.
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/healthcheck-default-'));
  try {
    for (const path of ['host', 'shared', 'owned']) await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    await cp(resolve(root, 'lifecycle.mjs'), resolve(directory, 'lifecycle.mjs'));
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
    const config = structuredClone(Object.values(configurations)[0]!);
    delete config.publicOrigin;
    await writeFile(resolve(directory, 'owned/store.config.ts'), `export function selectConfiguration() { return ${JSON.stringify(config)}; }`);
    const bin = resolve(directory, 'bin');
    await mkdir(bin);
    await writeFile(resolve(bin, 'docker'), '#!/bin/sh\nif [ "$4" = "-f" ]; then /bin/cat > override.json; fi\n', { mode: 0o755 });
    const child = spawn(process.execPath, ['lifecycle.mjs', 'up'], { cwd: directory, env: { PATH: bin }, stdio: 'pipe' });
    assert.equal((await once(child, 'exit'))[0], 0);
    const override = JSON.parse(await readFile(resolve(directory, 'override.json'), 'utf8'));
    assert.equal(Object.hasOwn(override.services.application, 'healthcheck'), false);
    assert.deepEqual(override.services.application.command.slice(0, 4),
      ['node', '--experimental-strip-types', 'lifecycle.mjs', 'serve-demo']);
    assert.equal(Object.hasOwn(override.services.application, 'environment'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
