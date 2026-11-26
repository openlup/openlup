import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, migrationRegistryUnion } from './agent-review-derived.mjs';
import { syncSqlReference } from './agent-review-generators.mjs';
import { applyMigrationReslot, assertAppendOnlyLandingSlots, assertNoAuthoredSlotReferences, landingMerge, landingSlotPlan, nextFreeMigrationSlot } from './agent-review-landing.mjs';
import { admit, coverageRequirement, deltaFloor, digest, prepareCandidate, receiptSummary, recordReport, integrationReviewContext, verdict } from './agent-review-decide.mjs';
import { parseReceipt } from './agent-review-queue.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, captureCoverageEdge, validateEconomySession, proveReviewIntegration, git as sourceGit } from './agent-review-session.mjs';
import { renderDocumentationSourceMap } from './documentation-navigation.ts';
import { readDocumentationState } from './documentation-routing.ts';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import { evaluatePlatformMigrationManifestMetadata } from './platform-migration-manifest.ts';
import {
  CATALOGUE,
  PORTABILITY,
  PORTABILITY_REPORT,
  SQL_REFERENCE,
  createDerivedFixture,
  fixtureEnvironment,
  json,
  npmCli,
  type DerivedFixture,
} from './fixtures/agent-review-derived-fixture.ts';

let f: DerivedFixture;

beforeAll(async () => {
  vi.stubEnv('npm_execpath', npmCli);
  f = await createDerivedFixture({ runInitialLanding: true, stubNpmEnv: false });
}, 180000);

afterAll(() => {
  vi.unstubAllEnvs();
  f?.cleanup();
});

