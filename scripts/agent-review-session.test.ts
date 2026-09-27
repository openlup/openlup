import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentReviewReportBinding, captureSessionCandidate, prepareAgentReview, pristineAgentReviewBaseline, recordAgentReview, serializeAgentReviewState, verifyAgentReview } from './agent-review-session.mjs';

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
  for (const path of ['scripts/agent-review-session.mjs', 'package.json', '.github/workflows/ci.yml', '.github/README.md', 'AGENTS.md', 'docs/CLAUDE.local.md', 'CONTRIBUTING.txt', 'SECURITY.rst', '.github/AI_CONTRIBUTION_POLICY.md', 'docs/AGENT_GUIDE.md']) it(`refuses prose classification for actual control/code change ${path}`, async () => {
    const scoped = { ...intent, risk: 'prose', scope: [path] }; const changed = { ...candidate, changedPaths: [path] };
    await expect(prepareAgentReview({ cwd: '.', base, intent: scoped, authorSessionId: 'author', snapshot: async () => changed, now })).rejects.toThrow('automatically prepare fresh behavior reviews');
    const req = await prepareAgentReview({ cwd: '.', base, intent: { ...scoped, risk: 'behavior' }, authorSessionId: 'author', snapshot: async () => changed, now });
    req.intent.risk = 'prose'; req.roles = ['correctness'];
    expect((await verify(req, [], { snapshot: async () => changed })).reason).toContain('prose risk cannot cover');
  });
  it('allows ordinary actual docs within a broader approved scope containing code', async () => {
    const changed = { ...candidate, changedPaths: ['docs/overview.md', 'notes.rst', 'copy.txt'] };
    const req = await prepareAgentReview({ cwd: '.', base, intent: { ...intent, risk: 'prose', scope: [...changed.changedPaths, 'scripts/tool.mjs', 'package.json'] }, authorSessionId: 'author', snapshot: async () => changed, now });
    expect(req.roles).toEqual(['correctness']);
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
  it.each(['.context', '.context/scratch', '.context/scratch/agent-review'])('refuses symlink ancestor %s before creating directories', async ancestor => {
    const { cwd } = await fixture(); const target = await mkdtemp(join(cwd, 'victim-'));
    const components = ancestor.split('/'); if (components.length > 1) await mkdir(join(cwd, ...components.slice(0, -1)), { recursive: true });
    await symlink(target, join(cwd, ancestor)); const script = resolve('scripts/agent-review-session.mjs');
    expect(() => execFileSync(process.execPath, [script, 'prepare'], { cwd, encoding: 'utf8', stdio: 'pipe' })).toThrow('session ancestor is a symlink');
    expect(await readdir(target)).toEqual([]);
  });
  it('atomically replaces hardlinked state without overwriting its sibling inode', async () => {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent: { ...intent, risk: 'prose' }, base: baseline, authorSessionId: 'author' }));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }));
    invoke('prepare'); const path = join(directory, 'session.json'); const victim = join(directory, 'sibling.json'); await link(path, victim);
    const before = await readFile(victim, 'utf8'); invoke('prepare'); expect(await readFile(victim, 'utf8')).toBe(before); expect(await readFile(path, 'utf8')).not.toBe(before);
    const state = JSON.parse(await readFile(path, 'utf8')); await rm(victim); await link(path, victim); const recordedBefore = await readFile(victim, 'utf8');
    const reportPath = join(directory, 'observed.json'); await writeFile(reportPath, JSON.stringify({ ...report(state.request), completedAt: Date.now() }));
    expect(invoke('record', reportPath).status).toBe('reviewed'); expect(await readFile(victim, 'utf8')).toBe(recordedBefore);
  });
  it('fails concurrent prepare/record closed without losing a recorded material finding', async () => {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent, base: baseline, authorSessionId: 'author' }));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }));
    invoke('prepare'); const statePath = join(directory, 'session.json'); const state = JSON.parse(await readFile(statePath, 'utf8'));
    const failedPath = join(directory, 'failed.json'); const passPath = join(directory, 'pass.json');
    const findings = [{ mechanism: 'lost clamp', precondition: 'late parcel', requirement: 'no early cycle', effect: 'early renewal' }];
    await writeFile(failedPath, JSON.stringify({ ...report(state.request), completedAt: Date.now(), verdict: 'fail', materialFindings: findings }));
    await writeFile(passPath, JSON.stringify({ ...report(state.request, 1), completedAt: Date.now() }));
    const child = spawn(process.execPath, [script, 'record', failedPath], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const completed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    for (let attempt = 0; ; attempt += 1) {
      try { await stat(join(directory, '.session.lock')); break; } catch { if (attempt >= 500) throw new Error('transaction lock was not observed'); await new Promise(resolve => setTimeout(resolve, 2)); }
    }
    const contenders = ['record', 'prepare'].map(verb => {
      const args = verb === 'record' ? [verb, passPath] : [verb];
      return new Promise<string>((resolve, reject) => {
        const rival = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let diagnostics = '';
        rival.stderr.on('data', bytes => { diagnostics += bytes; }); rival.on('error', reject); rival.on('close', code => code === 1 ? resolve(diagnostics) : reject(new Error(`concurrent ${verb} unexpectedly completed`)));
      });
    });
    expect(await completed).toBe(0); expect(stderr).toBe(''); expect(JSON.parse(stdout).status).toBe('needs_agent_review');
    for (const diagnostics of await Promise.all(contenders)) expect(diagnostics).toContain('session transaction is busy');
    expect(invoke('record', passPath).status).toBe('needs_agent_review');
    const recorded = JSON.parse(await readFile(statePath, 'utf8')); expect(recorded.request.id).toBe(state.request.id); expect(recorded.reports).toHaveLength(2); expect(recorded.reports[0].materialFindings).toEqual(findings);
    expect(() => invoke('prepare')).toThrow('unresolved material findings');
    await expect(stat(join(directory, '.session.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(directory, '.session.lock'), 'existing owner'); expect(() => invoke('prepare')).toThrow('session transaction is busy'); expect(await readFile(join(directory, '.session.lock'), 'utf8')).toBe('existing owner');
  });
  it('keeps two 4096-path reports usable when persisted state exceeds the input-file bound', async () => {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    const scope = ['source.txt', ...Array.from({ length: 4095 }, (_, index) => `scope/${index}-${'a'.repeat(88)}`)];
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent: { ...intent, scope }, base: baseline, authorSessionId: 'author' }));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    invoke('prepare'); const statePath = join(directory, 'session.json'); const state = JSON.parse(await readFile(statePath, 'utf8'));
    for (const index of [0, 1]) {
      const reportPath = join(directory, `observed-${index}.json`); await writeFile(reportPath, JSON.stringify({ ...report(state.request, index), coveredScope: scope, completedAt: Date.now() }));
      expect((await stat(reportPath)).size).toBeLessThan(1024 * 1024); invoke('record', reportPath);
    }
    expect((await stat(statePath)).size).toBeGreaterThan(1024 * 1024); expect(invoke('status').status).toBe('reviewed'); expect(invoke('verify').status).toBe('reviewed');
    const before = await readFile(statePath, 'utf8'); const huge = { ...state, reports: [{ payload: 'x'.repeat(8 * 1024 * 1024) }] };
    expect(() => serializeAgentReviewState(huge)).toThrow('previous state is preserved'); expect(await readFile(statePath, 'utf8')).toBe(before);
    await writeFile(join(directory, 'oversized.json'), JSON.stringify({ payload: 'x'.repeat(1024 * 1024) })); expect(() => invoke('record', join(directory, 'oversized.json'))).toThrow(); expect(await readFile(statePath, 'utf8')).toBe(before);
  });
  it('does not run a candidate clean filter while hashing bytes', async () => {
    const { cwd, base } = await fixture(); await writeFile(join(cwd, '.gitattributes'), 'source.txt filter=trap\n');
    await writeFile(join(cwd, 'source.txt'), 'dirty\n');
    const result = await captureSessionCandidate(cwd, base); expect(result.changedPaths).toEqual(['.gitattributes', 'source.txt']);
  });
});
