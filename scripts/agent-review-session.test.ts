import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentReviewReportBinding, captureAgentReviewDelta, captureSessionCandidate, prepareAgentReview, prepareAgentReviewState, pristineAgentReviewBaseline, recordAgentReview, serializeAgentReviewState, verifyAgentReview } from './agent-review-session.mjs';

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
  const repaired = (number = 1) => ({ ...candidate, head: String(number).repeat(40), tree: String(number + 2).repeat(40), workingDigest: String(number + 4).repeat(64), indexDigest: String(number + 6).repeat(64) });
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
  it('retains only unresolved prior cards and allows at most two committed repair cycles', async () => {
    const first = await advance(await initial()); first.reports = [closure(first)];
    const second = await advance(first, repaired(2)); expect(second.request.continuation.cycle).toBe(2); expect(second.request.continuation.findings).toEqual([]); second.reports = [closure(second)]; expect((await check(second)).status).toBe('reviewed');
    await expect(advance(second, repaired(3))).rejects.toThrow('two automatic repair cycles');
    expect((await check(second, { snapshot: async () => repaired(3) })).status).toBe('needs_rescope');
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
  async function exhausted() {
    const first = await advance(await initial(), repaired(1), { fullRefresh: true });
    return advance(first, repaired(2), { fullRefresh: true });
  }
  function ownerApproval(previous, next) { return { priorRequestDigest: digest(previous.request), candidateDigest: digest(next), ownerDecision }; }
  async function manual(previous, next = repaired(3), extra = {}) {
    return advance(previous, next, { fullRefresh: true, ownerContinuation: ownerApproval(previous, next), ...extra });
  }
  it('retains every round and finding for exactly one owner-bound third full review', async () => {
    const prior = await exhausted(); const state = await manual(prior);
    expect(state.history).toEqual([...prior.history, { request: prior.request, reports: prior.reports }]);
    expect(state.request.continuation).toMatchObject({ cycle: 3, mode: 'full', ownerContinuation: ownerApproval(prior, repaired(3)), findings: prior.request.continuation.findings });
    expect(state.request.roles).toEqual(['correctness', 'security']);
    expect((await check(state)).status).toBe('needs_agent_review');
    state.reports = [closure(state), closure(state, 1)]; expect((await check(state)).status).toBe('reviewed');
    expect(await manual(state, repaired(3), { ownerContinuation: state.request.continuation.ownerContinuation })).toEqual(state);
    expect(await advance(state, repaired(3))).toEqual(state);
    await expect(manual(state, { ...repaired(3), head: 'f'.repeat(40) })).rejects.toThrow('exhausted automatic budget');
    await expect(advance(state, { ...repaired(3), head: 'f'.repeat(40) })).rejects.toThrow('two automatic repair cycles');
    expect((await check(state, { now: () => 86401001 })).reason).toContain('expired');
    expect((await check(state, { snapshot: async () => ({ ...repaired(3), head: 'f'.repeat(40) }) })).status).toBe('needs_rescope');
    for (const mutate of [s => { delete s.request.continuation.ownerContinuation; }, s => { s.request.continuation.mode = 'focused'; }, s => { s.request.continuation.cycle = 4; }, s => { s.history[0].reports[0].materialFindings = []; }]) {
      const changed = structuredClone(state); mutate(changed); expect((await check(changed)).status).not.toBe('reviewed');
    }
  });
  it('refuses missing, mismatched, premature, changed-intent and nonfull owner continuation', async () => {
    const prior = await exhausted(); const next = repaired(3); const approval = ownerApproval(prior, next);
    await expect(advance(prior, next, { fullRefresh: true })).rejects.toThrow('two automatic repair cycles');
    for (const field of ['priorRequestDigest', 'candidateDigest']) await expect(manual(prior, next, { ownerContinuation: { ...approval, [field]: 'f'.repeat(64) } })).rejects.toThrow('differs from exact');
    await expect(manual(prior, next, { fullRefresh: false })).rejects.toThrow('explicit full refresh');
    await expect(manual(await initial(), next)).rejects.toThrow('exhausted automatic budget');
    await expect(manual(prior, next, { authorSessionId: 'other' })).rejects.toThrow('author changed');
    await expect(manual(prior, next, { intent: { ...intent, criteria: 'Changed intent' } })).rejects.toThrow('approved intent');
    await expect(manual(prior, next, { delta: async (_cwd, before, after) => { if (before.head === prior.request.candidate.head) throw new Error('not an authenticated ancestor'); return delta(_cwd, before, after); } })).rejects.toThrow('nonancestor integration');
    await expect(manual(prior, { ...next, clean: false })).rejects.toThrow('clean committed');
  });

});