describe('integration proof on a compact Git history', () => {
  let full: { root: string; base: string; reviewed: string; main: string; merged: string };

  beforeAll(() => {
    full = { root: f.root, base: f.base, reviewed: f.reviewed, main: f.main, merged: f.merged };
    f.root = realpathSync(mkdtempSync(join(tmpdir(), 'openlup-derived-objects-')));
    execFileSync('/usr/bin/git', ['clone', '--shared', '--no-checkout', '-q', full.root, f.root], { env: fixtureEnvironment, timeout: 30000 });
    const retained = [
      INVENTORY_PATH, ...MIGRATION_REGISTRIES, CATALOGUE, SQL_REFERENCE, PORTABILITY, PORTABILITY_REPORT,
      'README.md', 'db/platform/migrations', 'packages/platform/sql', 'packages/outbox/sql',
      'packages/core/package.json', 'packages/platform/src/migrations/catalog.ts',
      'scripts/platform-migration-manifest.ts', 'scripts/agent-review-decide.mjs', 'scripts/agent-review-session.mjs',
    ];
    const sourceMap = 'docs/platform/SOURCE_MAP.md';
    const route = (id: string, selector: string) => ({ id, when: 'Fixture routing', paths: [selector], doc: 'README.md', anchor: '' });
    function project(revision: string, ...parents: string[]) {
      f.git('rm', '-rf', '--ignore-unmatch', '--', '.');
      f.git('restore', `--source=${revision}`, '--staged', '--worktree', '--', ...retained);
      // Keep the real SQL and registry objects. A small routing inventory is
      // enough to exercise trusted source-map proofs in every variant.
      f.write('src/lib/coreDomains.ts', 'export const CORE_DOMAINS = Object.freeze(["fixture"] as const);\n');
      f.write('src/domains/fixture/index.ts', 'export const fixture = 1;\n');
      f.write('config/doc-routing.json', json({ version: 2, surfaces: [route('fixture-root', '**'), route('domain-fixture', 'src/domains/fixture/**')] }));
      f.write(sourceMap, '');
      f.git('add', '-A');
      const paths = f.git('ls-files', '-z').split('\0').filter(Boolean);
      f.write(sourceMap, renderDocumentationSourceMap(readDocumentationState(f.root, paths)));
      f.git('add', '--', sourceMap);
      return f.git('commit-tree', f.git('write-tree'), ...parents.flatMap(parent => ['-p', parent]), '-m', 'Project fixture proof objects');
    }
    f.git('read-tree', '--empty');
    f.base = project(full.base);
    f.reviewed = project(full.reviewed, f.base);
    f.main = project(full.main, f.base);
    f.merged = project(full.merged, f.reviewed, f.main);
    f.checkout(f.merged);
    f.setMain(f.main);
  }, 60000);

  afterAll(() => {
    if (full) {
      if (f.root !== full.root) rmSync(f.root, { recursive: true, force: true });
      ({ root: f.root, base: f.base, reviewed: f.reviewed, main: f.main, merged: f.merged } = full);
    }
  });

  it('preserves derived substitutions around API resolutions and uses the actual report mode for the floor', async () => {
    try {
      f.checkout(f.reviewed); f.probeExport(); const left = f.commit();
      f.checkout(f.merged); f.probeExport();
      f.write(PORTABILITY_REPORT, f.read(PORTABILITY_REPORT) + '\nFixture API resolution.\n');
      f.git('add', '-A');
      const firstParent = await captureCommittedReviewCandidate(f.root, f.base, left);
      for (const { modeChanged, floor } of [{ modeChanged: false, floor: 0 }, { modeChanged: true, floor: 2 }]) {
        if (modeChanged) f.git('update-index', '--chmod=+x', PORTABILITY_REPORT);
        const head = f.git('commit-tree', f.git('write-tree'), '-p', left, '-p', f.main, '-m', 'Synthetic report resolution');
        const integration = await proveReviewIntegration(f.root, firstParent, await captureCommittedReviewCandidate(f.root, f.main, head));
        expect(integration).toMatchObject({ kind: 'resolution', derived: true, resolution: [PORTABILITY_REPORT], modeChanged });
        expect(f.git('diff', '--name-only', integration.prediction, head)).toBe(PORTABILITY_REPORT);
        expect(deltaFloor(integration.resolution, integration.modeChanged)).toBe(floor);
      }
    } finally { f.restoreDerivedFixture(); }
  }, 180000);

  it('carries reviewed coverage through the derived edge and replays its recorded identity', async () => {
    const previous = await captureCommittedReviewCandidate(f.root, f.base, f.reviewed);
    const intent = { risk: 'routine', criteria: 'Preserve independently appended forwards and all reviewed boundaries' };
    let session = prepareCandidate(null, { ...previous, rules: await captureReviewRules(f.root, previous), intent, authorSessionId: 'fixture-author' }, 1000);
    for (const reviewer of ['fixture-reviewer-one', 'fixture-reviewer-two']) session = recordReport(session, {
      reviewer, cold: true, verdict: 'PASS', tree: previous.tree, findings: [], closes: [], documentation: 'Checked the fixture contract and contributor guidance.',
    }, 1000);
    const current = await captureCommittedReviewCandidate(f.root, f.main, f.merged);
    const observed = { ...current, rules: await captureReviewRules(f.root, current), intent, authorSessionId: 'fixture-author' };
    const integration = integrationReviewContext(session, observed, { parents: [f.reviewed, f.main], baseAncestor: true }, 1001);
    const coverage = await captureCoverageEdge(f.root, session, observed, 1001);
    expect(coverage?.proof.kind).toBe('portable-derived');
    session = prepareCandidate(session, { ...observed, integration, coverage }, 1001);
    expect(verdict(session, current, 1001).ok).toBe(true);
    await validateEconomySession(f.root, session);
  // Two full-tree generator passes plus receipt replay exceeded the 10 s unit default.
  }, 90000);

  it.each(['historical byte', 'edited existing entry', 'duplicate slot', 'wrong generator bytes', 'missing SQL reference row', 'other byte', 'SQL byte', 'wrong lineage'])('refuses %s on live Git objects', async scenario => {
    f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged);
    if (scenario === 'historical byte') f.write(INVENTORY_PATH, f.read(INVENTORY_PATH).replace('"historical": {}', '"historical": { }'));
    if (scenario === 'edited existing entry') {
      const path = MIGRATION_REGISTRIES[1], data = JSON.parse(f.read(path)); data.nativeStoreForwards[0].sha256 = 'a'.repeat(64); f.write(path, json(data));
    }
    if (scenario === 'duplicate slot') {
      const path = MIGRATION_REGISTRIES[1], data = JSON.parse(f.read(path)); data.nativeStoreForwardClass.slots.push(data.nativeStoreForwardClass.slots.at(-1)); f.write(path, json(data));
    }
    if (scenario === 'wrong generator bytes') f.write('packages/platform/sql/manifest.json', f.read('packages/platform/sql/manifest.json') + ' ');
    if (scenario === 'missing SQL reference row') {
      f.write(SQL_REFERENCE, f.read(SQL_REFERENCE).split('\n').filter(line => !line.startsWith('| [`20990101010000_landing_fixture.sql`]')).join('\n'));
    }
    if (scenario === 'other byte') f.write('README.md', f.read('README.md') + '\nUnexpected edit\n');
    if (scenario === 'SQL byte') f.write('db/platform/migrations/20990101010000_landing_fixture.sql', 'SELECT 2;\n');
    f.git('add', '-A'); const tree = f.git('write-tree');
    const args = scenario === 'wrong lineage' ? ['-p', f.reviewed] : ['-p', f.reviewed, '-p', f.main];
    const head = f.git('commit-tree', tree, ...args, '-m', 'Synthetic refusal');
    if (scenario === 'wrong lineage') await expect(f.proof(head)).rejects.toThrow('integration parents differ');
    else {
      const decision = await f.proof(head);
      expect(decision.kind).toBe('resolution');
      if (scenario === 'missing SQL reference row') {
        expect(decision.derived).toBeUndefined();
        expect(decision.resolution).toContain(SQL_REFERENCE);
      }
    }
  }, 50000);

  it.each(['edited existing entry', 'duplicate slot'])('refuses %s at the registry union boundary', scenario => {
    const original = f.git('show', `${f.base}:${MIGRATION_REGISTRIES[1]}`), side = JSON.parse(original);
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
      const original = await sourceGit(f.root, 'show', `${path === SQL_REFERENCE ? f.merged : f.base}:${path}`);
      f.git('reset', '--hard', f.reviewed); f.git('checkout', '-q', '--detach', f.reviewed);
      f.write(path, 'Reviewed carrier variant\n' + original); const left = f.commit();
      f.git('reset', '--hard', f.main); f.git('checkout', '-q', '--detach', f.main);
      f.write(path, 'Main carrier variant\n' + original); const right = f.commit();
      f.git('update-ref', 'refs/remotes/origin/main', right);
      let prediction: string | undefined;
      try { await sourceGit(f.root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right); }
      catch (error) {
        const gitError = error as { code: number; stdout: string };
        expect(gitError.code).toBe(1);
        const [tree, ...conflicts] = gitError.stdout.split('\0'); prediction = tree;
        expect(conflicts).toContain(path);
      }
      expect(prediction).toMatch(/^[a-f0-9]{40}$/);
      const markers = await sourceGit(f.root, 'show', `${prediction}:${path}`);
      expect(markers).toContain('<<<<<<<');
      if (path === SQL_REFERENCE) {
        expect(markers).toMatch(/^<<<<<<< .+\nReviewed carrier variant\n/mu);
        const regions = '<!-- generated:sql:outbox -->';
        expect(markers.slice(markers.indexOf(regions))).toBe(original.slice(original.indexOf(regions)));
      }
      // Keep the correct measured inventory and exact registry unions from the
      // successful landing, changing only the selected carrier to Git's raw blob.
      f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged);
      const inventory = f.read(INVENTORY_PATH);
      expect(inventory).not.toBe(await sourceGit(f.root, 'show', `${left}:${INVENTORY_PATH}`));
      for (const registry of MIGRATION_REGISTRIES) {
        const inputs = await Promise.all([f.base, left, right].map(revision => sourceGit(f.root, 'show', `${revision}:${registry}`)));
        expect(f.read(registry)).toBe(migrationRegistryUnion(registry, inputs[0], inputs[1], inputs[2], inventory));
      }
      if (unresolved) f.write(path, markers);
      f.git('add', '-A'); const tree = f.git('write-tree');
      const changed = (await captureCommittedReviewCandidate(f.root, prediction, tree)).changedPaths;
      if (unresolved) expect(changed).not.toContain(path);
      else expect(changed).toContain(path);
      const head = f.git('commit-tree', tree, '-p', left, '-p', right, '-m', 'Synthetic conflicting carrier');
      const result = proveReviewIntegration(f.root, await captureCommittedReviewCandidate(f.root, f.base, left), await captureCommittedReviewCandidate(f.root, right, head));
      if (expected === 'refusal') await expect(result).rejects.toThrow('integration commits a conflict without resolving it');
      else {
        const decision = await result;
        expect(decision.kind).toBe(expected);
        if (expected === 'resolution') expect(decision.resolution).toContain(path);
      }
    } finally {
      f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged);
      f.git('update-ref', 'refs/remotes/origin/main', f.main);
    }
  }, 50000);
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
  ], mainPaths)).toThrow('migration slots: ambiguous draft version');
  expect(() => assertAppendOnlyLandingSlots(['supabase/migrations/20990101010000_pr.sql'], mainPaths))
    .toThrow('landing: migration slot is not strictly later than origin/main');

  try {
    f.git('checkout', '-q', '--detach', f.base);
    f.append('20990101010000');
    const invertedPr = f.commit();
    f.git('checkout', '-q', '--detach', f.base);
    f.append('20990101020000');
    const aheadMain = f.commit();
    f.setMain(aheadMain);
    f.git('checkout', '-q', '--detach', invertedPr);
    const invoked: string[][] = [];
    await expect(landingMerge(f.root, {
      runCommand: (_command, args) => { invoked.push(args); },
    })).rejects.toThrow('landing: migration slot is not strictly later than origin/main');
    expect(invoked).toEqual([]);
    expect(f.git('status', '--porcelain=v1')).toBe('');
    expect(existsSync(join(f.root, '.git/MERGE_HEAD'))).toBe(false);

    // Stacked PR whose predecessor migration squash-merged byte-identically onto origin/main must not be falsely refused.
    f.git('checkout', '-q', '--detach', f.base);
    f.append('20990101010000');
    f.write('README.md', `${f.read('README.md')}\n<!-- stacked-child -->\n`);
    const stackedChild = f.commit();
    f.git('checkout', '-q', '--detach', f.base);
    f.append('20990101010000');
    const squashMergedMain = f.commit();
    f.setMain(squashMergedMain);
    f.git('checkout', '-q', '--detach', stackedChild);
    const stackedInvoked: string[][] = [];
    const stackedLanded = await landingMerge(f.root, {
      runCommand: (_command, args) => { stackedInvoked.push(args); },
    });
    expect(stackedLanded.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(stackedInvoked.length).toBeGreaterThan(0);
    expect(f.git('status', '--porcelain=v1')).toBe('');
  } finally {
    f.git('reset', '--hard', f.merged);
    f.git('checkout', '-q', '--detach', f.merged);
    f.setMain(f.main);
  }
}, 60_000);

