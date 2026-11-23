import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, migrationRegistryUnion } from './agent-review-derived.mjs';
import { runLandingGenerators, syncSqlReference } from './agent-review-generators.mjs';
import { applyMigrationReslot, assertAppendOnlyLandingSlots, assertNoAuthoredSlotReferences, carrierLocale, isInventoryInputPath, landingMerge, landingSlotPlan, nextFreeMigrationSlot } from './agent-review-landing.mjs';
import { deltaFloor, prepareCandidate, recordReport, integrationReviewContext, verdict } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, captureCoverageEdge, validateEconomySession, proveReviewIntegration, git as sourceGit } from './agent-review-session.mjs';
import { fixtureNpmCli, linkFixtureInstallation, localFixtureEnvironment } from './fixtures/landing-test-environment.ts';
import { renderDocumentationSourceMap } from './documentation-navigation.ts';
import { readDocumentationState } from './documentation-routing.ts';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import { evaluatePlatformMigrationManifestMetadata } from './platform-migration-manifest.ts';

const source = process.cwd();
const npmCli = fixtureNpmCli();
const fixtureEnvironment = { ...localFixtureEnvironment(), ...carrierLocale, npm_execpath: npmCli };
let root: string, base: string, reviewed: string, main: string, merged: string;
let initialLandingCommands: { command: string; args: string[] }[] = [];
let initialLandingResult: { head: string; main: string; inventoryRefreshed: boolean };
const git = (...args: string[]) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { env: fixtureEnvironment, encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 * 1024 }).trim();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
const commit = () => { git('add', '-A'); git('commit', '--allow-empty', '-qm', 'Synthetic forward', '-s'); return git('rev-parse', 'HEAD'); };
const json = value => JSON.stringify(value, null, 2) + '\n';
function append(slot: string) {
  const file = `db/platform/migrations/${slot}_landing_fixture.sql`, sql = '-- Synthetic no-op forward\nSELECT 1;\n';
  write(file, sql); const sha256 = createHash('sha256').update(sql).digest('hex');
  const manifest = JSON.parse(read(MIGRATION_REGISTRIES[0]));
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ file, sha256 });
  write(MIGRATION_REGISTRIES[0], json(manifest));
  const registry = JSON.parse(read(MIGRATION_REGISTRIES[1]));
  registry.nativeStoreForwardClass.slots.push({ row: `fixture-${slot}`, path: file, replacedFunctions: [], createdFunctions: [] });
  registry.nativeStoreForwards.push({ path: file, sha256, functions: [] });
  write(MIGRATION_REGISTRIES[1], json(registry));
  expect(checkPlatformMigrationProjection(root, true)).toEqual([]);
  write(SQL_REFERENCE, syncSqlReference(root));
}
const CATALOGUE = 'config/openlup-publication-catalog.json';
const SQL_REFERENCE = 'packages/core/docs/guide/reference/sql.md';
const SQL_HEADING = '# SQL catalogue';
const MAIN_SQL_HEADING = '# Package SQL catalogue';
const PORTABILITY = 'packages/platform/src/portability/index.ts';
const PORTABILITY_REPORT = 'packages/platform/api/portability.api.md';
const SETTING_DATA = 'packages/platform/src/inventory/settings-data.json';
const SETTING_CATALOGUE = 'packages/platform/settings-catalog.json';
const SETTING_REFUSALS = 'packages/platform/settings-refusals.json';
const SETTING_GUIDE = 'packages/core/docs/guide/how-to/operate/settings-catalogue.md';
const PROBE_OUTPUTS = [PORTABILITY_REPORT, SETTING_CATALOGUE, SETTING_REFUSALS, SETTING_GUIDE];
const PROBE_KEY = 'inventory.fixtureReservation';
const fixtureCommand = (command: string, args: string[]) => execFileSync(command, args, {
  cwd: root, env: fixtureEnvironment, encoding: 'utf8', timeout: 180000,
  maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const fixtureNpm = (...args: string[]) => fixtureCommand(process.execPath, [npmCli, ...args]);
const coldBuild = (...owners: string[]) => {
  for (const owner of owners) fixtureNpm('run', 'build', `--workspace=@openlup/${owner}`);
};
const landingCli = () => fixtureNpm('run', 'landing:merge');
const land = () => landingMerge(root, { runCommand: fixtureCommand });
const checkout = (rev: string) => { git('reset', '--hard'); git('checkout', '-q', '--detach', rev); };
const setMain = (rev: string) => { git('branch', '-f', 'main', rev); git('update-ref', 'refs/remotes/origin/main', rev); };
function probeExport() {
  write(PORTABILITY, read(PORTABILITY) + '\n/** @experimental A fixture declaration. */\nexport const fixturePortability = 1;\n');
  write('packages/platform/changes/fixture-portability.md', '- Add an experimental portability fixture and describe reservation policy.\n');
}
function probeSetting() {
  const data = JSON.parse(read(SETTING_DATA));
  data.push({ ...data.find(entry => entry.kind === 'invariant'), key: PROBE_KEY, goal: 'Describe fixture reservation replay.' });
  write(SETTING_DATA, json(data));
}
function restoreDerivedFixture() {
  if (existsSync(join(root, '.git/MERGE_HEAD'))) git('merge', '--abort');
  checkout(merged);
  setMain(main);
}
// Main adds a package command after the reviewed head forked; main's own owner
// writes its catalogue in a new process, as a contributor's generator run would.
function addPackageCommand() {
  const policy = 'scripts/oss-publication-policy.ts', close = '\n];\nexport const PUBLIC_PACKAGE_EXECUTION_SURFACES';
  expect(read(policy)).toContain(close);
  write(policy, read(policy).replace(close, `\n  publicCommand("fixture:landing", "node -e 0"),${close}`));
  const owner = pathToFileURL(join(root, policy)).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync, writeFileSync } from 'node:fs';
    const { createPublicPublicationCatalog } = await import(${JSON.stringify(owner)});
    const catalog = JSON.parse(readFileSync(${JSON.stringify(CATALOGUE)}, 'utf8'));
    writeFileSync(${JSON.stringify(CATALOGUE)}, createPublicPublicationCatalog(catalog.publicPaths, catalog.guardViability).contents);`], { cwd: root, env: fixtureEnvironment, timeout: 30000 });
}
beforeAll(async () => {
  vi.stubEnv('npm_execpath', npmCli);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openlup-derived-live-')));
  execFileSync('/usr/bin/git', ['clone', '--shared', '--no-hardlinks', '-q', source, root], { env: fixtureEnvironment, timeout: 30000 });
  // The clone already has HEAD. Overlay only differences during local development.
  const sourcePaths = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env: fixtureEnvironment, encoding: 'utf8' }).split('\0').filter(Boolean);
  const overlays = new Set([...sourcePaths('diff', '--name-only', '--no-renames', '-z', 'HEAD'),
    ...sourcePaths('ls-files', '-z', '--others', '--exclude-standard')]);
  for (const path of overlays) {
    if (!existsSync(join(source, path))) { rmSync(join(root, path), { force: true }); continue; }
    mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(source, path), join(root, path));
  }
  linkFixtureInstallation(source, root);
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  base = commit();
  append('20990101020000'); reviewed = commit();
  git('checkout', '-q', '--detach', base); append('20990101010000'); addPackageCommand();
  write(SQL_REFERENCE, read(SQL_REFERENCE).replace(SQL_HEADING, MAIN_SQL_HEADING));
  main = commit();
  git('remote', 'set-url', 'origin', '.'); setMain(main); git('checkout', '-q', '--detach', reviewed);
  initialLandingCommands = [];
  const inventoryScript = join(root, 'scripts/installation-inventory-refresh.ts');
  initialLandingResult = await landingMerge(root, {
    runCommand: (command, args) => {
      initialLandingCommands.push({ command, args });
      if (args.includes(inventoryScript)) {
        // Real Docker PostgreSQL measurement is witnessed in scripts/agent-review-derived-inventory.test.ts;
        // keep this unlisted scanner suite Docker-free while preserving exact current-only envelope semantics.
        const env = inventoryEnvelope(read(INVENTORY_PATH));
        const nextCurrent = structuredClone(env.value.current);
        for (const [profile, entry] of Object.entries(nextCurrent.profiles)) {
          (entry as { objectInventorySha256: string }).objectInventorySha256 = createHash('sha256')
            .update(`derived-fixture:${profile}:${read(MIGRATION_REGISTRIES[0])}`)
            .digest('hex');
        }
        write(INVENTORY_PATH, env.before + JSON.stringify(nextCurrent, null, 2).replaceAll('\n', '\n  ') + env.after);
        return;
      }
      execFileSync(command, args, { cwd: root, env: fixtureEnvironment, stdio: 'inherit', timeout: 900000 });
    },
  });
  merged = initialLandingResult.head;
}, 180000);
afterAll(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function proof(head = merged) {
  return proveReviewIntegration(root, await captureCommittedReviewCandidate(root, base, reviewed), await captureCommittedReviewCandidate(root, main, head));
}
it('lands two independently appended real forwards through the CLI as derived', async () => {
  await expect(sourceGit(root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', reviewed, main))
    .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(`${SQL_REFERENCE}\0`) });
  const page = git('show', `${merged}:${SQL_REFERENCE}`);
  expect(git('show', `${reviewed}:${SQL_REFERENCE}`)).toContain(SQL_HEADING);
  expect(page).toContain(MAIN_SQL_HEADING);
  expect(page).toContain('/packages/platform/sql/20990101010000_landing_fixture.sql)');
  expect(page).toContain('/packages/platform/sql/20990101020000_landing_fixture.sql)');
  expect(await proof()).toMatchObject({ kind: 'derived', derived: true });
  expect(git('show', '-s', '--format=%B', merged)).toContain('Signed-off-by: Fixture <fixture@example.invalid>');
  expect(git('show', '-s', '--format=%an <%ae>%n%cn <%ce>', merged)).toBe('Fixture <fixture@example.invalid>\nFixture <fixture@example.invalid>');
}, 50000);

it('lands owner-exact reports and settings from parents with zero carrier edits', async () => {
  try {
    checkout(base); probeExport(); probeSetting(); const left = commit();
    checkout(base); const right = commit(); setMain(right); checkout(left);
    expect(git('merge-base', left, right)).toBe(base);
    for (const parent of [left, right]) {
      expect(git('diff', '--raw', base, parent, '--', 'packages/core/api', 'packages/outbox/api', 'packages/platform/api', ...PROBE_OUTPUTS)).toBe('');
    }
    expect(landingCli()).toContain(`carrier toolchain: Node ${process.versions.node}, npm ${fixtureNpm('--version').trim()}, ICU ${process.versions.icu}`);
    const landed = git('rev-parse', 'HEAD');
    expect(git('show', '-s', '--format=%P%n%B', landed)).toBe(`${left} ${right}\nMerge origin/main and refresh derived carriers\n\nSigned-off-by: Fixture <fixture@example.invalid>`);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const integration = await proveReviewIntegration(root,
      await captureCommittedReviewCandidate(root, base, left), await captureCommittedReviewCandidate(root, right, landed));
    expect(git('diff', '--raw', left, landed, '--', 'packages/core/api', 'packages/outbox')).toBe('');
    const changed = PROBE_OUTPUTS.filter(path => path !== SETTING_REFUSALS).sort();
    expect(integration).toMatchObject({ kind: 'derived', derived: true });
    expect(integration.resolution).toBeUndefined();
    const historical = await proveReviewIntegration(root,
      await captureCommittedReviewCandidate(root, base, left), await captureCommittedReviewCandidate(root, right, landed),
      false, { resolvedOwnerOutputs: changed });
    expect(historical).toMatchObject({ kind: 'resolution', resolution: changed, modeChanged: false });
    expect(read(PORTABILITY_REPORT)).toContain('declare const fixturePortability = 1');
    expect(read(SETTING_GUIDE)).toContain(`## ${PROBE_KEY}`);
    expect(git('show', `${base}:${SETTING_REFUSALS}`)).toBe(read(SETTING_REFUSALS).trimEnd());
    const discovery = JSON.parse(fixtureCommand(process.execPath, ['packages/platform/src/lifecycle/openlup.mjs', 'settings', 'show', PROBE_KEY, '--json']));
    expect(discovery.setting).toMatchObject({ key: PROBE_KEY, kind: 'invariant' });
    // Landing's cold declarations still match this source tree. Rerun both renderers.
    fixtureCommand(process.execPath, ['packages/platform/scripts/api-contract.ts', '--update']);
    fixtureCommand(process.execPath, ['scripts/settings-catalogue.ts', '--write']);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const fast = spawnSync(process.execPath, [npmCli, 'run', 'preflight', '--', '--fast'], {
      cwd: root, env: fixtureEnvironment, encoding: 'utf8', timeout: 300000,
    });
    expect(fast.status, fast.stdout + fast.stderr).toBe(0);
    expect(JSON.parse(fast.stdout.trimEnd().split('\n').at(-1)!)).toEqual({ preflight: 'fast', result: 'pass', head: landed, failed: [] });
    console.info(`D3 landing: fork ${base}, parents ${left} ${right}, merge ${landed}; derived ${changed.join(', ')}; settings refusals already match`);
  } finally { restoreDerivedFixture(); }
}, 360000);

