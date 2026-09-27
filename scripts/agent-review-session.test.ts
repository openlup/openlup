import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentReviewReportBinding, captureSessionCandidate, prepareAgentReview, pristineAgentReviewBaseline, recordAgentReview, verifyAgentReview } from './agent-review-session.mjs';

const base = 'a'.repeat(40);
const candidate = { base, head: 'b'.repeat(40), tree: 'c'.repeat(40), clean: true, workingDigest: 'd'.repeat(64), indexDigest: 'e'.repeat(64), changedPaths: ['source.txt'] };
const intent = { risk: 'behavior', scope: ['source.txt'], criteria: 'Preserve required subscription behavior', requiredRoles: [] };
const snapshot = async () => structuredClone(candidate);
const now = () => 1000;
async function request(risk = 'behavior') { return prepareAgentReview({ cwd: '.', base, intent: { ...intent, risk }, authorSessionId: 'author', snapshot, now }); }
function report(req, index = 0) {
  return { ...agentReviewReportBinding(req), reviewerId: `agent-${index}`, sessionId: `session-${index}`, role: req.roles[index], cold: true, completedAt: 1000, complete: true, coveredScope: ['source.txt'], coveredCriteria: true, simplicityChecked: index === 0, verdict: 'pass', materialFindings: [] };
}
async function verify(req, reports, extra = {}) { return verifyAgentReview({ cwd: '.', request: req, reports, snapshot, now, ...extra }); }
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = join(process.cwd(), '.context', 'scratch'); await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, 'session-test-')); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', cwd, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q'); await writeFile(join(cwd, 'source.txt'), 'before\n'); git('add', 'source.txt'); git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  return { cwd, base, git };
}

describe('native session review process evidence', () => {
  for (const [risk, count] of [['prose', 1], ['behavior', 2], ['unknown', 2]] as const) it(`requires ${count} independent ${risk} reviews`, async () => {
    const req = await request(risk); expect(req.roles).toHaveLength(count);
    expect((await verify(req, [])).status).toBe('needs_agent_review');
    const reports = Array.from({ length: count }, (_, index) => report(req, index));
    expect((await verify(req, reports)).status).toBe('reviewed');
  });
  it('records an observed material finding but blocks approval and replacement', async () => {
    const req = await request('prose'); const failed = { ...report(req), verdict: 'fail', materialFindings: [{ mechanism: 'lost clamp', precondition: 'late parcel', requirement: 'no early cycle', effect: 'early renewal' }] };
    const reports = await recordAgentReview({ cwd: '.', request: req, report: failed, snapshot, now });
    expect((await verify(req, reports)).reason).toContain('unresolved material');
    await expect(recordAgentReview({ cwd: '.', request: req, reports, report: report(req), snapshot, now })).rejects.toThrow();
  });
  for (const field of ['base', 'head', 'tree', 'workingDigest', 'indexDigest', 'changedPaths']) it(`refuses stale ${field}`, async () => {
    const req = await request('prose'); const changed = { ...candidate, [field]: field === 'changedPaths' ? ['other.txt'] : 'f'.repeat(field.endsWith('Digest') ? 64 : 40) };
    expect((await verify(req, [report(req)], { snapshot: async () => changed })).reason).toContain('candidate changed');
    await expect(recordAgentReview({ cwd: '.', request: req, report: report(req), snapshot: async () => changed, now })).rejects.toThrow('candidate changed');
  });
  for (const mutation of [
    { reviewerId: 'author' }, { sessionId: 'author' }, { cold: false }, { complete: false }, { coveredCriteria: false }, { coveredScope: ['other.txt'] }, { simplicityChecked: false }, { completedAt: 999 }, { completedAt: 1001 }, { requestDigest: 'f'.repeat(64) },
  ]) it(`refuses invalid report ${JSON.stringify(mutation)}`, async () => {
    const req = await request('prose'); expect((await verify(req, [{ ...report(req), ...mutation }])).status).toBe('needs_agent_review');
  });
  it('rejects same identity reused across reviewer and session fields', async () => {
    const req = await request(); const first = report(req); const second = { ...report(req, 1), reviewerId: first.sessionId };
    expect((await verify(req, [first, second])).reason).toContain('duplicated');
  });
  it('rejects scope and criteria mutation after reports', async () => {
    const req = await request('prose'); const observation = report(req);
    req.intent.criteria = 'different acceptance'; expect((await verify(req, [observation])).status).toBe('needs_agent_review');
    req.intent.scope = ['other.txt']; expect((await verify(req, [observation])).status).toBe('needs_agent_review');
  });
  it('refuses reviewed dirty source and expiry during the final scan', async () => {
    const req = await request('prose'); const dirty = { ...req, candidate: { ...req.candidate, clean: false } };
    expect((await verify(dirty, [report(dirty)], { snapshot: async () => dirty.candidate })).reason).toContain('clean committed');
    let tick = 1000;
    const result = await verify(req, [report(req)], { now: () => tick, snapshot: async () => { tick += 1; return candidate; }, maxAgeMs: 1 });
    expect(result.status).toBe('needs_agent_review'); expect(result.reason).toContain('final source scan');
  });
  it('refuses over-scoped source before requesting reviewer execution', async () => {
    await expect(prepareAgentReview({ cwd: '.', base, intent, authorSessionId: 'author', snapshot: async () => ({ ...candidate, changedPaths: ['unexpected.txt'] }), now })).rejects.toThrow('exceeds approved scope');
  });
  it('expires old evidence and refuses empty candidate approval', async () => {
    const req = await request('prose'); expect((await verify(req, [report(req)], { now: () => 86401001 })).reason).toContain('expired');
    await expect(prepareAgentReview({ cwd: '.', base, intent, authorSessionId: 'author', snapshot: async () => ({ ...candidate, changedPaths: [] }), now })).rejects.toThrow('scope is invalid');
  });
});

