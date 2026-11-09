import { describe, expect, it } from 'vitest';
import { admit, candidateFloor, classifyRisk, digest, integrationReviewContext, prepareCandidate, receiptSummary, recordReport, requiredReviewers, verdict } from './agent-review-decide.mjs';

const time = 1000;
const observed = { base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), changedPaths: ['source.txt'], clean: true };
const intent = { risk: 'routine', criteria: 'Preserve the approved behavior' };
const prepare = (extra = {}) => prepareCandidate(null, { ...observed, intent, authorSessionId: 'author', ...extra }, time);
const report = (extra = {}) => ({ reviewer: 'reviewer-1', cold: true, tree: observed.tree, verdict: 'PASS', findings: [], closes: [], documentation: 'Reviewed canonical guidance and secondary examples; no documentation impact.', ...extra });
const passed = () => recordReport(prepare(), report(), time);

describe('native review decisions', () => {
  it.each([
    ['prose', 1], ['routine', 1], ['behavior', 2], ['unknown', 1],
  ])('requires the v3 %s reviewer floor', (risk, count) => {
    expect(requiredReviewers(classifyRisk(observed, risk))).toBe(count);
    const session = recordReport(prepare({ intent: { ...intent, risk }, rules: { version: 3 } }), report(), time);
    expect(verdict(session, observed, time).ok).toBe(count === 1);
  });
  it.each([
    'package.json', 'config/settings.json', 'db/example.sql',
    'scripts/agent-review-session.mjs', 'scripts/source-preview-release.ts', 'packages/core/src/index.ts',
    'server/bff/orders.ts', 'src/domains/payment/card.ts', 'src/domains/subscription/renewal.ts',
    'src/pages/account/login/useOtpCodeFallback.ts', 'src/domains/customers/customerMagicLinkClient.ts',
    'src/domains/shipping/contracts.ts', 'server/domains/accounting/accountingInvoiceDeliveryJob.ts',
  ])('raises the floor for %s', path => {
    expect(requiredReviewers(classifyRisk({ changedPaths: [path] }, 'routine'))).toBe(2);
  });
  it.each([true, false])('classifies mode changes: %s', modeChanged => {
    expect(requiredReviewers(classifyRisk({ ...observed, modeChanged }))).toBe(modeChanged ? 2 : 1);
  });
  it.each([
    ['no reports', () => prepare(), observed, time, 'needs_agent_review'],
    ['clean pass', passed, observed, time, 'reviewed'],
    ['dirty', passed, { ...observed, clean: false }, time, 'dirty'],
    ['head changed', passed, { ...observed, head: 'd'.repeat(40) }, time, 'stale'],
    ['tree changed', passed, { ...observed, tree: 'd'.repeat(40) }, time, 'stale'],
    ['base changed', passed, { ...observed, base: 'd'.repeat(40) }, time, 'stale'],
    ['a month later: reviews do not expire', passed, observed, time + 30 * 86400000, 'reviewed'],
    ['future report', passed, observed, time - 1, 'invalid'],
    ['invalid clock', passed, observed, NaN, 'invalid'],
    ['old version', () => ({ version: 1 }), observed, time, 'invalid'],
  ])('%s', (_name, state, actual, now, code) => {
    expect(verdict(state(), actual, now).code).toBe(code);
  });
  it.each([
    { reviewer: 'author' }, { reviewer: '' }, { cold: false }, { verdict: 'pass' },
    { documentation: undefined }, { documentation: '   ' }, { documentation: 42 }, { documentation: 'x'.repeat(4097) },
    { tree: 'd'.repeat(40) }, { findings: null }, { closes: null },
    { findings: [{ id: 'F1', summary: '', material: true }] },
    { findings: [{ id: 'F1', summary: 'broken' }] }, { closes: ['unknown'] },
  ])('refuses invalid report %j', patch => {
    expect(() => recordReport(prepare(), report(patch), time)).toThrow('invalid:');
  });
  it('requires fresh unique reviewers across current and earlier candidates', () => {
    const session = passed();
    expect(() => recordReport(session, report(), time)).toThrow('already used');
    const next = prepareCandidate(session, { ...observed, head: 'd'.repeat(40), tree: 'e'.repeat(40), intent, authorSessionId: 'author' }, time);
    expect(() => recordReport(next, report({ tree: next.candidate.tree }), time)).toThrow('already used');
    expect(verdict(next, next.candidate, time).code).toBe('needs_agent_review');
  });
  it('keeps prior reports without documentation valid without changing review evidence', () => {
    const session = recordReport(prepare(), report({ findings: [{ id: 'A1', summary: 'retained prior advice', material: false }] }), time);
    const stored = structuredClone(session);
    delete stored.history.at(-1).report.documentation;
    expect(verdict(stored, observed, time)).toMatchObject({ ok: true, code: 'reviewed' });
    const prepared = prepareCandidate(stored, { ...observed, intent, authorSessionId: 'author' }, time);
    expect(prepared.history).toEqual(stored.history);
    expect(stored.history.at(-1).report).not.toHaveProperty('documentation');
    expect(stored.history.at(-1).report.findings).toEqual(session.history.at(-1).report.findings);
    expect(receiptSummary(prepared, 12, time).expires).toBe(receiptSummary(session, 12, time).expires);
    expect(prepared.history.at(-1).at).toBe(session.history.at(-1).at);
  });
  it('retains the exact documentation assessment in new reports', () => {
    const documentation = 'Canonical guide is current; secondary example needs no change.';
    const session = recordReport(prepare(), report({ documentation }), time);
    expect(session.history.at(-1).report.documentation).toBe(documentation);
  });
  it.each([{ reviewer: 'author' }, { cold: false }])('rechecks persisted reviewer independence: %j', patch => {
    const session = passed(); Object.assign(session.history.at(-1).report, patch);
    expect(verdict(session, observed, time).code).toBe('invalid');
  });
  it('keeps evidence valid without expiry while the receipt keeps its recorded identity field', () => {
    let session = recordReport(prepare({ intent: { ...intent, risk: 'behavior' } }), report(), time);
    session = recordReport(session, report({ reviewer: 'reviewer-2' }), time + 60000);
    expect(verdict(session, observed, time + 86400000).code).toBe('reviewed');
    expect(receiptSummary(session, 12, time + 60000).expires).toBe(time + 86400000);
  });
  it('keeps material findings until a later report explicitly closes their ids', () => {
    let session = recordReport(prepare(), report({ verdict: 'FAIL', findings: [{ id: 'F1', summary: 'broken clamp', material: true }] }), time);
    session = recordReport(session, report({ reviewer: 'reviewer-2' }), time);
    expect(verdict(session, observed, time).reason).toContain('material finding');
    const next = { ...observed, tree: 'd'.repeat(40), head: 'e'.repeat(40), intent, authorSessionId: 'author' };
    session = prepareCandidate(session, next, time + 1);
    session = recordReport(session, report({ reviewer: 'reviewer-3', tree: next.tree, closes: ['F1'] }), time + 1);
    expect(verdict(session, next, time + 1).ok).toBe(true);
  });
  it('advice never blocks', () => {
    const session = recordReport(prepare(), report({ findings: [{ id: 'A1', summary: 'optional polish', material: false }] }), time);
    expect(verdict(session, observed, time).ok).toBe(true);
  });
  it('refuses changing the meaning of a stable finding id', () => {
    const session = recordReport(prepare(), report({ findings: [{ id: 'F1', summary: 'broken clamp', material: true }] }), time);
    expect(() => recordReport(session, report({ reviewer: 'reviewer-2', findings: [{ id: 'F1', summary: 'something else', material: true }] }), time)).toThrow('changed meaning');
  });
  it('records repeated repairs without cycle counters or an owner gate', () => {
    let session = prepare();
    expect(session).not.toHaveProperty('cycle'); expect(session).not.toHaveProperty('allowedCycles');
    for (let index = 1; index <= 7; index++) {
      const next = { ...observed, head: index.toString().repeat(40), tree: index.toString().repeat(40), intent, authorSessionId: 'author' };
      session = prepareCandidate(session, next, time + index);
      expect(session.history.at(-1)).not.toHaveProperty('cycle');
      session = recordReport(session, report({ reviewer: `reviewer-${index}`, tree: next.tree }), time + index);
      expect(verdict(session, next, time + index).ok).toBe(true);
    }
  });
  it.each(['GEMINI.md', '.cursor/rules/x.md', 'nested/GEMINI.md', 'nested/.cursor/rules/x.md', 'AGENTS.md', 'nested/AGENT_GUIDE.local.rst', '.github/guide.md', '.claude/rules.md', '.agents/rules.md', '.codex/rules.md', 'nested/SKILL.md'])('keeps a review for rule file %s', path => {
    expect(candidateFloor({ changedPaths: [path] }, 'unknown')).toBe(path.endsWith('.rst') ? 2 : 1);
  });
  it.each(['.nvmrc', 'scripts/documentation-routing.ts'])('replays a routine v2 session and receipt with one PASS for %s', path => {
    const candidate = { ...observed, changedPaths: [path] };
    // Persisted shape emitted by main, including its historical cycle fields.
    const session = { version: 2, authorSessionId: 'author', intent, cycle: 0, allowedCycles: 3,
      candidate, preparedAt: time, history: [
        { type: 'prepare', intent, candidate, authorSessionId: 'author', at: time, cycle: 0 },
        { type: 'report', at: time, report: { ...report(), at: time } },
      ] };
    expect(session.version).toBe(2);
    expect(session.history.filter(event => event.type === 'report')).toHaveLength(1);
    expect(verdict(session, candidate, time)).toMatchObject({ ok: true, code: 'reviewed' });
    // Literal legacy summary: admission replays receipts emitted on a legacy base.
    const receipt = { pr: 12, base: candidate.base, head: candidate.head, tree: candidate.tree,
      risk: 'routine', reviewers: ['reviewer-1'], verdict: 'PASS', expires: time + 86400000, sessionDigest: digest(session) };
    expect(receiptSummary(session, 12, time)).toEqual(receipt);
    expect(admit({ receipt, observed: { ...candidate, pr: 12, baseValid: true, legacyRules: true }, now: time })).toMatchObject({ ok: true, code: 'reviewed' });
    const v3 = recordReport(prepare({ changedPaths: [path], rules: { version: 3 } }), report(), time);
    expect(verdict(v3, candidate, time)).toMatchObject({ ok: false, code: 'needs_agent_review' });
  });
  it.each(['prose', 'routine', 'behavior', 'unknown'])('preserves the v2 risk floor for %s in verification and admission', risk => {
    const session = recordReport(prepare({ intent: { ...intent, risk } }), report(), time);
    const receipt = { pr: 12, base: observed.base, head: observed.head, tree: observed.tree,
      risk, reviewers: ['reviewer-1'], verdict: 'PASS', expires: time + 86400000, sessionDigest: digest(session) };
    const ok = ['prose', 'routine'].includes(risk);
    expect(verdict(session, observed, time).ok).toBe(ok);
    expect(admit({ receipt, observed: { ...observed, pr: 12, baseValid: true }, now: time }).ok).toBe(ok);
  });
  it.each([false, true])('--new keeps F1 open until explicitly closed (changed tree: %s)', changed => {
    let session = recordReport(prepare(), report({ verdict: 'FAIL', findings: [{ id: 'F1', summary: 'broken clamp', material: true }] }), time);
    const next = { ...observed, head: 'd'.repeat(40), tree: changed ? 'e'.repeat(40) : observed.tree,
      intent: { risk: 'behavior', criteria: 'Approved changed intent' }, authorSessionId: 'next-author' };
    session = prepareCandidate(session, next, time + 1, true);
    for (const reviewer of ['reviewer-2', 'reviewer-3']) session = recordReport(session, report({ reviewer, tree: next.tree }), time + 1);
    expect(verdict(session, next, time + 1)).toMatchObject({ code: 'needs_agent_review', reason: 'close every material finding' });
    session = recordReport(session, report({ reviewer: 'reviewer-4', tree: next.tree, closes: ['F1'] }), time + 1);
    expect(verdict(session, next, time + 1).ok).toBe(true);
    expect(receiptSummary(session, 12, time + 1).risk).toBe('behavior');
  });
  it.each(['reviewer-1', 'author', 'next-author'])('--new refuses historical reviewer or author %s', reviewer => {
    let session = prepareCandidate(passed(), { ...observed, intent, authorSessionId: 'next-author' }, time + 1, true);
    session = prepareCandidate(session, { ...observed, intent, authorSessionId: 'third-author' }, time + 2, true);
    expect(() => recordReport(session, report({ reviewer }), time + 2)).toThrow(reviewer === 'reviewer-1' ? 'already used' : 'independent');
    session = recordReport(session, report({ reviewer: 'fresh-reviewer' }), time + 2);
    session.history.at(-1).report.reviewer = reviewer;
    expect(verdict(session, observed, time + 2).code).toBe('invalid');
  });
  it.each([false, true])('first prepare accepts --new = %s and hashes intent history', fresh => {
    const session = prepareCandidate(null, { ...observed, intent, authorSessionId: 'author' }, time, fresh);
    expect(session).toEqual(prepare());
    const next = prepareCandidate(session, { ...observed, intent: { ...intent, criteria: 'Changed goal' }, authorSessionId: 'author' }, time, true);
    const alteredHistory = structuredClone(next); alteredHistory.history[0].intent.criteria = 'Different original goal';
    expect(digest(alteredHistory)).not.toBe(digest(next));
    expect(next.history[0].intent).toEqual(intent);
  });
  it.each([false, true])('--new retains version and timestamp validation (bad version: %s)', badVersion => {
    const session = prepare(); if (badVersion) session.version = 1;
    expect(() => prepareCandidate(session, { ...observed, intent, authorSessionId: 'author' }, time - 1, true)).toThrow(badVersion ? 'version' : 'time');
  });
  it.each([
    ['dirty source', { clean: false }], ['missing author', { authorSessionId: '' }],
    ['missing criteria', { intent: {} }],
    ['bad risk', { intent: { ...intent, risk: 'safe' } }],
  ])('refuses preparation: %s', (_name, patch) => expect(() => prepare(patch)).toThrow());
  it('unchanged prepare preserves history and expiry; changed intent requires --new', () => {
    const session = passed(); const bytes = JSON.stringify(session);
    expect(prepareCandidate(session, { ...observed, intent, authorSessionId: 'author' }, time + 1)).toEqual(session);
    expect(() => prepareCandidate(session, { ...observed, intent: { ...intent, criteria: 'new goal' }, authorSessionId: 'author' }, time)).toThrow('prepare --new');
    expect(JSON.stringify(session)).toBe(bytes);
  });
  it('refuses invalid report timestamps', () => {
    expect(() => recordReport(prepare(), report(), time - 1)).toThrow('time');
  });
  it('focuses an exact base integration without copying reports', () => {
    const source = passed();
    const actual = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), intent, authorSessionId: 'author' };
    const integration = integrationReviewContext(source, actual, { parents: [observed.head, actual.base], baseAncestor: true }, time + 1);
    expect(integration).toMatchObject({ base: observed.base, head: observed.head, tree: observed.tree, expires: time + 86400000, mechanical: false });
    let next = prepareCandidate(source, { ...actual, integration }, time + 1);
    expect(next.history.slice(0, -1)).toEqual(source.history);
    expect(verdict(next, actual, time + 1).code).toBe('needs_agent_review');
    next = recordReport(next, report({ reviewer: 'fresh-a', tree: actual.tree }), time + 60000);
    expect(verdict(next, actual, time + 60000).code).toBe('needs_agent_review');
    next = recordReport(next, report({ reviewer: 'fresh-b', tree: actual.tree }), time + 60000);
    expect(verdict(next, actual, time + 60000).ok).toBe(true);
    expect(receiptSummary(next, 12, time + 60000).expires).toBe(time + 86400000);
    const legacy = structuredClone(next); delete legacy.candidate.integration.mechanical;
    expect(verdict(legacy, actual, time + 60000).ok).toBe(true);
    expect(prepareCandidate(legacy, actual, time + 60001)).toEqual(legacy);
    expect(verdict(next, actual, time + 86400000).code).toBe('reviewed');
    expect(prepareCandidate(next, actual, time + 60001)).toEqual(next);
    const renewed = prepareCandidate(next, actual, time + 86400000, true);
    expect(renewed.candidate.integration).toBeUndefined();
    expect(() => prepareCandidate(source, { ...actual, integration: { ...integration, expires: integration.expires + 1 } }, time + 1)).toThrow('integration coverage');
    expect(() => prepareCandidate(source, { ...actual, integration: { ...integration, mechanical: 'yes' } }, time + 1)).toThrow('integration coverage');
    expect(() => prepareCandidate(source, { ...actual, integration }, time + 1, true)).toThrow('integration coverage');
  });
  it.each(['missing', 'open finding', 'wrong parent', 'extra parent', 'base not ancestor', 'changed intent', 'changed author'])('does not focus integration with %s coverage', reason => {
    let source = reason === 'missing' ? prepare() : passed();
    if (reason === 'open finding') source = recordReport(source, report({ reviewer: 'defect', verdict: 'FAIL', findings: [{ id: 'F1', summary: 'unresolved', material: true }] }), time);
    const actual = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), intent: reason === 'changed intent' ? { ...intent, criteria: 'Other goal' } : intent, authorSessionId: reason === 'changed author' ? 'other' : 'author' };
    const parents = reason === 'wrong parent' ? [actual.base, observed.head] : reason === 'extra parent' ? [observed.head, actual.base, observed.base] : [observed.head, actual.base];
    expect(integrationReviewContext(source, actual, { parents, baseAncestor: reason !== 'base not ancestor', mechanical: true }, time + 1)).toBeUndefined();
  });
  it('retains the two-reviewer floor for a v2 integration', () => {
    const source = passed();
    const actual = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), intent, authorSessionId: 'author' };
    const integration = integrationReviewContext(source, actual, { parents: [observed.head, actual.base], baseAncestor: true }, time + 1);
    let next = recordReport(prepareCandidate(source, { ...actual, integration }, time + 1), report({ reviewer: 'fresh', tree: actual.tree }), time + 1);
    expect(verdict(next, actual, time + 1).code).toBe('needs_agent_review');
    next = recordReport(next, report({ reviewer: 'fresh-2', tree: actual.tree }), time + 1);
    expect(verdict(next, actual, time + 1).ok).toBe(true);
    const receipt = receiptSummary(next, 12, time + 1);
    expect(receipt.risk).toBe('behavior');
    expect(admit({ receipt: { ...receipt, reviewers: ['fresh'] }, observed: { ...actual, pr: 12, baseValid: true }, now: time + 1 }).code).toBe('needs_agent_review');
  });
  it('emits only a bounded summary and validates the PR number', () => {
    const summary = receiptSummary(passed(), 12, time);
    expect(summary).toMatchObject({ pr: 12, base: observed.base, head: observed.head, tree: observed.tree, reviewers: ['reviewer-1'], verdict: 'PASS' });
    expect(summary.sessionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(summary).not.toHaveProperty('history');
    expect(() => receiptSummary(passed(), 0, time)).toThrow('PR number');
  });
});
