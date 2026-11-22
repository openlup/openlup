import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, migrationRegistryUnion } from './agent-review-derived.mjs';
import { runLandingGenerators } from './agent-review-generators.mjs';
import { carrierLocale, isInventoryInputPath, landingMerge } from './agent-review-landing.mjs';
import { deltaFloor, prepareCandidate, recordReport, integrationReviewContext, verdict } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, captureCoverageEdge, validateEconomySession, proveReviewIntegration, git as sourceGit } from './agent-review-session.mjs';

const source = process.cwd();
let root: string, base: string, reviewed: string, main: string, merged: string;
let initialLandingCommands: { command: string; args: string[] }[] = [];
let initialLandingResult: { head: string; main: string; inventoryRefreshed: boolean };
const git = (...args: string[]) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 * 1024 }).trim();
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
  runLandingGenerators(root, git('ls-files', '-z').split('\0').filter(Boolean).concat([file, `packages/platform/sql/${slot}_landing_fixture.sql`]));
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
  cwd: root, env: { ...processEnvironment, ...carrierLocale }, encoding: 'utf8', timeout: 180000,
  maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const coldBuild = (...owners: string[]) => {
  for (const owner of owners) fixtureCommand('npm', ['run', 'build', `--workspace=@openlup/${owner}`]);
};
const landingCli = () => fixtureCommand('npm', ['run', 'landing:merge']);
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
function registerOutput(path: string) {
  const catalogue = JSON.parse(read(CATALOGUE));
  catalogue.publicPaths.push({ path, class: 'public-output' });
  catalogue.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  write(CATALOGUE, json(catalogue));
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
    writeFileSync(${JSON.stringify(CATALOGUE)}, createPublicPublicationCatalog(catalog.publicPaths, catalog.guardViability).contents);`], { cwd: root, timeout: 30000 });
}
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openlup-derived-live-')));
  execFileSync('/usr/bin/git', ['clone', '--shared', '--no-hardlinks', '-q', source, root], { timeout: 30000 });
  // Include the candidate's working bytes during development as well as at final HEAD.
  const overlays = execFileSync('/usr/bin/git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of new Set([...git('ls-files', '-z').split('\0').filter(Boolean), ...overlays])) {
    if (!existsSync(join(source, path))) { rmSync(join(root, path), { force: true }); continue; }
    mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(source, path), join(root, path));
  }
  fixtureCommand('npm', ['ci', '--prefer-offline', '--no-audit', '--fund=false']);
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  base = commit();
  append('20990101010000'); reviewed = commit();
  git('checkout', '-q', '--detach', base); append('20990101020000'); addPackageCommand();
  write(SQL_REFERENCE, read(SQL_REFERENCE).replace(SQL_HEADING, MAIN_SQL_HEADING));
  main = commit();
  git('remote', 'set-url', 'origin', '.'); setMain(main); git('checkout', '-q', '--detach', reviewed);
  initialLandingCommands = [];
  initialLandingResult = await landingMerge(root, {
    runCommand: (command, args) => {
      initialLandingCommands.push({ command, args });
      execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 900000 });
    },
  });
  merged = initialLandingResult.head;
}, 600000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
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
    landingCli();
    const landed = git('rev-parse', 'HEAD');
    expect(git('show', '-s', '--format=%P%n%B', landed)).toBe(`${left} ${right}\nMerge origin/main and refresh derived carriers\n\nSigned-off-by: Fixture <fixture@example.invalid>`);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const integration = await proveReviewIntegration(root,
      await captureCommittedReviewCandidate(root, base, left), await captureCommittedReviewCandidate(root, right, landed));
    expect(git('diff', '--raw', left, landed, '--', 'packages/core/api', 'packages/outbox')).toBe('');
    const changed = PROBE_OUTPUTS.filter(path => path !== SETTING_REFUSALS).sort();
    expect(integration).toMatchObject({ kind: 'resolution', resolution: changed, modeChanged: false });
    expect(deltaFloor(integration.resolution, integration.modeChanged)).toBe(1);
    expect(deltaFloor(integration.resolution, true)).toBe(2);
    expect(read(PORTABILITY_REPORT)).toContain('declare const fixturePortability = 1');
    expect(read(SETTING_GUIDE)).toContain(`## ${PROBE_KEY}`);
    expect(git('show', `${base}:${SETTING_REFUSALS}`)).toBe(read(SETTING_REFUSALS).trimEnd());
    const discovery = JSON.parse(fixtureCommand(process.execPath, ['packages/platform/src/lifecycle/openlup.mjs', 'settings', 'show', PROBE_KEY, '--json']));
    expect(discovery.setting).toMatchObject({ key: PROBE_KEY, kind: 'invariant' });
    coldBuild('core', 'platform');
    fixtureCommand(process.execPath, ['packages/platform/scripts/api-contract.ts', '--update']);
    fixtureCommand(process.execPath, ['scripts/settings-catalogue.ts', '--write']);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const fast = spawnSync('npm', ['run', 'preflight', '--', '--fast'], {
      cwd: root, env: { ...processEnvironment, ...carrierLocale }, encoding: 'utf8', timeout: 180000,
    });
    expect(fast.status, fast.stdout + fast.stderr).toBe(0);
    expect(JSON.parse(fast.stdout.trimEnd().split('\n').at(-1)!)).toEqual({ preflight: 'fast', result: 'pass', head: landed, failed: [] });
    console.info(`D3 landing: fork ${base}, parents ${left} ${right}, merge ${landed}; residual ${changed.join(', ')}; settings refusals already match`);
  } finally { restoreDerivedFixture(); }
}, 180000);