it('plans shared migration slots across rails and UTC rollover', () => {
  expect(nextFreeMigrationSlot('20261231235959')).toBe('20270101000000');
  expect(nextFreeMigrationSlot('20261231235942')).toBe('20261231235943');
  expect(landingSlotPlan(['db/platform/migrations/20270101000000_pr.sql'], [
    'supabase/migrations/qa_20270101010000_main.sql',
  ])).toMatchObject({ maxMainSlot: '20270101010000', nextFreeSlot: '20270101010001',
    changes: [{ path: 'db/platform/migrations/20270101000000_pr.sql', target: 'db/platform/migrations/20270101010001_pr.sql' }] });
  expect(landingSlotPlan([
    'db/platform/migrations/20270101000000_old.sql',
    'db/platform/migrations/20270101010100_new.sql',
  ], ['supabase/migrations/20270101010000_main.sql'])).toMatchObject({
    nextFreeSlot: '20270101010001',
    changes: [{ target: 'db/platform/migrations/20270101010001_old.sql' }],
  });
});

it('refuses authored migration filenames before re-slot changes the tree', async () => {
  try {
    f.checkout(f.base);
    f.append('20990101010000');
    f.write('scripts/fixture-reference.test.ts', 'const migration = "20990101010000_landing_fixture.sql";\n');
    const other = 'db/platform/migrations/20990101020000_other.sql';
    f.write(other, "SELECT '20990101010000_landing_fixture.sql';\n");
    const head = f.commit();
    const changes = [{ path: 'db/platform/migrations/20990101010000_landing_fixture.sql',
      target: 'db/platform/migrations/20990101030100_landing_fixture.sql' },
    { path: other, target: 'db/platform/migrations/20990101030200_other.sql' }];
    await expect(assertNoAuthoredSlotReferences(f.root, f.base, head, changes))
      .rejects.toThrow(`${other}:1 (20990101010000), scripts/fixture-reference.test.ts:1 (20990101010000)`);
    expect(f.git('status', '--porcelain=v1')).toBe('');
  } finally { f.restoreDerivedFixture(); }
});