it('lands cold owner bytes after an added Core export and version bump on a warm incremental cache', () => {
  try {
    checkout(base);
    // Seed the previous package graph and exercise the cache-dependent emission originally used by landing.
    for (const owner of ['core', 'outbox', 'platform']) for (const leaf of ['dist', '.tsbuildinfo-build']) {
      rmSync(join(root, 'packages', owner, leaf), { force: true, recursive: true });
    }
    fixtureCommand(process.execPath, ['scripts/build-packages-incremental.mjs']);
    const declaration = 'packages/platform/dist/fulfillment/providerDispatchWorker.d.ts';
    const cleanDeclaration = read(declaration);
    const entry = 'packages/core/src/subscription/index.ts';
    write(entry, read(entry) + '\nexport const fixtureApi = 1;\n');
    write('packages/core/changes/fixture-cache.md', '- Add a fixture declaration.\n');
    fixtureCommand(process.execPath, ['scripts/build-packages-incremental.mjs']);
    const manifestPath = 'packages/core/package.json';
    const manifest = JSON.parse(read(manifestPath));
    manifest.version += '-fixture';
    write(manifestPath, json(manifest));
    const left = commit();
    checkout(base); const right = commit(); setMain(right); checkout(left);
    fixtureCommand(process.execPath, ['scripts/build-packages-incremental.mjs']);
    const warmDeclaration = read(declaration);
    expect(warmDeclaration).not.toBe(cleanDeclaration);

    landingCli();
    expect(git('show', '-s', '--format=%P')).toBe(`${left} ${right}`);
    expect(git('show', 'HEAD:packages/core/api/subscription.api.md')).toContain('declare const fixtureApi = 1');
    const landedDeclaration = read(declaration);
    expect(landedDeclaration).not.toBe(warmDeclaration);
    coldBuild('core', 'outbox', 'platform');
    expect(read(declaration)).toBe(landedDeclaration);
    for (const owner of ['core', 'outbox', 'platform']) fixtureNpm('run', 'api:check', `--workspace=@openlup/${owner}`);
    expect(git('status', '--porcelain')).toBe('');
  } finally { restoreDerivedFixture(); }
}, 240000);

