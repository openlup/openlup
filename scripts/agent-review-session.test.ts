import { afterEach, describe, expect, it as test, vi } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { agentReviewIdentities, agentReviewReportBinding, captureAgentReviewDelta, captureSessionCandidate, checkMergePreview, heavyCommandEnvironment, heavyLeaseDirectory, prepareAgentReview, prepareAgentReviewState, pristineAgentReviewBaseline, recordAgentReview, serializeAgentReviewState, verifyAgentReview, verifyCandidateCommand, withHeavyLease } from './agent-review-session.mjs';

const base = 'a'.repeat(40);
const candidate = { base, head: 'b'.repeat(40), tree: 'c'.repeat(40), clean: true, workingDigest: 'd'.repeat(64), indexDigest: 'e'.repeat(64), changedPaths: ['source.txt'] };
const intent = { risk: 'behavior', scope: ['source.txt'], criteria: 'Preserve required subscription behavior', requiredRoles: [] };
const snapshot = async () => structuredClone(candidate);
const now = () => 1000;
async function request(risk = 'behavior') { return prepareAgentReview({ cwd: '.', base, intent: { ...intent, risk }, authorSessionId: 'author', snapshot, modeCheck: async () => false, now }); }
function report(req, index = 0) {
  return { ...agentReviewReportBinding(req), reviewerId: `agent-${index}`, sessionId: `session-${index}`, role: req.roles[index], cold: true, completedAt: 1000, complete: true, coveredScope: ['source.txt'], coveredCriteria: true, simplicityChecked: index === 0, verdict: 'pass', materialFindings: [], ...(req.version === 1 && req.intent.risk === 'routine' ? { routineSemantics: true } : {}) };
}
async function verify(req, reports, extra = {}) { return verifyAgentReview({ cwd: '.', request: req, reports, snapshot, modeCheck: async () => false, now, ...extra }); }
function findingIds(rounds) { return rounds.flatMap(round => round.reports.flatMap(observed => observed.materialFindings.map((finding, index) => createHash('sha256').update(JSON.stringify({ requestDigest: createHash('sha256').update(JSON.stringify(round.request)).digest('hex'), reviewerId: observed.reviewerId, index, finding })).digest('hex')))); }
const simplicityPreCheck = 'Read Review lessons; the smallest adequate alternative is the direct edit';
const directories: string[] = [];
let currentBody: Promise<unknown>;
function joined<Args extends unknown[]>(body: (...args: Args) => unknown) {
  return (...args: Args) => {
    currentBody = Promise.resolve().then(() => body(...args));
    return currentBody;
  };
}
function it(name: string, body: () => unknown, timeout?: number) {
  return test(name, joined(body), timeout);
}
it.each = <T>(cases: T[]) => (name: string, body: (value: T) => unknown, timeout?: number) => test.each(cases)(name, joined(body), timeout);
afterEach(async () => {
  // Vitest times out without cancelling the body. Join it before removing fixtures.
  await Promise.allSettled([currentBody]);
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}, 120_000);
function closed(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    child.once('close', code => { if (failure) reject(failure); else resolve(code); });
  });
}
async function fixture() {
  const root = join(process.cwd(), '.context', 'scratch'); await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, 'session-test-')); directories.push(cwd);
  // Disposable Git commands must not leave detached automatic maintenance behind.
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', cwd, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q'); await writeFile(join(cwd, 'source.txt'), 'before\n'); git('add', 'source.txt'); git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  return { cwd, base, git };
}

