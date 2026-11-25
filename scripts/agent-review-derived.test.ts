import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, migrationRegistryUnion } from './agent-review-derived.mjs';
import { runLandingGenerators } from './agent-review-generators.mjs';
import { applyMigrationReslot, isInventoryInputPath, landingMerge } from './agent-review-landing.mjs';
import { captureCommittedReviewCandidate, proveReviewIntegration, git as sourceGit } from './agent-review-session.mjs';
import {
  CATALOGUE,
  MAIN_SQL_HEADING,
  PORTABILITY_REPORT,
  PROBE_KEY,
  PROBE_OUTPUTS,
  SETTING_GUIDE,
  SETTING_REFUSALS,
  SQL_HEADING,
  SQL_REFERENCE,
  createDerivedFixture,
  fixtureEnvironment,
  json,
  npmCli,
  type DerivedFixture,
} from './fixtures/agent-review-derived-fixture.ts';

let f: DerivedFixture;

beforeAll(async () => {
  f = await createDerivedFixture({ runInitialLanding: true });
}, 180000);

afterAll(() => {
  f?.cleanup();
});

it('lands two independently appended real forwards through the CLI as derived', async () => {
  await expect(sourceGit(f.root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', f.reviewed, f.main))
    .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(`${SQL_REFERENCE}\0`) });
  const page = f.git('show', `${f.merged}:${SQL_REFERENCE}`);
  expect(f.git('show', `${f.reviewed}:${SQL_REFERENCE}`)).toContain(SQL_HEADING);
  expect(page).toContain(MAIN_SQL_HEADING);
  expect(page).toContain('/packages/platform/sql/20990101010000_landing_fixture.sql)');
  expect(page).toContain('/packages/platform/sql/20990101020000_landing_fixture.sql)');
  expect(await f.proof()).toMatchObject({ kind: 'derived', derived: true });
  expect(f.git('show', '-s', '--format=%B', f.merged)).toContain('Signed-off-by: Fixture <fixture@example.invalid>');
  expect(f.git('show', '-s', '--format=%an <%ae>%n%cn <%ce>', f.merged)).toBe('Fixture <fixture@example.invalid>\nFixture <fixture@example.invalid>');
}, 50000);