describe('registered output conflicts', () => {
  beforeAll(() => {
    checkout(base);
    coldBuild('core', 'platform');
  }, 60000);

  it.each([
    { owner: 'API', paths: [PORTABILITY_REPORT] },
    { owner: 'settings', paths: [SETTING_CATALOGUE, SETTING_REFUSALS, SETTING_GUIDE] },
  ])('replaces the exact registered $owner output conflicts', async ({ paths }) => {
    try {
      const originals = paths.map(path => [path, git('show', `${base}:${path}`) + '\n'] as const);
      const parent = (label: string) => {
        checkout(base);
        for (const [path, original] of originals) write(path, label + '\n' + original);
        return commit();
      };
      const left = parent('First-parent edit'), right = parent('Main edit');
      setMain(right); checkout(left);
      // Only the output differs from the sources built in this group. Keep the real merge and owners.
      for (const revision of [left, right]) expect(git('diff', '--name-only', base, revision).split('\n')).toEqual([...paths].sort());
      await landingMerge(root, {
        runCommand: (command, args) => {
          if (args[0] === npmCli && args[1] === 'run' && args[2] === 'build') return;
          fixtureCommand(command, args);
        },
      });
      for (const [path, original] of originals) expect(read(path)).toBe(original);
      expect(git('status', '--porcelain')).toBe('');
    } finally { restoreDerivedFixture(); }
  }, 60000);
});

it('stages a renamed report and validates its exact selector against the generated file', async () => {
  try {
    const newReport = 'packages/platform/api/portability-fixture.api.md';
    checkout(base); probeExport();
    const catalogue: { publicPaths: { path: string; class: string }[] } = JSON.parse(read(CATALOGUE));
    const registration = catalogue.publicPaths.find(({ path }) => path === PORTABILITY_REPORT);
    if (registration?.class !== 'public-output') throw new Error(`Fixture report is not registered: ${PORTABILITY_REPORT}`);
    registration.path = newReport;
    catalogue.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    write(CATALOGUE, json(catalogue));
    const routing = 'config/doc-routing.json';
    expect(read(routing)).toContain(`"${PORTABILITY_REPORT}"`);
    write(routing, read(routing).replace(`"${PORTABILITY_REPORT}"`, `"${newReport}"`));
    rmSync(join(root, PORTABILITY_REPORT));
    const gatesPath = 'packages/platform/release-gates.json';
    const gates = JSON.parse(read(gatesPath));
    gates.packageSurface['./portability'].snapshot = 'api/portability-fixture.api.md';
    write(gatesPath, json(gates)); const left = commit();
    checkout(base); const right = commit(); setMain(right); checkout(left);
    expect(git('ls-files', '--', newReport)).toBe('');
    await land();
    expect(git('show', `HEAD:${newReport}`)).toContain('declare const fixturePortability = 1');
    expect(git('ls-files', '--', PORTABILITY_REPORT)).toBe('');
    expect(read('docs/platform/SOURCE_MAP.md')).toContain(`\`${newReport}\``).not.toContain(`\`${PORTABILITY_REPORT}\``);
    fixtureCommand(process.execPath, ['packages/platform/scripts/api-contract.ts', '--update']);
    expect(git('status', '--porcelain')).toBe('');
  } finally { restoreDerivedFixture(); }
}, 180000);

it.each(['unregistered', 'executable', 'symlink'])('keeps a %s report conflict unresolved', async mode => {
  try {
    const path = mode === 'unregistered' ? 'packages/platform/api/unregistered-fixture.api.md' : PORTABILITY_REPORT;
    checkout(base);
    if (mode === 'symlink') {
      rmSync(join(root, path)); symlinkSync('../release-gates.json', join(root, path));
    } else write(path, 'First-parent edit\n');
    const left = commit();
    checkout(base);
    if (mode === 'symlink') {
      rmSync(join(root, path)); symlinkSync('../package.json', join(root, path));
    } else {
      write(path, 'Main edit\n');
      if (mode === 'executable') chmodSync(join(root, path), 0o755);
    }
    const right = commit(); setMain(right); checkout(left);
    await expect(land()).rejects.toThrow(`landing: authored conflicts remain: ${path}`);
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe(path);
  } finally { restoreDerivedFixture(); }
}, 60000);

it.each([
  ['outbox', 'first parent'],
  ['outbox', 'missing'],
  ['outbox', 'removed'],
  ['outbox', 'main only'],
  ['core', 'first parent'],
  ['core', 'missing'],
])('checks the %s change note through landing (%s)', async (owner, note) => {
  const directory = `packages/${owner}`;
  const entry = `${directory}/src/${owner === 'core' ? 'subscription/index.ts' : 'index.ts'}`;
  const notePath = `${directory}/changes/fixture-api.md`;
  const report = `${directory}/api/${owner === 'core' ? 'subscription' : 'index'}.api.md`;
  try {
    checkout(base);
    if (note === 'removed') { write(notePath, '- Describe the fixture contract.\n'); commit(); }
    const fork = git('rev-parse', 'HEAD');
    write(entry, read(entry) + '\nexport const fixtureApi = 1;\n');
    if (note === 'first parent') write(notePath, '- Add a fixture API export.\n');
    if (note === 'removed') rmSync(join(root, notePath));
    const left = commit();
    checkout(fork);
    if (note === 'main only') write(notePath, '- Document a main-side change.\n');
    const right = commit(); setMain(right); checkout(left);
    if (note === 'first parent') {
      landingCli();
      const landed = git('rev-parse', 'HEAD');
      expect(git('show', '-s', '--format=%P', 'HEAD')).toBe(`${left} ${right}`);
      expect(git('show', `HEAD:${report}`)).toContain('declare const fixtureApi = 1');
      expect(git('status', '--porcelain')).toBe('');
      const integration = await proveReviewIntegration(root,
        await captureCommittedReviewCandidate(root, fork, left),
        await captureCommittedReviewCandidate(root, right, landed));
      expect(integration).toMatchObject({ kind: 'derived', derived: true });
    } else {
      expect(landingCli).toThrow(`landing: @openlup/${owner} API snapshots changed; add or modify ${directory}/changes/*.md or ${directory}/CHANGELOG.md on the first parent and retain it in the merge`);
      expect(git('rev-parse', 'HEAD')).toBe(left);
      expect(git('rev-parse', 'MERGE_HEAD')).toBe(right);
      expect(read(report)).not.toContain('fixtureApi');
      expect(git('diff', '--cached', '--name-only', '--', 'packages/core/api', 'packages/outbox/api', 'packages/platform/api')).toBe('');
    }
  } finally { restoreDerivedFixture(); }
}, 180000);

