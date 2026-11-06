import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_PATHS, readRegistry, registryUnion, strictRegistryJson } from './agent-review-registry.mjs';
import { digest, coverageState, protectedCoveragePath, receiptSummary, verdict, ECONOMY_RECEIPT_MARKER } from './agent-review-decide.mjs';
import { carryOverSourceReview, captureReviewRules, captureSessionCandidate, sessionMain, validateEconomySession, git as sourceGit } from './agent-review-session.mjs';
import { parseReceipt, waitNativeAdmission } from './agent-review-queue.mjs';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const DAY = 86400000;
const RECORD = 'docs/platform/plans/demo.md';
async function fixture(enabled = true, controls: string[] = [], initialFiles: Record<string, string> = {}) {
  await mkdir('.context/scratch', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), '.context/scratch/review-economy-')); roots.push(cwd);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = async (path: string, value: string) => { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), value); };
  git('init', '-q', '-b', 'main'); await write('.gitignore', '.context/\n');
  if (enabled) await write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n');
  for (const path of REGISTRY_PATHS) await write(path, await readFile(join(process.cwd(), path), 'utf8'));
  for (const path of controls) await write(path, await readFile(join(process.cwd(), path), 'utf8'));
  for (const [path, source] of Object.entries(initialFiles)) await write(path, source);
  await write('app.ts', 'export const before = 1;\n');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit(); git('update-ref', 'refs/remotes/origin/main', base);
  await write('app.ts', 'export const before = 2;\n');
  const head = commit();
  const scratch = join(cwd, '.context/scratch'); await mkdir(scratch, { recursive: true });
  const intent = { risk: 'behavior', criteria: 'Preserve the bounded fixture outcome' };
  const request = join(scratch, 'intent.json'); await writeFile(request, JSON.stringify({ authorSessionId: 'author', intent }));
  const env: { OPENLUP_STACK_BASE?: string } = {};
  const cli = (...args: string[]) => sessionMain(args, { cwd, env });
  const state = async () => JSON.parse(await readFile(join(scratch, 'agent-review/session.json'), 'utf8'));
  let reviewer = 0;
  const report = async (patch = {}) => {
    const session = await state(); const path = join(scratch, 'report.json');
    await writeFile(path, JSON.stringify({ reviewer: `cold-${reviewer++}`, tree: session.candidate.tree, cold: true, verdict: 'PASS', findings: [], closes: [], documentation: 'Checked contributor and documentation owners; fixture claims match source.', ...patch }));
    return cli('record', path);
  };
  const review = async () => { await cli('prepare', request); await report(); await report(); return state(); };
  const mainMove = async (change: () => Promise<void>, from = base) => {
    const previous = git('rev-parse', 'HEAD'); git('checkout', '-q', '--detach', from); await change(); const main = commit();
    git('update-ref', 'refs/remotes/origin/main', main); git('checkout', '-q', '--detach', previous); return main;
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { cwd, git, write, base, head, commit, request, cli, state, report, review, mainMove, scratch, env };
}
function addRegistry(path: string, source: string, entry: string) {
  if (path === REGISTRY_PATHS[0]) {
    const data = JSON.parse(source); data.publicPaths.push({ path: entry, class: 'public-output' });
    data.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); return JSON.stringify(data, null, 2) + '\n';
  }
  const registry = readRegistry(path, source); const [start, end] = registry.ranges[0];
  const list = [...registry.lists[0], entry]; const replacement = path === REGISTRY_PATHS[1] ? JSON.stringify(list) : `[\n${list.map(value => `  ${JSON.stringify(value)},`).join('\n')}\n]`;
  return source.slice(0, start) + replacement + source.slice(end);
}

