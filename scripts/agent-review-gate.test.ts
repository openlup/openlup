import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { assertMergePreflight, captureSessionCandidate, git as reviewGit, sessionMain, verifyCandidateCommand } from './agent-review-session.mjs';
import { carryOverSourceReview, waitNativeAdmission } from './agent-review-queue.mjs';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cwd of directories.splice(0)) await rm(cwd, { recursive: true, force: true }); });
const intent = { risk: 'routine', criteria: 'Preserve the reviewed source' };
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'native-review-v2-')); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();
  const commit = () => { git('add', 'source.txt'); git('commit', '-qm', 'fixture'); };
  git('init', '-q', '-b', 'main'); await writeFile(join(cwd, 'source.txt'), 'before\n'); commit();
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(cwd, 'source.txt'), 'reviewed\n'); commit(); const head = git('rev-parse', 'HEAD');
  const scratch = join(cwd, '.context', 'scratch'); await mkdir(scratch, { recursive: true });
  const statePath = join(scratch, 'agent-review', 'session.json');
  const env = { CODEX_THREAD_ID: 'author' };
  const cli = (...args: string[]) => sessionMain(args, { cwd, env });
  async function review() {
    const request = join(scratch, 'intent.json'); await writeFile(request, JSON.stringify({ intent })); await cli('prepare', request);
    const session = JSON.parse(await readFile(statePath, 'utf8'));
    const path = join(scratch, 'report.json');
    await writeFile(path, JSON.stringify({ reviewer: 'cold-reviewer', cold: true, verdict: 'PASS', tree: session.candidate.tree, findings: [], closes: [] }));
    await cli('record', path); return JSON.parse(await readFile(statePath, 'utf8'));
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { cwd, git, base, head, commit, scratch, statePath, cli, review };
}