describe('explicit owner regroup without reset', () => {
  const expanded = { ...intent, scope: ['source.txt', 'new.txt'], criteria: 'Preserve behavior and explicitly approved additional source' };
  const finding = { mechanism: 'lost clamp', precondition: 'late parcel', requirement: 'no early cycle', effect: 'early renewal', risk: 'ordinary' };
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const delta = async (_cwd, before, after) => before.head === after.head ? [] : after.changedPaths;
  const next = (number = 1, changedPaths = expanded.scope) => ({ ...candidate, head: String(number).repeat(40), tree: String(number + 2).repeat(40), workingDigest: String(number + 4).repeat(64), indexDigest: String(number + 6).repeat(64), changedPaths });
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
    await expect(regroup(state, next(3), { regroup: undefined })).rejects.toThrow('two automatic repair cycles');
    await expect(regroup(state, next(3), { intent: { ...expanded, scope: [...expanded.scope, 'third.txt'] }, regroup: approval(state, { ...expanded, scope: [...expanded.scope, 'third.txt'] }) })).rejects.toThrow('two automatic repair cycles');
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
    const spec = { intent, base: baseline, authorSessionId: 'author' }; await writeFile(specPath, JSON.stringify(spec));
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
  });
});

describe('actual source snapshot without candidate execution', () => {
  it('runs owner continuation through actual Git and CLI without resetting or permitting a fourth round', async () => {
    const { cwd, git } = await fixture();
    await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const baseline = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', baseline);
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true });
    const specPath = join(directory, 'intent.json'), statePath = join(directory, 'session.json');
    const spec = { intent, base: baseline, authorSessionId: 'author', fullRefresh: true };
    const script = resolve('scripts/agent-review-session.mjs');
    const invoke = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
    const commit = async number => { await writeFile(join(cwd, 'source.txt'), `candidate ${number}\n`); git('add', 'source.txt'); git('commit', '-qm', `candidate ${number}`); };
    await writeFile(specPath, JSON.stringify(spec));
    for (const number of [0, 1, 2]) { await commit(number); expect(invoke('prepare').status).toBe(0); }
    const priorBytes = await readFile(statePath, 'utf8'), prior = JSON.parse(priorBytes);
    await commit(3); expect(invoke('prepare').status).not.toBe(0); expect(await readFile(statePath, 'utf8')).toBe(priorBytes);
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const ownerContinuation = { priorRequestDigest: digest(prior.request), candidateDigest: digest(await captureSessionCandidate(cwd, baseline)), ownerDecision: 'Synthetic explicit approval for this exact fixture candidate' };
    await writeFile(specPath, JSON.stringify({ ...spec, ownerContinuation: { ...ownerContinuation, candidateDigest: 'f'.repeat(64) } }));
    expect(invoke('prepare').status).not.toBe(0); expect(await readFile(statePath, 'utf8')).toBe(priorBytes);
    await writeFile(specPath, JSON.stringify({ ...spec, ownerContinuation })); expect(invoke('prepare').status).toBe(0);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.history).toEqual([...prior.history, { request: prior.request, reports: prior.reports }]);
    expect(state.request.continuation).toMatchObject({ cycle: 3, mode: 'full', ownerContinuation, deltaPaths: ['source.txt'] });
    expect(state.request.roles).toEqual(['correctness', 'security']);
    for (const index of [0, 1]) {
      const reportPath = join(directory, `manual-${index}.json`);
      await writeFile(reportPath, JSON.stringify({ ...report(state.request, index), reviewerId: `manual-${index}`, sessionId: `manual-session-${index}`, completedAt: Date.now(), closure: { coveredDelta: ['source.txt'], interactionsChecked: true, ordinarySemantics: false, resolvedFindings: [] } }));
      expect(invoke('record', reportPath).status).toBe(0);
    }
    expect(invoke('verify').status).toBe(0); const reviewed = await readFile(statePath, 'utf8');
    expect(invoke('prepare').status).toBe(0); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
    await commit(4); const current = JSON.parse(reviewed);
    await writeFile(specPath, JSON.stringify({ ...spec, ownerContinuation: { ...ownerContinuation, priorRequestDigest: digest(current.request), candidateDigest: digest(await captureSessionCandidate(cwd, baseline)) } }));
    expect(invoke('prepare').status).not.toBe(0); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
    expect(invoke('verify').status).not.toBe(0);
  });

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
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true }); const spec = { intent, base: baseline, authorSessionId: 'author', repairRisk: 'ordinary' }; const specPath = join(directory, 'intent.json'); await writeFile(specPath, JSON.stringify(spec));
    const script = resolve('scripts/agent-review-session.mjs'); const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })); const statePath = join(directory, 'session.json');
    invoke('prepare'); const first = JSON.parse(await readFile(statePath, 'utf8'));
    for (const index of [0, 1]) { const reportPath = join(directory, `first-${index}.json`); await writeFile(reportPath, JSON.stringify({ ...report(first.request, index), completedAt: Date.now(), ...(index === 0 ? { verdict: 'fail', materialFindings: [{ mechanism: 'wrong bytes', precondition: 'read', requirement: 'right bytes', effect: 'wrong result', risk: 'ordinary' }] } : {}) })); invoke('record', reportPath); }
    const unchanged = await readFile(statePath, 'utf8'); expect(invoke('prepare').status).toBe('needs_agent_review'); expect(await readFile(statePath, 'utf8')).toBe(unchanged);
    await writeFile(join(cwd, 'source.txt'), 'repaired\n'); git('add', 'source.txt'); git('commit', '-qm', 'repair'); const prepared = invoke('prepare'); expect(prepared.request.roles).toEqual(['closure']); const state = JSON.parse(await readFile(statePath, 'utf8'));
    const reportPath = join(directory, 'closure.json'); await writeFile(reportPath, JSON.stringify({ ...report(state.request), reviewerId: 'fresh-closure', sessionId: 'fresh-closure-session', completedAt: Date.now(), closure: { coveredDelta: ['source.txt'], interactionsChecked: true, ordinarySemantics: true, resolvedFindings: state.request.continuation.findings.map(card => card.id) } })); expect(invoke('record', reportPath).status).toBe('reviewed');
    const reviewed = await readFile(statePath, 'utf8'); expect(invoke('prepare').status).toBe('reviewed'); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
    await writeFile(specPath, JSON.stringify({ ...spec, fullRefresh: true })); expect(invoke('prepare').status).toBe('reviewed'); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
  });
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
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent, base: baseline, authorSessionId: 'author' }));
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
    const completed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    await Promise.race([once(child.stdio[3], 'data'), completed.then(code => { throw new Error(`record exited ${code} before publishing its state: ${stderr}`); })]);
    try {
      expect((await stat(join(directory, '.session.lock'))).isFile()).toBe(true);
      const contenders = ['record', 'prepare'].map(verb => {
        const args = verb === 'record' ? [verb, passPath] : [verb];
        return new Promise<string>((resolve, reject) => {
          const rival = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let diagnostics = '';
          rival.stderr.on('data', bytes => { diagnostics += bytes; }); rival.on('error', reject); rival.on('close', code => code === 1 ? resolve(diagnostics) : reject(new Error(`concurrent ${verb} unexpectedly completed`)));
        });
      });
      for (const diagnostics of await Promise.all(contenders)) expect(diagnostics).toContain('session transaction is busy');
    } finally { child.stdin.end(); }
    expect(await completed).toBe(0); expect(stderr).toBe(''); expect(JSON.parse(stdout).status).toBe('needs_agent_review');
    expect(invoke('record', passPath).status).toBe('needs_agent_review');
    const recorded = JSON.parse(await readFile(statePath, 'utf8')); expect(recorded.request.id).toBe(state.request.id); expect(recorded.reports).toHaveLength(2); expect(recorded.reports[0].materialFindings).toEqual(findings);
    expect(invoke('prepare').status).toBe('needs_agent_review'); expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(recorded);
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