describe('actual source snapshot without candidate execution', () => {
  it('automatically distinguishes pristine baseline from dirty actual source', async () => {
    const { cwd, base } = await fixture(); expect((await pristineAgentReviewBaseline(cwd)).pristine).toBe(true);
    await writeFile(join(cwd, 'source.txt'), 'after!\n'); const dirty = await captureSessionCandidate(cwd, base);
    expect(dirty.changedPaths).toEqual(['source.txt']); expect((await pristineAgentReviewBaseline(cwd)).pristine).toBe(false);
  });
  it('captures staged bytes, untracked source, deletion, and independent index drift', async () => {
    const { cwd, base, git } = await fixture(); await writeFile(join(cwd, 'source.txt'), 'staged\n'); git('add', 'source.txt');
    const staged = await captureSessionCandidate(cwd, base); git('reset', '-q', 'HEAD', '--', 'source.txt');
    const unstaged = await captureSessionCandidate(cwd, base); expect(unstaged.workingDigest).toBe(staged.workingDigest); expect(unstaged.indexDigest).not.toBe(staged.indexDigest);
    await writeFile(join(cwd, 'extra.txt'), 'untracked'); expect((await captureSessionCandidate(cwd, base)).changedPaths).toEqual(['extra.txt', 'source.txt']);
    await rm(join(cwd, 'source.txt')); expect((await captureSessionCandidate(cwd, base)).changedPaths).toEqual(['extra.txt', 'source.txt']);
  });
  it('rejects index concealment flags', async () => {
    const { cwd, base, git } = await fixture(); git('update-index', '--assume-unchanged', 'source.txt'); await writeFile(join(cwd, 'source.txt'), 'dirty\n');
    await expect(captureSessionCandidate(cwd, base)).rejects.toThrow('flags conceal');
  });
  it('records deletion of a whole tracked directory', async () => {
    const { cwd, base, git } = await fixture(); await mkdir(join(cwd, 'nested')); await writeFile(join(cwd, 'nested', 'file.txt'), 'source'); git('add', 'nested'); git('commit', '-qm', 'nested source');
    await rm(join(cwd, 'nested'), { recursive: true }); expect((await captureSessionCandidate(cwd, base)).changedPaths).toEqual([]);
  });
  it('CLI missing-state bootstrap passes only pristine baseline', async () => {
    const { cwd, git } = await fixture(); const script = resolve('scripts/agent-review-session.mjs');
    const invoke = () => execFileSync(process.execPath, [script, 'verify'], { cwd, encoding: 'utf8' });
    expect(JSON.parse(invoke()).status).toBe('pristine_baseline');
    await writeFile(join(cwd, 'source.txt'), 'staged'); git('add', 'source.txt'); await writeFile(join(cwd, 'source.txt'), 'before\n'); expect(() => invoke()).toThrow();
    git('reset', '-q', 'HEAD', '--', 'source.txt'); await writeFile(join(cwd, 'extra.txt'), 'source'); expect(() => invoke()).toThrow();
    await rm(join(cwd, 'extra.txt')); await writeFile(join(cwd, 'source.txt'), 'dirty'); expect(() => invoke()).toThrow();
  });
  it('keeps the full CLI lifecycle outside source with the actual scratch-only ignore layout', async () => {
    const { cwd, base, git } = await fixture();
    await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent: { ...intent, risk: 'prose' }, base: baseline, authorSessionId: 'author' }));
    expect(git('check-ignore', '.context/scratch/agent-review/intent.json')).toBe('.context/scratch/agent-review/intent.json');
    const script = resolve('scripts/agent-review-session.mjs');
    const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }));
    expect(invoke('prepare').status).toBe('needs_agent_review');
    const state = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
    const reportPath = join(directory, 'observed.json'); await writeFile(reportPath, JSON.stringify({ ...report(state.request), completedAt: Date.now() }));
    expect(invoke('record', reportPath).status).toBe('reviewed'); expect(invoke('verify').status).toBe('reviewed');
    expect((await captureSessionCandidate(cwd, baseline)).changedPaths).toEqual(['source.txt']);
    expect(base).not.toBe(baseline);
  });
  it('does not run a candidate clean filter while hashing bytes', async () => {
    const { cwd, base } = await fixture(); await writeFile(join(cwd, '.gitattributes'), 'source.txt filter=trap\n');
    await writeFile(join(cwd, 'source.txt'), 'dirty\n');
    const result = await captureSessionCandidate(cwd, base); expect(result.changedPaths).toEqual(['.gitattributes', 'source.txt']);
  });
});