it('re-slots migration paths in the manifest, reviewed forwards and publication catalogue', () => {
  try {
    f.checkout(f.base);
    f.append('20990101010000');
    const oldPath = 'db/platform/migrations/20990101010000_landing_fixture.sql';
    const newPath = 'db/platform/migrations/20990101030100_landing_fixture.sql';
    const oldSupabase = 'supabase/migrations/20990101010000_landing_fixture.sql';
    const newSupabase = 'supabase/migrations/20990101030200_landing_fixture.sql';
    f.write(oldSupabase, 'SELECT 1;\n');
    const catalog = JSON.parse(f.read(CATALOGUE));
    catalog.publicPaths.push({ path: oldSupabase, class: 'public-output' });
    catalog.publicPaths.sort((left: { path: string }, right: { path: string }) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    f.write(CATALOGUE, json(catalog));
    applyMigrationReslot(f.root, [{ path: oldPath, target: newPath }, { path: oldSupabase, target: newSupabase }]);
    expect(existsSync(join(f.root, oldPath))).toBe(false);
    expect(existsSync(join(f.root, newPath))).toBe(true);
    expect(existsSync(join(f.root, oldSupabase))).toBe(false);
    expect(existsSync(join(f.root, newSupabase))).toBe(true);
    expect(f.read(MIGRATION_REGISTRIES[0])).toContain(newPath);
    expect(f.read(MIGRATION_REGISTRIES[1])).toContain(newPath);
    expect(f.read(MIGRATION_REGISTRIES[0])).not.toContain(oldPath);
    expect(f.read(MIGRATION_REGISTRIES[1])).not.toContain(oldPath);
    const rows = JSON.parse(f.read(CATALOGUE)).publicPaths.map(({ path }: { path: string }) => path);
    expect(rows).toContain(newSupabase);
    expect(rows).not.toContain(oldSupabase);
    expect(rows).not.toContain(newPath);
    expect(rows).toEqual([...rows].sort());
  } finally { f.restoreDerivedFixture(); }
});

it('lands an inverted migration only with explicit re-slot', async () => {
  const f = await createDerivedFixture({ runInitialLanding: false, stubNpmEnv: false });
  const ignoredMirror = 'packages/platform/sql/20990101020002_landing_fixture.sql';
  try {
    const exclude = f.read('.git/info/exclude');
    f.checkout(f.base);
    f.append('20990101010000');
    f.append('20990101020001');
    f.append('20990101020100');
    const pr = f.commit();
    f.checkout(f.base);
    f.append('20990101020000');
    const upstream = f.commit();
    f.setMain(upstream);
    f.checkout(pr);
    const original = 'db/platform/migrations/20990101010000_landing_fixture.sql';
    const reslotted = 'db/platform/migrations/20990101020002_landing_fixture.sql';
    const originalSql = f.read(original);
    f.write('.git/info/exclude', exclude + `\n/${ignoredMirror}\n`);
    f.write(ignoredMirror, 'Local ignored SQL.\n');
    await expect(landingMerge(f.root, { reSlot: true, runCommand: f.fixtureCommand }))
      .rejects.toThrow(`landing: re-slot refuses to overwrite untracked mirror: ${ignoredMirror}`);
    f.expectRestoredHead(pr);
    expect(f.read(ignoredMirror)).toBe('Local ignored SQL.\n');
    rmSync(join(f.root, ignoredMirror));
    await expect(landingMerge(f.root, { reSlot: true, runCommand: f.fixtureCommand }))
      .rejects.toThrow(`landing: re-slot destination mirror is ignored: ${ignoredMirror}`);
    f.expectRestoredHead(pr);
    f.write('.git/info/exclude', exclude);
    const failure = new Error('inventory refresh failed after re-slot');
    await expect(landingMerge(f.root, { reSlot: true, runCommand: (command, args) => {
      if (args.includes(join(f.root, 'scripts/installation-inventory-refresh.ts'))) {
        expect(f.read(reslotted)).toBe(originalSql);
        throw failure;
      }
      f.fixtureCommand(command, args);
    } })).rejects.toBe(failure);
    f.expectRestoredHead(pr);
    expect(f.read(original)).toBe(originalSql);
    expect(existsSync(join(f.root, reslotted))).toBe(false);
    const result = await landingMerge(f.root, { reSlot: true, runCommand: (command, args) => {
      if (args.includes(join(f.root, 'scripts/installation-inventory-refresh.ts'))) return;
      f.fixtureCommand(command, args);
    } });
    expect(result.head).toMatch(/^[a-f0-9]{40}$/u);
    expect(f.git('ls-files', 'db/platform/migrations/20990101020002_landing_fixture.sql')).toContain('20990101020002');
    expect(f.git('show', `HEAD:${ignoredMirror}`)).toBe(originalSql.trim());
    expect(f.git('ls-files', 'db/platform/migrations/20990101010000_landing_fixture.sql')).toBe('');
    const manifest = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
    const earlier = 'db/platform/migrations/20990101020000_landing_fixture.sql';
    const later = 'db/platform/migrations/20990101020002_landing_fixture.sql';
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      const files = plan.forward.map(({ file }: { file: string }) => file);
      expect(files.slice(files.indexOf(earlier))).toEqual([
        earlier, later, 'db/platform/migrations/20990101020003_landing_fixture.sql',
        'db/platform/migrations/20990101020100_landing_fixture.sql',
      ]);
    }
    const registry = JSON.parse(f.read(MIGRATION_REGISTRIES[1]));
    const slots = registry.nativeStoreForwardClass.slots.map(({ path }: { path: string }) => path);
    expect(slots.indexOf(later)).toBeGreaterThan(slots.indexOf(earlier));
    expect(evaluatePlatformMigrationManifestMetadata(manifest)).toEqual([]);
    // Byte-identical re-slot with owner-regenerated carriers proves as derived (floor 0).
    const derivedProof = await proveReviewIntegration(f.root,
      await captureCommittedReviewCandidate(f.root, f.base, pr),
      await captureCommittedReviewCandidate(f.root, f.git('rev-parse', 'origin/main'), result.head));
    expect(derivedProof.resolution).toBeUndefined();
    expect(derivedProof).toMatchObject({ kind: 'derived', derived: true });
    // Mutating even 1 byte of the reslotted SQL must fall back to reviewed resolution (floor 2).
    f.write(later, originalSql + '-- altered\n');
    f.git('add', later);
    f.git('commit', '--amend', '--no-edit', '-s');
    const tampered = f.git('rev-parse', 'HEAD');
    const tamperedProof = await proveReviewIntegration(f.root,
      await captureCommittedReviewCandidate(f.root, f.base, pr),
      await captureCommittedReviewCandidate(f.root, f.git('rev-parse', 'origin/main'), tampered));
    expect(tamperedProof.kind).toBe('resolution');
    expect(tamperedProof.resolution).toContain(later);
  } finally {
    f.cleanup();
  }
}, 120_000);