it('refuses an inventory-only landing with a mismatched installed dependency before writing', () => {
  const installedLock = 'node_modules/.package-lock.json';
  const lockBytes = read(installedLock);
  const indexBytes = () => readFileSync(join(root, '.git/index'));
  const trackedDigest = () => {
    const hash = createHash('sha256');
    for (const path of git('ls-files', '-z').split('\0').filter(Boolean)) {
      hash.update(path).update('\0').update(createHash('sha256').update(readFileSync(join(root, path))).digest());
    }
    return hash.digest('hex');
  };
  try {
    checkout(base);
    const manifest = 'scripts/platform-migration-manifest.ts';
    write(manifest, read(manifest) + '\n// Fixture inventory input.\n');
    const left = commit();
    expect(git('diff', '--name-only', base, left)).toBe(manifest);
    checkout(base);
    write('README.md', read('README.md') + '\nFixture main change.\n');
    const right = commit(); setMain(right); checkout(left);
    const lock = JSON.parse(lockBytes);
    lock.packages['node_modules/zod'].version = '0.0.0-fixture';
    write(installedLock, json(lock));
    const bytes = trackedDigest(), index = indexBytes();

    expect(landingCli).toThrow('carrier build: installed npm tree does not match package-lock.json (node_modules/zod); run npm ci in this checkout');
    expect(trackedDigest()).toBe(bytes);
    expect(indexBytes()).toEqual(index);
    expect(git('rev-parse', 'HEAD')).toBe(left);
    expect(existsSync(join(root, '.git/MERGE_HEAD'))).toBe(false);
  } finally {
    write(installedLock, lockBytes);
    restoreDerivedFixture();
  }
}, 30000);

