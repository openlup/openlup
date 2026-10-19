import { describe, expect, it } from 'vitest';
import { classifyRisk, continueOwner, digest, prepareCandidate, receiptSummary, recordReport, requiredReviewers, verdict } from './agent-review-decide.mjs';

const time = 1000;
const observed = { base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), changedPaths: ['source.txt'], clean: true };
const intent = { risk: 'routine', criteria: 'Preserve the approved behavior' };
const prepare = (extra = {}) => prepareCandidate(null, { ...observed, intent, authorSessionId: 'author', ...extra }, time);
const report = (extra = {}) => ({ reviewer: 'reviewer-1', cold: true, tree: observed.tree, verdict: 'PASS', findings: [], closes: [], ...extra });
const passed = () => recordReport(prepare(), report(), time);

describe('native review decisions', () => {
  it.each([
    ['prose', 1], ['routine', 1], ['behavior', 2], ['unknown', 2],
  ])('requires the %s reviewer floor', (risk, count) => {
    expect(requiredReviewers(classifyRisk(observed, risk))).toBe(count);
    const session = recordReport(prepare({ intent: { ...intent, risk } }), report(), time);
    expect(verdict(session, observed, time).ok).toBe(count === 1);
  });
  it.each([
    '.github/README.md', 'AGENTS.md', 'package.json', 'config/settings.json', 'db/example.sql',
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
    ['just before expiry', passed, observed, time + 86400000 - 1, 'reviewed'],
    ['at expiry', passed, observed, time + 86400000, 'expired'],
    ['future report', passed, observed, time - 1, 'invalid'],
    ['invalid clock', passed, observed, NaN, 'invalid'],
    ['old version', () => ({ version: 1 }), observed, time, 'invalid'],
  ])('%s', (_name, state, actual, now, code) => {
    expect(verdict(state(), actual, now).code).toBe(code);
  });
  it.each([
    { reviewer: 'author' }, { reviewer: '' }, { cold: false }, { verdict: 'pass' },
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
  it.each([{ reviewer: 'author' }, { cold: false }])('rechecks persisted reviewer independence: %j', patch => {
    const session = passed(); Object.assign(session.history.at(-1).report, patch);
    expect(verdict(session, observed, time).code).toBe('invalid');
  });
  it('never lets a later report refresh the earliest counted PASS expiry', () => {
    let session = recordReport(prepare({ intent: { ...intent, risk: 'behavior' } }), report(), time);
    session = recordReport(session, report({ reviewer: 'reviewer-2' }), time + 60000);
    expect(verdict(session, observed, time + 86400000).code).toBe('expired');
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
  it('bounds three repairs and grants three more with an owner note', () => {
    let session = prepare();
    for (let cycle = 1; cycle <= 7; cycle += 1) {
      const next = { ...observed, head: cycle.toString().repeat(40), tree: cycle.toString().repeat(40), intent, authorSessionId: 'author' };
      session = prepareCandidate(session, next, time + cycle);
      expect(session.cycle).toBe(cycle);
      if (cycle === 4) {
        expect(verdict(session, next, time + cycle).code).toBe('needs_owner');
        expect(() => recordReport(session, report({ tree: next.tree }), time + cycle)).toThrow('needs_owner');
        session = continueOwner(session, 'Owner approves three further repairs', time + cycle);
        expect(session.history.at(-1)).toMatchObject({ type: 'continue', at: time + cycle });
      }
      expect(verdict(session, next, time + cycle).code).toBe(cycle > 6 ? 'needs_owner' : 'needs_agent_review');
    }
  });
  it.each([
    [2, 3, false, 2, 'needs_agent_review'],
    [2, 3, true, 3, 'needs_agent_review'],
    [3, 3, true, 4, 'needs_owner'],
    [4, 3, false, 4, 'needs_owner'],
    [4, 3, true, 5, 'needs_owner'],
    [5, 6, true, 6, 'needs_agent_review'],
    [7, 6, false, 7, 'needs_owner'],
  ])('--new preserves budget %i/%i (changed tree: %s)', (cycle, allowedCycles, changed, expectedCycle, code) => {
    const session = { ...passed(), cycle, allowedCycles };
    const bytes = JSON.stringify(session);
    const nextObserved = { ...observed, head: 'd'.repeat(40), tree: changed ? 'e'.repeat(40) : observed.tree,
      intent: { ...intent, criteria: 'Approved changed intent' }, authorSessionId: 'author' };
    const next = prepareCandidate(session, nextObserved, time + 1, true);
    expect(next).toMatchObject({ cycle: expectedCycle, allowedCycles, previousSessionDigest: digest(session), intent: nextObserved.intent });
    expect(next.history).toHaveLength(1);
    expect(verdict(next, nextObserved, time + 1).code).toBe(code);
    if (code === 'needs_owner') {
      expect(() => recordReport(next, report({ tree: nextObserved.tree }), time + 1)).toThrow('needs_owner');
      expect(continueOwner(next, 'Owner authorizes continuation', time + 1).allowedCycles).toBe(allowedCycles + 3);
    }
    expect(JSON.stringify(session)).toBe(bytes);
  });
  it.each([
    ['dirty source', { clean: false }], ['missing author', { authorSessionId: '' }],
    ['missing criteria', { intent: {} }], ['scope mismatch', { intent: { ...intent, scope: ['elsewhere.txt'] } }],
    ['bad risk', { intent: { ...intent, risk: 'safe' } }],
  ])('refuses preparation: %s', (_name, patch) => expect(() => prepare(patch)).toThrow());
  it('unchanged prepare preserves history and expiry; changed intent requires --new', () => {
    const session = passed(); const bytes = JSON.stringify(session);
    expect(prepareCandidate(session, { ...observed, intent, authorSessionId: 'author' }, time + 1)).toEqual(session);
    expect(() => prepareCandidate(session, { ...observed, intent: { ...intent, criteria: 'new goal' }, authorSessionId: 'author' }, time)).toThrow('prepare --new');
    expect(JSON.stringify(session)).toBe(bytes);
  });
  it('refuses invalid owner notes and report timestamps', () => {
    expect(() => continueOwner(prepare(), '', time)).toThrow();
    expect(() => recordReport(prepare(), report(), time - 1)).toThrow('time');
  });
  it('emits only a bounded summary and validates the PR number', () => {
    const summary = receiptSummary(passed(), 12, time);
    expect(summary).toMatchObject({ pr: 12, base: observed.base, head: observed.head, tree: observed.tree, reviewers: ['reviewer-1'], verdict: 'PASS' });
    expect(summary.sessionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(summary).not.toHaveProperty('history');
    expect(() => receiptSummary(passed(), 0, time)).toThrow('PR number');
  });
});