describe('fork-point review base (S5)', () => {
  const finding = { mechanism: 'wrong bytes', precondition: 'read', requirement: 'right bytes', effect: 'wrong result', risk: 'ordinary' };
  // The reviewed base B is the branch's fork point; origin/main later moves while HEAD stays put.
  async function reviewedAtB(failFirst = false) {
    const { cwd, git } = await fixture(); await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n'); git('add', '.gitignore'); git('commit', '-qm', 'scratch boundary');
    const reviewedBase = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', reviewedBase); const branch = git('symbolic-ref', '--short', 'HEAD');
    await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', 'source.txt'); git('commit', '-qm', 'candidate');
    const directory = join(cwd, '.context', 'scratch', 'agent-review'); await mkdir(directory, { recursive: true }); const statePath = join(directory, 'session.json');
    await writeFile(join(directory, 'intent.json'), JSON.stringify({ intent, authorSessionId: 'author', repairRisk: 'ordinary' }));
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
  });
  it('(b) refuses once main is rewritten so the reviewed base is no longer an ancestor', async () => {
    const { git, reviewedBase, invoke, moveMain } = await reviewedAtB();
    await moveMain(git('rev-parse', `${reviewedBase}~1`), 'rewritten.txt');
    const verified = invoke('verify'); expect(verified.code).toBe(1); expect(verified.result.status).toBe('needs_agent_review'); expect(verified.result.reason).toContain('fork point');
  });
  it('(c) preserves unchanged evidence at prepare after main advanced, with no new round', async () => {
    const { reviewedBase, statePath, invoke, moveMain } = await reviewedAtB(); const reviewed = await readFile(statePath, 'utf8');
    await moveMain(reviewedBase, 'unrelated.txt');
    const prepared = invoke('prepare'); expect(prepared.result.status).toBe('reviewed'); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
  });
  it('(d) keeps base B and the closure lineage for a repair commit on the un-rebased branch', async () => {
    const { cwd, git, reviewedBase, statePath, invoke, record, moveMain } = await reviewedAtB(true);
    await moveMain(reviewedBase, 'unrelated.txt');
    await writeFile(join(cwd, 'source.txt'), 'repaired\n'); git('add', 'source.txt'); git('commit', '-qm', 'repair');
    expect(invoke('prepare').result.request.roles).toEqual(['closure']); const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.request.candidate.base).toBe(reviewedBase); expect(state.request.continuation).toMatchObject({ cycle: 1, mode: 'closure', deltaPaths: ['source.txt'] }); expect(state.history).toHaveLength(1);
    const closed = await record('closure', { ...report(state.request), reviewerId: 'fresh-closure', sessionId: 'fresh-closure-session', completedAt: Date.now(), closure: { coveredDelta: ['source.txt'], interactionsChecked: true, ordinarySemantics: true, resolvedFindings: state.request.continuation.findings.map(card => card.id) } });
    expect(closed.result.status).toBe('reviewed'); expect(invoke('verify').result.status).toBe('reviewed');
  });
  it('(e) moves the base to M and requires full review when the author integrates main', async () => {
    const { git, reviewedBase, statePath, invoke, moveMain } = await reviewedAtB(); const reviewedHead = git('rev-parse', 'HEAD'); const reviewed = await readFile(statePath, 'utf8');
    const moved = await moveMain(reviewedBase, 'unrelated.txt');
    git('merge', '-q', '--no-edit', 'refs/remotes/origin/main'); expect(invoke('verify').result.reason).toContain('fork point');
    const prepared = invoke('prepare'); expect(prepared.result.status).toBe('needs_agent_review'); const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.request.candidate.base).toBe(moved); expect(state.request.continuation).toMatchObject({ cycle: 1, mode: 'full', deltaPaths: ['unrelated.txt'] }); expect(state.request.roles).toHaveLength(2); expect(state.history[0].request.candidate.base).toBe(reviewedBase);
    // A rebase rewrites the reviewed head: as before, it needs a changed execution approach (a fresh session) at the new fork point.
    git('reset', '-q', '--hard', reviewedHead); await writeFile(statePath, reviewed); git('rebase', '-q', 'refs/remotes/origin/main');
    expect(invoke('prepare').result).toMatchObject({ status: 'needs_rescope' }); expect(await readFile(statePath, 'utf8')).toBe(reviewed);
    await rm(statePath); invoke('prepare'); expect(JSON.parse(await readFile(statePath, 'utf8')).request.candidate.base).toBe(moved);
  });
  it('keeps a pristine checkout pristine when main moves ahead of it', async () => {
    const { cwd, base, git } = await fixture(); const branch = git('symbolic-ref', '--short', 'HEAD');
    git('checkout', '-q', '--detach'); await writeFile(join(cwd, 'later.txt'), 'main\n'); git('add', 'later.txt'); git('commit', '-qm', 'later main'); git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD')); git('checkout', '-q', branch);
    const baseline = await pristineAgentReviewBaseline(cwd); expect(baseline.pristine).toBe(true); expect(baseline.candidate.base).toBe(base);
  });
});
