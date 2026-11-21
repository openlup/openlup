import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { z, type ZodType } from 'zod';
import { runSettingsCommand } from '@openlup/platform/operations/server';
import { createSettingsBindings } from '../owned/settings-host.ts';
import { configurations } from '../owned/store.config.ts';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { proveStarterCatalogueWrappers } from '../../../scripts/packages/distribution-cli-proof.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
// Source-release tests keep scratch inside this application.
const scratch = resolve(root, '.context', 'extract-');

test('native starter declaration schemas accept and reject the same values as the former catalogue schemas', () => {
  const int32Max = 2147483647;
  const safeMax = Number.MAX_SAFE_INTEGER;
  const cases = [
    ['offer.freeShippingFromMinor', { type: 'integer', minimum: 0, maximum: int32Max },
      [0, 1000, int32Max], [-1, int32Max + 1, '1000']],
    ['offer.subscriptionDiscountBps', { type: 'integer', minimum: 0 },
      [0, 500, 10000, safeMax], [-1, safeMax + 1, '500']],
    ['purchase.reservationMinutes', { type: 'integer', minimum: 1, maximum: safeMax },
      [1, 30, safeMax], [0, safeMax + 1, '30']],
    ['subscriptionCreation.editWindowHours', { type: 'integer', minimum: 1, maximum: 720 },
      [1, 72, 720], [0, 721, '72']],
    ['subscriptionOffers.deliveryCycles', { type: 'object' },
      [{ classic: {}, sized: {} }], [[]]],
    ['subscriptions.lifecycleNoticeRetryBudget', { type: 'integer', minimum: 1, maximum: int32Max },
      [1, 6, int32Max], [0, int32Max + 1, '6']],
  ] as const;
  const binding = createSettingsBindings({});
  assert.ok('file' in binding && binding.file);
  for (const [key, oldSchema, accepted, rejected] of cases) {
    const old = z.fromJSONSchema(oldSchema);
    const current: ZodType | undefined = binding.file.entries[key]?.descriptor?.schema;
    assert.ok(current, key);
    for (const [values, expected] of [[accepted, true], [rejected, false]] as const) {
      for (const value of values) {
        const message = key + ': ' + JSON.stringify(value);
        assert.equal(old.safeParse(value).success, expected, message);
        assert.equal(current.safeParse(value).success, expected, message);
      }
    }
  }
});

async function starterSettings(configuration: string, args: string[], expectedStatus = 0) {
  let stdout = '';
  const status = await runSettingsCommand([...args, '--app', './owned/settings-host.ts', '--configuration', configuration, '--json'], {
    write: text => { stdout += text; },
    readStdin: async () => '',
  }, {
    bind: async input => createSettingsBindings(input),
    loadCheck: async input => createSettingsBindings(input),
  });
  assert.equal(status, expectedStatus, stdout);
  return JSON.parse(stdout);
}

const starterSettingLocations = [
  ['renewal.retryBackoffHours', 'owned/renewal.config.ts', 'retryBackoffHours'],
  ['offer.shippingMinor', 'owned/store.config.ts', 'offer.shippingMinor'],
  ['purchase.tax.vatRateBps', 'owned/store.config.ts', 'purchase.tax.vatRateBps'],
  ['offer.minUnits', 'owned/store.config.ts', 'offer.minUnits'],
  ['offer.maxUnits', 'owned/store.config.ts', 'offer.maxUnits'],
  ['purchase.attemptLimits', 'owned/store.config.ts', 'purchase.attemptLimits'],
  ['renewal.subscriptionCare.terms', 'owned/renewal.config.ts', 'subscriptionCare.terms'],
  ['renewal.subscriptionCare.pausePresets', 'owned/renewal.config.ts', 'subscriptionCare.pausePresets'],
  ['renewal.subscriptionCare.notices', 'owned/renewal.config.ts', 'subscriptionCare.notices'],
  ['legal.returnsDays', 'owned/store.config.ts', 'legal.returnsDays'],
  ['offer.subscriptionRoundingQuantumMinor', 'owned/store.config.ts', 'offer.subscriptionRoundingQuantumMinor'],
  ['market', 'owned/store.config.ts', 'market'],
  ['shipping.rateResolver', 'owned/quote-shipping.ts', 'createQuoteShipping'],
] as const;

test('settings check includes all new declarations and their edit locations in both configurations', async () => {
  for (const configuration of Object.keys(configurations)) {
    const checked = await starterSettings(configuration, ['check']);
    assert.equal(checked.configuration, configuration);
    assert.equal(checked.state, 'checked');
    assert.equal(checked.appValidation.state, 'passed');
    for (const [key, file, symbol] of starterSettingLocations) {
      const row = checked.rows.find((entry: { key: string }) => entry.key === key);
      assert.ok(row, key);
      assert.equal(row.takesEffect, `${file} ${symbol}`, key);
      if (key === 'shipping.rateResolver') {
        assert.deepEqual(row.file, { state: 'not-reported' });
      } else {
        assert.equal(row.file.state, 'present', key);
        assert.deepEqual(row.file.location, { file, symbol }, key);
      }
      if (key === 'market') {
        const { country, currency, timezone } = configurations[configuration]!.market;
        assert.deepEqual(row.file.value, { country, currency, timezone });
      }
      assert.equal(row.validation.state, key === 'legal.returnsDays' || key === 'shipping.rateResolver' ? 'not-validated' : 'valid', key);
    }
  }
});

