import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { captureSessionCandidate, git as reviewGit, sessionMain, verifyCandidateCommand } from './agent-review-session.mjs';
import { carryOverSourceReview, waitNativeAdmission } from './agent-review-queue.mjs';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cwd of directories.splice(0)) await rm(cwd, { recursive: true, force: true }); });
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
      await expect(f.cli('verify')).rejects.toThrow('start a new session with prepare --new');
      await f.cli('prepare', '--new', join(f.scratch, 'intent.json'));
      const restarted = JSON.parse(await readFile(f.statePath, 'utf8'));
      expect(restarted.previousSessionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect((await readdir(join(f.scratch, 'agent-review'))).some(name => /^session-.*\.json$/.test(name))).toBe(true);
    }
  });
  it('hosted wait admits in one fake API poll and verify-command runs only its stub command', async () => {
    const f = await fixture(); const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} });
    const now = Date.now(); let session = prepareCandidate(null, { ...candidate, intent, authorSessionId: 'author' }, now);
    session = recordReport(session, { reviewer: 'reviewer', cold: true, tree: candidate.tree, verdict: 'PASS', findings: [], closes: [] }, now);
    const receipt = receiptSummary(session, 12, now);
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: f.head } };
    const api = { get: vi.fn(async path => path.includes('/pulls/') ? pr : path.includes('/issues/') ? [{ id: 1, author_association: 'MEMBER', body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : { object: { sha: f.base } }) };
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