it('preserves derived substitutions around an actual API resolution and uses its floor for D2', async () => {
  try {
    checkout(reviewed); probeExport(); const left = commit();
    checkout(merged); probeExport();
    coldBuild('core', 'platform');
    fixtureCommand(process.execPath, ['packages/platform/scripts/api-contract.ts', '--update']);
    git('add', '-A');
    const head = git('commit-tree', git('write-tree'), '-p', left, '-p', main, '-m', 'Synthetic report resolution');
    const firstParent = await captureCommittedReviewCandidate(root, base, left);
    const integration = await proveReviewIntegration(root, firstParent, await captureCommittedReviewCandidate(root, main, head));
    expect(integration).toMatchObject({ kind: 'resolution', derived: true, resolution: [PORTABILITY_REPORT], modeChanged: false });
    expect(git('diff', '--name-only', integration.prediction, head)).toBe(PORTABILITY_REPORT);
    const floor = deltaFloor(integration.resolution, integration.modeChanged);
    expect(floor).toBe(0);
    expect(firstParent.changedPaths.some(isInventoryInputPath)).toBe(true);
    // D2 defers only inventory rows with a resolution at floor one or above.
    const order = (resolutionFloor: number) => [
      { name: 'catalogue', defer: firstParent.changedPaths.some(isInventoryInputPath) && resolutionFloor >= 1 },
      { name: 'next', defer: false },
    ].sort((a, b) => Number(a.defer) - Number(b.defer)).map(({ name }) => name);
    expect(order(floor)).toEqual(['catalogue', 'next']);
    expect(order(deltaFloor(integration.resolution, true))).toEqual(['next', 'catalogue']);
  } finally { restoreDerivedFixture(); }
}, 180000);

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
    for (const owner of ['core', 'outbox', 'platform']) fixtureCommand('npm', ['run', 'api:check', `--workspace=@openlup/${owner}`]);
    expect(git('status', '--porcelain')).toBe('');
  } finally { restoreDerivedFixture(); }
}, 240000);

it.each([PORTABILITY_REPORT, SETTING_CATALOGUE, SETTING_REFUSALS, SETTING_GUIDE])('replaces the exact registered owner conflict at %s', path => {
  try {
    const original = git('show', `${base}:${path}`) + '\n';
    checkout(base); write(path, 'First-parent edit\n' + original); const left = commit();
    checkout(base); write(path, 'Main edit\n' + original); const right = commit(); setMain(right); checkout(left);
    landingCli();
    expect(read(path)).toBe(original);
    expect(git('status', '--porcelain')).toBe('');
  } finally { restoreDerivedFixture(); }
}, 180000);

