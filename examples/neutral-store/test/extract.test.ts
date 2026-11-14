import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { configurations } from '../owned/store.config.ts';
import { createHash } from 'node:crypto';

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
      assert.deepEqual(await readFile(resolve(target, file)),
        await readFile(resolve(root, ownership.sourceMappings?.[file] ?? file)), file);
    }
    const candidateDocumentation = ['README.md', 'docs/proof.md', 'docs/ownership.md'];
    const candidateFiles = [...ownership.owned, ...ownership.managed, '.starter-origin.json']
      .filter(path => !candidateDocumentation.includes(path)).sort();
    const candidateContent = await Promise.all(candidateFiles.map(async path =>
      [path, sha256(await readFile(resolve(target, path)))]));
    // Frozen non-documentation output of b037c43e9, including metadata and identity.
    assert.equal(sha256(JSON.stringify(candidateContent)), '49908e5041582a081addb9f7d663e104655296c74387f743f921c55c64dae2c9');
    for (const file of ownership.demoData) assert.ok(ownership.owned.includes(file), file);
    assert.ok(ownership.demoDataNote.includes('customer environment'));
    assert.ok(ownership.pageCopyRequiredFor.length > 0);
    assert.ok(ownership.pageCopyRule.includes('managed to owned'));
    for (const file of ownership.sourceOnly) await assert.rejects(access(resolve(target, file)));
    // Runtime editor witnesses need selected package artifacts; the raw archive test phase remains dependency-free.
    assert.ok(ownership.sourceOnly.includes('test/editor-contracts.test.ts'));
    assert.ok(ownership.sourceOnly.includes('test/editor-mail.test.ts'));
    assert.ok((await readFile(resolve(target,'host/editor-mail.ts'),'utf8')).includes('export function composeSizedPaidEmailNote'));
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
    ] as const) {
      assert.throws(() => execFileSync(process.execPath, ['lifecycle.mjs', 'up', ...args],
        { cwd: target, stdio: 'pipe' }),
      error => String((error as { stderr?: Buffer }).stderr).includes(code));
    }

    await assert.rejects(access(resolve(target, 'packages')));
    assert.ok((await stat(resolve(target, 'lifecycle'))).mode & 0o100);
    const displayed = execFileSync(process.execPath, ['lifecycle.mjs', 'ownership'], { cwd: target, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(displayed), ownership);
    assert.deepEqual(JSON.parse(await readFile(resolve(target, '.starter-origin.json'), 'utf8')),
      { schemaVersion: 1, kind: 'local-candidate', setVersion: null, sourceRevision: null });
    assert.equal(await readFile(resolve(target, '.starter-origin.json'), 'utf8'), JSON.stringify(
      { schemaVersion: 1, kind: 'local-candidate', setVersion: null, sourceRevision: null }, null, 2) + '\n');
    assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target, stdio: 'pipe' }));
    assert.match(await readFile(resolve(target, '.gitignore'), 'utf8'), /^package-lock\.json$/m);
    await assert.rejects(access(resolve(target, 'package-lock.json')));
    await writeFile(resolve(target, 'owner.txt'), 'keep me');
    assert.throws(() => execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' }));
    assert.equal(await readFile(resolve(target, 'owner.txt'), 'utf8'), 'keep me');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function releasedFixture() {
  await mkdir(dirname(scratch), { recursive: true });
  const directory = await mkdtemp(scratch), source = resolve(directory, 'examples/neutral-store');
  const names = ['@openlup/core', '@openlup/outbox', '@openlup/platform'];
  const version = '0.41.0', revision = 'a'.repeat(40);
  const application = { name: 'fixture-store', version: '0.0.0', private: true,
    dependencies: Object.fromEntries(names.map(name => [name, `file:artifacts/${name.slice(9)}.tgz`])) };
  const ownership = { owned: ['copy.txt'], managed: ['package.json', '.gitignore', 'README.md', 'ownership.json', 'starter-release.json'],
    sourceOnly: ['README.template.md'], sourceMappings: { 'README.md': 'README.template.md' } };
  const manifest = { schemaVersion: 2, commit: revision, packages: names.map(name => ({ name, version,
    filename: `${name.slice(1).replace('/', '-')}.tgz`, sha256: sha256(name),
    integrity: `sha512-${createHash('sha512').update(name).digest('base64')}` })) };
  const pinned = { ...application, dependencies: Object.fromEntries(names.map(name => [name, version])) };
  const lock = { name: application.name, version: application.version, lockfileVersion: 3, packages: {
    '': pinned, ...Object.fromEntries(manifest.packages.map(pkg => [`node_modules/${pkg.name}`, {
      version, integrity: pkg.integrity, resolved: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.slice(9)}-${version}.tgz`,
    }])),
  } as Record<string, Record<string, unknown>> };
  const put = async (path: string, value: unknown) => {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  await put('config/openlup-packages.json', { packages: names.map(name => ({ name, directory: `packages/${name.slice(9)}`, publish: true })) });
  for (const name of names) await put(`packages/${name.slice(9)}/package.json`, { name, version });
  await put('examples/neutral-store/package.json', application);
  await put('examples/neutral-store/ownership.json', ownership);
  await put('examples/neutral-store/starter-release.json', { kind: 'local-candidate' });
  await put('examples/neutral-store/extract.mjs', 'const releasedExtractionSchemaVersion = 2;\n');
  await put('examples/neutral-store/.gitignore', 'node_modules/\npackage-lock.json\n');
  await put('examples/neutral-store/copy.txt', 'fictional owned copy\n');
  await put('examples/neutral-store/README.template.md', 'Fixture application\n');
  await put('manifest.json', manifest); await put('lock.json', lock);
  const args = ['--mode', 'released', '--set-version', version, '--source-revision', revision,
    '--manifest', resolve(directory, 'manifest.json'), '--lockfile', resolve(directory, 'lock.json'), '--source', source];
  const run = (target = 'app', flags = args) => {
    execFileSync(process.execPath, [resolve(root, 'extract.mjs'), resolve(directory, target), ...flags], { cwd: root, stdio: 'pipe' });
    return resolve(directory, target);
  };
  return { directory, source, names, version, revision, application, ownership, manifest, lock, put, args, run };
}

test('released extraction pins and commits registry artifacts with deterministic content and lock identities', async () => {
  const f = await releasedFixture();
  try {
    const first = f.run(), second = f.run('second');
    const identity = JSON.parse(await readFile(resolve(first, '.starter-origin.json'), 'utf8'));
    assert.equal(identity.mode, 'released'); assert.equal(identity.setVersion, f.version);
    assert.equal(identity.sourceRevision, f.revision); assert.equal(identity.sourceRevisionVerification, 'supplied');
    assert.deepEqual(identity, JSON.parse(await readFile(resolve(second, '.starter-origin.json'), 'utf8')));
    const files = [...f.ownership.owned, ...f.ownership.managed].sort();
    const content = await Promise.all(files.map(async path => [path, sha256(await readFile(resolve(first, path)))]));
    assert.equal(identity.contentSha256, sha256(JSON.stringify(content)));
    assert.equal(identity.lockfileSha256, sha256(await readFile(resolve(first, 'package-lock.json'))));
    const application = JSON.parse(await readFile(resolve(first, 'package.json'), 'utf8'));
    assert.deepEqual(application.dependencies, Object.fromEntries(f.names.map(name => [name, f.version])));
    assert.equal(await readFile(resolve(first, '.gitignore'), 'utf8'), 'node_modules/\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: first, encoding: 'utf8' }).trim();
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('show', 'HEAD:package-lock.json'), (await readFile(resolve(f.directory, 'lock.json'), 'utf8')).trim());
    assert.equal(git('show', 'HEAD:.starter-origin.json'), (await readFile(resolve(first, '.starter-origin.json'), 'utf8')).trim());
    await f.put('lock.json', JSON.stringify(f.lock));
    const reformatted = JSON.parse(await readFile(resolve(f.run('reformatted'), '.starter-origin.json'), 'utf8'));
    assert.equal(identity.contentSha256, reformatted.contentSha256);
    assert.notEqual(identity.lockfileSha256, reformatted.lockfileSha256);
    await f.put('examples/neutral-store/copy.txt', 'changed copy');
    const changed = JSON.parse(await readFile(resolve(f.run('changed'), '.starter-origin.json'), 'utf8'));
    assert.notEqual(identity.contentSha256, changed.contentSha256);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('reconstruction requires an explicit reason and Git source identity must match HEAD', async () => {
  const f = await releasedFixture();
  try {
    await f.put('examples/neutral-store/extract.mjs', '// Earlier extractor without released identity support\n');
    const flags = f.args.map(value => value === 'released' ? 'reconstructed' : value);
    const app = f.run('old-source', [...flags, '--reason', 'Earlier development starter reconstructed with current extraction tooling']);
    const identity = JSON.parse(await readFile(resolve(app, '.starter-origin.json'), 'utf8'));
    assert.equal(identity.mode, 'reconstructed'); assert.match(identity.reason, /Earlier development/);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: f.directory, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'Source identity fixture'], { cwd: f.directory, stdio: 'pipe' });
    assert.throws(() => f.run('wrong-head', [...flags, '--reason', 'Earlier source']),
      error => String((error as { stderr?: Buffer }).stderr).includes('starter_release_source_revision_mismatch'));
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.directory, encoding: 'utf8' }).trim();
    f.manifest.commit = revision; await f.put('manifest.json', f.manifest);
    const verified = f.run('verified', [...flags.map(value => value === f.revision ? revision : value), '--reason', 'Earlier source']);
    assert.equal(JSON.parse(await readFile(resolve(verified, '.starter-origin.json'), 'utf8')).sourceRevisionVerification, 'verified');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

type ReleaseFixture = Awaited<ReturnType<typeof releasedFixture>>;
const refusals: [string, (f: ReleaseFixture) => Promise<unknown> | void, string?][] = [
  ['set_version_required', f => { f.args[3] = '^0.41.0'; }],
  ['source_revision_required', f => { f.args[5] = 'short'; }],
  ['inputs_required', f => { f.args.splice(6, 2); }],
  ['reconstruction_reason_required', f => { f.args[1] = 'reconstructed'; }],
  ['reconstruction_required', f => f.put('examples/neutral-store/extract.mjs', '// Earlier extractor\n')],
  ['source_package_version_mismatch', f => f.put('packages/core/package.json', { name: '@openlup/core', version: '0.40.0' }), '@openlup/core'],
  ['source_package_set_empty', f => f.put('config/openlup-packages.json', { packages: [] })],
  ['manifest_identity_mismatch', async f => { f.manifest.commit = 'b'.repeat(40); await f.put('manifest.json', f.manifest); }],
  ['manifest_package_extra', async f => { f.manifest.packages[0]!.name = '@openlup/extra'; await f.put('manifest.json', f.manifest); }, '@openlup/extra'],
  ['manifest_package_duplicate', async f => { f.manifest.packages.push(f.manifest.packages[0]!); await f.put('manifest.json', f.manifest); }, '@openlup/core'],
  ['manifest_package_mismatch', async f => { f.manifest.packages[0]!.version = '0.40.0'; await f.put('manifest.json', f.manifest); }, '@openlup/core'],
  ['manifest_package_mismatch', async f => { f.manifest.packages[0]!.integrity = 'sha256-invalid'; await f.put('manifest.json', f.manifest); }, '@openlup/core'],
  ['manifest_package_missing', async f => { f.manifest.packages.shift(); await f.put('manifest.json', f.manifest); }, '@openlup/core'],
  ['application_package_extra', f => f.put('examples/neutral-store/package.json', { ...f.application, dependencies: { '@openlup/extra': '*' } }), '@openlup/extra'],
  ['lock_format_invalid', async f => { f.lock.lockfileVersion = 1; await f.put('lock.json', f.lock); }],
  ['lock_root_mismatch', async f => { f.lock.packages['']!.dependencies = {}; await f.put('lock.json', f.lock); }, 'dependencies'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/@openlup/extra'] = { version: f.version, resolved: `https://registry.npmjs.org/@openlup/extra/-/extra-${f.version}.tgz` }; await f.put('lock.json', f.lock); }, '@openlup/extra'],
  ['lock_package_duplicate', async f => { f.lock.packages['node_modules/other/node_modules/@openlup/core'] = f.lock.packages['node_modules/@openlup/core']!; await f.put('lock.json', f.lock); }, '@openlup/core'],
  ['lock_package_missing', async f => { delete f.lock.packages['node_modules/@openlup/core']; await f.put('lock.json', f.lock); }, '@openlup/core'],
  ...['version', 'integrity'].map(key => ['lock_package_mismatch', async (f: ReleaseFixture) => {
    f.lock.packages['node_modules/@openlup/core']![key] = 'wrong'; await f.put('lock.json', f.lock);
  }, '@openlup/core'] as [string, (f: ReleaseFixture) => Promise<void>, string]),
  ...['file:artifact.tgz', 'http://registry.npmjs.org/core.tgz', 'https://example.invalid/core.tgz',
    'https://' + ['fixture', 'registry.npmjs.org'].join('@') + '/core.tgz', 'https://registry.npmjs.org/core.tgz?token=x',
    'https://registry.npmjs.org/wrong.tgz'].map(resolved => ['lock_non_registry', async (f: ReleaseFixture) => {
    f.lock.packages['node_modules/@openlup/core']!.resolved = resolved; await f.put('lock.json', f.lock);
  }] as [string, (f: ReleaseFixture) => Promise<void>]),
  ['lock_non_registry', async f => { f.lock.packages['node_modules/external'] = { resolved: 'file:external.tgz' }; await f.put('lock.json', f.lock); }],
  ['lock_package_duplicate', async f => { f.lock.packages['node_modules/alias'] = { ...f.lock.packages['node_modules/@openlup/core'], name: '@openlup/core' }; await f.put('lock.json', f.lock); }, '@openlup/core'],
  ['lock_package_mismatch', async f => { f.lock.packages['node_modules/pg/node_modules/alias'] = {
    version: '0.40.0', resolved: 'https://registry.npmjs.org/@openlup/core/-/core-0.40.0.tgz',
  }; await f.put('lock.json', f.lock); }, '@openlup/core'],
  ...['version', 'integrity'].map(key => ['lock_package_mismatch', async (f: ReleaseFixture) => {
    f.lock.packages['node_modules/pg/node_modules/alias'] = { ...f.lock.packages['node_modules/@openlup/core'], [key]: undefined };
    await f.put('lock.json', f.lock);
  }, '@openlup/core'] as [string, (f: ReleaseFixture) => Promise<void>, string]),
  ['lock_package_mismatch', async f => { f.lock.packages['node_modules/pg'] = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', dependencies: { alias: 'npm:@openlup/core@0.40.0' },
  }; await f.put('lock.json', f.lock); }, '@openlup/core'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/alias'] = {
    version: f.version, resolved: `https://registry.npmjs.org/@openlup/extra/-/extra-${f.version}.tgz`,
  }; await f.put('lock.json', f.lock); }, '@openlup/extra'],
  ['lock_package_mismatch', async f => { f.lock.packages['node_modules/pg'] = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', dependencies: { alias: `npm:@openlup/core@${f.version}` },
  }; f.lock.packages['node_modules/pg/node_modules/alias'] = {
    version: f.version, resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz',
  }; await f.put('lock.json', f.lock); }, '@openlup/core'],
];
for (const [index, [code, mutate, detail]] of refusals.entries()) test(`released extraction refuses ${code} (${index + 1})`, async () => {
  const f = await releasedFixture();
  try {
    await mutate(f);
    assert.throws(() => f.run(), error => {
      const message = String((error as { stderr?: Buffer }).stderr);
      return message.includes(`starter_release_${code}`) && (!detail || message.includes(detail));
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('released extraction verifies nameless npm aliases, including hoisted dependencies and version specs', async () => {
  const f = await releasedFixture();
  try {
    const core = f.lock.packages['node_modules/@openlup/core']!;
    delete f.lock.packages['node_modules/@openlup/core'];
    f.lock.packages['node_modules/alias'] = core;
    f.lock.packages['node_modules/pg'] = { resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz',
      dependencies: { alias: `npm:@openlup/core@${f.version}` } };
    await f.put('lock.json', f.lock);
    f.run('hoisted-alias');
    core.version = `npm:@openlup/core@${f.version}`;
    await f.put('lock.json', f.lock);
    f.run('version-alias');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('extraction refuses unknown, duplicated or incomplete flags and release inputs without a mode', async () => {
  const f = await releasedFixture();
  try {
    for (const flags of [['--unknown', 'x'], ['--mode'], [...f.args, '--mode', 'released']]) {
      assert.throws(() => f.run('invalid', flags), error => String((error as { stderr?: Buffer }).stderr).includes('starter_extract_arguments_invalid'));
    }
    assert.throws(() => f.run('no-mode', f.args.slice(2)),
      error => String((error as { stderr?: Buffer }).stderr).includes('starter_extract_requires_empty_directory'));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
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