describe('closed registry grammar', () => {
  it('rejects duplicate JSON keys and unsupported syntax', () => {
    expect(() => strictRegistryJson('{"a":1,"a":2}')).toThrow('duplicate');
    expect(() => strictRegistryJson('{"a":1,}')).toThrow();
    expect(() => readRegistry(REGISTRY_PATHS[2], 'export const ADAPTER_ENTRIES = [...other] as const;')).toThrow();
  });
  it.each(['class', 'removal', 'reorder', 'duplicate', 'overlap', 'outside'])('refuses %s rather than silently normalize', async kind => {
    const path = REGISTRY_PATHS[0]; const source = await readFile(path, 'utf8');
    const a = JSON.parse(addRegistry(path, source, 'zz-a')); const b = addRegistry(path, source, 'zz-b');
    if (kind === 'class') a.publicPaths[0].class = 'entrypoint';
    if (kind === 'removal') a.publicPaths.shift();
    if (kind === 'reorder') a.publicPaths.reverse();
    if (kind === 'duplicate') a.publicPaths.push(a.publicPaths[0]);
    if (kind === 'outside') a.schemaVersion = 4;
    expect(() => registryUnion(path, source, JSON.stringify(a, null, 2) + '\n', kind === 'overlap' ? JSON.stringify(a, null, 2) + '\n' : b)).toThrow();
  });
});