it('lands owner-exact reports and settings from parents with zero carrier edits', async () => {
  try {
    f.checkout(f.base); f.probeExport(); f.probeSetting(); const left = f.commit();
    f.checkout(f.base); const right = f.commit(); f.setMain(right); f.checkout(left);
    expect(f.git('merge-base', left, right)).toBe(f.base);
    for (const parent of [left, right]) {
      expect(f.git('diff', '--raw', f.base, parent, '--', 'packages/core/api', 'packages/outbox/api', 'packages/platform/api', ...PROBE_OUTPUTS)).toBe('');
    }
    expect(f.landingCli()).toContain(`carrier toolchain: Node ${process.versions.node}, npm ${f.fixtureNpm('--version').trim()}, ICU ${process.versions.icu}`);
    const landed = f.git('rev-parse', 'HEAD');
    expect(f.git('show', '-s', '--format=%P%n%B', landed)).toBe(`${left} ${right}\nMerge origin/main and refresh derived carriers\n\nSigned-off-by: Fixture <fixture@example.invalid>`);
    expect(f.git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const integration = await proveReviewIntegration(f.root,
      await captureCommittedReviewCandidate(f.root, f.base, left), await captureCommittedReviewCandidate(f.root, right, landed));
    expect(f.git('diff', '--raw', left, landed, '--', 'packages/core/api', 'packages/outbox')).toBe('');
    const changed = PROBE_OUTPUTS.filter(path => path !== SETTING_REFUSALS).sort();
    expect(integration).toMatchObject({ kind: 'derived', derived: true });
    expect(integration.resolution).toBeUndefined();
    const historical = await proveReviewIntegration(f.root,
      await captureCommittedReviewCandidate(f.root, f.base, left), await captureCommittedReviewCandidate(f.root, right, landed),
      false, { resolvedOwnerOutputs: changed });
    expect(historical).toMatchObject({ kind: 'resolution', resolution: changed, modeChanged: false });
    expect(f.read(PORTABILITY_REPORT)).toContain('declare const fixturePortability = 1');
    expect(f.read(SETTING_GUIDE)).toContain(`## ${PROBE_KEY}`);
    expect(f.git('show', `${f.base}:${SETTING_REFUSALS}`)).toBe(f.read(SETTING_REFUSALS).trimEnd());
    const discovery = JSON.parse(f.fixtureCommand(process.execPath, ['packages/platform/src/lifecycle/openlup.mjs', 'settings', 'show', PROBE_KEY, '--json']));
    expect(discovery.setting).toMatchObject({ key: PROBE_KEY, kind: 'invariant' });
    // Landing's cold declarations still match this source tree. Rerun both renderers.
    f.fixtureCommand(process.execPath, ['packages/platform/scripts/api-contract.ts', '--update']);
    f.fixtureCommand(process.execPath, ['scripts/settings-catalogue.ts', '--write']);
    expect(f.git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const fast = spawnSync(process.execPath, [npmCli, 'run', 'preflight', '--', '--fast'], {
      cwd: f.root, env: fixtureEnvironment, encoding: 'utf8', timeout: 300000,
    });
    expect(fast.status, fast.stdout + fast.stderr).toBe(0);
    expect(JSON.parse(fast.stdout.trimEnd().split('\n').at(-1)!)).toEqual({ preflight: 'fast', result: 'pass', head: landed, failed: [] });
    console.info(`D3 landing: fork ${f.base}, parents ${left} ${right}, merge ${landed}; derived ${changed.join(', ')}; settings refusals already match`);
  } finally { f.restoreDerivedFixture(); }
}, 360000);

it('leaves the merge in place when both sides edit the SQL reference prose', async () => {
  f.git('reset', '--hard', f.reviewed); f.git('checkout', '-q', '--detach', f.reviewed);
  try {
    f.write(SQL_REFERENCE, f.read(SQL_REFERENCE).replace(SQL_HEADING, '# Reviewed SQL catalogue'));
    const left = f.commit();
    await expect(landingMerge(f.root)).rejects.toThrow(`landing: authored conflicts remain: ${SQL_REFERENCE}`);
    expect(f.git('rev-parse', 'HEAD')).toBe(left);
    expect(f.git('rev-parse', 'MERGE_HEAD')).toBe(f.main);
    expect(f.git('diff', '--name-only', '--diff-filter=U')).toContain(SQL_REFERENCE);
    expect(f.read(SQL_REFERENCE)).toContain('# Reviewed SQL catalogue');
    expect(f.read(SQL_REFERENCE)).toContain(MAIN_SQL_HEADING);
  } finally { f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged); }
}, 50000);

it('refuses a non-SQL generated region on the SQL reference', () => {
  f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged);
  try {
    f.write(SQL_REFERENCE, f.read(SQL_REFERENCE).replaceAll('generated:sql:platform', 'generated:exports:platform'));
    expect(() => runLandingGenerators(f.root, f.git('ls-files', '-z').split('\0').filter(Boolean)))
      .toThrow(`${SQL_REFERENCE}: unknown generated region exports:platform`);
  } finally { f.git('reset', '--hard', f.merged); }
}, 50_000);

it('keeps a package command that main added after the reviewed head forked', () => {
  const names = (revision: string) => JSON.parse(f.git('show', `${revision}:${CATALOGUE}`)).packageCommands.map(({ name }: { name: string }) => name);
  expect(names(f.reviewed)).not.toContain('fixture:landing');
  expect(names(f.main)).toContain('fixture:landing');
  const landed = JSON.parse(f.git('show', `${f.merged}:${CATALOGUE}`));
  const upstream = JSON.parse(f.git('show', `${f.main}:${CATALOGUE}`));
  expect(landed.packageCommands).toEqual(upstream.packageCommands);
  expect(landed.publicPaths.map((row: { path: string }) => row.path)).not.toContain('packages/platform/sql/20990101010000_landing_fixture.sql');
  expect(landed.publicPaths.map((row: { path: string }) => row.path)).not.toContain('packages/platform/sql/20990101020000_landing_fixture.sql');
  expect(f.git('ls-tree', '-r', '--name-only', f.merged, '--', 'packages/platform/sql/')).toContain('packages/platform/sql/20990101010000_landing_fixture.sql');
  expect(f.git('ls-tree', '-r', '--name-only', f.merged, '--', 'packages/platform/sql/')).toContain('packages/platform/sql/20990101020000_landing_fixture.sql');
});

it('regenerates stale package command metadata when the trusted owner is unchanged', () => {
  try {
    f.checkout(f.reviewed);
    const catalog = JSON.parse(f.read(CATALOGUE));
    const expected = catalog.packageCommands;
    catalog.packageCommands = [];
    f.write(CATALOGUE, json(catalog));
    runLandingGenerators(f.root, f.git('ls-files', '-z').split('\0').filter(Boolean));
    expect(JSON.parse(f.read(CATALOGUE)).packageCommands).toEqual(expected);
  } finally { f.restoreDerivedFixture(); }
}, 50_000); // Runs the landing generators like its sibling; 10.8 s under hosted contention.