test('settings check identifies five invalid object members in scratch configurations', async () => {
  const configuration = 'settings-review-scratch';
  const cases: readonly [string, string[], (config: typeof configurations[string]) => void][] = [
    ['purchase.attemptLimits', ['maxPerEmail'], config => { config.purchase.attemptLimits.maxPerEmail = 0; }],
    ['renewal.subscriptionCare.terms', ['pauseDays'], config => { config.renewal.subscriptionCare.terms.pauseDays = 0; }],
    ['renewal.subscriptionCare.pausePresets', ['allowed', '0'], config => {
      Object.assign(config.renewal.subscriptionCare.pausePresets, { allowed: ['forever'] });
    }],
    ['renewal.subscriptionCare.notices', ['operatorMaxAttempts'], config => {
      config.renewal.subscriptionCare.notices.operatorMaxAttempts = 0;
    }],
    ['market', ['country'], config => { config.market.country = 'USA'; }],
  ];
  for (const [key, path, change] of cases) {
    const config = { ...structuredClone(configurations.supplements!), id: configuration };
    change(config);
    configurations[configuration] = config;
    try {
      const checked = await starterSettings(configuration, ['check'], 1);
      assert.equal(checked.state, 'invalid', key);
      assert.equal(checked.appValidation.state, 'failed', key);
      const row = checked.rows.find((entry: { key: string }) => entry.key === key);
      assert.deepEqual(row?.validation, { state: 'invalid', paths: [path] }, key);
    } finally {
      delete configurations[configuration];
    }
  }
});

test('settings show leaves frozen values empty for admission rules and notice windows', async () => {
  for (const key of ['offer.minUnits', 'offer.maxUnits', 'renewal.subscriptionCare.pausePresets', 'renewal.subscriptionCare.notices']) {
    const shown = await starterSettings('supplements', ['show', key]);
    assert.deepEqual(shown.setting.effect.frozenOn, [], key);
  }
});