describe('native session review process evidence', () => {
  for (const [risk, count] of [['prose', 1], ['routine', 1], ['behavior', 2], ['unknown', 2]] as const) it(`requires ${count} independent ${risk} reviews`, async () => {
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
  it.each(['.github/README.md', 'AGENTS.md', 'package.json', 'config/settings.json', 'db/example.sql', 'scripts/agent-review-session.mjs', 'scripts/source-preview-release.ts', 'packages/core/src/index.ts', 'server/bff/orders.ts', 'src/domains/payment/card.ts', 'src/domains/subscription/renewal.ts', 'src/pages/account/login/useOtpCodeFallback.ts', 'src/pages/account/cardSetupSupport.ts', 'src/domains/customers/customerMagicLinkClient.ts', 'src/domains/shipping/contracts.ts', 'server/domains/accounting/accountingInvoiceDeliveryJob.ts'])('refuses routine review on elevated path %s', async path => {
    const scoped = { ...intent, risk: 'routine', scope: [path] }; const changed = { ...candidate, changedPaths: [path] };
    await expect(prepareAgentReview({ cwd: '.', base, intent: scoped, authorSessionId: 'author', snapshot: async () => changed, modeCheck: async () => false, now })).rejects.toThrow('routine risk cannot cover');
    const req = await prepareAgentReview({ cwd: '.', base, intent: { ...scoped, risk: 'behavior' }, authorSessionId: 'author', snapshot: async () => changed, now });
    req.intent.risk = 'routine'; req.roles = ['correctness'];
    expect((await verify(req, [], { snapshot: async () => changed })).reason).toContain('routine risk cannot cover');
  });
  it('requires a correctness reviewer and independent ordinary-semantics assessment for routine code', async () => {
    await expect(prepareAgentReview({ cwd: '.', base, intent: { ...intent, risk: 'routine', requiredRoles: ['security'] }, authorSessionId: 'author', snapshot, modeCheck: async () => false, now })).rejects.toThrow('correctness reviewer');
    const req = await request('routine');
    expect((await verify(req, [{ ...report(req), routineSemantics: false }])).reason).toContain('elevated or uncertain semantics');
    expect((await verify(req, [{ ...report(req), routineSemantics: 'yes' }])).reason).toContain('semantic assessment');
    expect((await verify(req, [{ ...report(req), routineSemantics: undefined }])).reason).toContain('semantic assessment');
  });
  it('escalates an uncertain routine review on the same committed candidate to two full reviews', async () => {
    const req = await request('routine'); const previous = { request: req, reports: [{ ...report(req), routineSemantics: false }] };
    const state = await prepareAgentReviewState({ cwd: '.', base, intent: { ...intent, risk: 'routine' }, authorSessionId: 'author', snapshot, modeCheck: async () => false, now, previous, fullRefresh: true, delta: async () => [] });
    expect(state.request.continuation.mode).toBe('full'); expect(state.request.roles).toEqual(['correctness', 'security']); expect(state.history).toHaveLength(1);
    state.reports = [0, 1].map(index => ({ ...report(state.request, index), reviewerId: `full-${index}`, sessionId: `full-session-${index}`, closure: { coveredDelta: [], interactionsChecked: true, ordinarySemantics: false, resolvedFindings: [] } }));
    expect((await verifyAgentReview({ cwd: '.', ...state, snapshot, modeCheck: async () => false, now, delta: async () => [] })).status).toBe('reviewed');
  });
  it('rejects a real mode-only change at preparation and verification, even after risk tampering', async () => {
    const { cwd, base: realBase, git } = await fixture();
    await chmod(join(cwd, 'source.txt'), 0o755); git('add', 'source.txt'); git('commit', '-qm', 'mode');
    const scoped = { ...intent, risk: 'routine' };
    await expect(prepareAgentReview({ cwd, base: realBase, intent: scoped, authorSessionId: 'author' })).rejects.toThrow('mode or symlink');
    const req = await prepareAgentReview({ cwd, base: realBase, intent, authorSessionId: 'author' });
    req.intent.risk = 'routine'; req.roles = ['correctness'];
    expect((await verifyAgentReview({ cwd, request: req, reports: [] })).reason).toContain('mode or symlink');
  });
  it('rejects a new symlink from the routine route', async () => {
    const { cwd, base: realBase, git } = await fixture();
    await symlink('source.txt', join(cwd, 'link.txt')); git('add', 'link.txt'); git('commit', '-qm', 'symlink');
    await expect(prepareAgentReview({ cwd, base: realBase, intent: { ...intent, risk: 'routine', scope: ['link.txt'] }, authorSessionId: 'author' })).rejects.toThrow('mode or symlink');
  });
  it('rejects a newly executable file from the routine route', async () => {
    const { cwd, base: realBase, git } = await fixture();
    await writeFile(join(cwd, 'utility.txt'), 'new\n'); await chmod(join(cwd, 'utility.txt'), 0o755);
    git('add', 'utility.txt'); git('commit', '-qm', 'executable');
    await expect(prepareAgentReview({ cwd, base: realBase, intent: { ...intent, risk: 'routine', scope: ['utility.txt'] }, authorSessionId: 'author' })).rejects.toThrow('mode or symlink');
  });
  it('refuses over-scoped source before requesting reviewer execution', async () => {
    await expect(prepareAgentReview({ cwd: '.', base, intent, authorSessionId: 'author', snapshot: async () => ({ ...candidate, changedPaths: ['unexpected.txt'] }), now })).rejects.toThrow('exceeds approved scope');
  });
  it('expires old evidence and refuses empty candidate approval', async () => {
    const req = await request('prose'); expect((await verify(req, [report(req)], { now: () => 86401001 })).reason).toContain('expired');
    await expect(prepareAgentReview({ cwd: '.', base, intent, authorSessionId: 'author', snapshot: async () => ({ ...candidate, changedPaths: [] }), now })).rejects.toThrow('scope is invalid');
  });
});

describe('bounded repair convergence', () => {
  const finding = { mechanism: 'lost clamp', precondition: 'late parcel', requirement: 'no early cycle', effect: 'early renewal', risk: 'ordinary' };
  const delta = async (_cwd, before, after) => before.head === after.head ? [] : ['source.txt'];
  const repaired = (number = 1) => ({ ...candidate, head: String(number).repeat(40), tree: String(number + 2).repeat(40), workingDigest: (number + 4).toString(16).repeat(64), indexDigest: (number + 6).toString(16).repeat(64) });
  async function initial() { const req = await request(); return { request: req, reports: [{ ...report(req), verdict: 'fail', materialFindings: [structuredClone(finding)] }, report(req, 1)] }; }
  async function advance(previous, next = repaired(), extra = {}) { return prepareAgentReviewState({ cwd: '.', base, intent, authorSessionId: 'author', now, snapshot: async () => next, delta, previous, repairRisk: 'ordinary', ...extra }); }
  function closure(state, index = 0, extra = {}) {
    return { ...report(state.request, index), reviewerId: `closure-${state.request.continuation.cycle}-${index}`, sessionId: `closure-session-${state.request.continuation.cycle}-${index}`, coveredScope: state.request.continuation.mode === 'full' ? [...new Set([...state.request.intent.scope, ...state.request.continuation.deltaPaths])] : state.request.continuation.deltaPaths, closure: { coveredDelta: state.request.continuation.deltaPaths, interactionsChecked: true, ordinarySemantics: true, resolvedFindings: state.request.continuation.findings.map(card => card.id) }, ...extra };
  }
  async function check(state, extra = {}) { return verifyAgentReview({ cwd: '.', ...state, snapshot: async () => state.request.candidate, delta, now, ...extra }); }
  it('preserves unchanged complete, partial, failing and advisory-only old state without reset', async () => {
    const req = await request();
    for (const reports of [[], [report(req)], [report(req), report(req, 1)], [{ ...report(req), verdict: 'fail', materialFindings: [finding] }], [{ ...report(req), advisoryFindings: ['Optional polish'] }, report(req, 1)]]) {
      const previous = { request: req, reports }; const state = await prepareAgentReviewState({ cwd: '.', base, intent, authorSessionId: 'author', now, snapshot, previous }); expect(state).toEqual(previous);
    }
    expect((await verify(req, [{ ...report(req), advisoryFindings: ['Optional polish'] }, report(req, 1)])).status).toBe('reviewed');
    expect((await verify(req, [{ ...report(req), verdict: 'fail', advisoryFindings: ['Optional polish'] }, report(req, 1)])).status).toBe('needs_agent_review');
  });
  it('admits one fresh narrow closure with bound finding cards and actual interactions', async () => {
    const state = await advance(await initial()); expect(state.request.roles).toEqual(['closure']); expect(state.history).toHaveLength(1); expect(state.request.continuation.findings).toHaveLength(1);
    state.reports = await recordAgentReview({ cwd: '.', ...state, report: closure(state), snapshot: async () => state.request.candidate, delta, now });
    expect((await check(state)).status).toBe('reviewed'); expect(await advance(state, state.request.candidate)).toEqual(state); expect(await advance(state, state.request.candidate, { fullRefresh: true })).toEqual(state);
  });
  it('retains findings from failed closure alongside earlier unresolved cards', async () => {
    const first = await advance(await initial()); first.reports = [closure(first, 0, { verdict: 'fail', materialFindings: [{ ...finding, mechanism: 'second failure' }] })];
    const second = await advance(first, repaired(2)); expect(second.request.continuation.findings).toHaveLength(2); second.reports = [closure(second)]; expect((await check(second)).status).toBe('reviewed');
  });
  it.each(['security', 'control', 'schema', 'instructions', 'unknown'])('escalates semantic repair risk %s to full2', async repairRisk => {
    const state = await advance(await initial(), repaired(), { repairRisk }); expect(state.request.roles).toEqual(['correctness', 'security']); state.reports = [closure(state), closure(state, 1)]; expect((await check(state)).status).toBe('reviewed');
  });
  it.each(['security', 'control', 'schema', 'instructions', 'unknown'])('escalates finding risk %s regardless of ordinary filename', async risk => {
    const prior = await initial(); prior.reports[0].materialFindings[0].risk = risk;
    const state = await advance(prior); expect(state.request.roles).toHaveLength(2);
  });
  it('escalates old findings with unknown semantics and control paths', async () => {
    const prior = await initial(); delete prior.reports[0].materialFindings[0].risk; expect((await advance(prior)).request.roles).toHaveLength(2);
    const scoped = { ...intent, scope: ['source.txt', 'scripts/agent-review-session.mjs'] }; const req = await prepareAgentReview({ cwd: '.', base, intent: scoped, authorSessionId: 'author', now, snapshot });
    const previous = { request: req, reports: [0, 1].map(index => ({ ...report(req, index), coveredScope: scoped.scope })) };
    const state = await advance(previous, { ...repaired(), changedPaths: scoped.scope }, { intent: scoped, delta: async () => ['scripts/agent-review-session.mjs'] }); expect(state.request.roles).toHaveLength(2);
  });
  it('refuses missing prior floor, zero-finding failure, dirty and non-changing committed repairs', async () => {
    const prior = await initial(); expect((await advance({ ...prior, reports: prior.reports.slice(0, 1) })).request.continuation.mode).toBe('full');
    expect((await advance({ ...prior, reports: [{ ...prior.reports[0], materialFindings: [] }, prior.reports[1]] })).request.continuation.mode).toBe('full');
    await expect(advance(prior, { ...repaired(), clean: false })).rejects.toThrow('clean committed');
    await expect(advance(prior, { ...repaired(), workingDigest: candidate.workingDigest })).rejects.toThrow('committed lineage');
    await expect(advance(prior, repaired(), { delta: async () => [] })).rejects.toThrow('scope is invalid');
  });
  it('does not silently restart lineage or budget on changed scope, criteria or author', async () => {
    const prior = await initial();
    for (const extra of [{ intent: { ...intent, scope: ['source.txt', 'other.txt'] } }, { intent: { ...intent, criteria: 'new criteria' } }, { authorSessionId: 'new-author' }]) await expect(advance(prior, repaired(), extra)).rejects.toThrow('changed execution approach');
  });
  it('uses fresh full2 coverage for an ancestor-preserving base advance while retaining history/cards/budget', async () => {
    const prior = await initial(); const next = { ...repaired(), base: 'f'.repeat(40) }; const integrationDelta = async () => ['incoming.txt', 'source.txt'];
    const state = await advance(prior, next, { base: next.base, delta: integrationDelta }); expect(state.request.continuation.mode).toBe('full'); expect(state.request.continuation.cycle).toBe(1); expect(state.request.continuation.findings).toHaveLength(1); expect(state.history[0].request.candidate.base).toBe(base);
    state.reports = [closure(state), closure(state, 1)]; expect((await check(state, { delta: integrationDelta })).status).toBe('reviewed');
    const missingIntegration = closure(state); missingIntegration.coveredScope = ['source.txt']; expect((await check({ ...state, reports: [missingIntegration, closure(state, 1)] }, { delta: integrationDelta })).status).toBe('needs_agent_review');
    await expect(advance(prior, next, { base: next.base, delta: async () => { throw new Error('base is not an authenticated ancestor of candidate'); } })).rejects.toThrow('nonancestor integration');
  });
  it('rejects erased history/cards, altered scopes/deltas and reused cold execution identities', async () => {
    const state = await advance(await initial()); state.reports = [closure(state)];
    for (const mutate of [value => { value.history = []; }, value => { value.request.continuation.findings = []; value.reports = [closure(value)]; }, value => { value.history[0].reports[0].materialFindings = []; }, value => { value.request.continuation.deltaPaths = ['other.txt']; value.reports = []; }, value => { value.history[0].request.intent.scope = ['other.txt']; }]) {
      const altered = structuredClone(state); mutate(altered); expect((await check(altered)).status).toBe('needs_agent_review');
    }
    expect((await check(state, { delta: async () => ['other.txt'] })).reason).toContain('actual committed repair delta');
    const reused = closure(state, 0, { reviewerId: state.history[0].reports[0].sessionId }); expect((await check({ ...state, reports: [reused] })).reason).toContain('duplicated');
  });
  it('does not erase an old card when only one of two focused roles closes it', async () => {
    const first = await advance(await initial(), repaired(), { repairRisk: 'control' }); first.reports = [closure(first), closure(first, 1, { verdict: 'fail', materialFindings: [{ ...finding, mechanism: 'unclosed interaction' }] })];
    const second = await advance(first, repaired(2)); expect(second.request.continuation.findings).toHaveLength(2); expect(second.request.continuation.findings[0].id).toBe(first.request.continuation.findings[0].id);
  });
  it('refuses incomplete finding/interactions closure and independent semantic escalation', async () => {
    const state = await advance(await initial());
    for (const mutation of [{ resolvedFindings: [] }, { interactionsChecked: false }, { ordinarySemantics: false }]) {
      const observation = closure(state); Object.assign(observation.closure, mutation); expect((await check({ ...state, reports: [observation] })).status).toBe('needs_agent_review');
    }
  });
  it('recovers unavailable or semantically escalated review on the same SHA through explicit full refresh', async () => {
    const initialState = await initial(); const partial = { ...initialState, reports: initialState.reports.slice(0, 1) };
    const refreshed = await advance(partial, candidate, { fullRefresh: true }); expect(refreshed.request.continuation.mode).toBe('full'); expect(refreshed.request.continuation.deltaPaths).toEqual([]); refreshed.reports = [closure(refreshed), closure(refreshed, 1)]; expect((await check(refreshed)).status).toBe('reviewed');
    const first = await advance(initialState); const observation = closure(first); observation.closure.ordinarySemantics = false; first.reports = [observation];
    expect(await advance(first, first.request.candidate)).toEqual(first);
    const escalated = await advance(first, first.request.candidate, { fullRefresh: true }); expect(escalated.request.roles).toHaveLength(2); expect(escalated.request.continuation.cycle).toBe(2); escalated.reports = [closure(escalated), closure(escalated, 1)]; expect((await check(escalated)).status).toBe('reviewed');
  });
  it('restores expired coverage only through full2 refresh while preserving its budget and findings', async () => {
    const prior = await initial(); const refreshTime = 86401001;
    const refreshed = await advance(prior, candidate, { fullRefresh: true, now: () => refreshTime }); expect(refreshed.request.continuation.mode).toBe('full'); expect(refreshed.request.continuation.findings).toHaveLength(1);
    refreshed.reports = [0, 1].map(index => closure(refreshed, index, { completedAt: refreshTime })); expect((await check(refreshed, { now: () => refreshTime })).status).toBe('reviewed');
    const next = await advance(refreshed, repaired(2), { now: () => refreshTime }); expect(next.request.continuation.cycle).toBe(2); next.reports = [closure(next, 0, { completedAt: refreshTime })]; expect((await check(next, { now: () => refreshTime })).status).toBe('reviewed');
  });
  it('refreshes full coverage from an earlier dirty unreviewable snapshot', async () => {
    const req = await prepareAgentReview({ cwd: '.', base, intent, authorSessionId: 'author', snapshot: async () => ({ ...candidate, clean: false }), now });
    const state = await advance({ request: req, reports: [] }); expect(state.request.continuation.mode).toBe('full'); state.reports = [closure(state), closure(state, 1)]; expect((await check(state)).status).toBe('reviewed');
  });
  it('does not renew root coverage expiry with a fresh closure', async () => {
    const state = await advance(await initial(), repaired(), { now: () => 2000 }); const observation = closure(state, 0, { completedAt: 2000 });
    expect((await check({ ...state, reports: [observation] }, { now: () => 2001, maxAgeMs: 1000 })).reason).toContain('expired');
  });
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ownerDecision = 'Synthetic explicit owner authorization for one additional full review';
  function ownerApproval(previous, next) { return { priorRequestDigest: digest(previous.request), candidateDigest: digest(next), ownerDecision }; }
  async function manual(previous, next = repaired(3), extra = {}) {
    return advance(previous, next, { fullRefresh: true, ownerContinuation: ownerApproval(previous, next), ...extra });
  }
  const fail = (state, index, mechanism) => closure(state, index, { verdict: 'fail', materialFindings: [{ ...finding, mechanism }] });
  async function thirdFailed() {
    const first = await advance(await initial()); first.reports = [closure(first)];
    const second = await advance(first, repaired(2)); second.reports = [fail(second, 0, 'second escape')];
    const third = await advance(second, repaired(3)); third.reports = [fail(third, 0, 'third escape'), closure(third, 1)];
    return third;
  }
  function rethinkFor(state, extra = {}) {
    return { priorRequestDigest: digest(state.request), reviewerId: 'simplicity-reviewer', sessionId: 'simplicity-session', completedAt: 1000, findingClasses: [{ class: 'non-canonical specifier escapes', findingIds: findingIds([...state.history, state]) }], pattern: 'One recurring class: every round found another specifier escape', rootCause: 'A growing denylist of import specifiers', simplicityCheck: 'An allowlist of canonical specifiers removes the whole class', alternatives: ['Allowlist canonical relative specifiers', 'Reuse the TypeScript module resolver'], decision: 'change', rationale: 'Same intent and scope; replace the denylist with an allowlist', lesson: 'growing specifier denylist → allowlist the canonical forms', ...extra };
  }
  it('runs cycle 3 automatically as a full review while retaining unresolved cards', async () => {
    const first = await advance(await initial()); first.reports = [closure(first)];
    const second = await advance(first, repaired(2)); expect(second.request.continuation.cycle).toBe(2); expect(second.request.continuation.findings).toEqual([]); second.reports = [fail(second, 0, 'second escape')];
    const third = await advance(second, repaired(3)); expect(third.request.continuation).toMatchObject({ cycle: 3, mode: 'full' }); expect(third.request.roles).toEqual(['correctness', 'security']);
    expect(third.request.continuation.findings).toHaveLength(1); expect(third.history).toEqual([...second.history, { request: second.request, reports: second.reports }]);
    third.reports = [closure(third)]; expect((await check(third)).status).toBe('needs_agent_review');
    third.reports.push(closure(third, 1)); expect((await check(third)).status).toBe('reviewed');
    for (const mutate of [s => { s.request.continuation.mode = 'focused'; }, s => { s.history[2].reports[0].materialFindings = []; }]) {
      const changed = structuredClone(third); mutate(changed); expect((await check(changed)).status).not.toBe('reviewed');
    }
  });
  it('pauses after a failed cycle 3 until a rethink, then allows two automatic cycles and requires the owner at cycle 6', async () => {
    const third = await thirdFailed(); const rethink = rethinkFor(third);
    expect((await check(third, { snapshot: async () => repaired(4) })).reason).toContain('record a rethink');
    for (const extra of [{}, { fullRefresh: true }]) await expect(advance(third, repaired(4), extra)).rejects.toThrow('record a rethink');
    const fourth = await advance(third, repaired(4), { rethink });
    expect(fourth.request.continuation).toMatchObject({ cycle: 4, mode: 'full', rethink }); expect(fourth.request.roles).toEqual(['correctness', 'security']);
    expect(fourth.history).toEqual([...third.history, { request: third.request, reports: third.reports }]); expect(fourth.request.continuation.findings).toHaveLength(2);
    expect(await advance(fourth, repaired(4), { rethink })).toEqual(fourth); expect(await advance(fourth, repaired(4), { rethink, fullRefresh: true })).toEqual(fourth);
    fourth.reports = [fail(fourth, 0, 'fourth escape'), closure(fourth, 1)]; expect((await check(fourth)).status).toBe('needs_agent_review');
    for (const mutate of [s => { delete s.request.continuation.rethink; }, s => { s.request.continuation.mode = 'focused'; }, s => { s.request.continuation.rethink.findingClasses[0].findingIds.pop(); }, s => { s.request.continuation.rethink.decision = 'intent'; }, s => { s.request.continuation.rethink.priorRequestDigest = 'f'.repeat(64); }]) {
      const changed = structuredClone(fourth); mutate(changed); expect((await check(changed)).reason).not.toContain('unresolved material');
    }
    const fifth = await advance(fourth, repaired(5), { rethink }); expect(fifth.request.continuation.cycle).toBe(5); expect(fifth.request.continuation.rethink).toBeUndefined();
    expect(fifth.history[4].request.continuation.rethink).toEqual(rethink);
    expect((await check({ ...fifth, reports: [closure(fifth, 0, { reviewerId: 'simplicity-reviewer' })] })).reason).toContain('duplicated');
    expect([...agentReviewIdentities(fifth)]).toEqual(expect.arrayContaining(['simplicity-reviewer', 'simplicity-session', 'agent-0', 'session-0']));
    const reviewed = structuredClone(fifth); reviewed.reports = fifth.request.roles.map((_, index) => closure(fifth, index)); expect((await check(reviewed)).status).toBe('reviewed');
    fifth.reports = fifth.request.roles.map((_, index) => index === 0 ? fail(fifth, 0, 'fifth escape') : closure(fifth, index));
    expect((await check(fifth, { snapshot: async () => repaired(6) })).reason).toContain('cycle 6 requires an explicit owner continuation');
    await expect(advance(fifth, repaired(6), { fullRefresh: true })).rejects.toThrow('cycle 6 requires an explicit owner continuation');
    await expect(manual(fifth, repaired(6), { fullRefresh: false })).rejects.toThrow('explicit full refresh');
    for (const field of ['priorRequestDigest', 'candidateDigest']) await expect(manual(fifth, repaired(6), { ownerContinuation: { ...ownerApproval(fifth, repaired(6)), [field]: 'f'.repeat(64) } })).rejects.toThrow('differs from exact');
    await expect(manual(fifth, repaired(6), { intent: { ...intent, criteria: 'Changed goal' } })).rejects.toThrow('approved intent');
    const sixth = await manual(fifth, repaired(6)); expect(sixth.request.continuation).toMatchObject({ cycle: 6, mode: 'full', ownerContinuation: ownerApproval(fifth, repaired(6)) });
    expect(sixth.history).toHaveLength(6); expect(sixth.history[0].reports[0].materialFindings).toEqual([finding]);
    sixth.reports = [closure(sixth)]; expect((await check(sixth)).status).toBe('needs_agent_review'); sixth.reports.push(closure(sixth, 1)); expect((await check(sixth)).status).toBe('reviewed');
    expect(await manual(sixth, repaired(6), { ownerContinuation: sixth.request.continuation.ownerContinuation })).toEqual(sixth);
    for (const mutate of [s => { delete s.request.continuation.ownerContinuation; }, s => { s.request.continuation.mode = 'focused'; }, s => { delete s.history[4].request.continuation.rethink; }, s => { s.history = []; }]) {
      const changed = structuredClone(sixth); mutate(changed); expect((await check(changed)).status).not.toBe('reviewed');
    }
    sixth.reports[0] = fail(sixth, 0, 'sixth escape');
    await expect(advance(sixth, repaired(7), { fullRefresh: true })).rejects.toThrow('six review cycles are exhausted');
    await expect(manual(sixth, repaired(7))).rejects.toThrow('applies at cycle 6');
    expect((await check(sixth, { snapshot: async () => repaired(7) })).status).toBe('needs_rescope');
  });
  it('binds the rethink to the failed round, every finding card, a fresh reviewer and the approved intent', async () => {
    const third = await thirdFailed(); const ids = rethinkFor(third).findingClasses[0].findingIds; expect(ids).toHaveLength(3);
    for (const [extra, message] of [
      [{ priorRequestDigest: 'f'.repeat(64) }, 'differs from exact previous request'], [{ reviewerId: 'author' }, 'not fresh'], [{ sessionId: third.history[0].reports[0].sessionId }, 'not fresh'],
      [{ findingClasses: [{ class: 'partial', findingIds: ids.slice(1) }] }, 'every finding card'], [{ findingClasses: [{ class: 'one', findingIds: ids }, { class: 'two', findingIds: ids.slice(0, 1) }] }, 'every finding card'],
      [{ decision: 'intent' }, 'requires an owner regroup'], [{ decision: 'skip' }, 'decision is invalid'], [{ lesson: 'no arrow here' }, 'pattern → simpler path'], [{ lesson: `${'x'.repeat(240)} → y` }, 'lesson is invalid'],
      [{ alternatives: [] }, 'alternatives'], [{ rootCause: '' }, 'rootCause is invalid'], [{ completedAt: 999 }, 'predates'], [{ completedAt: 1001 }, 'follows the request'], [{ extra: true }, 'rethink schema'],
    ] as const) await expect(advance(third, repaired(4), { rethink: rethinkFor(third, extra) })).rejects.toThrow(message);
    const unreviewed = { ...third, reports: [] };
    await expect(advance(unreviewed, repaired(4), { rethink: rethinkFor(unreviewed, { completedAt: 999 }) })).rejects.toThrow('predates');
    const second = structuredClone(third.history[2]); second.history = third.history.slice(0, 2);
    await expect(advance(second, repaired(3), { rethink: rethinkFor(second) })).rejects.toThrow('only at the cycle 4 transition');
    await expect(advance(undefined, repaired(1), { rethink: rethinkFor(third) })).rejects.toThrow('preserved previous state');
    const expanded = { ...intent, scope: ['source.txt', 'new.txt'] };
    const regroup = { priorRequestDigest: digest(third.request), priorIntentDigest: digest(third.request.intent), nextIntentDigest: digest(expanded), ownerDecision: 'Synthetic owner decision for the intent change' };
    await expect(advance(third, repaired(4), { intent: expanded, regroup, fullRefresh: true, rethink: rethinkFor(third) })).rejects.toThrow('requires an owner regroup');
    const changed = await advance(third, repaired(4), { intent: expanded, regroup, fullRefresh: true, rethink: rethinkFor(third, { decision: 'intent' }) });
    expect(changed.request.continuation).toMatchObject({ cycle: 4, mode: 'full', regroup }); expect(changed.request.intent).toEqual(expanded);
  });
  it('keeps an expired cycle 4 while the spec repeats its rethink and refreshes it as cycle 5 once the rethink is dropped', async () => {
    const third = await thirdFailed(); const rethink = rethinkFor(third); const fourth = await advance(third, repaired(4), { rethink });
    fourth.reports = [closure(fourth), closure(fourth, 1)]; const late = () => 86402000;
    expect((await check(fourth, { now: late })).reason).toContain('expired');
    expect(await advance(fourth, repaired(4), { rethink, fullRefresh: true, now: late })).toEqual(fourth);
    const refreshed = await advance(fourth, repaired(4), { fullRefresh: true, now: late });
    expect(refreshed.request.continuation).toMatchObject({ cycle: 5, mode: 'full', deltaPaths: [] }); expect(refreshed.request.continuation.rethink).toBeUndefined();
  });
  it('needs no rethink when cycle 3 passed, for example before a later base integration', async () => {
    const third = await thirdFailed(); third.reports = [closure(third), closure(third, 1)]; expect((await check(third)).status).toBe('reviewed');
    const next = { ...repaired(4), base: 'f'.repeat(40) }; const integrationDelta = async (_cwd, before, after) => before.head === third.request.candidate.head && after.head === next.head ? ['incoming.txt', 'source.txt'] : delta(_cwd, before, after);
    const fourth = await advance(third, next, { base: next.base, delta: integrationDelta });
    expect(fourth.request.continuation).toMatchObject({ cycle: 4, mode: 'full' }); expect(fourth.request.continuation.rethink).toBeUndefined();
  });
  it('keeps a cycle 3 owner continuation recorded before cycle 3 became automatic and refuses one at cycles 2, 4 and 5', async () => {
    const first = await advance(await initial(), repaired(1), { fullRefresh: true }); const second = await advance(first, repaired(2), { fullRefresh: true });
    for (const [previous, next] of [[first, repaired(2)], [second, repaired(3)]]) await expect(manual(previous, next)).rejects.toThrow('applies at cycle 6');
    const third = await advance(second, repaired(3), { fullRefresh: true }); third.request.continuation.ownerContinuation = ownerApproval(second, repaired(3));
    expect(third.request.continuation).toMatchObject({ cycle: 3, mode: 'full' });
    expect((await check(third)).status).toBe('needs_agent_review'); third.reports = [closure(third), closure(third, 1)]; expect((await check(third)).status).toBe('reviewed');
    expect(await manual(third, repaired(3), { ownerContinuation: third.request.continuation.ownerContinuation })).toEqual(third);
    for (const mutate of [s => { s.request.continuation.ownerContinuation.priorRequestDigest = 'f'.repeat(64); }, s => { s.request.continuation.ownerContinuation.candidateDigest = 'f'.repeat(64); }, s => { s.request.continuation.cycle = 4; }]) {
      const changed = structuredClone(third); mutate(changed); expect((await check(changed)).status).not.toBe('reviewed');
    }
    third.reports[0] = fail(third, 0, 'third escape');
    await expect(manual(third, repaired(4))).rejects.toThrow('applies at cycle 6');
    const fourth = await advance(third, repaired(4), { rethink: rethinkFor(third) }); fourth.reports = [closure(fourth), closure(fourth, 1)];
    await expect(manual(fourth, repaired(5))).rejects.toThrow('applies at cycle 6');
  });

});

describe('explicit owner regroup without reset', () => {
  const expanded = { ...intent, scope: ['source.txt', 'new.txt'], criteria: 'Preserve behavior and explicitly approved additional source' };
  const finding = { mechanism: 'lost clamp', precondition: 'late parcel', requirement: 'no early cycle', effect: 'early renewal', risk: 'ordinary' };
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const delta = async (_cwd, before, after) => before.head === after.head ? [] : after.changedPaths;
  const next = (number = 1, changedPaths = expanded.scope) => ({ ...candidate, head: String(number).repeat(40), tree: String(number + 2).repeat(40), workingDigest: String(number + 4).repeat(64), indexDigest: (number + 6).toString(16).repeat(64), changedPaths });
  function approval(previous, approved = expanded) {
    return { priorRequestDigest: digest(previous.request), priorIntentDigest: digest(previous.request.intent), nextIntentDigest: digest(approved), ownerDecision: 'Synthetic test approval for the explicitly expanded scope' };
  }
  async function initial() {
    const req = await request();
    return { request: req, reports: [{ ...report(req), verdict: 'fail', materialFindings: [finding] }, report(req, 1)] };
  }
  async function regroup(previous, candidate = next(), extra = {}) {
    return prepareAgentReviewState({ cwd: '.', base, intent: expanded, authorSessionId: 'author', now, snapshot: async () => candidate, modeCheck: async () => false, delta, previous, fullRefresh: true, regroup: approval(previous), ...extra });
  }
  function complete(state, prefix = 'regroup') {
    return state.request.roles.map((role, index) => ({ ...report(state.request, index), role, reviewerId: `${prefix}-${index}`, sessionId: `${prefix}-session-${index}`, coveredScope: state.request.continuation.mode === 'full' ? [...new Set([...state.request.intent.scope, ...state.request.continuation.deltaPaths])] : state.request.continuation.deltaPaths, closure: { coveredDelta: state.request.continuation.deltaPaths, interactionsChecked: true, ordinarySemantics: state.request.continuation.mode === 'closure', resolvedFindings: state.request.continuation.findings.map(card => card.id) } }));
  }
  async function check(state, extra = {}) {
    return verifyAgentReview({ cwd: '.', ...state, snapshot: async () => state.request.candidate, delta, now, ...extra });
  }
  it('binds expanded scope to exact requests and preserves history, findings and consumed budget', async () => {
    const root = await initial();
    const first = await prepareAgentReviewState({ cwd: '.', base, intent, authorSessionId: 'author', now, snapshot: async () => next(1, intent.scope), delta, previous: root, fullRefresh: true });
    const state = await regroup(first, next(2));
    expect(state.history).toEqual([...first.history, { request: first.request, reports: first.reports }]);
    expect(state.request.continuation).toMatchObject({ cycle: 2, mode: 'full', regroup: approval(first), findings: first.request.continuation.findings });
    expect(state.request.intent).toEqual(expanded); expect(state.request.authorSessionId).toBe('author');
    expect(state.request.roles).toEqual(['correctness', 'security']); expect(state.reports).toEqual([]);
    expect((await check(state)).status).toBe('needs_agent_review');
    state.reports = complete(state); expect((await check(state)).status).toBe('reviewed');
    const third = await regroup(state, next(3), { regroup: undefined, fullRefresh: false });
    expect(third.request.continuation).toMatchObject({ cycle: 3, mode: 'full' }); expect(third.request.continuation.regroup).toBeUndefined();
    const wider = { ...expanded, scope: [...expanded.scope, 'third.txt'] };
    expect((await regroup(state, next(3), { intent: wider, regroup: approval(state, wider) })).request.continuation).toMatchObject({ cycle: 3, mode: 'full', regroup: approval(state, wider) });
  });
  it('forces fresh full2 on same-SHA expansion and keeps pending and completed prepare idempotent without renewing expiry', async () => {
    const prior = await initial(); const decision = approval(prior); const state = await regroup(prior, candidate);
    expect(state.request.continuation.deltaPaths).toEqual([]); expect(state.request.continuation.mode).toBe('full');
    expect(state.request.roles).toHaveLength(2); expect(state.reports).toEqual([]);
    for (const completed of [false, true]) {
      if (completed) state.reports = complete(state);
      const repeated = await regroup(state, candidate, { regroup: decision, now: () => 86402000 });
      expect(repeated).toEqual(state); expect(repeated.request.preparedAt).toBe(1000);
      expect((await check(repeated, { now: () => 86402000 })).reason).toContain('expired');
    }
  });
  it('retains historic regroup metadata through a later ordinary continuation and retries', async () => {
    const prior = await initial(); const decision = approval(prior); const first = await regroup(prior);
    first.reports = complete(first);
    const second = await regroup(first, next(2), { regroup: decision, fullRefresh: false, repairRisk: 'ordinary' }); second.reports = complete(second, 'later');
    expect(second.request.continuation.mode).toBe('closure');
    expect(second.request.continuation.cycle).toBe(2); expect(second.request.continuation.regroup).toBeUndefined();
    expect(second.history[1].request.continuation.regroup).toEqual(decision); expect((await check(second)).status).toBe('reviewed');
    expect(await regroup(second, next(2), { regroup: decision })).toEqual(second);
    expect(await regroup(second, next(2), { regroup: decision, now: () => 86402000 })).toEqual(second);
    expect((await check(second, { now: () => 86402000 })).reason).toContain('expired');
    await expect(regroup(second, next(2), { regroup: { ...decision, ownerDecision: 'Different decision' } })).rejects.toThrow('preserved transition');
  });
  it('requires explicit full refresh, unchanged author and preserved previous state', async () => {
    const prior = await initial();
    await expect(regroup(prior, next(), { regroup: undefined })).rejects.toThrow('changed execution approach');
    await expect(regroup(prior, next(), { fullRefresh: false })).rejects.toThrow('explicit full refresh');
    await expect(regroup(prior, next(), { authorSessionId: 'other-author' })).rejects.toThrow('changed execution approach');
    await expect(regroup(prior, next(), { previous: undefined })).rejects.toThrow('preserved previous state');
  });
  it.each(['priorRequestDigest', 'priorIntentDigest', 'nextIntentDigest'])('rejects mismatched %s at prepare and persisted verification', async field => {
    const prior = await initial(); const decision = { ...approval(prior), [field]: 'f'.repeat(64) };
    await expect(regroup(prior, next(), { regroup: decision })).rejects.toThrow('differs from exact');
    const state = await regroup(prior); state.request.continuation.regroup[field] = 'f'.repeat(64);
    expect((await check(state)).status).toBe('needs_agent_review');
  });
  it.each([
    { ...intent, criteria: 'Replacement criteria only' }, { ...intent, risk: 'unknown' },
    { ...intent, scope: ['new.txt'] }, { ...expanded, risk: 'prose' }, { ...expanded, risk: 'routine' },
  ])('rejects equal, replaced or shrunk scope and non-full review risk: %j', async approved => {
    const prior = await initial();
    await expect(regroup(prior, candidate, { intent: approved, regroup: approval(prior, approved) })).rejects.toThrow(/expanded scope|exceeds approved scope/);
  });
  it.each([
    { ownerDecision: '' }, { ownerDecision: 'x'.repeat(4097) }, { ownerDecision: true },
    { priorRequestDigest: 'invalid' }, { extra: true }, { nextIntentDigest: undefined },
  ])('refuses invalid regroup metadata: %j', async mutation => {
    const prior = await initial();
    await expect(regroup(prior, next(), { regroup: { ...approval(prior), ...mutation } })).rejects.toThrow();
    const state = await regroup(prior); Object.assign(state.request.continuation.regroup, mutation);
    expect((await check(state)).status).toBe('needs_agent_review');
  });
  it('cannot erase history, findings or expiry, or bypass dirty, nonancestor and current source checks', async () => {
    const prior = await initial();
    await expect(regroup(prior, { ...next(), clean: false })).rejects.toThrow('clean committed');
    await expect(regroup(prior, next(), { delta: async () => { throw new Error('not an authenticated ancestor'); } })).rejects.toThrow('nonancestor integration');
    const state = await regroup(prior); state.reports = complete(state);
    for (const mutate of [value => { value.history = []; }, value => { value.request.continuation.findings = []; }, value => { value.request.continuation.mode = 'closure'; }, value => { value.request.preparedAt = 1001; }]) {
      const altered = structuredClone(state); mutate(altered); expect((await check(altered)).status).toBe('needs_agent_review');
    }
    expect((await check(state, { snapshot: async () => ({ ...state.request.candidate, clean: false }) })).status).toBe('needs_agent_review');
    expect((await check(state, { delta: async () => ['concealed-permission-change.txt'] })).reason).toContain('actual committed repair delta');
    expect((await check(state, { snapshot: async () => ({ ...state.request.candidate, indexDigest: 'f'.repeat(64) }) })).reason).toContain('candidate changed');
  });
  it('binds real permission changes to the committed delta and refuses later permission drift', async () => {
    const { cwd, base: baseline, git } = await fixture();
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const previous = await prepareAgentReviewState({ cwd, base: baseline, intent, authorSessionId: 'author', now });
    await chmod(join(cwd, 'source.txt'), 0o755); git('add', 'source.txt'); git('commit', '-qm', 'permission change');
    const state = await prepareAgentReviewState({ cwd, base: baseline, intent: expanded, authorSessionId: 'author', now, previous, fullRefresh: true, regroup: approval(previous) });
    expect(state.request.continuation.deltaPaths).toEqual(['source.txt']); expect(state.request.roles).toHaveLength(2);
    state.reports = complete(state); expect((await verifyAgentReview({ cwd, ...state, now })).status).toBe('reviewed');
    await chmod(join(cwd, 'source.txt'), 0o644);
    expect((await verifyAgentReview({ cwd, ...state, now })).status).toBe('needs_agent_review');
    await expect(recordAgentReview({ cwd, ...state, report: complete(state, 'drift')[0], now })).rejects.toThrow('candidate changed');
  });
  it('requires CLI metadata for expansion and rejects a separate regroup command without mutating state', async () => {
    const { cwd, git } = await fixture();
    await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    const specPath = join(directory, 'intent.json'); const statePath = join(directory, 'session.json');
    const spec = { intent, base: baseline, authorSessionId: 'author', simplicityPreCheck }; await writeFile(specPath, JSON.stringify(spec));
    const script = resolve('scripts/agent-review-session.mjs');
    const invoke = (...args: string[]) => {
      try { return execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }); }
      catch (error) { throw new Error(error instanceof Error && 'stdout' in error && 'stderr' in error ? String(error.stdout) + String(error.stderr) : String(error)); }
    };
    invoke('prepare'); const before = await readFile(statePath, 'utf8');
    await writeFile(specPath, JSON.stringify({ ...spec, intent: expanded, fullRefresh: true }));
    expect(() => invoke('prepare')).toThrow('changed execution approach'); expect(await readFile(statePath, 'utf8')).toBe(before);
    expect(() => invoke('regroup')).toThrow('use prepare'); expect(await readFile(statePath, 'utf8')).toBe(before);
    const previous = JSON.parse(before); await writeFile(specPath, JSON.stringify({ ...spec, intent: expanded, fullRefresh: true, regroup: approval(previous) }));
    expect(JSON.parse(invoke('prepare')).status).toBe('needs_agent_review');
    const state = JSON.parse(await readFile(statePath, 'utf8')); expect(state.request.roles).toHaveLength(2); expect(state.reports).toEqual([]); expect(state.history).toEqual([previous]);
  }, 30_000);
});