it.each(['user.name', 'user.email'])('refuses landing before merging without configured %s', async key => {
  f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged);
  f.git('config', key, '');
  try {
    await expect(landingMerge(f.root)).rejects.toThrow(`landing: configure Git ${key} before making a personal DCO sign-off`);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.merged);
    await expect(sourceGit(f.root, 'rev-parse', '--verify', 'MERGE_HEAD')).rejects.toThrow();
  } finally { f.git('config', key, key === 'user.name' ? 'Fixture' : 'fixture@example.invalid'); }
});

it('runs incremental package build before inventory refresh when PR touches SQL', () => {
  expect(f.initialLandingResult?.inventoryRefreshed).toBe(true);
  expect(f.initialLandingCommands.map(({ args }) => args)).toEqual([
    ['--input-type=module', '-e', expect.stringContaining('assertCarrierToolchain(process.cwd())')],
    [join(f.root, 'scripts/build-packages-incremental.mjs')],
    ['--import', 'tsx', join(f.root, 'scripts/installation-inventory-refresh.ts')],
  ]);
});

it('does not auto-admit an authored SQL bystander as a generated mirror', () => {
  const rogue = 'packages/platform/sql/20990101040000_rogue.sql';
  try {
    f.checkout(f.merged);
    f.write(rogue, 'SELECT 1;\n');
    const prior = JSON.parse(f.read('packages/platform/sql/manifest.json'));
    prior.migrations.push({ file: '20260809150001_job_run_ledger_v3.sql', source: 'db/platform/migrations/20990101040000_forged.sql', sha256: '0'.repeat(64) });
    f.write('packages/platform/sql/manifest.json', json(prior));
    runLandingGenerators(f.root, f.git('ls-files', '-z').split('\0').filter(Boolean));
    const paths = JSON.parse(f.read(CATALOGUE)).publicPaths.map(({ path }: { path: string }) => path);
    expect(paths).not.toContain(rogue);
    expect(paths).toContain('packages/platform/sql/20260809150001_job_run_ledger_v3.sql');
    expect(f.read('packages/platform/sql/20260809150001_job_run_ledger_v3.sql')).toContain('CREATE OR REPLACE');
  } finally {
    rmSync(join(f.root, rogue), { force: true });
    f.restoreDerivedFixture();
  }
});

it('removes a catalogue row when a generated SQL mirror was deleted', () => {
  const stale = 'packages/platform/sql/20990101040000_stale_fixture.sql';
  try {
    f.checkout(f.merged);
    const catalog = JSON.parse(f.read(CATALOGUE));
    catalog.publicPaths.push({ path: stale, class: 'public-output' });
    catalog.publicPaths.sort((left: { path: string }, right: { path: string }) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    f.write(CATALOGUE, json(catalog));
    runLandingGenerators(f.root, f.git('ls-files', '-z').split('\0').filter(Boolean));
    expect(JSON.parse(f.read(CATALOGUE)).publicPaths.some(({ path }: { path: string }) => path === stale)).toBe(false);
  } finally { f.restoreDerivedFixture(); }
});

it('keeps a platform SQL mirror when only a supabase migration is re-slotted', () => {
  const oldPath = 'supabase/migrations/20990101040000_shared_fixture.sql';
  const target = 'supabase/migrations/20990101050000_shared_fixture.sql';
  const mirror = 'packages/platform/sql/20990101040000_shared_fixture.sql';
  try {
    f.checkout(f.merged);
    f.write(oldPath, 'SELECT 1;\n');
    f.write(mirror, 'SELECT 2;\n');
    applyMigrationReslot(f.root, [{ path: oldPath, target }]);
    expect(existsSync(join(f.root, mirror))).toBe(true);
    expect(f.read(mirror)).toBe('SELECT 2;\n');
  } finally {
    rmSync(join(f.root, oldPath), { force: true });
    rmSync(join(f.root, target), { force: true });
    rmSync(join(f.root, mirror), { force: true });
    f.restoreDerivedFixture();
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

it('deduplicates byte-for-byte identical stacked rows in migrationRegistryUnion and still refuses conflicts', () => {
  const baseManifest = f.git('show', `${f.base}:${MIGRATION_REGISTRIES[0]}`);
  const baseForwards = f.git('show', `${f.base}:${MIGRATION_REGISTRIES[1]}`);
  const inv = f.git('show', `${f.base}:${INVENTORY_PATH}`);

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
