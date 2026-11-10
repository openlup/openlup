import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, migrationRegistryUnion } from './agent-review-derived.mjs';
import { runLandingGenerators } from './agent-review-generators.mjs';
import { landingMerge } from './agent-review-landing.mjs';
import { prepareCandidate, recordReport, integrationReviewContext, verdict } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, captureCoverageEdge, validateEconomySession, proveReviewIntegration } from './agent-review-session.mjs';

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
beforeAll(async () => {
  mkdirSync('.context/scratch', { recursive: true }); root = mkdtempSync(join(source, '.context/scratch/derived-live-'));
  execFileSync('/usr/bin/git', ['clone', '--shared', '--no-hardlinks', '-q', source, root], { timeout: 30000 });
  // Include the candidate's working bytes during development as well as at final HEAD.
  const overlays = execFileSync('/usr/bin/git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of overlays) { mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(source, path), join(root, path)); }
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'));
  base = commit();
  append('20990101010000'); reviewed = commit();
  git('checkout', '-q', '--detach', base); append('20990101020000'); main = commit();
  git('update-ref', 'refs/remotes/origin/main', main); git('checkout', '-q', '--detach', reviewed);
  merged = (await landingMerge(root)).head;
}, 180000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
async function proof(head = merged) {
  return proveReviewIntegration(root, await captureCommittedReviewCandidate(root, base, reviewed), await captureCommittedReviewCandidate(root, main, head));
}
it('lands two independently appended real forwards through the CLI as derived', async () => {
  expect(await proof()).toMatchObject({ kind: 'derived', derived: true });
  expect(git('show', '-s', '--format=%B', merged)).toContain('Signed-off-by: Bart Roszkowski <dev@openlup.com>');
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
}, 60000);
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
});
it.each(['edited existing entry', 'duplicate slot'])('refuses %s at the registry union boundary', scenario => {
  const original = git('show', `${base}:${MIGRATION_REGISTRIES[1]}`), side = JSON.parse(original);
  if (scenario === 'edited existing entry') side.nativeStoreForwards[0].sha256 = 'a'.repeat(64);
  else side.nativeStoreForwards.push({ ...side.nativeStoreForwards.at(-1), path: side.nativeStoreForwards.at(-1).path.replace(/_[^/]+\.sql$/, '_duplicate.sql') });
  expect(() => migrationRegistryUnion(MIGRATION_REGISTRIES[1], original, json(side), original)).toThrow();
});