describe('actual source snapshot without candidate execution', () => {
  it('runs automatic cycles, the rethink pause and the owner cycle through actual Git and CLI, retaining history and refusing a seventh', async () => {
    const { cwd, git } = await fixture();
    await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    const specPath = join(directory, 'intent.json'), statePath = join(directory, 'session.json');
    const spec = { intent, base: baseline, authorSessionId: 'author', fullRefresh: true };
    const script = resolve('scripts/agent-review-session.mjs');
    const invoke = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
    const commit = async number => { await writeFile(join(cwd, 'source.txt'), `candidate ${number}\n`); git('add', 'source.txt'); git('commit', '-qm', `candidate ${number}`); };
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const finding = { mechanism: 'wrong bytes', precondition: 'read source', requirement: 'preserve behavior', effect: 'wrong result', risk: 'ordinary' };
    const record = async (label, failing = -1) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      for (const index of [0, 1]) {
        const reportPath = join(directory, `${label}-${index}.json`);
        const scope = state.request.version === 1 ? intent.scope : [...new Set([...intent.scope, ...state.request.continuation.deltaPaths])];
        await writeFile(reportPath, JSON.stringify({ ...report(state.request, index), reviewerId: `${label}-${index}`, sessionId: `${label}-session-${index}`, coveredScope: scope, completedAt: Date.now(), ...(state.request.version === 2 ? { closure: { coveredDelta: state.request.continuation.deltaPaths, interactionsChecked: true, ordinarySemantics: false, resolvedFindings: state.request.continuation.findings.map(card => card.id) } } : {}), ...(index === failing ? { verdict: 'fail', materialFindings: [finding] } : {}) }));
        expect(invoke('record', reportPath).status).toBe(0);
      }
      return readFile(statePath, 'utf8');
    };
    await writeFile(specPath, JSON.stringify(spec)); await commit(0);
    expect(invoke('prepare').stderr).toContain('simplicityPreCheck'); await expect(readFile(statePath, 'utf8')).rejects.toThrow();
    await writeFile(specPath, JSON.stringify({ ...spec, simplicityPreCheck })); expect(invoke('prepare').status).toBe(0);
    expect(JSON.parse(await readFile(statePath, 'utf8')).request.simplicityPreCheck).toBe(simplicityPreCheck);
    await record('initial', 0);
    for (const number of [1, 2]) { await commit(number); expect(invoke('prepare').status).toBe(0); }
    await commit(3); expect(invoke('prepare').status).toBe(0);
    const third = JSON.parse(await readFile(statePath, 'utf8'));
    expect(third.request.continuation).toMatchObject({ cycle: 3, mode: 'full', deltaPaths: ['source.txt'] }); expect(third.request.continuation.ownerContinuation).toBeUndefined();
    expect(third.history[0].request.simplicityPreCheck).toBe(simplicityPreCheck);
    const thirdBytes = await record('third', 1); const failedThird = JSON.parse(thirdBytes);
    await commit(4); const refused = invoke('prepare'); expect(refused.status).not.toBe(0); expect(refused.stdout).toContain('needs_rescope'); expect(refused.stdout).toContain('record a rethink');
    expect(await readFile(statePath, 'utf8')).toBe(thirdBytes);
    const rethink = { priorRequestDigest: digest(failedThird.request), reviewerId: 'simplicity-reviewer', sessionId: 'simplicity-session', completedAt: Date.now(), findingClasses: [{ class: 'wrong bytes', findingIds: findingIds([...failedThird.history, failedThird]) }], pattern: 'The same wrong-bytes class recurs', rootCause: 'The source is rewritten instead of preserved', simplicityCheck: 'Preserving the original bytes removes the class', alternatives: ['Keep the original bytes'], decision: 'change', rationale: 'Same intent and scope', lesson: 'rewriting preserved bytes → keep the original bytes' };
    await writeFile(specPath, JSON.stringify({ ...spec, rethink: { ...rethink, priorRequestDigest: 'f'.repeat(64) } })); expect(invoke('prepare').status).not.toBe(0); expect(await readFile(statePath, 'utf8')).toBe(thirdBytes);
    await writeFile(specPath, JSON.stringify({ ...spec, rethink })); expect(invoke('prepare').status).toBe(0);
    const fourth = JSON.parse(await readFile(statePath, 'utf8'));
    expect(fourth.history).toEqual([...failedThird.history, { request: failedThird.request, reports: failedThird.reports }]);
    expect(fourth.request.continuation).toMatchObject({ cycle: 4, mode: 'full', rethink }); expect(fourth.history[0].reports[0].materialFindings).toEqual([finding]);
    const fourthBytes = await record('fourth'); expect(invoke('verify').status).toBe(0);
    expect(invoke('prepare').status).toBe(0); expect(await readFile(statePath, 'utf8')).toBe(fourthBytes);
    await commit(5); const branch = git('symbolic-ref', '--short', 'HEAD');
    git('checkout', '-q', '--detach', baseline); await writeFile(join(cwd, 'incoming.txt'), 'ancestor integration\n'); git('add', 'incoming.txt'); git('commit', '-qm', 'main integration source');
    const integratedBase = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', integratedBase); git('checkout', '-q', branch); git('merge', '-q', '--no-edit', integratedBase);
    const fifthSpec = { ...spec, base: integratedBase, rethink }; await writeFile(specPath, JSON.stringify(fifthSpec)); expect(invoke('prepare').status).toBe(0);
    const fifth = JSON.parse(await readFile(statePath, 'utf8'));
    expect(fifth.request.continuation).toMatchObject({ cycle: 5, mode: 'full', deltaPaths: ['incoming.txt', 'source.txt'] }); expect(fifth.request.continuation.rethink).toBeUndefined();
    const fifthBytes = await record('fifth', 0); expect(invoke('verify').status).not.toBe(0);
    await commit(6); expect(invoke('prepare').stdout).toContain('cycle 6 requires an explicit owner continuation'); expect(await readFile(statePath, 'utf8')).toBe(fifthBytes);
    const failedFifth = JSON.parse(fifthBytes);
    const sixthApproval = { priorRequestDigest: digest(failedFifth.request), candidateDigest: digest(await captureSessionCandidate(cwd, integratedBase)), ownerDecision: 'Synthetic separate fresh sixth fixture decision' };
    for (const rejected of [{ ...fifthSpec, ownerContinuation: { ...sixthApproval, candidateDigest: 'f'.repeat(64) } }, { ...fifthSpec, ownerContinuation: sixthApproval, fullRefresh: false }, { ...fifthSpec, ownerContinuation: sixthApproval, authorSessionId: 'other' }]) {
      await writeFile(specPath, JSON.stringify(rejected)); expect(invoke('prepare').status).not.toBe(0); expect(await readFile(statePath, 'utf8')).toBe(fifthBytes);
    }
    await writeFile(specPath, JSON.stringify({ ...fifthSpec, ownerContinuation: sixthApproval })); expect(invoke('prepare').status).toBe(0);
    const sixth = JSON.parse(await readFile(statePath, 'utf8'));
    expect(sixth.request.continuation).toMatchObject({ cycle: 6, mode: 'full', ownerContinuation: sixthApproval }); expect(sixth.history).toHaveLength(6);
    const sixthBytes = await record('sixth', 0);
    for (const mutate of [value => { value.history = []; }, value => { delete value.history[4].request.continuation.rethink; }, value => { value.history[0].reports[0].materialFindings = []; }]) {
      const altered = JSON.parse(sixthBytes); mutate(altered); await writeFile(statePath, JSON.stringify(altered)); expect(invoke('verify').status).not.toBe(0); expect(invoke('prepare').status).not.toBe(0);
    }
    await writeFile(statePath, sixthBytes); await commit(7);
    const seventhApproval = { priorRequestDigest: digest(JSON.parse(sixthBytes).request), candidateDigest: digest(await captureSessionCandidate(cwd, integratedBase)), ownerDecision: 'Synthetic unsupported seventh decision' };
    for (const rejected of [{ ...fifthSpec, ownerContinuation: seventhApproval }, fifthSpec]) { await writeFile(specPath, JSON.stringify(rejected)); expect(invoke('prepare').status).not.toBe(0); expect(await readFile(statePath, 'utf8')).toBe(sixthBytes); }
    expect(invoke('verify').status).not.toBe(0);
  }, 60_000); // Drives prepare/verify through Git and the CLI many times: about 7 s hosted, past 30 s under full local load.

  it('authenticates actual repair ancestry and deletions and refuses forked prior lineage', async () => {
    const { cwd, base, git } = await fixture(); await writeFile(join(cwd, 'source.txt'), 'first\n'); git('add', 'source.txt'); git('commit', '-qm', 'first'); const before = await captureSessionCandidate(cwd, base);
    await rm(join(cwd, 'source.txt')); await writeFile(join(cwd, 'new.txt'), 'replacement\n'); git('add', '-A'); git('commit', '-qm', 'repair'); const after = await captureSessionCandidate(cwd, base);
    expect(await captureAgentReviewDelta(cwd, before, after)).toEqual(['new.txt', 'source.txt']);
    await expect(captureAgentReviewDelta(cwd, { ...before, tree: 'f'.repeat(40) }, after)).rejects.toThrow('prior tree differs');
    await expect(captureAgentReviewDelta(cwd, after, before)).rejects.toThrow('not an authenticated ancestor');
  });
  it('runs actual CLI ordinary closure and keeps terminal PASS idempotent even with full refresh', async () => {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline); await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true }); const spec = { intent, base: baseline, authorSessionId: 'author', repairRisk: 'ordinary', simplicityPreCheck }; const specPath = join(directory, 'intent.json'); await writeFile(specPath, JSON.stringify(spec));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })); const statePath = join(directory, 'session.json');
    invoke('prepare'); const first = JSON.parse(await readFile(statePath, 'utf8'));
    for (const index of [0, 1]) { const reportPath = join(directory, `first-${index}.json`); await writeFile(reportPath, JSON.stringify({ ...report(first.request, index), completedAt: Date.now(), ...(index === 0 ? { verdict: 'fail', materialFindings: [{ mechanism: 'wrong bytes', precondition: 'read', requirement: 'right bytes', effect: 'wrong result', risk: 'ordinary' }] } : {}) })); invoke('record', reportPath); }
    const unchanged = await readFile(statePath, 'utf8'); expect(invoke('prepare').status).toBe('needs_agent_review'); expect(await readFile(statePath, 'utf8')).toBe(unchanged);
    await writeFile(join(cwd, 'source.txt'), 'repaired\n'); git('add', 'source.txt'); git('commit', '-qm', 'repair'); const prepared = invoke('prepare'); expect(prepared.request.roles).toEqual(['closure']); const state = JSON.parse(await readFile(statePath, 'utf8'));
    const reportPath = join(directory, 'closure.json'); await writeFile(reportPath, JSON.stringify({ ...report(state.request), reviewerId: 'fresh-closure', sessionId: 'fresh-closure-session', completedAt: Date.now(), closure: { coveredDelta: ['source.txt'], interactionsChecked: true, ordinarySemantics: true, resolvedFindings: state.request.continuation.findings.map(card => card.id) } })); expect(invoke('record', reportPath).status).toBe('reviewed');
    const reviewed = await readFile(statePath, 'utf8'); expect(invoke('prepare').status).toBe('reviewed'); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
    await writeFile(specPath, JSON.stringify({ ...spec, fullRefresh: true })); expect(invoke('prepare').status).toBe('reviewed'); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
  }, 30_000);
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
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent: { ...intent, risk: 'prose' }, base: baseline, authorSessionId: 'author', simplicityPreCheck }));
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
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent: { ...intent, risk: 'prose' }, base: baseline, authorSessionId: 'author', simplicityPreCheck }));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }));
    invoke('prepare'); const path = join(directory, 'session.json'); const victim = join(directory, 'sibling.json'); await link(path, victim);
    const before = await readFile(victim, 'utf8'); invoke('prepare'); expect(await readFile(victim, 'utf8')).toBe(before); expect(await readFile(path, 'utf8')).toBe(before);
    const state = JSON.parse(await readFile(path, 'utf8')); await rm(victim); await link(path, victim); const recordedBefore = await readFile(victim, 'utf8');
    const reportPath = join(directory, 'observed.json'); await writeFile(reportPath, JSON.stringify({ ...report(state.request), completedAt: Date.now() }));
    expect(invoke('record', reportPath).status).toBe('reviewed'); expect(await readFile(victim, 'utf8')).toBe(recordedBefore);
  });
  it('fails concurrent prepare/record closed without losing a recorded material finding', async () => {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent, base: baseline, authorSessionId: 'author', simplicityPreCheck }));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }));
    invoke('prepare'); const statePath = join(directory, 'session.json'); const state = JSON.parse(await readFile(statePath, 'utf8'));
    const failedPath = join(directory, 'failed.json'); const passPath = join(directory, 'pass.json');
    const findings = [{ mechanism: 'lost clamp', precondition: 'late parcel', requirement: 'no early cycle', effect: 'early renewal' }];
    await writeFile(failedPath, JSON.stringify({ ...report(state.request), completedAt: Date.now(), verdict: 'fail', materialFindings: findings }));
    await writeFile(passPath, JSON.stringify({ ...report(state.request, 1), completedAt: Date.now() }));
    // The recording owner pauses just before it publishes its new state, inside its transaction,
    // until the test ends its stdin, so both rivals meet a live lock however the runner schedules them.
    const holdPublish = "import { once } from 'node:events'; import { writeSync } from 'node:fs'; import promises from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module'; const { rename } = promises;" +
      " promises.rename = async (from, to) => { if (String(to).endsWith('session.json')) { writeSync(3, 'held'); await once(process.stdin.resume(), 'end'); } return rename(from, to); }; syncBuiltinESMExports();";
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(holdPublish)}`, script, 'record', failedPath], { cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const completed = closed(child);
    try {
      await Promise.race([once(child.stdio[3], 'data'), completed.then(code => { throw new Error(`record exited ${code} before publishing its state: ${stderr}`); })]);
      expect((await stat(join(directory, '.session.lock'))).isFile()).toBe(true);
      const contenders = ['record', 'prepare'].map(async verb => {
        const args = verb === 'record' ? [verb, passPath] : [verb];
        const rival = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let diagnostics = '';
        rival.stderr.on('data', bytes => { diagnostics += bytes; });
        const code = await closed(rival);
        if (code !== 1) throw new Error(`concurrent ${verb} unexpectedly completed`);
        return diagnostics;
      });
      // A first rejection must not leave its sibling using the fixture.
      const results = await Promise.allSettled(contenders);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        expect(result.value).toContain('session transaction is busy');
      }
    } finally { child.stdin.end(); await completed; }
    expect(await completed).toBe(0); expect(stderr).toBe(''); expect(JSON.parse(stdout).status).toBe('needs_agent_review');
    expect(invoke('record', passPath).status).toBe('needs_agent_review');
    const recorded = JSON.parse(await readFile(statePath, 'utf8')); expect(recorded.request.id).toBe(state.request.id); expect(recorded.reports).toHaveLength(2); expect(recorded.reports[0].materialFindings).toEqual(findings);
    expect(invoke('prepare').status).toBe('needs_agent_review'); expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(recorded);
    await expect(stat(join(directory, '.session.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(directory, '.session.lock'), 'existing owner'); expect(() => invoke('prepare')).toThrow('session transaction is busy'); expect(await readFile(join(directory, '.session.lock'), 'utf8')).toBe('existing owner');
  }, 30_000);
  it('keeps two 4096-path reports usable when persisted state exceeds the input-file bound', async () => {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    const scope = ['source.txt', ...Array.from({ length: 4095 }, (_, index) => `scope/${index}-${'a'.repeat(88)}`)];
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent: { ...intent, scope }, base: baseline, authorSessionId: 'author', simplicityPreCheck }));
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
  }, 30_000);
  it('does not run a candidate clean filter while hashing bytes', async () => {
    const { cwd, base } = await fixture(); await writeFile(join(cwd, '.gitattributes'), 'source.txt filter=trap\n');
    await writeFile(join(cwd, 'source.txt'), 'dirty\n');
    const result = await captureSessionCandidate(cwd, base); expect(result.changedPaths).toEqual(['.gitattributes', 'source.txt']);
  });
});

describe('pinned stack bases and local final proof', () => {
  it('keeps the exact own-delta review and expiry before and after a merge-commit predecessor landing', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'source.txt'), 'predecessor\n'); f.git('add', '.'); f.git('commit', '-qm', 'predecessor'); const predecessor = f.git('rev-parse', 'HEAD');
    await writeFile(join(f.cwd, 'upper.txt'), 'upper\n'); f.git('add', '.'); f.git('commit', '-qm', 'upper');
    vi.stubEnv('OPENLUP_STACK_BASE', predecessor);
    const scoped = { ...intent, scope: ['upper.txt'] };
    const req = await prepareAgentReview({ cwd: f.cwd, intent: scoped, authorSessionId: 'author', now });
    expect(req.candidate).toMatchObject({ base: predecessor, stackBase: predecessor, changedPaths: ['upper.txt'] });
    const reports = req.roles.map((_, index) => ({ ...report(req, index), coveredScope: ['upper.txt'] }));
    expect((await verifyAgentReview({ cwd: f.cwd, request: req, reports, now })).status).toBe('reviewed');
    const main = f.git('commit-tree', f.git('rev-parse', `${predecessor}^{tree}`), '-p', f.base, '-p', predecessor, '-m', 'land predecessor'); f.git('update-ref', 'refs/remotes/origin/main', main);
    expect((await verifyAgentReview({ cwd: f.cwd, request: req, reports, now })).status).toBe('reviewed');
    const state = await prepareAgentReviewState({ cwd: f.cwd, base: predecessor, intent: scoped, authorSessionId: 'author', previous: { request: req, reports }, now });
    expect(state.request).toEqual(req); expect(state.reports).toEqual(reports); expect(state.history).toBeUndefined();
    expect((await verifyAgentReview({ cwd: f.cwd, request: req, reports, now: () => 86401001 })).status).toBe('needs_agent_review');
    vi.unstubAllEnvs();
    expect((await verifyAgentReview({ cwd: f.cwd, request: req, reports, now })).status).toBe('needs_agent_review');
  });
  it('refuses an unrelated predecessor, mismatched pin, and integration beyond the pinned base', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'upper.txt'), 'upper\n'); f.git('add', '.'); f.git('commit', '-qm', 'upper'); const upper = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', f.base); await writeFile(join(f.cwd, 'other.txt'), 'other\n'); f.git('add', '.'); f.git('commit', '-qm', 'other'); const other = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', upper); vi.stubEnv('OPENLUP_STACK_BASE', other);
    await expect(captureSessionCandidate(f.cwd)).rejects.toThrow();
    await expect(captureSessionCandidate(f.cwd, f.base)).rejects.toThrow('differs');
    vi.stubEnv('OPENLUP_STACK_BASE', f.base); f.git('update-ref', 'refs/remotes/origin/main', other); f.git('merge', '-q', '--no-edit', other);
    await expect(captureSessionCandidate(f.cwd)).rejects.toThrow('fork point');
  });
  it('catches a clean merge with an invalid combined aggregate before any heavy command', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'a.json'), 'false'); await writeFile(join(f.cwd, 'b.json'), 'false'); await writeFile(join(f.cwd, 'count.json'), '0');
    await writeFile(join(f.cwd, 'check.mjs'), "import{readFileSync as r}from'node:fs';if(Number(r('count.json'))!==['a','b'].filter(n=>JSON.parse(r(n+'.json'))).length)process.exitCode=1;\n");
    f.git('add', '.'); f.git('commit', '-qm', 'counter'); const base = f.git('rev-parse', 'HEAD');
    await writeFile(join(f.cwd, 'a.json'), 'true'); await writeFile(join(f.cwd, 'count.json'), '1'); f.git('add', '.'); f.git('commit', '-qm', 'a'); const a = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', base); await writeFile(join(f.cwd, 'b.json'), 'true'); await writeFile(join(f.cwd, 'count.json'), '1'); f.git('add', '.'); f.git('commit', '-qm', 'b'); const b = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', '--detach', a);
    expect(checkMergePreview({ cwd: f.cwd, target: base, checks: [] }).basis).toBe('unchanged tree');
    expect(() => checkMergePreview({ cwd: f.cwd, target: b, checks: [[process.execPath, 'check.mjs']] })).toThrow('combined tree failed');
    expect(f.git('rev-parse', 'HEAD')).toBe(a); expect(f.git('status', '--porcelain')).toBe('');
  });
  it('reports textual conflicts without changing the source checkout', async () => {
    const f = await fixture(); await writeFile(join(f.cwd, 'source.txt'), 'ours\n'); f.git('add', '.'); f.git('commit', '-qm', 'ours'); const ours = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', f.base); await writeFile(join(f.cwd, 'source.txt'), 'theirs\n'); f.git('add', '.'); f.git('commit', '-qm', 'theirs'); const theirs = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', '--detach', ours);
    expect(() => checkMergePreview({ cwd: f.cwd, target: theirs })).toThrow('merge main into this branch');
    expect(f.git('status', '--porcelain')).toBe('');
  });
  it.each([false, true])('accepts disjoint main through the actual default policy and inventory commands (aggregate: %s)', async aggregate => {
    const source = process.cwd();
    const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const base = execFileSync('/usr/bin/git', ['merge-base', 'HEAD', 'origin/main'], { cwd: source, encoding: 'utf8' }).trim();
    const f = await fixture(); f.git('fetch', '-q', '--no-tags', source, head);
    f.git('checkout', '-q', '--detach', base);
    if (aggregate) {
      const path = 'scripts/independent-main-preview.test.ts';
      await writeFile(join(f.cwd, path), 'export {};\n');
      const cataloguePath = join(f.cwd, 'config/openlup-publication-catalog.json');
      const catalogue = JSON.parse(await readFile(cataloguePath, 'utf8'));
      catalogue.publicPaths.push({ path, class: 'public-output' });
      catalogue.publicPaths.sort((left: { path: string }, right: { path: string }) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      await writeFile(cataloguePath, `${JSON.stringify(catalogue, null, 2)}\n`);
      // The fixture may predate a command-policy change in this candidate.
      // Derive its independent main contract with that tree's own policy.
      execFileSync(process.execPath, ['--input-type=module', '--eval', `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { deriveSourceReleaseContract } from './scripts/oss-source-release-contract.ts';
        writeFileSync('config/openlup-source-release-contract.json', deriveSourceReleaseContract(path => readFileSync(path)).contents);
      `], { cwd: f.cwd, stdio: 'pipe' });
    } else {
      await writeFile(join(f.cwd, 'README.md'), `${await readFile(join(f.cwd, 'README.md'), 'utf8')}\n<!-- Independent main change for the merge-preview contract. -->\n`);
    }
    f.git('add', '.'); f.git('commit', '-qm', 'independent main change'); const main = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', aggregate ? base : head);
    if (aggregate) {
      await writeFile(join(f.cwd, 'README.md'), `${await readFile(join(f.cwd, 'README.md'), 'utf8')}\n<!-- Independent source change without aggregate ownership. -->\n`);
      f.git('add', 'README.md'); f.git('commit', '-qm', 'independent source documentation');
    }
    const sourceHead = f.git('rev-parse', 'HEAD');
    expect(checkMergePreview({ cwd: f.cwd, target: main }).basis).toBe('combined policy and inventory passed');
    expect(f.git('rev-parse', 'HEAD')).toBe(sourceHead); expect(f.git('status', '--porcelain')).toBe('');
    if (aggregate) {
      f.git('update-ref', 'refs/remotes/origin/main', base);
      const eventDirectory = await mkdtemp(join(source, '.context', 'scratch', 'foreign-hosted-event-')); directories.push(eventDirectory);
      const eventPath = join(eventDirectory, 'event.json');
      await writeFile(eventPath, JSON.stringify({ repository: { full_name: 'openlup/openlup', private: false }, before: base, after: main }));
      vi.stubEnv('GITHUB_ACTIONS', 'true'); vi.stubEnv('GITHUB_REPOSITORY', 'openlup/openlup');
      vi.stubEnv('GITHUB_EVENT_NAME', 'push'); vi.stubEnv('GITHUB_REF', 'refs/heads/main');
      vi.stubEnv('GITHUB_SHA', main); vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
      const marker = join(f.cwd, '.context', 'heavy-must-not-run');
      const attempt = spawnSync(process.execPath, [resolve('scripts/agent-review-session.mjs'), 'verify-command', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { cwd: f.cwd, encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      expect(attempt.error).toBeUndefined(); expect(attempt.status).toBe(1);
      expect(attempt.stderr).toContain('current independent native review is required');
      await expect(stat(marker)).rejects.toThrow();
    }
  }, 120_000);
  it('serializes independent callers and releases only its own lease on success or failure', async () => {
    const f = await fixture(); const directory = join(f.cwd, 'lease'); const order: string[] = [];
    let release!: () => void; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const first = withHeavyLease(async () => { order.push('first'); entered(); await held; order.push('first done'); }, { directory, waitMs: 1000, pollMs: 5 });
    await ready;
    await expect(withHeavyLease(async () => {}, { directory, waitMs: 0 })).rejects.toThrow('bounded wait');
    const second = withHeavyLease(async () => { order.push('second'); throw new Error('command failed'); }, { directory, waitMs: 1000, pollMs: 5 });
    release(); await first; await expect(second).rejects.toThrow('command failed');
    expect(order).toEqual(['first', 'first done', 'second']);
    await expect(stat(directory)).rejects.toThrow();
  });
  it('does not start expensive work after preflight failure and refuses a mid-run source mutation', async () => {
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', '1');
    const f = await fixture(); const run = vi.fn(async () => 0); const snapshot = async () => candidate;
    await expect(verifyCandidateCommand({ cwd: f.cwd, command: 'unused', lease: { directory: join(f.cwd, 'lease') }, snapshot, preflight: async () => { throw new Error('cheap failure'); }, run })).rejects.toThrow('cheap failure');
    expect(run).not.toHaveBeenCalled(); let changed = false;
    await expect(verifyCandidateCommand({ cwd: f.cwd, command: 'unused', lease: { directory: join(f.cwd, 'lease') }, snapshot: async () => ({ ...candidate, head: changed ? 'f'.repeat(40) : candidate.head }), preflight: async () => {}, run: async () => { changed = true; return 0; } })).rejects.toThrow('superseded');
    await expect(stat(join(f.cwd, 'lease'))).rejects.toThrow();
  });
  it.each([false, true])('revalidates after host admission before expensive work (source changed: %s)', async changed => {
    const f = await fixture(); const bin = join(f.cwd, 'bin'); await mkdir(bin);
    const broker = join(bin, 'ai-resource-gate'); await writeFile(broker, 'fixture'); await chmod(broker, 0o755);
    vi.stubEnv('PATH', bin); vi.stubEnv('CI', 'false'); vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', '0');
    let admitted = false; const heavy = vi.fn(async () => 0); const preflight = vi.fn(async () => {});
    const snapshot = async () => ({ ...candidate, head: admitted && changed ? 'f'.repeat(40) : candidate.head });
    await expect(verifyCandidateCommand({ cwd: f.cwd, command: 'required-command', preflight, snapshot, run: heavy })).rejects.toThrow('select the existing broker profile');
    expect(heavy).not.toHaveBeenCalled(); preflight.mockClear();
    const run = async (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
      expect(command).toBe(broker);
      expect(args).toContain(`openlup:coverage:${(await heavyLeaseDirectory(cwd)).split('/').at(-1)}`);
      for (const policy of ['--cpu', '--memory-mb', '--lane', '--queue-timeout', '--execution-timeout']) expect(args).not.toContain(policy);
      expect(env.VITEST_MAX_WORKERS).toBe(processEnvironment.VITEST_MAX_WORKERS);
      expect(args.slice(-8)).toEqual([process.execPath, resolve('scripts/agent-review-session.mjs'), 'verify-command', '--resource', 'openlup:coverage', '--', 'required-command', 'argument']);
      vi.stubEnv('OPENLUP_VERIFY_EXPECTED', env.OPENLUP_VERIFY_EXPECTED!); vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', '1'); admitted = true;
      return verifyCandidateCommand({ cwd, command: 'required-command', args: ['argument'], resource: 'openlup:coverage', preflight, snapshot, run: heavy });
    };
    const result = verifyCandidateCommand({ cwd: f.cwd, command: 'required-command', args: ['argument'], resource: 'openlup:coverage', preflight, snapshot, run });
    if (changed) { await expect(result).rejects.toThrow('host capacity'); expect(heavy).not.toHaveBeenCalled(); }
    else { expect(await result).toBe(0); expect(preflight).toHaveBeenCalledTimes(3); expect(heavy).toHaveBeenCalledOnce(); }
  });
  it('keeps independent projects separate, rejects nesting immediately, and scopes stack pins away from test fixtures', async () => {
    const first = await fixture(); const second = await fixture();
    expect(await heavyLeaseDirectory(first.cwd)).not.toBe(await heavyLeaseDirectory(second.cwd));
    const directory = await heavyLeaseDirectory(first.cwd); vi.stubEnv('OPENLUP_HEAVY_ACTIVE', directory);
    const snapshot = vi.fn(async () => candidate);
    await expect(verifyCandidateCommand({ cwd: first.cwd, command: 'unused', snapshot })).rejects.toThrow('nested wrapper');
    expect(snapshot).not.toHaveBeenCalled();
    expect(heavyCommandEnvironment(directory, { OPENLUP_STACK_BASE: base, OPENLUP_VERIFY_EXPECTED: 'other repo', PATH: '/bin' })).toEqual({ OPENLUP_HEAVY_ACTIVE: directory, PATH: '/bin' });
    const busy = join(second.cwd, 'busy'); await mkdir(busy);
    await expect(verifyCandidateCommand({ cwd: second.cwd, command: 'unused', lease: { directory: busy, waitMs: 0 }, snapshot: async () => ({ ...candidate, clean: false }) })).rejects.toThrow('commit source');
    await rm(busy, { recursive: true });
    vi.stubEnv('OPENLUP_VERIFY_EXPECTED', 'another candidate');
    await expect(verifyCandidateCommand({ cwd: second.cwd, command: 'unused', snapshot: async () => candidate })).rejects.toThrow('host capacity');
  });
});

describe('fork-point review base (S5)', () => {
  const finding = { mechanism: 'wrong bytes', precondition: 'read', requirement: 'right bytes', effect: 'wrong result', risk: 'ordinary' };
  // The reviewed base B is the branch's fork point; origin/main later moves while HEAD stays put.
  async function reviewedAtB(failFirst = false) {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const reviewedBase = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', reviewedBase); const branch = git('symbolic-ref', '--short', 'HEAD');
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true }); const statePath = join(directory, 'session.json');
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent, authorSessionId: 'author', repairRisk: 'ordinary', simplicityPreCheck }));
    const script = resolve('scripts/agent-review-session.mjs');
    const invoke = (...args: string[]) => { const run = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }); return { code: run.status, result: run.stdout ? JSON.parse(run.stdout) : undefined, stderr: run.stderr }; };
    const record = async (name: string, observation: object) => { const path = join(directory, `${name}.json`); await writeFile(path, JSON.stringify(observation)); return invoke('record', path); };
    const moveMain = async (from: string, file: string) => { git('checkout', '-q', '--detach', from); await writeFile(join(cwd, file), 'main\n'); git('add', file); git('commit', '-qm', `main ${file}`); const moved = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', moved); git('checkout', '-q', branch); return moved; };
    expect(invoke('prepare').result.status).toBe('needs_agent_review'); const first = JSON.parse(await readFile(statePath, 'utf8'));
    for (const index of [0, 1]) await record(`first-${index}`, { ...report(first.request, index), completedAt: Date.now(), ...(failFirst && index === 0 ? { verdict: 'fail', materialFindings: [finding] } : {}) });
    return { cwd, git, reviewedBase, statePath, invoke, record, moveMain };
  }
  it('(a) keeps verify reviewed when origin/main advances past the unchanged reviewed base', async () => {
    const { reviewedBase, invoke, moveMain } = await reviewedAtB(); expect(invoke('verify').result.status).toBe('reviewed');
    await moveMain(reviewedBase, 'unrelated.txt');
    const verified = invoke('verify'); expect(verified.result.status).toBe('reviewed'); expect(verified.code).toBe(0); expect(verified.result.candidate.base).toBe(reviewedBase);
    expect(invoke('status').result.status).toBe('reviewed');
  }, 30_000);
  it('(b) refuses once main is rewritten so the reviewed base is no longer an ancestor', async () => {
    const { git, reviewedBase, invoke, moveMain } = await reviewedAtB();
    await moveMain(git('rev-parse', `${reviewedBase}~1`), 'rewritten.txt');
    const verified = invoke('verify'); expect(verified.code).toBe(1); expect(verified.result.status).toBe('needs_agent_review'); expect(verified.result.reason).toContain('fork point');
  }, 30_000);
  it('(c) preserves unchanged evidence at prepare after main advanced, with no new round', async () => {
    const { reviewedBase, statePath, invoke, moveMain } = await reviewedAtB(); const reviewed = await readFile(statePath, 'utf8');
    await moveMain(reviewedBase, 'unrelated.txt');
    const prepared = invoke('prepare'); expect(prepared.result.status).toBe('reviewed'); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
  }, 30_000);
  it('(d) keeps base B and the closure lineage for a repair commit on the un-rebased branch', async () => {
    const { cwd, git, reviewedBase, statePath, invoke, record, moveMain } = await reviewedAtB(true);
    await moveMain(reviewedBase, 'unrelated.txt');
    await writeFile(join(cwd, 'source.txt'), 'repaired\n'); git('add', 'source.txt'); git('commit', '-qm', 'repair');
    expect(invoke('prepare').result.request.roles).toEqual(['closure']); const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.request.candidate.base).toBe(reviewedBase); expect(state.request.continuation).toMatchObject({ cycle: 1, mode: 'closure', deltaPaths: ['source.txt'] }); expect(state.history).toHaveLength(1);
    const closed = await record('closure', { ...report(state.request), reviewerId: 'fresh-closure', sessionId: 'fresh-closure-session', completedAt: Date.now(), closure: { coveredDelta: ['source.txt'], interactionsChecked: true, ordinarySemantics: true, resolvedFindings: state.request.continuation.findings.map(card => card.id) } });
    expect(closed.result.status).toBe('reviewed'); expect(invoke('verify').result.status).toBe('reviewed');
  }, 30_000);
  it('(e) moves the base to M and requires full review when the author integrates main', async () => {
    const { git, reviewedBase, statePath, invoke, moveMain } = await reviewedAtB(); const reviewedHead = git('rev-parse', 'HEAD'); const reviewed = await readFile(statePath, 'utf8');
    const moved = await moveMain(reviewedBase, 'unrelated.txt');
    git('merge', '-q', '--no-edit', 'refs/remotes/origin/main'); expect(invoke('verify').result.reason).toContain('fork point');
    const prepared = invoke('prepare'); expect(prepared.result.status).toBe('needs_agent_review'); const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.request.candidate.base).toBe(moved); expect(state.request.continuation).toMatchObject({ cycle: 1, mode: 'full', deltaPaths: ['unrelated.txt'] }); expect(state.request.roles).toHaveLength(2); expect(state.history[0].request.candidate.base).toBe(reviewedBase);
    // A rebase rewrites the reviewed head: as before, prepare refuses with needs_rescope and keeps the state; the supervisor regroups
    // without restarting the budget. Only state prepared from scratch, as below, binds the new fork point.
    git('reset', '-q', '--hard', reviewedHead); await writeFile(statePath, reviewed); git('rebase', '-q', 'refs/remotes/origin/main');
    expect(invoke('prepare').result).toMatchObject({ status: 'needs_rescope' }); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
    await rm(statePath); invoke('prepare'); expect(JSON.parse(await readFile(statePath, 'utf8')).request.candidate.base).toBe(moved);
  }, 30_000);
  it('keeps a pristine checkout pristine when main moves ahead of it', async () => {
    const { cwd, base, git } = await fixture(); const branch = git('symbolic-ref', '--short', 'HEAD');
    git('checkout', '-q', '--detach'); await writeFile(join(cwd, 'later.txt'), 'main\n'); git('add', 'later.txt'); git('commit', '-qm', 'later main'); git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD')); git('checkout', '-q', branch);
    const baseline = await pristineAgentReviewBaseline(cwd); expect(baseline.pristine).toBe(true); expect(baseline.candidate.base).toBe(base);
  });
});