test('settings check names the offer member when zero cadence prevents configuration loading', async () => {
  await mkdir(dirname(scratch), { recursive: true });
  const target = await mkdtemp(scratch);
  try {
    execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' });
    const store = resolve(target, 'owned/store.config.ts');
    const source = await readFile(store, 'utf8');
    assert.ok(source.includes('offers(set(28, 56), 28,'));
    await writeFile(store, source.replace('offers(set(28, 56), 28,', 'offers(set(0, 56), 28,'));
    const app = resolve(target, 'owned/settings-host.ts');
    let stdout = '';
    const status = await runSettingsCommand(['check', '--app', app, '--json'], {
      write: text => { stdout += text; },
      readStdin: async () => '',
    }, {
      bind: async input => createSettingsBindings(input),
      loadCheck: async input => (await import(pathToFileURL(input.app).href)).createSettingsBindings(input),
    });
    assert.equal(status, 1, stdout);
    const checked = JSON.parse(stdout);
    assert.equal(checked.state, 'invalid');
    assert.equal(checked.appValidation.state, 'failed');
    assert.equal(checked.appValidation.phase, 'load');
    assert.match(checked.appValidation.message, /^starter_subscription_offer_invalid \(subscriptionOffers\.<mode>\.days: .+\)$/);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('settings list finds starter declarations by customer and operator goals', async () => {
  const goals = [
    ['payment retry', 'renewal.retryBackoffHours'],
    ['dunning schedule', 'renewal.retryBackoffHours'],
    ['flat shipping', 'offer.shippingMinor'],
    ['delivery fee', 'offer.shippingMinor'],
    ['vat', 'purchase.tax.vatRateBps'],
    ['tax rate', 'purchase.tax.vatRateBps'],
    ['quantity limit', 'offer.minUnits', 'offer.maxUnits'],
    ['pause duration', 'renewal.subscriptionCare.terms'],
    ['pause presets', 'renewal.subscriptionCare.pausePresets'],
    ['reminder window', 'renewal.subscriptionCare.notices'],
    ['return window', 'legal.returnsDays'],
    ['rounding', 'offer.subscriptionRoundingQuantumMinor'],
    ['currency', 'market'],
    ['carrier', 'shipping.rateResolver'],
    ['shipping provider', 'shipping.rateResolver'],
  ] as const;
  for (const configuration of Object.keys(configurations)) {
    for (const [goal, ...keys] of goals) {
      const listed = await starterSettings(configuration, ['list', '--goal', goal]);
      const matches = listed.entries.map((entry: { key: string }) => entry.key);
      for (const key of keys) assert.ok(matches.includes(key), `${configuration}: ${goal} must find ${key}`);
    }
  }
});

test('settings show reports the six existing declarations from the selected file', async () => {
  for (const [configuration, config] of Object.entries(configurations)) {
    const settings = {
      'offer.freeShippingFromMinor': config.offer.freeShippingFromMinor,
      'offer.subscriptionDiscountBps': config.offer.subscriptionDiscountBps,
      'purchase.reservationMinutes': config.purchase.reservationMinutes,
      'subscriptionCreation.editWindowHours': config.subscriptionCreation.editWindowHours,
      'subscriptionOffers.deliveryCycles': config.subscriptionOffers,
      'subscriptions.lifecycleNoticeRetryBudget': config.renewal.subscriptionCare.dispatch.maxAttempts,
    };
    for (const [key, value] of Object.entries(settings)) {
      const shown = await starterSettings(configuration, ['show', key]);
      assert.equal(shown.setting.key, key);
      assert.deepEqual(shown.observation, { state: 'file', configuration, value }, key);
    }
  }
});

const managedHint = 'Managed by OpenLup. Use AGENTS.md to find the owned extension point.';
const catalogueHint = 'Managed by OpenLup. Use owned/catalogue.ts and owned/catalogue-rules.cjs for catalogue definitions and rules.';

test('extract creates an independent repository and refuses to overwrite an existing one', async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(scratch), { recursive: true });
  const target = await mkdtemp(scratch);
  try {
    const stdout = execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    assert.equal(stdout, `Created independent application: ${relative(root, target)}\n`
      + 'Read README.md before installing. Local candidates are not published releases.\n');
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8' }).trim();
    assert.equal(gitRoot, target);
    const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    assert.equal(manifest.workspaces, undefined);
    assert.ok((await readFile(resolve(target, 'AGENTS.md'), 'utf8')).includes('owned/store.config.ts'));
    const ownership = JSON.parse(await readFile(resolve(root, 'ownership.json'), 'utf8'));
    assert.equal(ownership.schemaVersion, 1);
    assert.equal(new Set([...ownership.owned, ...ownership.managed]).size,
      ownership.owned.length + ownership.managed.length);
    const candidateFiles = [];
    for (const file of await readdir(target, { recursive: true })) {
      if (file === '.git' || file.startsWith('.git/')) continue;
      if ((await stat(resolve(target, file))).isFile()) candidateFiles.push(file);
    }
    assert.deepEqual(candidateFiles.sort(), [...ownership.owned, ...ownership.managed, '.starter-origin.json'].sort());
    const managedJson = ['ownership.json', 'package.json', 'starter-release.json', 'tsconfig.json'];
    assert.deepEqual(ownership.managed.filter((path: string) => path.endsWith('.json')).sort(), managedJson);
    const indexed = ['Dockerfile', 'client/style.css', 'index.html', ...managedJson];
    const index = Buffer.from('\n## Managed files without a header\n\n' + indexed.map(path => `- \`${path}\` — ${managedHint}\n`).join(''));
    // Strip only the expected annotations, then compare the source bytes and mode.
    for (const file of [...ownership.owned, ...ownership.managed]) {
      const source = resolve(root, ownership.sourceMappings?.[file] ?? file);
      const output = resolve(target, file);
      assert.equal((await stat(output)).mode, (await stat(source)).mode, file);
      let bytes = await readFile(output);
      if (file === 'docs/ownership.md') {
        assert.deepEqual(bytes.subarray(-index.length), index, 'managed ownership index');
        bytes = bytes.subarray(0, -index.length);
      }
      if (managedJson.includes(file)) JSON.parse(bytes.toString());
      if (ownership.managed.includes(file) && !indexed.includes(file)) {
        const hint = ['host/editor-catalogue.ts', 'installation/install.ts'].includes(file) ? catalogueHint : managedHint;
        let line = `# ${hint}`;
        if (/\.(?:ts|mts|mjs)$/.test(file)) line = `// ${hint}`;
        if (file.endsWith('.md')) line = `<!-- ${hint} -->`;
        const lines = bytes.toString().split('\n');
        assert.equal(lines.filter(line => line.includes('Managed by OpenLup.')).length, 1, file);
        const prefix = file === 'lifecycle' ? '#!/bin/sh\n' : '';
        const annotation = Buffer.from(prefix + line + '\n');
        assert.deepEqual(bytes.subarray(0, annotation.length), annotation, file);
        bytes = Buffer.concat([Buffer.from(prefix), bytes.subarray(annotation.length)]);
      } else assert.ok(!bytes.includes('Managed by OpenLup.'), file);
      assert.deepEqual(bytes, await readFile(source), file);
    }
    for (const [name, specifier] of Object.entries(manifest.dependencies)) {
      if (name.startsWith('@openlup/')) assert.match(specifier as string, /^file:artifacts\/.+\.tgz$/);
    }
    for (const file of ownership.demoData) assert.ok(ownership.owned.includes(file), file);
    assert.ok(ownership.owned.includes('owned/quote-shipping.ts'));
    assert.ok(ownership.owned.includes('owned/renewal-policy.ts'));
    for (const file of ['host/quote-composition.ts', 'shared/config.ts', 'test/quote-shipping.test.ts', 'test/subscription-creation.test.ts']) {
      assert.ok(ownership.managed.includes(file), file);
      assert.ok(!ownership.owned.includes(file), file);
    }
    for (const file of ['host/renewal-job.ts', 'host/scheduled-renewal.ts', 'test/renewal-policy.test.ts']) {
      assert.ok(ownership.managed.includes(file), file);
      assert.ok(!ownership.owned.includes(file), file);
    }
    assert.ok(ownership.demoDataNote.includes('customer environment'));
    assert.ok(ownership.pageCopyRequiredFor.length > 0);
    assert.ok(ownership.pageCopyRule.includes('managed to owned'));
    for (const file of ownership.sourceOnly) await assert.rejects(access(resolve(target, file)));
    const provenance = JSON.parse(await readFile(resolve(root, 'starter-release.json'), 'utf8'));
    const candidateIdentity = { schemaVersion: 1, kind: provenance.kind,
      setVersion: provenance.setVersion, sourceRevision: provenance.sourceRevision };
    assert.deepEqual(JSON.parse(await readFile(resolve(target, '.starter-origin.json'), 'utf8')), candidateIdentity);
    assert.equal(await readFile(resolve(target, '.starter-origin.json'), 'utf8'), JSON.stringify(candidateIdentity, null, 2) + '\n');
    assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target, stdio: 'pipe' }));
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: target, encoding: 'utf8' }).trim(), 'main');
    assert.equal(execFileSync('git', ['ls-files'], { cwd: target, encoding: 'utf8' }), '');
    assert.match(await readFile(resolve(target, '.gitignore'), 'utf8'), /^package-lock\.json$/m);
    assert.equal(execFileSync('git', ['check-ignore', 'package-lock.json'], { cwd: target, encoding: 'utf8' }), 'package-lock.json\n');
    await assert.rejects(access(resolve(target, 'package-lock.json')));
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
    await writeFile(resolve(target, 'owner.txt'), 'keep me');
    assert.throws(() => execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' }));
    assert.equal(await readFile(resolve(target, 'owner.txt'), 'utf8'), 'keep me');
    await mkdir(resolve(target, 'bin')); await mkdir(resolve(target, 'package'));
    await writeFile(resolve(target, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const version of ['0.43.0', '0.43.0-rc.1', '1.0.0', '1.2.3', '1.0.0-rc.1', '1.0', '01.0.0']) {
      const archives = [];
      for (const name of ['core', 'outbox', 'platform']) {
        await writeFile(resolve(target, 'package/package.json'), JSON.stringify({ name: `@openlup/${name}`, version }));
        const archive = resolve(target, `${name}.tgz`); archives.push(archive);
        execFileSync('tar', ['-czf', archive, 'package/package.json'], { cwd: target });
      }
      const run = () => execFileSync(process.execPath, ['lifecycle.mjs', 'candidate', ...archives],
        { cwd: target, env: { PATH: `${target}/bin:/usr/bin:/bin` }, stdio: 'pipe' });
      if (['1.0', '01.0.0'].includes(version)) assert.throws(run, error => String((error as { stderr?: Buffer }).stderr).includes('starter_candidate_identity_mismatch'));
      else { run(); assert.ok(JSON.parse(await readFile(resolve(target, 'artifacts/identity.json'), 'utf8')).artifacts.every((item: { version: string }) => item.version === version)); }
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('a Polish-only owned market typechecks the extracted starter and passes its tests', async () => {
  await mkdir(dirname(scratch), { recursive: true });
  const target = await mkdtemp(scratch);
  try {
    execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' });
    await writeFile(resolve(target, 'owned/market.config.ts'),
      "export const market = { locales: ['pl'], defaultLocale: 'pl' } as const;\n");
    // Reuse the source checkout's dependencies; extraction needs no new installation.
    execFileSync('npm', ['run', 'typecheck'], { cwd: target, encoding: 'utf8', stdio: 'pipe' });
    const tests = execFileSync(process.execPath, ['--experimental-strip-types', '--test'], {
      cwd: target, encoding: 'utf8', stdio: 'pipe', env: {},
    });
    assert.match(tests, /fail 0/);
  } finally { await rm(target, { recursive: true, force: true }); }
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

test('manifests without managed edit routes retain historical extraction bytes and identity', async () => {
  const f = await releasedFixture();
  try {
    f.ownership.managed.push('docs/ownership.md');
    await f.put('examples/neutral-store/docs/ownership.md', '# Application ownership\n');
    await f.put('examples/neutral-store/ownership.json', f.ownership);
    const target = f.run(), files = [...f.ownership.owned, ...f.ownership.managed];
    const rewrites: Record<string, string> = {
      'package.json': JSON.stringify(f.lock.packages[''], null, 2) + '\n',
      '.gitignore': 'node_modules/\n',
    };
    const expected = await Promise.all(files.map(path => Object.hasOwn(rewrites, path)
      ? Buffer.from(rewrites[path]!) : readFile(resolve(f.source, path === 'README.md' ? 'README.template.md' : path))));
    const actual = await Promise.all(files.map(path => readFile(resolve(target, path))));
    const { contentSha256 } = JSON.parse(await readFile(resolve(target, '.starter-origin.json'), 'utf8'));
    // Recorded with the extractor before managed edit routes.
    assert.deepEqual({ files: actual, contentSha256 }, {
      files: expected, contentSha256: '715fda1eefd3977996b6f26eb4d9b50aaf5f6f93f6c3fd3f1e9e56a33f64153f',
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('released extraction pins and commits registry artifacts with deterministic content and lock identities', async () => {
  const f = await releasedFixture();
  try {
    for (const path of ['node_modules/pg', 'node_modules/pg/node_modules/@types/node'])
      f.lock.packages[path] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz' };
    await f.put('lock.json', f.lock);
    const indexed = {
      Dockerfile: Buffer.from('FROM node:24.21.0-bookworm-slim AS application\nRUN true\n'),
      'index.html': Buffer.from('<!doctype html><html lang="en"></html>\n'),
      'bom.html': Buffer.from('\ufeff<!doctype html><html lang="en"></html>\n'),
      'style.css': Buffer.from('@charset "windows-1252";a::after { content: "café"; }\n', 'latin1'),
    };
    for (const [path, bytes] of Object.entries(indexed)) {
      f.ownership.managed.push(path);
      await writeFile(resolve(f.source, path), bytes);
    }
    const scripts = [
      ['lone-cr.mjs', '#!/usr/bin/env node\rconst text = `before\nafter`;\n',
        `#!/usr/bin/env node\r// ${managedHint}\nconst text = \`before\nafter\`;\n`],
      ['entry.mjs', '#!/usr/bin/env node\r\nexport {};\r\n', `#!/usr/bin/env node\r\n// ${managedHint}\nexport {};\r\n`],
      ['entry.js', '#!/usr/bin/env node\nexport {};\n', `#!/usr/bin/env node\n// ${managedHint}\nexport {};\n`],
      ['line-separator.d.mts', '#!/usr/bin/env node\u2028export {};\n',
        `#!/usr/bin/env node\u2028// ${managedHint}\nexport {};\n`],
      ['paragraph-separator.ts', '#!/usr/bin/env node\u2029export {};\n',
        `#!/usr/bin/env node\u2029// ${managedHint}\nexport {};\n`],
      ['entry.cjs', '#!/usr/bin/env node', `#!/usr/bin/env node\n// ${managedHint}\n`],
    ] as const;
    for (const [path, source] of scripts) {
      f.ownership.managed.push(path);
      await f.put(`examples/neutral-store/${path}`, source);
    }
    await f.put('examples/neutral-store/ownership.json', { ...f.ownership, managedEditRoutes: {} });
    const first = f.run(), second = f.run('second');
    for (const [path, bytes] of Object.entries(indexed)) {
      assert.deepEqual(await readFile(resolve(first, path)), bytes, path);
    }
    for (const [path, , expected] of scripts) {
      assert.deepEqual(await readFile(resolve(first, path)), Buffer.from(expected), path);
    }
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
    assert.equal(await readFile(resolve(first, '.gitignore'), 'utf8'), `# ${managedHint}\nnode_modules/\n`);
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

test('extraction refuses misrouted or unhandled managed paths', async () => {
  const f = await releasedFixture();
  try {
    for (const managedEditRoutes of [null, [], 0, false, '']) {
      await f.put('examples/neutral-store/ownership.json', { ...f.ownership, managedEditRoutes });
      assert.throws(() => f.run('invalid-map'), /starter_managed_edit_routes_invalid/);
    }
    for (const managedEditRoutes of [{ 'copy.txt': ['copy.txt'] }, { 'README.md': ['unknown.txt'] }, { 'README.md': [] }]) {
      await f.put('examples/neutral-store/ownership.json', { ...f.ownership, managedEditRoutes });
      assert.throws(() => f.run('invalid-route'), /starter_managed_edit_route_invalid/);
    }
    await f.put('examples/neutral-store/unknown.txt', 'managed text\n');
    await f.put('examples/neutral-store/ownership.json', { ...f.ownership, managed: [...f.ownership.managed, 'unknown.txt'], managedEditRoutes: {} });
    assert.throws(() => f.run('unknown-format'), /starter_managed_format_unknown: unknown.txt/);
    await f.put('examples/neutral-store/ownership.json', { ...f.ownership, managedEditRoutes: {} });
    await f.put('examples/neutral-store/README.template.md', '\ufeff# Application\n');
    assert.throws(() => f.run('managed-bom'), /starter_managed_file_bom: README.md/);
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
test('the frozen 0.43.0 inputs extract as released without copying source-only inputs or overwriting an application', async () => {
  const f = await releasedFixture();
  try {
    const input = 'release-inputs/openlup-core-v0.43.0/';
    const manifestBytes = await readFile(resolve(root, input, 'manifest.json'), 'utf8');
    const lockBytes = await readFile(resolve(root, input, 'package-lock.json'), 'utf8');
    const manifest = JSON.parse(manifestBytes), lock = JSON.parse(lockBytes);
    const revision = '6facc3e72441ade5813397f65ac7edbe34fd1d0f';
    assert.equal(manifest.commit, revision);
    assert.equal(sha256(lockBytes), '1341821438e57653386bc6900130e3f0e60a33406091c3a917fcfef6a84a9353');
    assert.deepEqual(manifest.packages.map((pkg: { name: string }) => pkg.name), f.names);
    const application = structuredClone(lock.packages['']);
    for (const name of f.names) {
      application.dependencies[name] = `file:artifacts/${name.slice(9)}.tgz`;
      await f.put(`packages/${name.slice(9)}/package.json`, { name, version: '0.43.0' });
    }
    await f.put('examples/neutral-store/package.json', application);
    for (const [name, bytes] of [['manifest.json', manifestBytes], ['package-lock.json', lockBytes]] as const) {
      await f.put(name, bytes);
      await f.put(`examples/neutral-store/${input}${name}`, bytes);
      f.ownership.sourceOnly.push(input + name);
    }
    await f.put('examples/neutral-store/ownership.json', f.ownership);
    f.args.splice(0, f.args.length, ...f.args.map(value => value === f.version ? '0.43.0' : value === f.revision ? revision
      : value === resolve(f.directory, 'lock.json') ? resolve(f.directory, 'package-lock.json') : value));
    const target = f.run();
    const identity = JSON.parse(await readFile(resolve(target, '.starter-origin.json'), 'utf8'));
    assert.equal(identity.mode, 'released'); assert.equal(identity.setVersion, '0.43.0');
    assert.equal(identity.sourceRevision, revision);
    assert.equal(identity.lockfileSha256, sha256(lockBytes));
    assert.equal(await readFile(resolve(target, 'package-lock.json'), 'utf8'), lockBytes);
    assert.deepEqual(JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8')).dependencies, lock.packages[''].dependencies);
    await assert.rejects(access(resolve(target, 'release-inputs')));
    assert.throws(() => f.run(), error => String((error as { stderr?: Buffer }).stderr).includes('starter_extract_directory_not_empty'));
    assert.equal(await readFile(resolve(target, 'package-lock.json'), 'utf8'), lockBytes);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

const refusals: [string, (f: ReleaseFixture) => Promise<unknown> | void, string?, string?][] = [
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
  ...[1, 2, 4].map(value => ['lock_format_invalid', async (f: ReleaseFixture) => {
    f.lock.lockfileVersion = value; await f.put('lock.json', f.lock);
  }] as [string, (f: ReleaseFixture) => Promise<void>]),
  ...[undefined, null, []].map(packages => ['lock_format_invalid', (f: ReleaseFixture) => f.put('lock.json', { ...f.lock, packages })] as [string, (f: ReleaseFixture) => Promise<void>]),
  ...['node_modules/@openlup/core/', 'node_modules/./pg', 'node_modules/../pg', 'node_modules//pg',
    'node_modules/pg/node_modules/..', 'node_modules/pg\\alias', 'node_modules/%70g', 'pg', 'node_modules/pg/alias']
    .map(path => ['lock_path_invalid', async (f: ReleaseFixture) => {
      f.lock.packages[path] = { ...f.lock.packages['node_modules/@openlup/core'], integrity: 'arbitrary' };
      await f.put('lock.json', f.lock);
    }, path, path.endsWith('/core/') ? 'trailing slash' : undefined] as [string, (f: ReleaseFixture) => Promise<void>, string, string?]),
  ['lock_path_duplicate', async f => {
    for (const name of ['pg', 'PG']) f.lock.packages[`node_modules/${name}`] = { resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz' };
    await f.put('lock.json', f.lock);
  }, 'node_modules/PG'],
  ['lock_root_mismatch', async f => { f.lock.packages['']!.dependencies = {}; await f.put('lock.json', f.lock); }, 'dependencies'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/@openlup/extra'] = { version: f.version, resolved: `https://registry.npmjs.org/@openlup/extra/-/extra-${f.version}.tgz` }; await f.put('lock.json', f.lock); }, '@openlup/extra'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/other/node_modules/@openlup/core'] = f.lock.packages['node_modules/@openlup/core']!; await f.put('lock.json', f.lock); }, '@openlup/core'],
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
  ['lock_package_extra', async f => { f.lock.packages['node_modules/alias'] = { ...f.lock.packages['node_modules/@openlup/core'], name: '@openlup/core' }; await f.put('lock.json', f.lock); }, 'node_modules/alias'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/pg/node_modules/alias'] = {
    version: '0.40.0', resolved: 'https://registry.npmjs.org/@openlup/core/-/core-0.40.0.tgz',
  }; await f.put('lock.json', f.lock); }, 'node_modules/pg/node_modules/alias', 'nameless alias'],
  ...['version', 'integrity'].map(key => ['lock_package_extra', async (f: ReleaseFixture) => {
    f.lock.packages['node_modules/pg/node_modules/alias'] = { ...f.lock.packages['node_modules/@openlup/core'], [key]: undefined };
    await f.put('lock.json', f.lock);
  }, 'node_modules/pg/node_modules/alias'] as [string, (f: ReleaseFixture) => Promise<void>, string]),
  ['lock_package_extra', async f => { f.lock.packages['node_modules/pg'] = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', dependencies: { alias: 'npm:@openlup/core@0.40.0' },
  }; await f.put('lock.json', f.lock); }, 'node_modules/pg'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/alias'] = {
    version: f.version, resolved: `https://registry.npmjs.org/@openlup/extra/-/extra-${f.version}.tgz`,
  }; await f.put('lock.json', f.lock); }, 'node_modules/alias'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/pg'] = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', dependencies: { alias: `npm:@openlup/core@${f.version}` },
  }; f.lock.packages['node_modules/pg/node_modules/alias'] = {
    version: f.version, resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz',
  }; await f.put('lock.json', f.lock); }, 'node_modules/pg'],
  ['lock_package_extra', async f => { f.lock.packages['node_modules/pg'] = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', dependencies: { alias: `NPM:@openlup/core@${f.version}` },
  }; f.lock.packages['node_modules/pg/node_modules/alias'] = {
    version: f.version, integrity: 'arbitrary', resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz',
  }; await f.put('lock.json', f.lock); }, 'node_modules/pg', 'uppercase alias'],
  ...['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'].map(section =>
    ['lock_package_extra', async (f: ReleaseFixture) => {
      f.lock.packages['node_modules/pg'] = { resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', [section]: { alias: 'NPM:%40OpEnLuP%2fcore@0.41.0' } };
      await f.put('lock.json', f.lock);
    }, 'node_modules/pg'] as [string, (f: ReleaseFixture) => Promise<void>, string]),
  ['lock_package_extra', async f => { f.lock.packages['node_modules/pg'] = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.0.0.tgz', dependencies: { '@openlup/extra': '0.42.0' },
  }; await f.put('lock.json', f.lock); }, 'node_modules/pg', 'dependency name'],
  ...[{ name: '@OpEnLuP/core' }, { resolved: 'https://registry.npmjs.org/%2540%6fpenlup%252fcore/-/core.tgz' }]
    .map(fields => ['lock_package_extra', async (f: ReleaseFixture) => {
      f.lock.packages['node_modules/alias'] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz', ...fields };
      await f.put('lock.json', f.lock);
    }, 'node_modules/alias'] as [string, (f: ReleaseFixture) => Promise<void>, string]),
];
for (const [index, [code, mutate, detail, label]] of refusals.entries()) test(`released extraction refuses ${code} (${label ?? index + 1})`, async () => {
  const f = await releasedFixture();
  try {
    await mutate(f);
    assert.throws(() => f.run(), error => {
      const message = String((error as { stderr?: Buffer }).stderr);
      return message.includes(`starter_release_${code}`) && (!detail || message.includes(detail));
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('an alias cannot replace the canonical entry and is forbidden even alongside it', async () => {
  const f = await releasedFixture();
  try {
    const core = f.lock.packages['node_modules/@openlup/core']!;
    delete f.lock.packages['node_modules/@openlup/core'];
    f.lock.packages['node_modules/alias'] = core;
    await f.put('lock.json', f.lock);
    assert.throws(() => f.run(), error => String((error as { stderr?: Buffer }).stderr)
      .includes('starter_release_lock_package_missing: @openlup/core'));
    f.lock.packages['node_modules/@openlup/core'] = core;
    await f.put('lock.json', f.lock);
    assert.throws(() => f.run(), error => String((error as { stderr?: Buffer }).stderr)
      .includes('starter_release_lock_package_extra: node_modules/alias'));
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
    const plan = config.subscriptionOffers.classic;
    plan.days = { kind: 'set',values: [21,42] }; plan.defaultDays = 21;
    plan.bySku = Object.fromEntries(Object.keys(plan.bySku).map(sku => [sku,[{ days: plan.days,quantities: { kind: 'set',values: [1,2,3,4] } }]]));
    config.subscriptionOffers.sized = { ...structuredClone(plan),minimumBaseUnits: 6 };
    config.quote.acquisition.graduationCadenceDays = 42;
    const owned = `import type { StoreConfig } from '../shared/config.ts';
import { choices } from '../shared/subscription-offer.ts';
import { subscriptionEditing } from './subscription-editing.ts';
export const configurations: Record<string, StoreConfig> = ${JSON.stringify({ [config.id]: config }, null, 2)};
for (const config of Object.values(configurations)) {
  config.offer.cadenceDays = choices(config.subscriptionOffers.classic.days);
  config.offer.defaultCadenceDays = config.subscriptionOffers.classic.defaultDays;
  config.subscriptionEditing = subscriptionEditing(config.offer.products,config.subscriptionOffers);
}
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
    const body = await response.json() as { config: typeof config };
    assert.equal(body.config.id, config.id);
    assert.equal(body.config.brand.name, 'Harbor Objects');
    assert.deepEqual(body.config.offer.cadenceDays,[21,42]);
    assert.deepEqual(body.config.subscriptionEditing.planDays,[21,42]);
    assert.deepEqual(body.config.subscriptionEditing.sized.allowedCadences,[21,42]);
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
    const selected = { ...cart,mode: 'subscription',cadenceDays: 21,lines: [{ sku: config.offer.products[0]!.sku,quantity: 2 }] };
    for (const [selection,code] of [[selected,'host_binding_required'],
      [{ ...selected,cadenceDays: 28 },'cadence_unavailable'],
      [{ ...selected,lines: [{ ...selected.lines[0]!,quantity: 5 }] },'quantity_invalid']] as const) {
      const refusal = await action('offer.validate',{ cart: selection,acquisitionCapability: 'subscription-acquisition.v1' });
      assert.equal(refusal.body.code,code);
    }
    for (const [path, bytes] of managed) assert.deepEqual(await readFile(resolve(target, path)), bytes, path);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(target, { recursive: true, force: true });
  }
});

test('RP2 source wrapper checks the independent registry from packed dependencies', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'catalogue-extract-'));
  const target = resolve(directory, 'app'), checkout = resolve(root, '../..');
  const scoped = resolve(target, 'node_modules/@openlup'), bin = resolve(target, 'node_modules/.bin');
  try {
    execFileSync(process.execPath, ['extract.mjs', target], { cwd: root, stdio: 'pipe' });
    await mkdir(bin, { recursive: true });
    for (const name of ['core', 'platform']) {
      const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
        { cwd: resolve(checkout, 'packages', name), encoding: 'utf8', stdio: 'pipe' }));
      const installed = resolve(scoped, name);
      await mkdir(installed, { recursive: true });
      execFileSync('tar', ['-xzf', resolve(directory, pack.filename), '-C', installed, '--strip-components=1']);
    }
    await cp(resolve(checkout, 'node_modules/zod'), resolve(target, 'node_modules/zod'), { recursive: true });
    await symlink('../@openlup/platform/src/lifecycle/openlup.mjs', resolve(bin, 'openlup'));

    const invoke = (script: string, exit: number) => {
      const result = spawnSync('npm', ['run', '--silent', script], { cwd: target, encoding: 'utf8',
        env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), TMPDIR: directory, TMP: directory, TEMP: directory } });
      assert.ifError(result.error);
      assert.equal(result.stderr, '');
      assert.equal(result.status, exit, result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.exitCode, exit);
      return report;
    };
    const path = resolve(target, 'owned/catalogue.ts');
    const owned = await readFile(path, 'utf8');
    assert.equal(invoke('catalogue:check', 0).command, 'catalogue check');
    assert.equal(invoke('catalogue:check:source', 0).command, 'catalogue project');

    const manifestPath = resolve(target, 'package.json');
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    try {
      for (const [script, wrong] of [
        ['catalogue:check', manifest.scripts['catalogue:check:source']],
        ['catalogue:check:source', manifest.scripts['catalogue:check:source'] + ';'],
      ]) {
        await writeFile(manifestPath, JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, [script]: wrong } }));
        assert.throws(() => proveStarterCatalogueWrappers(target, directory),
          { message: `unexpected starter catalogue script: ${script}` });
      }
    } finally { await writeFile(manifestPath, manifestBytes); }
    proveStarterCatalogueWrappers(target, directory);

    const independent = owned.replaceAll('starter:', 'independent:').replaceAll("'starter'", "'independent'");
    await writeFile(path, independent);
    // This application uses offline authoring and has no installed starter rules.
    await rm(resolve(target, 'owned/catalogue-rules.cjs'));
    const report = invoke('catalogue:check:source', 0);
    const projected = JSON.parse(await readFile(report.transport.subjectPath, 'utf8'));
    assert.deepEqual(projected.packs.map(({ pack }: { pack: { id: string } }) => pack.id), ['independent']);
    assert.deepEqual(projected.packs[0].drafts[0].product.type, { key: 'independent:item', version: 1 });
    const registry = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { catalogDraftRegistry, catalogueConformance } from './owned/catalogue.ts';
      import { starterCatalogue } from './host/editor-catalogue.ts';
      const type = { key: 'independent:item', version: 1 };
      const resolved = catalogDraftRegistry.resolve(type);
      assert.equal(resolved, starterCatalogue().registry.resolve(type));
      assert.equal(resolved.validateContent, catalogueConformance.packs[0].pack.types[0].validateContent);
      assert.equal(catalogDraftRegistry.resolve({ key: 'starter:item', version: 1 }), undefined);
      process.stdout.write(resolved.key);
    `], { cwd: target, encoding: 'utf8', stdio: 'pipe' });
    assert.equal(registry, 'independent:item');

    await writeFile(path, independent.replace("netContentUnits: ['independent:each']", "netContentUnits: ['independent:absent']"));
    assert.ok(invoke('catalogue:check:source', 1).findings.some(({ code }: { code: string }) => code === 'definition_unknown_net_content_unit'));
    const host = spawnSync(process.execPath, ['--input-type=module', '-e', "import './host/editor-catalogue.ts';"], { cwd: target, encoding: 'utf8' });
    assert.equal(host.status, 1);
    assert.match(host.stderr, /invalid_catalog_type_definition/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