it.each([
  {
    name: 'disjoint SQL definitions stay derived (floor 0)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.main_only_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'CREATE OR REPLACE FUNCTION public.pr_only_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
    expectedOverlap: false,
  },
  {
    name: 'overlapping CREATE OR REPLACE FUNCTION forces reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.shared_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'CREATE OR REPLACE FUNCTION shared_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
    expectedOverlap: true,
  },
  {
    name: 'table mutation vs policy target forces reslotOverlap (floor 1)',
    mainSql: 'CREATE TABLE public.reslot_orders (id uuid PRIMARY KEY);\n',
    prSql: 'CREATE POLICY reslot_orders_read ON reslot_orders FOR SELECT USING (true);\n',
    expectedOverlap: true,
  },
  {
    name: 'opaque DO block in re-slotted migration forces reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'DO $$ BEGIN EXECUTE v_dynamic_sql; END $$;\n',
    expectedOverlap: true,
  },
  {
    name: 'DO EXECUTE GRANT on main-replaced function forces reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.shared_fn(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1; $$;\n',
    prSql: "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.shared_fn(int) TO service_role;'; END IF; END; $$;\n",
    expectedOverlap: true,
  },
  {
    name: 'GRANT on main-created view forces reslotOverlap (floor 1)',
    mainSql: 'CREATE VIEW public.summary_v AS SELECT 1 AS n;\n',
    prSql: 'GRANT SELECT ON public.summary_v TO authenticated;\n',
    expectedOverlap: true,
  },
  {
    name: 'REFERENCES on main-altered table forces reslotOverlap (floor 1)',
    mainSql: 'ALTER TABLE private.users ADD COLUMN active boolean DEFAULT true;\n',
    prSql: 'CREATE TABLE public.orders (id int PRIMARY KEY, user_id int REFERENCES private.users(id));\n',
    expectedOverlap: true,
  },
  {
    name: 'E-string hex escape in DO EXECUTE fails closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: "DO $$ BEGIN EXECUTE E'\\x43REATE OR REPLACE FUNCTION public.other() RETURNS int LANGUAGE sql AS $b$ SELECT 1; $b$;'; END $$;\n",
    expectedOverlap: true,
  },
  {
    name: 'top-level SET search_path fails closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'SET search_path TO private, public; CREATE OR REPLACE FUNCTION calc() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
    expectedOverlap: true,
  },
  {
    name: 'inline CREATE SCHEMA elements fail closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'CREATE SCHEMA analytics CREATE TABLE analytics.events (id int);\n',
    expectedOverlap: true,
  },
  {
    name: 'ALTER FUNCTION RENAME TO fails closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'ALTER FUNCTION public.other_fn(int) RENAME TO moved_fn;\n',
    expectedOverlap: true,
  },
])('guards byte-identical SQL re-slots against semantic clobber: $name', async ({ mainSql, prSql, expectedOverlap }) => {
  const writeMigration = (slot: string, slug: string, sql: string) => {
    const file = `db/platform/migrations/${slot}_${slug}.sql`;
    f.write(file, sql);
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const manifest = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ file, sha256 });
    f.write(MIGRATION_REGISTRIES[0], json(manifest));
    const registry = JSON.parse(f.read(MIGRATION_REGISTRIES[1]));
    registry.nativeStoreForwardClass.slots.push({ row: `fixture-${slot}-${slug}`, path: file, replacedFunctions: [], createdFunctions: [] });
    registry.nativeStoreForwards.push({ path: file, sha256, functions: [] });
    f.write(MIGRATION_REGISTRIES[1], json(registry));
    expect(checkPlatformMigrationProjection(f.root, true)).toEqual([]);
    f.write(SQL_REFERENCE, syncSqlReference(f.root));
    return file;
  };
  try {
    f.checkout(f.base);
    const prFile = writeMigration('20990101010000', 'pr_item', prSql);
    const pr = f.commit();
    f.checkout(f.base);
    writeMigration('20990101020000', 'main_item', mainSql);
    const upstream = f.commit();
    f.setMain(upstream);
    f.checkout(pr);

    const landed = await landingMerge(f.root, { reSlot: true, runCommand: (command, args) => {
      if (args.includes(join(f.root, 'scripts/installation-inventory-refresh.ts'))) return;
      f.fixtureCommand(command, args);
    } });
    const reslottedFile = 'db/platform/migrations/20990101020001_pr_item.sql';
    const reslottedMirror = 'packages/platform/sql/20990101020001_pr_item.sql';
    expect(f.git('ls-files', prFile)).toBe('');
    expect(f.git('ls-files', reslottedFile)).toBe(reslottedFile);

    const previous = await captureCommittedReviewCandidate(f.root, f.base, pr);
    const intent = { risk: 'behavior', criteria: 'Guard overlapping re-slotted SQL migrations' };
    let session = prepareCandidate(null, { ...previous, rules: await captureReviewRules(f.root, previous), intent, authorSessionId: 'fixture-author' }, 1000);
    for (const reviewer of ['r-init-1', 'r-init-2']) {
      session = recordReport(session, {
        reviewer, cold: true, verdict: 'PASS', tree: previous.tree, findings: [], closes: [],
        documentation: 'Checked SQL forward and guidance.',
      }, 1000);
    }
    const current = await captureCommittedReviewCandidate(f.root, upstream, landed.head);
    const observed = { ...current, rules: await captureReviewRules(f.root, current), intent, authorSessionId: 'fixture-author' };
    const integration = integrationReviewContext(session, observed, { parents: [pr, upstream], baseAncestor: true }, 1001);
    const coverage = await captureCoverageEdge(f.root, session, observed, 1001);
    expect(coverage).toBeDefined();
    session = prepareCandidate(session, { ...observed, integration, coverage }, 1001);

    if (!expectedOverlap) {
      expect(coverage!.proof).toMatchObject({ kind: 'portable-derived', derived: true });
      expect(coverage!.proof.reslotOverlap).toBeUndefined();
      expect(coverageRequirement(session).floor).toBe(0);
      expect(verdict(session, current, 1001)).toEqual({ ok: true, code: 'reviewed', reason: 'reviewed' });
    } else {
      expect(coverage!.proof).toMatchObject({
        kind: 'portable-resolution',
        derived: true,
        reslotOverlap: true,
        modeChanged: false,
      });
      expect(coverage!.proof.resolution).toEqual([reslottedFile, reslottedMirror].sort());
      expect(coverageRequirement(session).floor).toBe(1);
      expect(verdict(session, current, 1001)).toMatchObject({ ok: false, code: 'needs_agent_review', reason: 'needs_agent_review: 1 independent PASS reports required' });

      session = recordReport(session, {
        reviewer: 'r-overlap-check', cold: true, verdict: 'PASS', tree: current.tree,
        ordinary: true, delta: coverage!.delta, findings: [], closes: [],
        documentation: 'Verified re-slotted SQL does not clobber upstream migration.',
      }, 1002);
      expect(verdict(session, current, 1002)).toEqual({ ok: true, code: 'reviewed', reason: 'reviewed' });
      await expect(validateEconomySession(f.root, session)).resolves.toBeUndefined();
      const summary = receiptSummary(session, 12, 1002);
      expect(admit({ receipt: summary, observed: { ...current, pr: 12, baseValid: true }, now: 1002 })).toEqual({
        ok: true, code: 'reviewed', reason: 'reviewed',
      });
    }
  } finally {
    f.git('reset', '--hard', f.merged);
    f.git('clean', '-fd', '--', 'db/platform/migrations', 'packages/platform/sql');
    f.git('checkout', '-q', '--detach', f.merged);
    f.setMain(f.main);
  }
}, 90_000);