describe('real Git coverage histories', () => {
  it('requires full reports for a first protected candidate and excludes partial observations from full expiry', async () => {
    const f = await fixture(); await f.write('scripts/ci-extra.mjs', 'export const guard = true;\n'); f.commit();
    const partialAt = Date.now(); const fullAt = partialAt + DAY / 2;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(partialAt);
    await f.cli('prepare', f.request); const prepared = await f.state(); expect(prepared.candidate.coverage).toBeUndefined();
    await f.report({ ordinary: true, delta: 'a'.repeat(64) }); await f.report({ ordinary: true, delta: 'b'.repeat(64) });
    const partial = await f.state();
    await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await expect(f.cli('receipt', '12')).rejects.toThrow('2 independent PASS');
    clock.mockReturnValue(fullAt); await f.report(); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report({ ordinary: false }); await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    const full = await f.state(); expect(full.candidate).toEqual(prepared.candidate);
    expect(full.history.slice(0, partial.history.length)).toEqual(partial.history);
    expect(coverageState(full)).toMatchObject({ earliest: fullAt, expires: fullAt + DAY });
    const malformed = structuredClone(full); malformed.history.find(event => event.type === 'report').report.ordinary = 'invalid';
    expect(verdict(malformed, malformed.candidate, fullAt).reason).toContain('review scope');
    clock.mockReturnValue(partialAt + DAY); await expect(f.cli('verify')).resolves.toBe(0);
  });
  it.each(['prose', 'routine'])('retains one standard full report for an initial %s candidate', async risk => {
    const f = await fixture();
    if (risk === 'prose') { await f.write('app.ts', 'export const before = 1;\n'); await f.write('docs/guide.md', 'Explain the existing example.\n'); f.commit(); }
    const request = JSON.parse(await readFile(f.request, 'utf8')); request.intent.risk = risk; await writeFile(f.request, JSON.stringify(request));
    await f.cli('prepare', f.request); await f.report();
    expect((await f.state()).candidate.coverage).toBeUndefined();
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
  });
  it('keeps the full-review route for an integration on an unlanded stack base', async () => {
    const f = await fixture(); const prior = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await f.write('predecessor.ts', 'independent predecessor\n'); const predecessor = f.commit();
    f.git('checkout', '-q', '--detach', f.head); f.git('merge', '--no-ff', '-qm', 'integrate unlanded predecessor', predecessor);
    f.env.OPENLUP_STACK_BASE = predecessor;
    expect(f.git('rev-parse', 'origin/main')).toBe(f.base);
    await f.cli('prepare', f.request); const next = await f.state();
    expect(next.candidate.base).toBe(predecessor);
    expect(next.candidate.integration).toBeUndefined(); expect(next.candidate.coverage).toBeUndefined();
    expect(next.history.slice(0, prior.history.length)).toEqual(prior.history);
    expect(next.cycle).toBe(prior.cycle + 1); expect(next.allowedCycles).toBe(prior.allowedCycles);
    await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await expect(f.cli('receipt', '12')).rejects.toThrow('2 independent PASS');
    await f.report(); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report(); await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    await expect(validateEconomySession(f.cwd, await f.state())).resolves.toBeUndefined();
  });
  it('inherits a clean disjoint merge with no new reports and retains the original expiry', async () => {
    const f = await fixture(); const prior = await f.review(); const expiry = coverageState(prior).expires;
    const main = await f.mainMove(() => f.write('other.ts', 'independent\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate main', main); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.kind).toBe('integration'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0); expect(coverageState(next).expires).toBe(expiry);
    expect(next.history.filter(event => event.type === 'report')).toHaveLength(2);
    await validateEconomySession(f.cwd, next);
  });
  it('proves a registry-only conflicting merge by the exact union of current carriers', async () => {
    const f = await fixture();
    for (const path of REGISTRY_PATHS) await f.write(path, addRegistry(path, f.git('show', `${f.base}:${path}`) + '\n', 'zz-row-a'));
    const reviewed = f.commit(); const prior = await f.review();
    const main = await f.mainMove(async () => {
      for (const path of REGISTRY_PATHS) await f.write(path, addRegistry(path, f.git('show', `${f.base}:${path}`) + '\n', 'zz-row-b'));
    });
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    for (const path of REGISTRY_PATHS) await f.write(path, registryUnion(path, f.git('show', `${f.base}:${path}`) + '\n', f.git('show', `${reviewed}:${path}`) + '\n', f.git('show', `${main}:${path}`) + '\n'));
    f.commit(); await f.cli('prepare', f.request); const next = await f.state();
    expect(next.candidate.coverage.proof.kind).toBe('registry-union'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('reviews a hand edit made in a clean merge as the resolution', async () => {
    const f = await fixture(); await f.review();
    const main = await f.mainMove(() => f.write('other.ts', 'main delta\n'));
    f.git('merge', '--no-ff', '--no-commit', main); await f.write('extra.ts', 'hand edit\n');
    f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof).toMatchObject({ kind: 'resolution', resolution: ['extra.ts'] });
    await expect(f.cli('verify')).rejects.toThrow('1 independent PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('inherits a clean merge that touches review machinery with no new review', async () => {
    const f = await fixture(); const prior = await f.review();
    const main = await f.mainMove(() => f.write('scripts/agent-review-extra.mjs', 'main delta\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate main', main); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof.kind).toBe('git'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
  });
  it.each([['app.ts', 1], ['config/demo.json', 2]])('reviews only the resolution of a conflict on %s, with floor %i', async (path, floor) => {
    const f = await fixture(true, [], { [path]: 'line one\n' });
    await f.write(path, 'reviewed line\n'); f.commit(); const prior = await f.review();
    const main = await f.mainMove(() => f.write(path, 'main line\n'));
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write(path, 'reviewed line\nmain line\n'); f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof).toMatchObject({ kind: 'resolution', resolution: [path] });
    expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).rejects.toThrow(`${floor} independent PASS`);
    for (let index = 0; index < floor; index++) await f.report({ ordinary: true, delta: next.candidate.coverage.delta });
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
    await validateEconomySession(f.cwd, await f.state());
  });
  it('carries a clean merge where main edits a registry carrier outside its arrays', async () => {
    const f = await fixture(); const prior = await f.review(); const path = REGISTRY_PATHS[2];
    const main = await f.mainMove(() => f.write(path, f.git('show', `${f.base}:${path}`) + '\n// main edit outside the arrays\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate main', main); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof.kind).toBe('git'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('takes the exact union when both sides add entries to one carrier array in conflict', async () => {
    const f = await fixture(); const path = REGISTRY_PATHS[2]; const source = f.git('show', `${f.base}:${path}`) + '\n';
    await f.write(path, addRegistry(path, source, 'zz-row-a')); f.commit(); const prior = await f.review();
    const main = await f.mainMove(() => f.write(path, addRegistry(path, source, 'zz-row-b')));
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write(path, registryUnion(path, source, f.git('show', `HEAD:${path}`) + '\n', f.git('show', `${main}:${path}`) + '\n'));
    f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof.kind).toBe('registry-union'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('reviews a carrier conflict outside its arrays as a resolution with two reviewers', async () => {
    const f = await fixture(); const path = REGISTRY_PATHS[2]; const source = f.git('show', `${f.base}:${path}`) + '\n';
    const line = (text: string) => source.replace('Cold installed-artifact proof.', text);
    await f.write(path, line('Cold installed-artifact proof, reviewed.')); f.commit(); await f.review();
    const main = await f.mainMove(() => f.write(path, line('Cold installed-artifact proof, from main.')));
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write(path, line('Cold installed-artifact proof, reviewed and from main.')); f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof).toMatchObject({ kind: 'resolution', resolution: [path] });
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
    await validateEconomySession(f.cwd, await f.state());
  });
  it('reviews an edit outside the conflicts together with the resolution', async () => {
    const f = await fixture(); await f.review();
    const main = await f.mainMove(() => f.write('app.ts', 'main line\n'));
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write('app.ts', 'resolved\n'); await f.write('other.ts', 'unrelated edit\n'); f.commit();
    await f.cli('prepare', f.request); const next = await f.state();
    expect(next.candidate.coverage.proof).toMatchObject({ kind: 'resolution', resolution: ['app.ts', 'other.ts'] });
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('refuses a merge that commits a conflict without resolving it', async () => {
    const f = await fixture(); await f.review(); const head = f.git('rev-parse', 'HEAD');
    const main = await f.mainMove(() => f.write('app.ts', 'main line\n'));
    let prediction = '';
    try { f.git('-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--name-only', '--no-messages', head, main); } catch (error) { prediction = String((error as { stdout: string }).stdout).split('\n')[0]; }
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write('app.ts', f.git('show', `${prediction}:app.ts`) + '\n'); f.commit();
    await f.cli('prepare', f.request); expect((await f.state()).candidate.coverage).toBeUndefined();
  });
  it('reviews a carrier conflict resolved by hand differently from the union, with two reviewers', async () => {
    const f = await fixture(); const path = REGISTRY_PATHS[2]; const source = f.git('show', `${f.base}:${path}`) + '\n';
    await f.write(path, addRegistry(path, source, 'zz-row-a')); f.commit(); await f.review();
    const main = await f.mainMove(() => f.write(path, addRegistry(path, source, 'zz-row-b')));
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write(path, addRegistry(path, addRegistry(path, source, 'zz-row-b'), 'zz-row-a')); f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.proof).toMatchObject({ kind: 'resolution', resolution: [path] });
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
    await validateEconomySession(f.cwd, await f.state());
  });
  it('needs one fresh ordinary-delta report for a test repair, preserving initial full coverage', async () => {
    const f = await fixture(); const prior = await f.review();
    await f.write('tests/demo.test.ts', 'test fixture\n'); f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.kind).toBe('repair');
    await expect(f.cli('verify')).rejects.toThrow('PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
    expect(coverageState(await f.state()).expires).toBe(coverageState(prior).expires);
  });
  it.each([undefined, false])('accepts two full reports with ordinary=%s for a semantically nonordinary docs repair', async ordinary => {
    const f = await fixture(); const prior = await f.review(); const original = coverageState(prior);
    const fullAt = original.earliest + DAY / 2; const clock = vi.spyOn(Date, 'now').mockReturnValue(fullAt);
    await f.write('docs/host-guide.md', 'Run the host callback only after validating the caller capability.\n'); f.commit();
    await f.cli('prepare', f.request); const prepared = await f.state();
    expect(prepared.candidate.coverage.kind).toBe('repair');
    await f.report(ordinary === undefined ? {} : { ordinary }); await expect(f.cli('verify')).rejects.toThrow();
    clock.mockReturnValue(fullAt + 1000); await f.report(ordinary === undefined ? {} : { ordinary });
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
    const reviewed = await f.state(); expect(reviewed.candidate).toEqual(prepared.candidate);
    expect(reviewed.history.slice(0, prior.history.length)).toEqual(prior.history);
    expect(reviewed.cycle).toBe(prepared.cycle); expect(reviewed.allowedCycles).toBe(prior.allowedCycles);
    expect(coverageState(reviewed)).toMatchObject({ earliest: fullAt, expires: fullAt + DAY });
    await expect(validateEconomySession(f.cwd, reviewed)).resolves.toBeUndefined();
    clock.mockReturnValue(fullAt + 30 * DAY); await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('counts only full reports when mixed with delta-only reports and uses the full-report expiry', async () => {
    const f = await fixture(); const prior = await f.review(); const origin = coverageState(prior).earliest;
    const deltaAt = origin + DAY / 4; const fullAt = origin + DAY / 2;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deltaAt);
    await f.write('docs/host-guide.md', 'Run the host callback only after validating the caller capability.\n'); f.commit();
    await f.cli('prepare', f.request); const prepared = await f.state();
    await f.report({ ordinary: true, delta: prepared.candidate.coverage.delta });
    clock.mockReturnValue(fullAt); await f.report({ ordinary: false });
    await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await expect(f.cli('receipt', '12')).rejects.toThrow('2 independent PASS');
    clock.mockReturnValue(fullAt + 1000); await f.report();
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
    expect(coverageState(await f.state())).toMatchObject({ earliest: fullAt, expires: fullAt + DAY });
  });
  it('keeps two delta-only reports as delta coverage, valid without expiry', async () => {
    const f = await fixture(); const prior = await f.review(); const original = coverageState(prior);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(original.earliest + DAY / 2);
    await f.write('docs/host-guide.md', 'Clarify the existing host example.\n'); f.commit(); await f.cli('prepare', f.request);
    const prepared = await f.state(); const patch = { ordinary: true, delta: prepared.candidate.coverage.delta };
    await f.report(patch); await f.report(patch); await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    expect(coverageState(await f.state())).toMatchObject({ earliest: original.earliest, expires: original.expires });
    clock.mockReturnValue(original.expires + 30 * DAY); await expect(f.cli('verify')).resolves.toBe(0);
  });
  it('still refuses an incorrect delta confirmation alongside two full reports', async () => {
    const f = await fixture(); await f.review();
    await f.write('docs/host-guide.md', 'Run the host callback only after validating the caller capability.\n'); f.commit();
    await f.cli('prepare', f.request); await f.report({ ordinary: true, delta: 'incorrect' });
    await f.report({ ordinary: false }); await f.report();
    await expect(f.cli('verify')).rejects.toThrow('exact delta');
    await expect(f.cli('receipt', '12')).rejects.toThrow('exact delta');
  });
  it('reviews a mixed product repair as its delta with one reviewer', async () => {
    const f = await fixture(); const prior = await f.review(); await f.write('tests/demo.test.ts', 'test\n'); await f.write('app.ts', 'product change\n'); f.commit();
    await f.cli('prepare', f.request); const next = await f.state();
    expect(next.candidate.coverage).toMatchObject({ kind: 'repair', proof: { paths: ['app.ts', 'tests/demo.test.ts'] } }); expect(next.cycle).toBe(prior.cycle + 1);
    await expect(f.cli('verify')).rejects.toThrow('1 independent PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta });
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
  });
  it.each(['scripts/agent-review-extra.mjs', 'db/platform/migrations/20990101000000_demo.sql', 'tests/postgres/nativeStoreForwardCatalog.test.ts'])('needs two delta reviewers for a repair of %s', async path => {
    const f = await fixture(); await f.review(); await f.write(path, 'repair\n'); f.commit();
    await f.cli('prepare', f.request); const next = await f.state(); expect(next.candidate.coverage.kind).toBe('repair');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
  });
  it.each(['resolution', 'repair'])('needs two delta reviewers for a %s that changes a mode', async kind => {
    const f = await fixture(); await f.review();
    if (kind === 'resolution') { const main = await f.mainMove(() => f.write('app.ts', 'main line\n')); expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow(); }
    await f.write('app.ts', 'resolved\n'); await chmod(join(f.cwd, 'app.ts'), 0o755); f.commit();
    await f.cli('prepare', f.request); const next = await f.state(); expect(next.candidate.coverage.proof).toMatchObject({ modeChanged: true });
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
    await validateEconomySession(f.cwd, await f.state());
  });
  it('does not inherit coverage with an open material card', async () => {
    const f = await fixture(); const prior = await f.review();
    await f.report({ verdict: 'FAIL', findings: [{ id: 'F1', summary: 'unclosed mechanism', material: true }] });
    await f.write(RECORD, 'ordinary prose\n'); f.commit(); await f.cli('prepare', f.request);
    expect((await f.state()).candidate.coverage).toBeUndefined();
    expect(verdict(prior, prior.candidate, coverageState(prior).expires + 30 * DAY).code).toBe('reviewed');
  });
  it('keeps evidence valid without expiry for verify, receipt and queue admission', async () => {
    const f = await fixture(); const session = await f.review();
    vi.spyOn(Date, 'now').mockReturnValue(coverageState(session).expires + 30 * DAY);
    await expect(f.cli('verify')).resolves.toBe(0); await expect(f.cli('receipt', '12')).resolves.toBe(0);
  });
  it('replays a historical renewal event without re-proving it', async () => {
    const f = await fixture(); const session = await f.review(); const state = coverageState(session); const at = state.earliest + DAY;
    // The shape the earlier renewal command recorded; it stays valid evidence after renewal was removed.
    const renewed = structuredClone(session);
    renewed.history.push({ type: 'renew', previous: digest(session.history), at, head: session.candidate.head, tree: session.candidate.tree,
      base: session.candidate.base, policy: digest(session.candidate.rules), oldExpiry: state.expires,
      expires: Math.min(at + DAY, state.earliest + 3 * DAY), proof: { main: f.base, untouched: true } });
    await validateEconomySession(f.cwd, renewed);
    expect(verdict(renewed, renewed.candidate, at + 30 * DAY).ok).toBe(true);
    const tampered = structuredClone(renewed); tampered.history.at(-1).expires += 1;
    expect(verdict(tampered, tampered.candidate, at).ok).toBe(false);
  });
  it('an enabling topic with an old base stays v2', async () => {
    const f = await fixture(false); await f.write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n'); f.commit();
    const session = await f.review(); expect(session.version).toBe(2); expect(session.candidate.rules).toBeUndefined();
    const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} }); expect(await captureReviewRules(f.cwd, candidate)).toBeUndefined();
    const reader = await import('./agent-review-queue.mjs');
    const summary = receiptSummary(session, 12, Date.now()); expect(summary).not.toHaveProperty('version');
    expect(reader.parseReceipt(`${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toBeNull();
  });
  it('replays a v2 prefix after enabling v3 with two fresh full reviews and preserves absent rules', async () => {
    const f = await fixture(false); const prior = await f.review();
    expect(prior.version).toBe(2); expect(prior.candidate).not.toHaveProperty('rules');
    const main = await f.mainMove(() => f.write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate enabled rules', main);
    await f.cli('prepare', f.request); const next = await f.state();
    expect(next.version).toBe(3); expect(next.candidate.rules.version).toBe(3);
    expect(next.history.slice(0, prior.history.length)).toEqual(prior.history);
    expect(next.history[prior.history.length]).toMatchObject({ type: 'rules', version: 3 });
    expect(next.cycle).toBe(prior.cycle); expect(next.allowedCycles).toBe(prior.allowedCycles);
    expect(next.candidate.coverage).toBeUndefined();
    await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report(); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report(); await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    const reviewed = await f.state();
    await expect(validateEconomySession(f.cwd, reviewed)).resolves.toBeUndefined();
    expect(verdict(reviewed, reviewed.candidate, Date.now()).ok).toBe(true);
    const summary = receiptSummary(reviewed, 12, Date.now());
    expect(parseReceipt(`${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toEqual(summary);
    const fabricatedLegacyRules = structuredClone(reviewed);
    fabricatedLegacyRules.history.find(event => event.type === 'prepare').candidate.rules = reviewed.candidate.rules;
    await expect(validateEconomySession(f.cwd, fabricatedLegacyRules)).rejects.toThrow('recorded policy or base rules differ');
    const missingEnabledRules = structuredClone(reviewed);
    delete missingEnabledRules.history.findLast(event => event.type === 'prepare').candidate.rules;
    await expect(validateEconomySession(f.cwd, missingEnabledRules)).rejects.toThrow('recorded policy or base rules differ');
  });
  it('binds v3 summaries to complete history and the actual head', async () => {
    const f = await fixture(); const session = await f.review(); const summary = receiptSummary(session, 12, Date.now());
    const body = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
    expect(parseReceipt(body)).toEqual(summary); expect(summary.sessionDigest).toBe(digest(session));
  });
});

describe('coverage preconditions in real histories', () => {
  it.each(['incomplete'])('does not inherit %s first coverage across a main merge', async reason => {
    const f = await fixture(); await f.cli('prepare', f.request); await f.report();
    if (reason === 'expired') await f.report(); const original = await f.state();
    const main = await f.mainMove(() => f.write('other.ts', 'main\n')); f.git('merge', '--no-ff', '-qm', 'integrate', main);
    if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(coverageState(original).expires);
    await f.cli('prepare', f.request); expect((await f.state()).candidate.coverage).toBeUndefined();
    await expect(f.cli('verify')).rejects.toThrow('PASS');
  });
  it('rejects incomplete or altered receipt histories rather than trust inherited reviewer arrays', async () => {
    const f = await fixture(); const session = await f.review();
    const root = structuredClone(session); root.history.find(event => event.type === 'report').report.tree = 'a'.repeat(40);
    expect(verdict(root, root.candidate, Date.now()).ok).toBe(false);
  });
});

describe('fixture dependency evidence', () => {
  it.each([false, true])('reviews a fixture repair as its delta (product consumer: %s)', async product => {
    const f = await fixture(); await f.write('tests/fixtures/value.ts', 'export const value = 1;\n');
    await f.write('tests/helpers/parent.ts', "export { value } from '../fixtures/value.js';\n");
    await f.write(product ? 'src/consumer.ts' : 'tests/consumer.test.ts', "import { value } from '../tests/helpers/parent.js';\n"); f.commit(); await f.review();
    await f.write('tests/fixtures/value.ts', 'export const value = 2;\n'); f.commit(); await f.cli('prepare', f.request);
    expect((await f.state()).candidate.coverage?.kind).toBe('repair');
  });
});


describe('v3 source admission from real Git objects', () => {
  it('admits inherited integration coverage through the full queue reader', async () => {
    const f = await fixture(); await f.review(); const main = await f.mainMove(() => f.write('other.ts', 'main\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate', main); await f.cli('prepare', f.request); const session = await f.state();
    const summary = receiptSummary(session, 12, Date.now());
    const body = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: session.candidate.head } };
    const api = { get: async (path: string) => path.includes('/pulls/') ? pr : path.includes('/issues/')
      ? [{ id: 1, body, user: { login: 'supervisor', type: 'User' } }]
      : path.includes('/collaborators/') ? { permission: 'write' } : { object: { sha: main } } };
    const runGit = async (cwd: string, ...args: string[]) => args.includes('fetch') ? '' : sourceGit(cwd, ...args);
    await expect(waitNativeAdmission({ cwd: f.cwd, api, runGit,
      event: { number: 12, repository: { private: false }, pull_request: { head: pr.head } },
      env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' },
    })).resolves.toEqual(summary);
  });
});

describe('portable review on real Git objects', () => {
  const policy = "const PORTABLE_REVIEW = 'openlup-portable-review-20261103';\n";
  const lock = (node: string, version = '1.0.0') => JSON.stringify({
    lockfileVersion: 3, packages: { 'packages/platform': { engines: { node } }, 'node_modules/sample': { version } },
  }) + '\n';
  const oldFiles = {
    '.nvmrc': '24.21.0\n',
    'package-lock.json': lock('24.x'),
    '.github/VERSIONING_AND_EOL.md': 'Existing publication instructions.\n',
    'scripts/agent-review-session.mjs': '// original source\n',
  };
  for (const order of ['policy first', 'metadata first']) {
    it('accepts the original receipt across both base changes: ' + order, async () => {
      const f = await fixture(true, [], oldFiles);
      const source = await f.review();
      const original = receiptSummary(source, 12, Date.now());
      const body = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(original)}\n\`\`\``;
      const packageMove = () => f.write('package-lock.json', lock('>=24'));
      const policyMove = async () => {
        await f.write('scripts/agent-review-session.mjs', policy);
        await f.write('scripts/agent-review-registry.test.ts', '// rollout fixture\n');
      };
      const first = await f.mainMove(order === 'policy first' ? policyMove : packageMove);
      const main = await f.mainMove(order === 'policy first' ? packageMove : policyMove, first);
      const tree = f.git('merge-tree', '--write-tree', main, f.head);
      const groupHead = f.git('commit-tree', tree, '-p', main, '-p', f.head, '-m', 'queued group');
      const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: f.head } };
      const api = { get: vi.fn(async (path: string) => path.includes('/pulls/') ? pr
        : path.includes('/collaborators/') ? { permission: 'write' }
        : path.includes('/issues/') ? [{ id: 1, user: { login: 'owner', type: 'User' }, author_association: 'OWNER',
          body }]
        : { object: { sha: main } }) };
      const runGit = (cwd: string, ...args: string[]) => args.includes('fetch') ? Promise.resolve('') : sourceGit(cwd, ...args);
      const sleep = vi.fn();
      await expect(waitNativeAdmission({ cwd: f.cwd, api, runGit, sleep,
        event: { action: 'checks_requested', repository: { private: false }, merge_group: {
          base_ref: 'refs/heads/main', head_ref: 'refs/heads/gh-readonly-queue/main/pr-12-ab', base_sha: main, head_sha: groupHead,
        } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'merge_group' },
      })).resolves.toEqual(original);
      expect(sleep).not.toHaveBeenCalled();
      await expect(f.cli('receipt', '12')).resolves.toBe(0);
      expect(await f.state()).toEqual(source);
      await expect(carryOverSourceReview(f.cwd, source.candidate, { base: main, tree, trustedMain: f.base })).resolves.toMatchObject({ ok: true });
    });
  }

  it('keeps a legacy v2 review across the exact committed registry union', async () => {
    const f = await fixture(false, [], oldFiles);
    const path = REGISTRY_PATHS[0];
    const base = f.git('show', f.base + ':' + path) + '\n';
    await f.write(path, addRegistry(path, base, 'zz-row-a'));
    const reviewed = f.commit();
    const prior = await f.review();
    const oldReceipt = receiptSummary(prior, 12, Date.now());
    const rollout = await f.mainMove(async () => {
      await f.write('scripts/agent-review-session.mjs', policy);
      await f.write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n');
    });
    const main = await f.mainMove(async () => {
      await f.write('package-lock.json', lock('>=24'));
      await f.write(path, addRegistry(path, base, 'zz-row-b'));
    }, rollout);
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write(path, registryUnion(path, base, f.git('show', reviewed + ':' + path) + '\n', f.git('show', main + ':' + path) + '\n'));
    f.commit();
    await f.cli('prepare', f.request);
    const next = await f.state();
    expect(next.history.slice(0, prior.history.length)).toEqual(prior.history);
    expect(next.candidate.coverage.proof.kind).toBe('portable-registry-union');
    expect(next.cycle).toBe(prior.cycle);
    expect(coverageState(next).expires).toBe(oldReceipt.expires);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(oldReceipt.expires + 30 * DAY);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
  });
  it('preserves the v3 workspace npm policy fingerprint', async () => {
    const f = await fixture();
    const path = 'packages/outbox/.npmrc';
    expect(protectedCoveragePath(path)).toBe(false);
    await f.write(path, 'engine-strict=true\n');
    f.commit();
    const source = await f.review();
    expect(source.candidate.rules.head).toBe(source.candidate.rules.base);
    await validateEconomySession(f.cwd, source);
  });

  it.each([
    ['legacy workspace npm policy', false, 'packages/outbox/.npmrc', 'git'],
    ['portable workspace npm policy', true, 'packages/outbox/.npmrc', 'portable-git'],
    ['portable unrelated source', true, 'unrelated.ts', 'portable-git'],
  ])('selects the committed integration proof from its landed base: %s', async (_name, landed, path, expected) => {
    const f = await fixture(true, [], landed ? { 'scripts/agent-review-session.mjs': policy } : {});
    await f.review();
    const main = await f.mainMove(() => f.write(path, 'fixture change\n'));
    f.git('merge', '--no-ff', '--no-commit', main);
    f.commit();
    await f.cli('prepare', f.request);
    const prepared = await f.state();
    expect(prepared.candidate.coverage?.proof.kind).toBe(expected);
    if (expected) {
      await validateEconomySession(f.cwd, prepared);
      await expect(f.cli('receipt', '12')).resolves.toBe(0);
    } else {
      await expect(f.cli('receipt', '12')).rejects.toThrow('independent PASS reports required');
    }
  });

});
