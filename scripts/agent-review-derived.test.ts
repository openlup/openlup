import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, migrationRegistryUnion } from './agent-review-derived.mjs';
import { runLandingGenerators } from './agent-review-generators.mjs';
import { landingMerge } from './agent-review-landing.mjs';
import { prepareCandidate, recordReport, integrationReviewContext, verdict } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, captureCoverageEdge, validateEconomySession, proveReviewIntegration, git as sourceGit } from './agent-review-session.mjs';

const source = process.cwd();
let root: string, base: string, reviewed: string, main: string, merged: string;
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
  mkdirSync('.context/scratch', { recursive: true }); root = mkdtempSync(join(source, '.context/scratch/derived-live-'));
  execFileSync('/usr/bin/git', ['clone', '--shared', '--no-hardlinks', '-q', source, root], { timeout: 30000 });
  // Include the candidate's working bytes during development as well as at final HEAD.
  const overlays = execFileSync('/usr/bin/git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of overlays) { mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(source, path), join(root, path)); }
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'));
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  base = commit();
  append('20990101010000'); reviewed = commit();
  git('checkout', '-q', '--detach', base); append('20990101020000'); addPackageCommand(); main = commit();
  git('update-ref', 'refs/remotes/origin/main', main); git('checkout', '-q', '--detach', reviewed);
  merged = (await landingMerge(root)).head;
}, 180000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
async function proof(head = merged) {
  return proveReviewIntegration(root, await captureCommittedReviewCandidate(root, base, reviewed), await captureCommittedReviewCandidate(root, main, head));
}
it('lands two independently appended real forwards through the CLI as derived', async () => {
  expect(await proof()).toMatchObject({ kind: 'derived', derived: true });
  expect(git('show', '-s', '--format=%B', merged)).toContain('Signed-off-by: Fixture <fixture@example.invalid>');
  expect(git('show', '-s', '--format=%an <%ae>%n%cn <%ce>', merged)).toBe('Fixture <fixture@example.invalid>\nFixture <fixture@example.invalid>');
}, 50000);
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
it.each(['historical byte', 'edited existing entry', 'duplicate slot', 'wrong generator bytes', 'other byte', 'SQL byte', 'wrong lineage'])('refuses %s on live Git objects', async scenario => {
  git('reset', '--hard', merged); git('checkout', '-q', '--detach', merged);
  if (scenario === 'historical byte') write(INVENTORY_PATH, read(INVENTORY_PATH).replace('"historical": {}', '"historical": { }'));
  if (scenario === 'edited existing entry') {
    const path = MIGRATION_REGISTRIES[1], data = JSON.parse(read(path)); data.nativeStoreForwards[0].sha256 = 'a'.repeat(64); write(path, json(data));
  }
  if (scenario === 'duplicate slot') {
    const path = MIGRATION_REGISTRIES[1], data = JSON.parse(read(path)); data.nativeStoreForwardClass.slots.push(data.nativeStoreForwardClass.slots.at(-1)); write(path, json(data));
  }
  if (scenario === 'wrong generator bytes') write('packages/platform/sql/manifest.json', read('packages/platform/sql/manifest.json') + ' ');
  if (scenario === 'other byte') write('README.md', read('README.md') + '\nUnexpected edit\n');
  if (scenario === 'SQL byte') write('db/platform/migrations/20990101010000_landing_fixture.sql', 'SELECT 2;\n');
  git('add', '-A'); const tree = git('write-tree');
  const args = scenario === 'wrong lineage' ? ['-p', reviewed] : ['-p', reviewed, '-p', main];
  const head = git('commit-tree', tree, ...args, '-m', 'Synthetic refusal');
  if (scenario === 'wrong lineage') await expect(proof(head)).rejects.toThrow('integration parents differ');
  else expect((await proof(head)).kind).toBe('resolution');
}, 50000);
it.each(['edited existing entry', 'duplicate slot'])('refuses %s at the registry union boundary', scenario => {
  const original = git('show', `${base}:${MIGRATION_REGISTRIES[1]}`), side = JSON.parse(original);
  if (scenario === 'edited existing entry') side.nativeStoreForwards[0].sha256 = 'a'.repeat(64);
  else side.nativeStoreForwards.push({ ...side.nativeStoreForwards.at(-1), path: side.nativeStoreForwards.at(-1).path.replace(/_[^/]+\.sql$/, '_duplicate.sql') });
  expect(() => migrationRegistryUnion(MIGRATION_REGISTRIES[1], original, json(side), original)).toThrow();
});

it.each([
  { path: 'packages/platform/AGENT_CONTEXT.md', unresolved: true, expected: 'refusal' },
  { path: 'packages/platform/sql/manifest.json', unresolved: true, expected: 'refusal' },
  { path: 'packages/platform/sql/00000000000000_platform_baseline.sql', unresolved: true, expected: 'refusal' },
  { path: 'packages/platform/AGENT_CONTEXT.md', unresolved: false, expected: 'derived' },
  { path: 'packages/platform/sql/00000000000000_platform_baseline.sql', unresolved: false, expected: 'resolution' },
])('requires $expected for $path with unresolved=$unresolved despite other derived carriers', async ({ path, unresolved, expected }) => {
  try {
    const original = await sourceGit(root, 'show', `${base}:${path}`);
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