it('preserves pre-PR-4 derived re-slot replay when RESLOT_OVERLAP_GUARD is absent on main', async () => {
  const writeMigration = (slot: string, slug: string, sql: string) => {
    const file = `db/platform/migrations/${slot}_${slug}.sql`;
    f.write(file, sql);
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const manifest = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ file, sha256 });
    f.write(MIGRATION_REGISTRIES[0], json(manifest));
    const registry = JSON.parse(f.read(MIGRATION_REGISTRIES[1]));
    registry.nativeStoreForwardClass.slots.push({ row: `fixture-${slot}-${slug}`, path: file, replacedFunctions: [], createdFunctions: [] });
    registry.nativeStoreForwards.push({ path: file, sha256, functions: [] });
    f.write(MIGRATION_REGISTRIES[1], json(registry));
    expect(checkPlatformMigrationProjection(f.root, true)).toEqual([]);
    f.write(SQL_REFERENCE, syncSqlReference(f.root));
    return file;
  };
  try {
    f.checkout(f.base);
    const sessionSource = f.read('scripts/agent-review-session.mjs')
      .replace("const RESLOT_OVERLAP_GUARD = 'openlup-reslot-overlap-20261126';", '// pre-PR-4 session without reslot overlap guard');
    f.write('scripts/agent-review-session.mjs', sessionSource);
    const preGuardBase = f.commit();

    writeMigration('20990101010000', 'pr_grant', "DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.reslot_tbl TO anon;'; END $$;\n");
    const pr = f.commit();
    f.checkout(preGuardBase);
    writeMigration('20990101020000', 'main_tbl', 'CREATE TABLE public.reslot_tbl (id int);\n');
    const upstream = f.commit();
    f.setMain(upstream);
    f.checkout(pr);

    const landed = await landingMerge(f.root, { reSlot: true, runCommand: (command, args) => {
      if (args.includes(join(f.root, 'scripts/installation-inventory-refresh.ts'))) return;
      f.fixtureCommand(command, args);
    } });

    const previous = await captureCommittedReviewCandidate(f.root, preGuardBase, pr);
    const intent = { risk: 'behavior', criteria: 'Replay pre-PR-4 derived re-slot without reslotOverlap' };
    let session = prepareCandidate(null, { ...previous, rules: await captureReviewRules(f.root, previous), intent, authorSessionId: 'fixture-author' }, 1000);
    for (const reviewer of ['pre-r1', 'pre-r2']) {
      session = recordReport(session, {
        reviewer, cold: true, verdict: 'PASS', tree: previous.tree, findings: [], closes: [],
        documentation: 'Checked pre-PR-4 migration.',
      }, 1000);
    }
    const current = await captureCommittedReviewCandidate(f.root, upstream, landed.head);
    const observed = { ...current, rules: await captureReviewRules(f.root, current), intent, authorSessionId: 'fixture-author' };
    const integration = integrationReviewContext(session, observed, { parents: [pr, upstream], baseAncestor: true }, 1001);
    const coverage = await captureCoverageEdge(f.root, session, observed, 1001);
    expect(coverage?.proof).toMatchObject({ kind: 'portable-derived', derived: true });
    expect(coverage?.proof.reslotOverlap).toBeUndefined();
    session = prepareCandidate(session, { ...observed, integration, coverage }, 1001);
    expect(coverageRequirement(session).floor).toBe(0);
    await expect(validateEconomySession(f.root, session)).resolves.toBeUndefined();
  } finally {
    f.git('reset', '--hard', f.merged);
    f.git('clean', '-fd', '--', 'db/platform/migrations', 'packages/platform/sql');
    f.git('checkout', '-q', '--detach', f.merged);
    f.setMain(f.main);
  }
}, 90_000);