it('stages a newly generated report absent from the merged index', () => {
  try {
    const newReport = 'packages/platform/api/portability-fixture.api.md';
    checkout(base); probeExport(); registerOutput(newReport);
    const gatesPath = 'packages/platform/release-gates.json';
    const gates = JSON.parse(read(gatesPath));
    gates.packageSurface['./portability'].snapshot = 'api/portability-fixture.api.md';
    write(gatesPath, json(gates)); const left = commit();
    checkout(base); const right = commit(); setMain(right); checkout(left);
    expect(git('ls-files', '--', newReport)).toBe('');
    landingCli();
    expect(git('show', `HEAD:${newReport}`)).toContain('declare const fixturePortability = 1');
    expect(git('status', '--porcelain')).toBe('');
  } finally { restoreDerivedFixture(); }
}, 180000);

it.each(['unregistered', 'executable', 'symlink'])('keeps a %s report conflict unresolved', mode => {
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
    expect(() => landingCli()).toThrow(`landing: authored conflicts remain: ${path}`);
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe(path);
  } finally { restoreDerivedFixture(); }
}, 60000);

it.each(['core', 'outbox'].flatMap(owner => ['first parent', 'missing', 'removed', 'main only'].map(note => ({ owner, note }))))(
  'checks the $owner change note from the $note before staging any API reports', ({ owner, note }) => {
    try {
      const directory = `packages/${owner}`;
      const entry = `${directory}/src/${owner === 'core' ? 'subscription/index.ts' : 'index.ts'}`;
      const notePath = `${directory}/changes/fixture-api.md`;
      const report = `${directory}/api/${owner === 'core' ? 'subscription' : 'index'}.api.md`;
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
        expect(git('show', `HEAD:${report}`)).toContain('declare const fixtureApi = 1');
      } else {
        expect(() => landingCli()).toThrow(`landing: @openlup/${owner} API snapshots changed`);
        expect(git('rev-parse', 'HEAD')).toBe(left);
        expect(git('diff', '--cached', '--name-only', '--', 'packages/core/api', 'packages/outbox/api', 'packages/platform/api')).toBe('');
      }
    } finally { restoreDerivedFixture(); }
  }, 180000,
);

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
});
it('keeps a package command that main added after the reviewed head forked', () => {
  const names = (revision: string) => JSON.parse(git('show', `${revision}:${CATALOGUE}`)).packageCommands.map(({ name }) => name);
  expect(names(reviewed)).not.toContain('fixture:landing');
  expect(names(main)).toContain('fixture:landing');
  expect(git('show', `${merged}:${CATALOGUE}`)).toBe(git('show', `${main}:${CATALOGUE}`));
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

it('runs incremental package build before inventory refresh when PR touches SQL', () => {
  expect(initialLandingResult.inventoryRefreshed).toBe(true);
  expect(initialLandingCommands.map(({ args }) => args)).toEqual([
    [join(root, 'scripts/build-packages-incremental.mjs')],
    ['--import', 'tsx', join(root, 'scripts/installation-inventory-refresh.ts')],
  ]);
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
    { cwd: root, input: git('ls-files', '-z'), timeout: 30000 });
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
      { cwd: root, input: git('ls-files', '-z'), timeout: 30000 });
    }
    const nonSqlHead = commit();

    const invoked: string[][] = [];
    const landed = await landingMerge(root, {
      runCommand: (command, args, options) => {
        invoked.push(args);
        expect(args).not.toContain(join(root, 'scripts/installation-inventory-refresh.ts'));
        execFileSync(command, args, { cwd: root, stdio: 'ignore', ...options });
      },
    });
    if (mode === 'clean') expect(invoked).toEqual([]);
    else expect(invoked.filter(([command]) => command === 'run')).toEqual(['core', 'outbox', 'platform'].map(owner => ['run', 'build', `--workspace=@openlup/${owner}`]));
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