it('leaves the merge in place when both sides edit the SQL reference prose', async () => {
  git('reset', '--hard', reviewed); git('checkout', '-q', '--detach', reviewed);
  try {
    write(SQL_REFERENCE, read(SQL_REFERENCE).replace(SQL_HEADING, '# Reviewed SQL catalogue'));
    const left = commit();
    await expect(landingMerge(root)).rejects.toThrow(`landing: authored conflicts remain: ${SQL_REFERENCE}`);
    expect(git('rev-parse', 'HEAD')).toBe(left);
    expect(git('rev-parse', 'MERGE_HEAD')).toBe(main);
    expect(git('diff', '--name-only', '--diff-filter=U')).toContain(SQL_REFERENCE);
    expect(read(SQL_REFERENCE)).toContain('# Reviewed SQL catalogue');
    expect(read(SQL_REFERENCE)).toContain(MAIN_SQL_HEADING);
  } finally { git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged); }
}, 50000);
it('refuses a non-SQL generated region on the SQL reference', () => {
  git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
  try {
    write(SQL_REFERENCE, read(SQL_REFERENCE).replaceAll('generated:sql:platform', 'generated:exports:platform'));
    expect(() => runLandingGenerators(root, git('ls-files', '-z').split('\0').filter(Boolean)))
      .toThrow(`${SQL_REFERENCE}: unknown generated region exports:platform`);
  } finally { git('reset', '--hard', merged); }
}, 50_000);
it('keeps a package command that main added after the reviewed head forked', () => {
  const names = (revision: string) => JSON.parse(git('show', `${revision}:${CATALOGUE}`)).packageCommands.map(({ name }) => name);
  expect(names(reviewed)).not.toContain('fixture:landing');
  expect(names(main)).toContain('fixture:landing');
  const landed = JSON.parse(git('show', `${merged}:${CATALOGUE}`));
  const upstream = JSON.parse(git('show', `${main}:${CATALOGUE}`));
  expect(landed.packageCommands).toEqual(upstream.packageCommands);
  expect(landed.publicPaths.map(row => row.path)).toContain('packages/platform/sql/20990101010000_landing_fixture.sql');
  expect(landed.publicPaths.map(row => row.path)).toContain('packages/platform/sql/20990101020000_landing_fixture.sql');
});
it('regenerates stale package command metadata when the trusted owner is unchanged', () => {
  try {
    checkout(reviewed);
    const catalog = JSON.parse(read(CATALOGUE));
    const expected = catalog.packageCommands;
    catalog.packageCommands = [];
    write(CATALOGUE, json(catalog));
    runLandingGenerators(root, git('ls-files', '-z').split('\0').filter(Boolean));
    expect(JSON.parse(read(CATALOGUE)).packageCommands).toEqual(expected);
  } finally { restoreDerivedFixture(); }
});
it.each(['user.name', 'user.email'])('refuses landing before merging without configured %s', async key => {
  git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
  git('config', key, '');
  try {
    await expect(landingMerge(root)).rejects.toThrow(`landing: configure Git ${key} before making a personal DCO sign-off`);
    expect(git('rev-parse', 'HEAD')).toBe(merged);
    await expect(sourceGit(root, 'rev-parse', '--verify', 'MERGE_HEAD')).rejects.toThrow();
  } finally { git('config', key, key === 'user.name' ? 'Fixture' : 'fixture@example.invalid'); }
});
describe('integration proof on a compact Git history', () => {
  let full: { root: string; base: string; reviewed: string; main: string; merged: string };

  beforeAll(() => {
    full = { root, base, reviewed, main, merged };
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlup-derived-objects-')));
    execFileSync('/usr/bin/git', ['clone', '--shared', '--no-checkout', '-q', full.root, root], { env: fixtureEnvironment, timeout: 30000 });
    const retained = [
      INVENTORY_PATH, ...MIGRATION_REGISTRIES, CATALOGUE, SQL_REFERENCE, PORTABILITY, PORTABILITY_REPORT,
      'README.md', 'db/platform/migrations', 'packages/platform/sql', 'packages/outbox/sql',
      'packages/core/package.json', 'packages/platform/src/migrations/catalog.ts',
      'scripts/platform-migration-manifest.ts', 'scripts/agent-review-decide.mjs', 'scripts/agent-review-session.mjs',
    ];
    const sourceMap = 'docs/platform/SOURCE_MAP.md';
    const route = (id: string, selector: string) => ({ id, when: 'Fixture routing', paths: [selector], doc: 'README.md', anchor: '' });
    function project(revision: string, ...parents: string[]) {
      git('rm', '-rf', '--ignore-unmatch', '--', '.');
      git('restore', `--source=${revision}`, '--staged', '--worktree', '--', ...retained);
      // Keep the real SQL and registry objects. A small routing inventory is
      // enough to exercise trusted source-map proofs in every variant.
      write('src/lib/coreDomains.ts', 'export const CORE_DOMAINS = Object.freeze(["fixture"] as const);\n');
      write('src/domains/fixture/index.ts', 'export const fixture = 1;\n');
      write('config/doc-routing.json', json({ version: 2, surfaces: [route('fixture-root', '**'), route('domain-fixture', 'src/domains/fixture/**')] }));
      write(sourceMap, '');
      git('add', '-A');
      const paths = git('ls-files', '-z').split('\0').filter(Boolean);
      write(sourceMap, renderDocumentationSourceMap(readDocumentationState(root, paths)));
      git('add', '--', sourceMap);
      return git('commit-tree', git('write-tree'), ...parents.flatMap(parent => ['-p', parent]), '-m', 'Project fixture proof objects');
    }
    git('read-tree', '--empty');
    base = project(full.base);
    reviewed = project(full.reviewed, base);
    main = project(full.main, base);
    merged = project(full.merged, reviewed, main);
    checkout(merged);
    setMain(main);
  }, 60000);

  afterAll(() => {
    if (full) {
      if (root !== full.root) rmSync(root, { recursive: true, force: true });
      ({ root, base, reviewed, main, merged } = full);
    }
  });

  it('preserves derived substitutions around API resolutions and uses the actual report mode for the floor', async () => {
    try {
      checkout(reviewed); probeExport(); const left = commit();
      checkout(merged); probeExport();
      write(PORTABILITY_REPORT, read(PORTABILITY_REPORT) + '\nFixture API resolution.\n');
      git('add', '-A');
      const firstParent = await captureCommittedReviewCandidate(root, base, left);
      for (const { modeChanged, floor } of [{ modeChanged: false, floor: 0 }, { modeChanged: true, floor: 2 }]) {
        if (modeChanged) git('update-index', '--chmod=+x', PORTABILITY_REPORT);
        const head = git('commit-tree', git('write-tree'), '-p', left, '-p', main, '-m', 'Synthetic report resolution');
        const integration = await proveReviewIntegration(root, firstParent, await captureCommittedReviewCandidate(root, main, head));
        expect(integration).toMatchObject({ kind: 'resolution', derived: true, resolution: [PORTABILITY_REPORT], modeChanged });
        expect(git('diff', '--name-only', integration.prediction, head)).toBe(PORTABILITY_REPORT);
        expect(deltaFloor(integration.resolution, integration.modeChanged)).toBe(floor);
      }
    } finally { restoreDerivedFixture(); }
  }, 180000);

  it('carries reviewed coverage through the derived edge and replays its recorded identity', async () => {
    const previous = await captureCommittedReviewCandidate(root, base, reviewed);
    const intent = { risk: 'routine', criteria: 'Preserve independently appended forwards and all reviewed boundaries' };
    let session = prepareCandidate(null, { ...previous, rules: await captureReviewRules(root, previous), intent, authorSessionId: 'fixture-author' }, 1000);
    for (const reviewer of ['fixture-reviewer-one', 'fixture-reviewer-two']) session = recordReport(session, {
      reviewer, cold: true, verdict: 'PASS', tree: previous.tree, findings: [], closes: [], documentation: 'Checked the fixture contract and contributor guidance.',
    }, 1000);
    const current = await captureCommittedReviewCandidate(root, main, merged);
    const observed = { ...current, rules: await captureReviewRules(root, current), intent, authorSessionId: 'fixture-author' };
    const integration = integrationReviewContext(session, observed, { parents: [reviewed, main], baseAncestor: true }, 1001);
    const coverage = await captureCoverageEdge(root, session, observed, 1001);
    expect(coverage?.proof.kind).toBe('portable-derived');
    session = prepareCandidate(session, { ...observed, integration, coverage }, 1001);
    expect(verdict(session, current, 1001).ok).toBe(true);
    await validateEconomySession(root, session);
  // Two full-tree generator passes plus receipt replay exceeded the 10 s unit default.
  }, 90000);
  it.each(['historical byte', 'edited existing entry', 'duplicate slot', 'wrong generator bytes', 'missing SQL reference row', 'other byte', 'SQL byte', 'wrong lineage'])('refuses %s on live Git objects', async scenario => {
    git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
    if (scenario === 'historical byte') write(INVENTORY_PATH, read(INVENTORY_PATH).replace('"historical": {}', '"historical": { }'));
    if (scenario === 'edited existing entry') {
      const path = MIGRATION_REGISTRIES[1], data = JSON.parse(read(path)); data.nativeStoreForwards[0].sha256 = 'a'.repeat(64); write(path, json(data));
    }
    if (scenario === 'duplicate slot') {
      const path = MIGRATION_REGISTRIES[1], data = JSON.parse(read(path)); data.nativeStoreForwardClass.slots.push(data.nativeStoreForwardClass.slots.at(-1)); write(path, json(data));
    }
    if (scenario === 'wrong generator bytes') write('packages/platform/sql/manifest.json', read('packages/platform/sql/manifest.json') + ' ');
    if (scenario === 'missing SQL reference row') {
      write(SQL_REFERENCE, read(SQL_REFERENCE).split('\n').filter(line => !line.startsWith('| [`20990101010000_landing_fixture.sql`]')).join('\n'));
    }
    if (scenario === 'other byte') write('README.md', read('README.md') + '\nUnexpected edit\n');
    if (scenario === 'SQL byte') write('db/platform/migrations/20990101010000_landing_fixture.sql', 'SELECT 2;\n');
    git('add', '-A'); const tree = git('write-tree');
    const args = scenario === 'wrong lineage' ? ['-p', reviewed] : ['-p', reviewed, '-p', main];
    const head = git('commit-tree', tree, ...args, '-m', 'Synthetic refusal');
    if (scenario === 'wrong lineage') await expect(proof(head)).rejects.toThrow('integration parents differ');
    else {
      const decision = await proof(head);
      expect(decision.kind).toBe('resolution');
      if (scenario === 'missing SQL reference row') {
        expect(decision.derived).toBeUndefined();
        expect(decision.resolution).toContain(SQL_REFERENCE);
      }
    }
  }, 50000);
  it.each(['edited existing entry', 'duplicate slot'])('refuses %s at the registry union boundary', scenario => {
    const original = git('show', `${base}:${MIGRATION_REGISTRIES[1]}`), side = JSON.parse(original);
    if (scenario === 'edited existing entry') side.nativeStoreForwards[0].sha256 = 'a'.repeat(64);
    else side.nativeStoreForwards.push({ ...side.nativeStoreForwards.at(-1), path: side.nativeStoreForwards.at(-1).path.replace(/_[^/]+\.sql$/, '_duplicate.sql') });
    expect(() => migrationRegistryUnion(MIGRATION_REGISTRIES[1], original, json(side), original)).toThrow();
  });

  it.each([
    { path: SQL_REFERENCE, unresolved: true, expected: 'refusal' },
    { path: 'docs/platform/SOURCE_MAP.md', unresolved: true, expected: 'refusal' },
    { path: 'packages/platform/sql/manifest.json', unresolved: true, expected: 'refusal' },
    { path: 'packages/platform/sql/00000000000000_platform_baseline.sql', unresolved: true, expected: 'refusal' },
    { path: 'docs/platform/SOURCE_MAP.md', unresolved: false, expected: 'derived' },
    { path: 'packages/platform/sql/00000000000000_platform_baseline.sql', unresolved: false, expected: 'resolution' },
  ])('requires $expected for $path with unresolved=$unresolved despite other derived carriers', async ({ path, unresolved, expected }) => {
    try {
      // Use the same generated rows on both sides so the SQL page has only a prose conflict.
      const original = await sourceGit(root, 'show', `${path === SQL_REFERENCE ? merged : base}:${path}`);
      git('reset', '--hard', reviewed); git('checkout', '-q', '--detach', reviewed);
      write(path, 'Reviewed carrier variant\n' + original); const left = commit();
      git('reset', '--hard', main); git('checkout', '-q', '--detach', main);
      write(path, 'Main carrier variant\n' + original); const right = commit();
      git('update-ref', 'refs/remotes/origin/main', right);
      let prediction: string | undefined;
      try { await sourceGit(root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right); }
      catch (error) {
        expect(error.code).toBe(1);
        const [tree, ...conflicts] = error.stdout.split('\0'); prediction = tree;
        expect(conflicts).toContain(path);
      }
      expect(prediction).toMatch(/^[a-f0-9]{40}$/);
      const markers = await sourceGit(root, 'show', `${prediction}:${path}`);
      expect(markers).toContain('<<<<<<<');
      if (path === SQL_REFERENCE) {
        expect(markers).toMatch(/^<<<<<<< .+\nReviewed carrier variant\n/mu);
        const regions = '<!-- generated:sql:outbox -->';
        expect(markers.slice(markers.indexOf(regions))).toBe(original.slice(original.indexOf(regions)));
      }
      // Keep the correct measured inventory and exact registry unions from the
      // successful landing, changing only the selected carrier to Git's raw blob.
      git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
      const inventory = read(INVENTORY_PATH);
      expect(inventory).not.toBe(await sourceGit(root, 'show', `${left}:${INVENTORY_PATH}`));
      for (const registry of MIGRATION_REGISTRIES) {
        const inputs = await Promise.all([base, left, right].map(revision => sourceGit(root, 'show', `${revision}:${registry}`)));
        expect(read(registry)).toBe(migrationRegistryUnion(registry, ...inputs, inventory));
      }
      if (unresolved) write(path, markers);
      git('add', '-A'); const tree = git('write-tree');
      const changed = (await captureCommittedReviewCandidate(root, prediction, tree)).changedPaths;
      if (unresolved) expect(changed).not.toContain(path);
      else expect(changed).toContain(path);
      const head = git('commit-tree', tree, '-p', left, '-p', right, '-m', 'Synthetic conflicting carrier');
      const result = proveReviewIntegration(root, await captureCommittedReviewCandidate(root, base, left), await captureCommittedReviewCandidate(root, right, head));
      if (expected === 'refusal') await expect(result).rejects.toThrow('integration commits a conflict without resolving it');
      else {
        const decision = await result;
        expect(decision.kind).toBe(expected);
        if (expected === 'resolution') expect(decision.resolution).toContain(path);
      }
    } finally {
      git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
      git('update-ref', 'refs/remotes/origin/main', main);
    }
  }, 50000);
});

