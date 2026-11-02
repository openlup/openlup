import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { configurations } from '../owned/store.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
// Source-release tests keep scratch inside this application.
const scratch = resolve(root, '.context', 'extract-');

test('extract creates an independent repository and refuses to overwrite an existing one', async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(scratch), { recursive: true });
  const target = await mkdtemp(scratch);
  try {
    execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' });
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8' }).trim();
    assert.equal(gitRoot, target);
    const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    assert.equal(manifest.workspaces, undefined);
    assert.ok((await readFile(resolve(target, 'AGENTS.md'), 'utf8')).includes('owned/store.config.ts'));
    const ownership = JSON.parse(await readFile(resolve(target, 'ownership.json'), 'utf8'));
    assert.equal(ownership.schemaVersion, 1);
    assert.equal(new Set([...ownership.owned, ...ownership.managed]).size,
      ownership.owned.length + ownership.managed.length);
    for (const file of [...ownership.owned, ...ownership.managed]) {
      assert.ok((await stat(resolve(target, file))).isFile(), file);
    }
    for (const file of ownership.demoData) assert.ok(ownership.owned.includes(file), file);
    assert.ok(ownership.demoDataNote.includes('customer environment'));
    assert.ok(ownership.pageCopyRequiredFor.length > 0);
    assert.ok(ownership.pageCopyRule.includes('managed to owned'));
    for (const file of ownership.sourceOnly) await assert.rejects(access(resolve(target, file)));
    // The materialized application's default test discovery must not need archive tooling.
    const tests = execFileSync(process.execPath, ['--experimental-strip-types', '--test'], {
      cwd: target, encoding: 'utf8', stdio: 'pipe', env: {},
    });
    assert.match(tests, /fail 0/);
    for (const [args, code] of [
      [['--unknown', 'value'], 'starter_argument_unknown'],
      [['--configuration'], 'starter_argument_value_required'],
      [['--port', 'bad'], 'starter_port_invalid'],
      [['--configuration', 'unknown-configuration'], 'starter_configuration_unknown'],
    ] as const) {
      assert.throws(() => execFileSync(process.execPath,
        ['--experimental-strip-types', 'host/server.ts', ...args], { cwd: target, stdio: 'pipe' }),
      error => String((error as { stderr?: Buffer }).stderr).includes(code));
    }
    for (const [args, code] of [
      [['--unknown', 'value'], 'starter_argument_unknown'],
      [['--configuration'], 'starter_argument_value_required'],
      [['--configuration', 'unknown-configuration'], 'starter_configuration_unknown'],
      [['--configuration', 'coffee'], 'starter_installation_binding_required'],
    ] as const) {
      assert.throws(() => execFileSync(process.execPath, ['lifecycle.mjs', 'up', ...args],
        { cwd: target, stdio: 'pipe' }),
      error => String((error as { stderr?: Buffer }).stderr).includes(code));
    }

    assert.throws(() => execFileSync(process.execPath, ['lifecycle.mjs', 'up'], {
      cwd: target, stdio: 'pipe',
    }), error => String((error as { stderr?: Buffer }).stderr).includes('starter_installation_binding_required'));
    await assert.rejects(access(resolve(target, 'packages')));
    assert.ok((await stat(resolve(target, 'lifecycle'))).mode & 0o100);
    const displayed = execFileSync(process.execPath, ['lifecycle.mjs', 'ownership'], { cwd: target, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(displayed), ownership);
    assert.deepEqual(JSON.parse(await readFile(resolve(target, '.starter-origin.json'), 'utf8')),
      { schemaVersion: 1, kind: 'local-candidate', setVersion: null, sourceRevision: null });
    await writeFile(resolve(target, 'owner.txt'), 'keep me');
    assert.throws(() => execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' }));
    assert.equal(await readFile(resolve(target, 'owner.txt'), 'utf8'), 'keep me');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});


test('a third owned-only registry supplies the host default and shared offer rules', async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(scratch), { recursive: true });
  const target = await mkdtemp(scratch);
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' });
    const inventory = JSON.parse(await readFile(resolve(target, 'ownership.json'), 'utf8'));
    const managed = new Map<string, Buffer>();
    for (const path of inventory.managed) managed.set(path, await readFile(resolve(target, path)));
    const config = structuredClone(Object.values(configurations)[0]!);
    config.id = 'harbor-objects';
    config.brand.name = 'Harbor Objects';
    const owned = `import type { StoreConfig } from '../shared/config.ts';
export const configurations: Record<string, StoreConfig> = ${JSON.stringify({ [config.id]: config }, null, 2)};
export const defaultConfigurationId = 'harbor-objects';
export function selectConfiguration(id: string = defaultConfigurationId): StoreConfig {
  const config = Object.hasOwn(configurations, id) ? configurations[id] : undefined;
  if (!config) throw new Error('starter_configuration_unknown');
  return config;
}
`;
    await writeFile(resolve(target, 'owned/store.config.ts'), owned);
    const tests = execFileSync(process.execPath, ['--experimental-strip-types', '--test'], {
      cwd: target, encoding: 'utf8', stdio: 'pipe', env: {},
    });
    assert.match(tests, /fail 0/);
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    child = spawn(process.execPath, ['--experimental-strip-types', 'host/server.ts', '--port', String(port), '--listen', '127.0.0.1'], {
      cwd: target, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    let diagnostic = '';
    child.stderr?.on('data', data => { diagnostic += String(data); });
    const origin = `http://127.0.0.1:${port}`;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { response = await fetch(origin + '/api/config'); break; }
      catch { if (child.exitCode !== null) break; await setTimeout(25); }
    }
    assert.ok(response?.ok, diagnostic || 'third configuration host did not start');
    const body = await response.json() as { config: { id: string; brand: { name: string } } };
    assert.equal(body.config.id, config.id);
    assert.equal(body.config.brand.name, 'Harbor Objects');
    const cart = { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }], totalMinor: 1 };
    const action = async (operation: string, input: unknown) => {
      const result = await fetch(origin + '/api/actions/' + operation, {
        method: 'POST', headers: { Origin: origin, 'X-Starter-Request': '1',
          'Content-Type': 'application/json', 'Idempotency-Key': 'third-owned-configuration-123456' },
        body: JSON.stringify(input),
      });
      return { status: result.status, body: await result.json() as Record<string, unknown> };
    };
    const offer = await action('offer.validate', { cart });
    assert.equal(offer.status, 200);
    assert.equal(offer.body.ok, true);
    const quote = offer.body.value as { totalMinor: number };
    assert.ok(quote.totalMinor > 1); // A supplied total cannot become the shared quote.
    const checkout = await action('checkout.create', {
      cart, termsAccepted: true, termsRevision: config.legal.revision,
    });
    assert.deepEqual(checkout, { status: 409, body: { ok: false, code: 'host_binding_required' } });
    for (const [path, bytes] of managed) assert.deepEqual(await readFile(resolve(target, path)), bytes, path);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(target, { recursive: true, force: true });
  }
});