describe('six real Git witnesses', () => {
  it('uses system Git and a fixed search path despite an injected git executable', async () => {
    const f = await fixture();
    const fakeGit = join(f.scratch, 'git'); await writeFile(fakeGit, '#!/bin/sh\necho substituted-git\n'); await chmod(fakeGit, 0o700);
    vi.stubEnv('PATH', f.scratch);
    expect(await reviewGit(f.cwd, '--version')).toMatch(/^git version /);
    const searchPath = await reviewGit(f.cwd, '-c', 'alias.review-path=!printf "%s" "$PATH"', 'review-path');
    expect(searchPath.endsWith('/usr/bin:/bin')).toBe(true);
    expect(searchPath).not.toContain(f.scratch);
  });
  it.each(['older landed ancestor', 'unlanded predecessor', 'landed predecessor'])('hosted base validation: %s', async scenario => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'source.txt'), 'upper change\n'); f.commit();
    const candidate = await captureSessionCandidate(f.cwd, undefined, { env: { OPENLUP_STACK_BASE: f.head } });
    const base = scenario === 'older landed ancestor' ? f.base : candidate.base;
    const main = scenario === 'unlanded predecessor' ? f.base : f.head;
    let clock = 1000;
    let session = prepareCandidate(null, { ...candidate, base, intent, authorSessionId: 'author' }, clock);
    session = recordReport(session, { reviewer: 'reviewer', cold: true, tree: candidate.tree, verdict: 'PASS', findings: [], closes: [] }, clock);
    const receipt = receiptSummary(session, 12, clock);
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: candidate.head } };
    const api = { get: vi.fn(async path => path.includes('/pulls/') ? pr : path.includes('/issues/') ? [{ id: 1, user: { login: 'review-owner', type: 'User' }, author_association: 'CONTRIBUTOR', body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : path.includes('/collaborators/') ? { permission: 'admin' } : { object: { sha: main } }) };
    const runGit = vi.fn(async (cwd, ...args) => args.includes('fetch') ? '' : reviewGit(cwd, ...args));
    const wait = waitNativeAdmission({ cwd: f.cwd, event: { number: 12, repository: { private: false }, pull_request: { head: { sha: candidate.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 1 });
    if (scenario === 'landed predecessor') await expect(wait).resolves.toBeUndefined();
    else await expect(wait).rejects.toThrow('review base must be the exact fork point on main');
  });
  it('prepare / record / verify and receipt PASS, with scratch ignored', async () => {
    const f = await fixture(); const session = await f.review();
    await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining(RECEIPT_MARKER));
    expect(session.version).toBe(2);
  });
  it('refuses a commit after review', async () => {
    const f = await fixture(); await f.review();
    await writeFile(join(f.cwd, 'source.txt'), 'unreviewed\n'); f.commit();
    await expect(f.cli('verify')).rejects.toThrow('candidate changed');
  });
  it('still passes when origin/main moves beyond the fork point', async () => {
    const f = await fixture(); await f.review();
    const tree = f.git('rev-parse', `${f.base}^{tree}`);
    const main = f.git('commit-tree', tree, '-p', f.base, '-m', 'unrelated main move');
    f.git('update-ref', 'refs/remotes/origin/main', main);
    await expect(f.cli('verify')).resolves.toBe(0);
  });
  it.each([false, true])('merge group carry-over with overlapping base move = %s', async overlap => {
    const f = await fixture(); const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} });
    f.git('checkout', '-q', '--detach', f.base);
    if (overlap) f.git('update-index', '--chmod=+x', 'source.txt');
    else { await writeFile(join(f.cwd, 'other.txt'), 'disjoint\n'); f.git('add', 'other.txt'); }
    f.git('commit', '-qm', 'base move'); const base = f.git('rev-parse', 'HEAD');
    const tree = f.git('merge-tree', '--write-tree', base, f.head);
    const head = f.git('commit-tree', tree, '-p', base, '-p', f.head, '-m', 'queue group');
    const decision = await carryOverSourceReview(f.cwd, candidate, { base, head, tree });
    expect(decision.ok).toBe(!overlap);
    expect(decision.reason).toContain(overlap ? 'merge main and re-review' : 'disjoint base move');
    if (!overlap) {
      await mkdir(join(f.scratch, 'agent-review'));
      await writeFile(join(f.scratch, 'intent.json'), JSON.stringify({ intent }));
      await writeFile(f.statePath, JSON.stringify({ version: 1 }));
      await expect(f.cli('verify')).rejects.toThrow('prepare a version-2 session before review');
      await expect(f.cli('prepare', '--new', join(f.scratch, 'intent.json'))).rejects.toThrow('session version must be 2; a version-1 session');
      await rm(f.statePath);
      await f.cli('prepare', '--new', join(f.scratch, 'intent.json'));
      const initial = JSON.parse(await readFile(f.statePath, 'utf8'));
      await f.cli('prepare', '--new', join(f.scratch, 'intent.json'));
      const next = JSON.parse(await readFile(f.statePath, 'utf8'));
      expect(next.history.slice(0, -1)).toEqual(initial.history);
      expect(next.cycle).toBe(initial.cycle);
      expect(next).not.toHaveProperty('previousSessionDigest');
      expect((await readdir(join(f.scratch, 'agent-review'))).some(name => /^session-.*\.json$/.test(name))).toBe(false);
    }
  });
  it.each(['text conflict', 'clean overlap', 'admission machinery', 'disjoint'])('preflight refuses known integration failure before review or costly verification: %s', async scenario => {
    const f = await fixture(); const session = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    if (scenario === 'text conflict') await writeFile(join(f.cwd, 'source.txt'), 'main conflicts\n');
    else if (scenario === 'clean overlap') await chmod(join(f.cwd, 'source.txt'), 0o755);
    else {
      const path = scenario === 'admission machinery' ? 'scripts/agent-review-admission.mjs' : 'other.txt';
      await mkdir(join(f.cwd, 'scripts'), { recursive: true });
      await writeFile(join(f.cwd, path), 'main addition\n'); f.git('add', path);
    }
    f.git('add', 'source.txt');
    f.git('commit', '-qm', 'main move');
    f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    f.git('checkout', '-q', '--detach', f.head);
    const run = vi.fn(async () => 0);
    const prepared = await readFile(f.statePath, 'utf8');
    const request = join(f.scratch, 'intent.json');
    if (scenario === 'disjoint') {
      await expect(f.cli('prepare', request)).resolves.toBe(0);
      await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'costly-check', run })).resolves.toBe(0);
      await expect(f.cli('receipt', '12')).resolves.toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
    } else {
      await expect(f.cli('prepare', request)).rejects.toThrow('merge_preflight');
      expect(await readFile(f.statePath, 'utf8')).toBe(prepared);
      await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'costly-check', run })).rejects.toThrow('merge_preflight');
      await expect(f.cli('receipt', '12')).rejects.toThrow('merge_preflight');
      expect(run).not.toHaveBeenCalled();
    }
  });
  it.each([false, true])('preserves exact integration coverage without admitting a later repair as a merge (repair: %s)', async repair => {
    const f = await fixture(); const prior = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await mkdir(join(f.cwd, 'scripts'), { recursive: true });
    await writeFile(join(f.cwd, 'scripts/agent-review-extra.mjs'), 'main admission change\n');
    f.git('add', 'scripts/agent-review-extra.mjs'); f.git('commit', '-qm', 'main machinery change');
    const main = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/main', main);
    f.git('checkout', '-q', '--detach', f.head); f.git('merge', '--no-ff', '-qm', 'integrate main', main);
    if (repair) { await writeFile(join(f.cwd, 'source.txt'), 'new implementation\n'); f.commit(); }
    await f.cli('prepare', join(f.scratch, 'intent.json'));
    const next = JSON.parse(await readFile(f.statePath, 'utf8'));
    expect(next.cycle).toBe(prior.cycle + 1);
    expect(next.candidate.base).toBe(main);
    expect(next.history.slice(0, -1)).toEqual(prior.history);
    if (repair) expect(next.candidate).not.toHaveProperty('integration');
    else {
      expect(next.candidate.integration).toEqual({ base: f.base, head: f.head, tree: prior.candidate.tree, expires: prior.history.at(-1).at + 86400000 });
      await f.cli('prepare', join(f.scratch, 'intent.json'));
      expect(JSON.parse(await readFile(f.statePath, 'utf8'))).toEqual(next);
      const path = join(f.scratch, 'integration-report.json');
      await writeFile(path, JSON.stringify({ reviewer: 'fresh-integration-1', cold: true, verdict: 'PASS', tree: next.candidate.tree, findings: [], closes: [] }));
      await f.cli('record', path);
      await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
      await writeFile(path, JSON.stringify({ reviewer: 'fresh-integration-2', cold: true, verdict: 'PASS', tree: next.candidate.tree, findings: [], closes: [] }));
      await f.cli('record', path);
      await expect(f.cli('verify')).resolves.toBe(0);
    }
  });
  it('requires full local review for an exact merge of an unlanded stacked predecessor', async () => {
    const f = await fixture(); await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await writeFile(join(f.cwd, 'predecessor.txt'), 'unlanded predecessor\n');
    f.git('add', 'predecessor.txt'); f.git('commit', '-qm', 'predecessor');
    const predecessor = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', f.head); f.git('merge', '--no-ff', '-qm', 'integrate predecessor', predecessor);
    const env = { CODEX_THREAD_ID: 'author', OPENLUP_STACK_BASE: predecessor };
    await sessionMain(['prepare', join(f.scratch, 'intent.json')], { cwd: f.cwd, env });
    const session = JSON.parse(await readFile(f.statePath, 'utf8'));
    expect(session.candidate.base).toBe(predecessor);
    expect(session.candidate).not.toHaveProperty('integration');
    await expect(sessionMain(['verify'], { cwd: f.cwd, env })).rejects.toThrow('independent PASS');
    const path = join(f.scratch, 'full-stack-report.json');
    await writeFile(path, JSON.stringify({ reviewer: 'full-stack-reviewer', cold: true, verdict: 'PASS', tree: session.candidate.tree, findings: [], closes: [] }));
    await sessionMain(['record', path], { cwd: f.cwd, env });
    await expect(sessionMain(['verify'], { cwd: f.cwd, env })).resolves.toBe(0);
  });
  it('keeps local stack review available before its pinned predecessor lands', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'source.txt'), 'upper change\n'); f.commit();
    const head = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', f.base);
    await writeFile(join(f.cwd, 'source.txt'), 'conflicting main\n'); f.commit();
    f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    f.git('checkout', '-q', '--detach', head);
    const env = { OPENLUP_STACK_BASE: f.head };
    const candidate = await captureSessionCandidate(f.cwd, undefined, { env });
    await expect(assertMergePreflight(f.cwd, candidate, { env })).resolves.toBeUndefined();
    await expect(assertMergePreflight(f.cwd, candidate, { env: {} })).rejects.toThrow('merge_preflight');
    const request = join(f.scratch, 'stack-intent.json');
    await writeFile(request, JSON.stringify({ authorSessionId: 'author', intent }));
    await expect(sessionMain(['prepare', request], { cwd: f.cwd, env })).resolves.toBe(0);
    let session = JSON.parse(await readFile(f.statePath, 'utf8'));
    session = recordReport(session, { reviewer: 'stack-reviewer', cold: true, verdict: 'PASS', tree: session.candidate.tree, findings: [], closes: [] }, Date.now());
    const run = vi.fn(async () => 0);
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, env, command: 'stack-check', run })).resolves.toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('carries over disjoint export additions to the same package manifest with real Git', async () => {
    const f = await fixture(); const path = 'packages/p/package.json';
    await mkdir(join(f.cwd, 'packages/p'), { recursive: true });
    const manifest = { name: '@openlup/p', exports: { '.': './index.js', './middle': './middle.js', './last': './last.js' } };
    const writeManifest = value => writeFile(join(f.cwd, path), `${JSON.stringify(value, null, 2)}\n`);
    await writeManifest(manifest); f.git('add', path); f.git('commit', '-qm', 'base manifest');
    const base = f.git('rev-parse', 'HEAD');
    await writeManifest({ ...manifest, exports: { ...manifest.exports, './b': './b.js' } });
    f.git('add', path); f.git('commit', '-qm', 'PR export addition');
    const head = f.git('rev-parse', 'HEAD'); const tree = f.git('rev-parse', 'HEAD^{tree}');
    f.git('checkout', '-q', '--detach', base);
    await writeManifest({ ...manifest, exports: { './a': './a.js', ...manifest.exports } });
    f.git('add', path); f.git('commit', '-qm', 'main export addition');
    const queueBase = f.git('rev-parse', 'HEAD');
    const groupTree = f.git('merge-tree', '--write-tree', queueBase, head);
    const decision = await carryOverSourceReview(f.cwd, { base, head, tree, changedPaths: [path] }, { base: queueBase, tree: groupTree });
    expect(decision).toEqual({ ok: true, code: 'reviewed', reason: 'disjoint base move with export additions' });
  });
  it('hosted wait admits in one fake API poll and verify-command runs only its stub command', async () => {
    const f = await fixture(); const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} });
    const now = Date.now(); let session = prepareCandidate(null, { ...candidate, intent, authorSessionId: 'author' }, now);
    session = recordReport(session, { reviewer: 'reviewer', cold: true, tree: candidate.tree, verdict: 'PASS', findings: [], closes: [] }, now);
    const receipt = receiptSummary(session, 12, now);
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: f.head } };
    const api = { get: vi.fn(async path => path.includes('/pulls/') ? pr : path.includes('/collaborators/') ? { permission: 'admin' } : path.includes('/issues/') ? [{ id: 1, user: { login: 'review-owner', type: 'User' }, author_association: 'CONTRIBUTOR', body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : { object: { sha: f.base } }) };
    const runGit = vi.fn(async (cwd, ...args) => {
      if (args.includes('fetch')) { expect(args).toEqual(['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', f.base, f.head]); return ''; }
      return reviewGit(cwd, ...args);
    });
    const sleep = vi.fn();
    await waitNativeAdmission({ cwd: f.cwd, event: { number: 12, repository: { private: false }, pull_request: { head: { sha: f.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, sleep });
    expect(sleep).not.toHaveBeenCalled(); expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('reviewed PR head'));
    const run = vi.fn(async () => 0);
    const snapshot = (cwd, base) => captureSessionCandidate(cwd, base, { env: {} });
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub-check', args: ['arg'], env: {}, run, snapshot })).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith('stub-check', ['arg'], f.cwd, expect.objectContaining({ OPENLUP_HEAVY_ACTIVE: f.cwd }));
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', env: { AI_RESOURCE_GATE_ACTIVE: '1' }, run })).rejects.toThrow('nested');
    const frozen = async () => candidate;
    const broker = join(f.scratch, 'ai-resource-gate'); await writeFile(broker, 'stub'); await chmod(broker, 0o700);
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', resource: 'openlup:coverage', env: { PATH: f.scratch }, run, snapshot: frozen })).resolves.toBe(0);
    expect(run).toHaveBeenLastCalledWith(broker, ['run', '--wait', `openlup:coverage:${f.cwd.split('/').at(-1)}`, '--', 'stub'], f.cwd, expect.any(Object));
    const untouched = vi.fn();
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', env: {}, run: untouched, snapshot: async () => ({ ...candidate, clean: false }) })).rejects.toThrow('dirty');
    expect(untouched).not.toHaveBeenCalled();
    let samples = 0;
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', env: {}, run, snapshot: async () => ++samples === 1 ? candidate : { ...candidate, tree: 'e'.repeat(40) } })).rejects.toThrow('stale');
    const pin = 'e'.repeat(40);
    const pinGit = vi.fn(async (_cwd, ...args) => args[0] === 'merge-base' && args[1] === '--all' ? f.base : args[0] === 'rev-parse' ? (args.at(-1).includes('tree') ? candidate.tree : f.head) : '');
    await expect(captureSessionCandidate(f.cwd, pin, { env: { OPENLUP_STACK_BASE: pin }, runGit: pinGit })).resolves.toMatchObject({ base: pin });
    expect(pinGit.mock.calls).toContainEqual([f.cwd, 'merge-base', '--is-ancestor', f.base, pin]);
    expect(pinGit.mock.calls).toContainEqual([f.cwd, 'merge-base', '--is-ancestor', pin, f.head]);
    await expect(captureSessionCandidate(f.cwd, pin, { env: {}, runGit: pinGit })).rejects.toThrow('fork point changed');
    await expect(captureSessionCandidate(f.cwd, undefined, { env: { OPENLUP_STACK_BASE: 'bad' }, runGit: pinGit })).rejects.toThrow('full commit digest');
  });
});