it('runs incremental package build before inventory refresh when PR touches SQL', () => {
  expect(initialLandingResult.inventoryRefreshed).toBe(true);
  expect(initialLandingCommands.map(({ args }) => args)).toEqual([
    ['--input-type=module', '-e', expect.stringContaining('assertCarrierToolchain(process.cwd())')],
    [join(root, 'scripts/build-packages-incremental.mjs')],
    ['--import', 'tsx', join(root, 'scripts/installation-inventory-refresh.ts')],
  ]);
});

it('refuses inverted or duplicate migration slots before starting merge or Docker', async () => {
  const mainPaths = [
    'db/platform/migrations/20990101020000_main.sql',
    'supabase/migrations/20990101020000_main.sql',
  ];
  expect(() => assertAppendOnlyLandingSlots(['db/platform/migrations/20990101030000_pr.sql'], mainPaths)).not.toThrow();
  expect(() => assertAppendOnlyLandingSlots(['db/platform/migrations/20990101010000_pr.sql'], mainPaths))
    .toThrow('landing: migration slot is not strictly later than origin/main');
  expect(() => assertAppendOnlyLandingSlots(['db/platform/migrations/20990101020000_pr.sql'], mainPaths))
    .toThrow('landing: migration slot is not strictly later than origin/main');
  expect(() => assertAppendOnlyLandingSlots([
    'db/platform/migrations/20990101030000_first.sql',
    'db/platform/migrations/20990101030000_second.sql',
  ], mainPaths)).toThrow('landing: migration slot is not strictly later than origin/main');
  expect(() => assertAppendOnlyLandingSlots(['supabase/migrations/20990101010000_pr.sql'], mainPaths))
    .toThrow('landing: migration slot is not strictly later than origin/main');

  try {
    git('checkout', '-q', '--detach', base);
    append('20990101010000');
    const invertedPr = commit();
    git('checkout', '-q', '--detach', base);
    append('20990101020000');
    const aheadMain = commit();
    setMain(aheadMain);
    git('checkout', '-q', '--detach', invertedPr);
    const invoked: string[][] = [];
    await expect(landingMerge(root, {
      runCommand: (_command, args) => { invoked.push(args); },
    })).rejects.toThrow('landing: migration slot is not strictly later than origin/main');
    expect(invoked).toEqual([]);
    expect(git('status', '--porcelain=v1')).toBe('');
    expect(existsSync(join(root, '.git/MERGE_HEAD'))).toBe(false);

    // Stacked PR whose predecessor migration squash-merged byte-identically onto origin/main must not be falsely refused.
    git('checkout', '-q', '--detach', base);
    append('20990101010000');
    write('README.md', `${read('README.md')}\n<!-- stacked-child -->\n`);
    const stackedChild = commit();
    git('checkout', '-q', '--detach', base);
    append('20990101010000');
    const squashMergedMain = commit();
    setMain(squashMergedMain);
    git('checkout', '-q', '--detach', stackedChild);
    const stackedInvoked: string[][] = [];
    const stackedLanded = await landingMerge(root, {
      runCommand: (_command, args) => { stackedInvoked.push(args); },
    });
    expect(stackedLanded.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(stackedInvoked.length).toBeGreaterThan(0);
    expect(git('status', '--porcelain=v1')).toBe('');
  } finally {
    git('reset', '--hard', merged);
    git('checkout', '-q', '--detach', merged);
    setMain(main);
  }
}, 60_000);

it('plans shared migration slots across rails and UTC rollover', () => {
  expect(nextFreeMigrationSlot('20261231235900')).toBe('20270101000000');
  expect(nextFreeMigrationSlot('20261231235942')).toBe('20270101000042');
  expect(landingSlotPlan(['db/platform/migrations/20270101000000_pr.sql'], [
    'supabase/migrations/qa_20270101010000_main.sql',
  ])).toMatchObject({ maxMainSlot: '20270101010000', nextFreeSlot: '20270101010100',
    changes: [{ path: 'db/platform/migrations/20270101000000_pr.sql', target: 'db/platform/migrations/20270101010100_pr.sql' }] });
  expect(landingSlotPlan([
    'db/platform/migrations/20270101000000_old.sql',
    'db/platform/migrations/20270101010100_new.sql',
  ], ['supabase/migrations/20270101010000_main.sql'])).toMatchObject({
    nextFreeSlot: '20270101010200',
    changes: [{ target: 'db/platform/migrations/20270101010200_old.sql' }],
  });
});

it('refuses authored migration filenames before re-slot changes the tree', async () => {
  try {
    checkout(base);
    append('20990101010000');
    write('scripts/fixture-reference.test.ts', 'const migration = "20990101010000_landing_fixture.sql";\n');
    const head = commit();
    const changes = [{ path: 'db/platform/migrations/20990101010000_landing_fixture.sql',
      target: 'db/platform/migrations/20990101030100_landing_fixture.sql' }];
    await expect(assertNoAuthoredSlotReferences(root, base, head, changes))
      .rejects.toThrow('scripts/fixture-reference.test.ts:1');
    expect(git('status', '--porcelain=v1')).toBe('');
  } finally { restoreDerivedFixture(); }
});

it('re-slots migration paths in the manifest, reviewed forwards and publication catalogue', () => {
  try {
    checkout(base);
    append('20990101010000');
    const oldPath = 'db/platform/migrations/20990101010000_landing_fixture.sql';
    const newPath = 'db/platform/migrations/20990101030100_landing_fixture.sql';
    const catalog = JSON.parse(read(CATALOGUE));
    catalog.publicPaths.push({ path: oldPath, class: 'public-output' });
    catalog.publicPaths.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    write(CATALOGUE, json(catalog));
    applyMigrationReslot(root, [{ path: oldPath, target: newPath }]);
    expect(existsSync(join(root, oldPath))).toBe(false);
    expect(existsSync(join(root, newPath))).toBe(true);
    expect(read(MIGRATION_REGISTRIES[0])).toContain(newPath);
    expect(read(MIGRATION_REGISTRIES[1])).toContain(newPath);
    expect(read(MIGRATION_REGISTRIES[0])).not.toContain(oldPath);
    expect(read(MIGRATION_REGISTRIES[1])).not.toContain(oldPath);
    const rows = JSON.parse(read(CATALOGUE)).publicPaths.map(({ path }) => path);
    expect(rows).toContain(newPath);
    expect(rows).not.toContain(oldPath);
    expect(rows).toEqual([...rows].sort());
  } finally { restoreDerivedFixture(); }
});

it('lands an inverted migration only with explicit re-slot', async () => {
  try {
    checkout(base);
    append('20990101010000');
    const pr = commit();
    checkout(base);
    append('20990101020000');
    const upstream = commit();
    setMain(upstream);
    checkout(pr);
    const result = await landingMerge(root, { reSlot: true, runCommand: (command, args) => {
      if (args.includes(join(root, 'scripts/installation-inventory-refresh.ts'))) return;
      fixtureCommand(command, args);
    } });
    expect(result.head).toMatch(/^[a-f0-9]{40}$/u);
    expect(git('ls-files', 'db/platform/migrations/20990101020100_landing_fixture.sql')).toContain('20990101020100');
    expect(git('ls-files', 'db/platform/migrations/20990101010000_landing_fixture.sql')).toBe('');
    const manifest = JSON.parse(read(MIGRATION_REGISTRIES[0]));
    const earlier = 'db/platform/migrations/20990101020000_landing_fixture.sql';
    const later = 'db/platform/migrations/20990101020100_landing_fixture.sql';
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      const files = plan.forward.map(({ file }) => file);
      expect(files.indexOf(later)).toBeGreaterThan(files.indexOf(earlier));
    }
    const registry = JSON.parse(read(MIGRATION_REGISTRIES[1]));
    const slots = registry.nativeStoreForwardClass.slots.map(({ path }) => path);
    expect(slots.indexOf(later)).toBeGreaterThan(slots.indexOf(earlier));
    expect(evaluatePlatformMigrationManifestMetadata(manifest)).toEqual([]);
  } finally { git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged); setMain(main); }
}, 60_000);