it('keeps both SQL forwards when main added the same migration filename', async () => {
  const oldPath = 'db/platform/migrations/20990101010000_landing_fixture.sql';
  const target = 'db/platform/migrations/20990101010001_landing_fixture.sql';
  const mainSql = '-- Distinct main forward\nSELECT 2;\n';
  try {
    f.checkout(f.base);
    f.append('20990101010000');
    const prSql = f.read(oldPath);
    const pr = f.commit();
    f.checkout(f.base);
    f.append('20990101010000');
    f.write(oldPath, mainSql);
    const sha = createHash('sha256').update(mainSql).digest('hex');
    const manifest = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      plan.forward.find((row: { file: string }) => row.file === oldPath).sha256 = sha;
    }
    f.write(MIGRATION_REGISTRIES[0], json(manifest));
    const forwards = JSON.parse(f.read(MIGRATION_REGISTRIES[1]));
    forwards.nativeStoreForwards.find((row: { path: string }) => row.path === oldPath).sha256 = sha;
    f.write(MIGRATION_REGISTRIES[1], json(forwards));
    const upstream = f.commit();
    f.setMain(upstream); f.checkout(pr);
    const result = await landingMerge(f.root, { reSlot: true, runCommand: (command, args) => {
      if (args.includes(join(f.root, 'scripts/installation-inventory-refresh.ts'))) return;
      f.fixtureCommand(command, args);
    } });
    expect(result.head).toMatch(/^[a-f0-9]{40}$/u);
    expect(f.read(oldPath)).toBe(mainSql);
    expect(f.read(target)).toBe(prSql);
    const landed = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
    expect(landed.forward.map((row: { file: string }) => row.file)).toEqual(expect.arrayContaining([oldPath, target]));
    expect(JSON.parse(f.read(MIGRATION_REGISTRIES[1])).nativeStoreForwards.map((row: { path: string }) => row.path))
      .toEqual(expect.arrayContaining([oldPath, target]));
    expect(checkPlatformMigrationProjection(f.root, false)).toEqual([]);
    expect(f.git('status', '--porcelain=v1')).toBe('');
    expect(f.git('show', '-s', '--format=%B', result.head)).toContain('Signed-off-by: Fixture <fixture@example.invalid>');
    const integration = await proveReviewIntegration(f.root,
      await captureCommittedReviewCandidate(f.root, f.base, pr),
      await captureCommittedReviewCandidate(f.root, upstream, result.head));
    expect(integration.kind).toBe('resolution');
    expect(integration.resolution).toContain(target);
  } finally { f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged); f.setMain(f.main); }
}, 90_000);