it('does not auto-admit an authored SQL bystander as a generated mirror', () => {
  const rogue = 'packages/platform/sql/20990101040000_rogue.sql';
  try {
    checkout(merged);
    write(rogue, 'SELECT 1;\n');
    const prior = JSON.parse(read('packages/platform/sql/manifest.json'));
    prior.migrations.push({ file: '20260809150001_job_run_ledger_v3.sql', source: 'db/platform/migrations/20990101040000_forged.sql', sha256: '0'.repeat(64) });
    write('packages/platform/sql/manifest.json', json(prior));
    runLandingGenerators(root, git('ls-files', '-z').split('\0').filter(Boolean));
    const paths = JSON.parse(read(CATALOGUE)).publicPaths.map(({ path }) => path);
    expect(paths).not.toContain(rogue);
    expect(paths).toContain('packages/platform/sql/20260809150001_job_run_ledger_v3.sql');
    expect(read('packages/platform/sql/20260809150001_job_run_ledger_v3.sql')).toContain('CREATE OR REPLACE');
  } finally {
    rmSync(join(root, rogue), { force: true });
    restoreDerivedFixture();
  }
});

it('removes a catalogue row when a generated SQL mirror was deleted', () => {
  const stale = 'packages/platform/sql/20990101040000_stale_fixture.sql';
  try {
    checkout(merged);
    const catalog = JSON.parse(read(CATALOGUE));
    catalog.publicPaths.push({ path: stale, class: 'public-output' });
    catalog.publicPaths.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    write(CATALOGUE, json(catalog));
    runLandingGenerators(root, git('ls-files', '-z').split('\0').filter(Boolean));
    expect(JSON.parse(read(CATALOGUE)).publicPaths.some(({ path }) => path === stale)).toBe(false);
  } finally { restoreDerivedFixture(); }
});

it('keeps a platform SQL mirror when only a supabase migration is re-slotted', () => {
  const oldPath = 'supabase/migrations/20990101040000_shared_fixture.sql';
  const target = 'supabase/migrations/20990101050000_shared_fixture.sql';
  const mirror = 'packages/platform/sql/20990101040000_shared_fixture.sql';
  try {
    checkout(merged);
    write(oldPath, 'SELECT 1;\n');
    write(mirror, 'SELECT 2;\n');
    applyMigrationReslot(root, [{ path: oldPath, target }]);
    expect(existsSync(join(root, mirror))).toBe(true);
    expect(read(mirror)).toBe('SELECT 2;\n');
  } finally {
    rmSync(join(root, oldPath), { force: true });
    rmSync(join(root, target), { force: true });
    rmSync(join(root, mirror), { force: true });
    restoreDerivedFixture();
  }
});

it('classifies SQL and migration-inventory inputs conservatively', () => {
  for (const path of [
    'db/platform/migrations/20990101010000_fixture.sql',
    'db/bootstrap/vanilla-pg/00_roles.sql',
    'supabase/migrations/20990101010000_fixture.sql',
    'packages/platform/sql/20990101010000_fixture.sql',
    'packages/platform/src/migrations/catalog.ts',
    ...MIGRATION_REGISTRIES,
    INVENTORY_PATH,
    'config/ci-images.json',
    'scripts/ci-image-pull.mjs',
    'scripts/ci-image-mirror.mjs',
    'scripts/platform-migration-manifest.ts',
    'scripts/installation-inventory-refresh.ts',
    'server/adapters/postgres/migrationRunner.ts',
    'server/adapters/postgres/qualifiedInstall.ts',
    'server/adapters/postgres/selectedCatalogProjection.ts',
    'server/adapters/postgres/connectedStoreCapture.ts',
  ]) expect(isInventoryInputPath(path), path).toBe(true);

  for (const path of [
    'README.md',
    'scripts/agent-review-landing.mjs',
    'docs/platform/README.md',
    CATALOGUE,
    'packages/core/src/index.ts',
  ]) expect(isInventoryInputPath(path), path).toBe(false);
});

it.each(['clean', 'derived-carrier'])('skips Docker inventory refresh on non-SQL PR (%s) even when main changed SQL and inventory', async mode => {
  try {
    // Build a main commit that changed SQL, registries, publication catalogue, AND measured inventory.
    git('reset', '--hard', main); git('checkout', '-q', '--detach', main);
    const baseInvSource = read(INVENTORY_PATH);
    const invEnvelope = inventoryEnvelope(baseInvSource);
    const updatedCurrent = structuredClone(invEnvelope.value.current);
    const digests: Record<string, string> = {
      legacy: '1'.repeat(64),
      bootstrap: '2'.repeat(64),
      separate: '3'.repeat(64),
      'admin-managed': '4'.repeat(64),
      'admin-operator': '5'.repeat(64),
    };
    for (const [profile, sha] of Object.entries(digests)) updatedCurrent.profiles[profile].objectInventorySha256 = sha;
    write(INVENTORY_PATH, invEnvelope.before + JSON.stringify(updatedCurrent, null, 2).replaceAll('\n', '\n  ') + invEnvelope.after);
    const mainManifest = JSON.parse(read(MIGRATION_REGISTRIES[0]));
    mainManifest.objectInventorySha256 = digests.legacy;
    mainManifest.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: digests.bootstrap }, separateMigrator: { withRestore: digests.separate } };
    mainManifest.qualifiedAdmin.objectInventorySha256 = { installerManaged: digests['admin-managed'], operatorProvisioned: digests['admin-operator'] };
    write(MIGRATION_REGISTRIES[0], json(mainManifest));
    const mergedGenerators = pathToFileURL(join(root, 'scripts/agent-review-generators.mjs')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs';
      const owners = await import(${JSON.stringify(mergedGenerators)});
      owners.runLandingGenerators(process.cwd(), readFileSync(0, 'utf8').split('\\0').filter(Boolean));`],
    { cwd: root, env: fixtureEnvironment, input: git('ls-files', '-z'), timeout: 30000 });
    const mainWithInventory = commit();
    git('update-ref', 'refs/remotes/origin/main', mainWithInventory);

    // Create a non-SQL PR forked from base (stale inventory, no SQL changes).
    git('reset', '--hard', base); git('checkout', '-q', '--detach', base);
    if (mode === 'clean') {
      write('README.md', read('README.md') + '\nNon-SQL PR note\n');
    } else {
      // Bumping core version updates generated SQL reference links without touching SQL or inventory inputs,
      // conflicting with main's appended SQL row in packages/core/docs/guide/reference/sql.md.
      const corePkg = JSON.parse(read('packages/core/package.json'));
      corePkg.version = `${corePkg.version}-fixture`;
      write('packages/core/package.json', json(corePkg));
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs';
        const owners = await import(${JSON.stringify(mergedGenerators)});
        owners.runLandingGenerators(process.cwd(), readFileSync(0, 'utf8').split('\\0').filter(Boolean));`],
      { cwd: root, env: fixtureEnvironment, input: git('ls-files', '-z'), timeout: 30000 });
    }
    const nonSqlHead = commit();

    const invoked: { command: string; args: string[] }[] = [];
    const landed = await landingMerge(root, {
      runCommand: (command, args) => {
        invoked.push({ command, args });
        expect(args).not.toContain(join(root, 'scripts/installation-inventory-refresh.ts'));
      },
    });
    if (mode === 'clean') expect(invoked).toEqual([{
      command: process.execPath, args: ['--input-type=module', '-e', expect.stringContaining('assertCarrierToolchain(process.cwd())')],
    }]);
    else expect(invoked.filter(({ args }) => args[0] === npmCli)).toEqual(['core', 'outbox', 'platform'].map(owner => ({
      command: process.execPath, args: [npmCli, 'run', 'build', `--workspace=@openlup/${owner}`],
    })));
    expect(landed.inventoryRefreshed).toBe(false);
    expect(git('show', `${landed.head}:${INVENTORY_PATH}`)).toBe(git('show', `${mainWithInventory}:${INVENTORY_PATH}`));
    expect(git('show', `${landed.head}:${INVENTORY_PATH}`)).not.toBe(git('show', `${nonSqlHead}:${INVENTORY_PATH}`));

    const integration = await proveReviewIntegration(
      root,
      await captureCommittedReviewCandidate(root, base, nonSqlHead),
      await captureCommittedReviewCandidate(root, mainWithInventory, landed.head),
    );
    expect(integration, JSON.stringify(integration)).toMatchObject(mode === 'clean' ? { kind: 'git' } : { kind: 'derived', derived: true });
  } finally {
    git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
    git('update-ref', 'refs/remotes/origin/main', main);
  }
}, 180000);

it('deduplicates byte-for-byte identical stacked rows in migrationRegistryUnion and still refuses conflicts', () => {
  const baseManifest = git('show', `${base}:${MIGRATION_REGISTRIES[0]}`);
  const baseForwards = git('show', `${base}:${MIGRATION_REGISTRIES[1]}`);
  const inv = git('show', `${base}:${INVENTORY_PATH}`);

  const pred = { file: 'db/platform/migrations/20990101010000_pred.sql', sha256: 'a'.repeat(64) };
  const leftOnly = { file: 'db/platform/migrations/20990101030000_stack.sql', sha256: 'b'.repeat(64) };
  const rightOnly = { file: 'db/platform/migrations/20990101020000_main.sql', sha256: 'c'.repeat(64) };

  const manifestLeft = JSON.parse(baseManifest);
  const manifestRight = JSON.parse(baseManifest);
  for (const plan of [manifestLeft, manifestLeft.qualified, manifestLeft.qualifiedAdmin]) plan.forward.push(pred, leftOnly);
  for (const plan of [manifestRight, manifestRight.qualified, manifestRight.qualifiedAdmin]) plan.forward.push(pred, rightOnly);
  const mergedManifest = JSON.parse(migrationRegistryUnion(MIGRATION_REGISTRIES[0], baseManifest, json(manifestLeft), json(manifestRight), inv));
  expect(mergedManifest.forward.slice(-3)).toEqual([pred, rightOnly, leftOnly]);

  // Same key with different content MUST still refuse.
  const manifestDifferentSha = JSON.parse(baseManifest);
  for (const plan of [manifestDifferentSha, manifestDifferentSha.qualified, manifestDifferentSha.qualifiedAdmin]) {
    plan.forward.push({ ...pred, sha256: 'd'.repeat(64) });
  }
  expect(() => migrationRegistryUnion(MIGRATION_REGISTRIES[0], baseManifest, json(manifestLeft), json(manifestDifferentSha), inv))
    .toThrow('derived: duplicate entry');

  // Same slot with different filename MUST still refuse.
  const manifestDifferentFile = JSON.parse(baseManifest);
  for (const plan of [manifestDifferentFile, manifestDifferentFile.qualified, manifestDifferentFile.qualifiedAdmin]) {
    plan.forward.push({ file: 'db/platform/migrations/20990101010000_other.sql', sha256: pred.sha256 });
  }
  expect(() => migrationRegistryUnion(MIGRATION_REGISTRIES[0], baseManifest, json(manifestLeft), json(manifestDifferentFile), inv))
    .toThrow('derived: duplicate slot');

  // Also verify reviewed-platform-forwards.json deduplication and conflict refusal.
  const predSlot = { row: 'pred', path: pred.file, replacedFunctions: [], createdFunctions: [] };
  const predForward = { path: pred.file, sha256: pred.sha256, functions: [] };
  const leftForwards = JSON.parse(baseForwards);
  const rightForwards = JSON.parse(baseForwards);
  leftForwards.nativeStoreForwardClass.slots.push(predSlot, { row: 'stack', path: leftOnly.file, replacedFunctions: [], createdFunctions: [] });
  leftForwards.nativeStoreForwards.push(predForward, { path: leftOnly.file, sha256: leftOnly.sha256, functions: [] });
  rightForwards.nativeStoreForwardClass.slots.push(predSlot, { row: 'main', path: rightOnly.file, replacedFunctions: [], createdFunctions: [] });
  rightForwards.nativeStoreForwards.push(predForward, { path: rightOnly.file, sha256: rightOnly.sha256, functions: [] });
  const mergedForwards = JSON.parse(migrationRegistryUnion(MIGRATION_REGISTRIES[1], baseForwards, json(leftForwards), json(rightForwards)));
  expect(mergedForwards.nativeStoreForwards.slice(-3).map((row: { path: string }) => row.path)).toEqual([pred.file, rightOnly.file, leftOnly.file]);

  const conflictForwards = JSON.parse(baseForwards);
  conflictForwards.nativeStoreForwardClass.slots.push({ ...predSlot, row: 'changed-row' });
  conflictForwards.nativeStoreForwards.push(predForward);
  expect(() => migrationRegistryUnion(MIGRATION_REGISTRIES[1], baseForwards, json(leftForwards), json(conflictForwards)))
    .toThrow('derived: duplicate entry');
});