it.each(['clean', 'derived-carrier'])('skips Docker inventory refresh on non-SQL PR (%s) even when main changed SQL and inventory', async mode => {
  expect(process.env.npm_execpath).toBe(npmCli);
  try {
    // Build a main commit that changed SQL, registries, publication catalogue, AND measured inventory.
    f.git('reset', '--hard', f.main); f.git('checkout', '-q', '--detach', f.main);
    const baseInvSource = f.read(INVENTORY_PATH);
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
    f.write(INVENTORY_PATH, invEnvelope.before + JSON.stringify(updatedCurrent, null, 2).replaceAll('\n', '\n  ') + invEnvelope.after);
    const mainManifest = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
    mainManifest.objectInventorySha256 = digests.legacy;
    mainManifest.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: digests.bootstrap }, separateMigrator: { withRestore: digests.separate } };
    mainManifest.qualifiedAdmin.objectInventorySha256 = { installerManaged: digests['admin-managed'], operatorProvisioned: digests['admin-operator'] };
    f.write(MIGRATION_REGISTRIES[0], json(mainManifest));
    const mergedGenerators = pathToFileURL(join(f.root, 'scripts/agent-review-generators.mjs')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs';
      const owners = await import(${JSON.stringify(mergedGenerators)});
      owners.runLandingGenerators(process.cwd(), readFileSync(0, 'utf8').split('\\0').filter(Boolean));`],
    { cwd: f.root, env: fixtureEnvironment, input: f.git('ls-files', '-z'), timeout: 30000 });
    const mainWithInventory = f.commit();
    f.git('update-ref', 'refs/remotes/origin/main', mainWithInventory);

    // Create a non-SQL PR forked from base (stale inventory, no SQL changes).
    f.git('reset', '--hard', f.base); f.git('checkout', '-q', '--detach', f.base);
    if (mode === 'clean') {
      f.write('README.md', f.read('README.md') + '\nNon-SQL PR note\n');
    } else {
      // Bumping core version updates generated SQL reference links without touching SQL or inventory inputs,
      // conflicting with main's appended SQL row in packages/core/docs/guide/reference/sql.md.
      const corePkg = JSON.parse(f.read('packages/core/package.json'));
      corePkg.version = `${corePkg.version}-fixture`;
      f.write('packages/core/package.json', json(corePkg));
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs';
        const owners = await import(${JSON.stringify(mergedGenerators)});
        owners.runLandingGenerators(process.cwd(), readFileSync(0, 'utf8').split('\\0').filter(Boolean));`],
      { cwd: f.root, env: fixtureEnvironment, input: f.git('ls-files', '-z'), timeout: 30000 });
    }
    const nonSqlHead = f.commit();

    const invoked: { command: string; args: string[] }[] = [];
    const landed = await landingMerge(f.root, {
      runCommand: (command, args) => {
        invoked.push({ command, args });
        expect(args).not.toContain(join(f.root, 'scripts/installation-inventory-refresh.ts'));
      },
    });
    if (mode === 'clean') expect(invoked).toEqual([{
      command: process.execPath, args: ['--input-type=module', '-e', expect.stringContaining('assertCarrierToolchain(process.cwd())')],
    }]);
    else expect(invoked.filter(({ args }) => args[0] === npmCli)).toEqual(['core', 'outbox', 'platform'].map(owner => ({
      command: process.execPath, args: [npmCli, 'run', 'build', `--workspace=@openlup/${owner}`],
    })));
    expect(landed.inventoryRefreshed).toBe(false);
    expect(f.git('show', `${landed.head}:${INVENTORY_PATH}`)).toBe(f.git('show', `${mainWithInventory}:${INVENTORY_PATH}`));
    expect(f.git('show', `${landed.head}:${INVENTORY_PATH}`)).not.toBe(f.git('show', `${nonSqlHead}:${INVENTORY_PATH}`));

    const integration = await proveReviewIntegration(
      f.root,
      await captureCommittedReviewCandidate(f.root, f.base, nonSqlHead),
      await captureCommittedReviewCandidate(f.root, mainWithInventory, landed.head),
    );
    expect(integration, JSON.stringify(integration)).toMatchObject(mode === 'clean' ? { kind: 'git' } : { kind: 'derived', derived: true });
  } finally {
    f.git('reset', '--hard', f.merged); f.git('checkout', '-q', '--detach', f.merged);
    f.git('update-ref', 'refs/remotes/origin/main', f.main);
  }
}, 180000);
