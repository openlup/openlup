import { describe, expect, it, vi } from 'vitest';
import { admit, carryOver, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { parseReceipt, readReceipts, waitNativeAdmission } from './agent-review-queue.mjs';

const time = 1000;
const receipt = { pr: 12, base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), risk: 'routine', reviewers: ['reviewer'], verdict: 'PASS', expires: time + 86400000, sessionDigest: 'd'.repeat(64) };
const observed = { ...receipt, baseValid: true, changedPaths: ['source.txt'] };
const body = (value = receipt) => `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const comment = (patch = {}) => ({ id: 1, body: body(), author_association: 'OWNER', created_at: '2026-10-19T00:00:00Z', ...patch });

describe('hosted review decisions', () => {
  it.each([
    ['pass', {}, {}, time, 'reviewed'],
    ['expired', {}, {}, receipt.expires, 'expired'],
    ['future expiry', { expires: receipt.expires + 1 }, {}, time, 'invalid'],
    ['wrong PR', { pr: 13 }, {}, time, 'stale'],
    ['wrong head', { head: 'e'.repeat(40) }, {}, time, 'stale'],
    ['wrong tree', { tree: 'e'.repeat(40) }, {}, time, 'stale'],
    ['wrong base', { base: 'e'.repeat(40) }, {}, time, 'stale'],
    ['unlanded pin', {}, { baseValid: false }, time, 'stale'],
    ['failed verdict', { verdict: 'FAIL' }, {}, time, 'invalid'],
    ['duplicate reviewers', { reviewers: ['r', 'r'] }, {}, time, 'invalid'],
    ['empty reviewer', { reviewers: [''] }, {}, time, 'invalid'],
    ['bad digest', { sessionDigest: 'bad' }, {}, time, 'invalid'],
    ['recomputed floor', {}, { changedPaths: ['AGENTS.md'] }, time, 'needs_agent_review'],
    ['mode floor', {}, { modeChanged: true }, time, 'needs_agent_review'],
    ['intent raises floor', { risk: 'unknown' }, {}, time, 'needs_agent_review'],
  ])('%s', (_name, patch, actual, now, code) => {
    expect(admit({ receipt: { ...receipt, ...patch }, observed: { ...observed, ...actual }, now }).code).toBe(code);
  });
  const facts = { reviewedTree: receipt.tree, groupTree: 'e'.repeat(40), baseAncestor: true, predictedTree: 'e'.repeat(40), changedPaths: ['source.txt'], movedPaths: ['other.ts'] };
  it.each([
    ['equal tree', { groupTree: receipt.tree, predictedTree: null }, true],
    ['disjoint paths', {}, true],
    ['unlanded base, even with equal tree', { baseAncestor: false, groupTree: receipt.tree }, false],
    ['wrong prediction', { predictedTree: 'f'.repeat(40) }, false],
    ['conflict', { predictedTree: null }, false],
    ['overlap', { movedPaths: ['source.txt'] }, false],
    ['ordinary check config', { movedPaths: ['vitest.config.ts'] }, true],
  ])('carry-over: %s', (_name, patch, ok) => {
    const decision = carryOver({ ...facts, ...patch }); expect(decision.ok).toBe(ok);
    if (!ok) expect(decision.reason).toContain('merge main and re-review');
  });
  it.each([
    '.github/workflows/extra.yml', 'scripts/agent-review-decide.mjs', 'scripts/documentation-git.ts',
    'package.json', 'package-lock.json', 'packages/core/package.json', 'packages/core/package-lock.json',
    'supabase/migrations/0001_extra.sql', 'db/platform/migrations/0001_extra.sql', 'config/platform-migration-manifest.json',
  ])('refuses protected base move %s', path => {
    expect(carryOver({ ...facts, movedPaths: [path] }).ok).toBe(false);
  });
  it.each(['not JSON', `${RECEIPT_MARKER}\n{}`, `prefix\n${body()}`, `${RECEIPT_MARKER}\n\`\`\`json\n{\n\`\`\``])('ignores malformed receipt %s', value => {
    expect(parseReceipt(value)).toBeNull();
  });
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'])('checks author association %s', async association => {
    const api = { get: vi.fn(async () => [comment({ author_association: association })]) };
    const found = await readReceipts(api, '/repos/openlup/openlup', 12, receipt.head, time);
    expect(found).toHaveLength(['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association) ? 1 : 0);
  });
  it('paginates and chooses the newest valid matching comment, ignoring malformed and stale receipts', async () => {
    const old = comment({ id: 2 }); const newer = comment({ id: 3, body: body({ ...receipt, reviewers: ['new'] }) });
    const first = Array.from({ length: 100 }, (_, index) => comment({ id: index + 4, body: 'unrelated' }));
    first[0] = comment({ id: 105, body: body({ ...receipt, head: 'e'.repeat(40) }) });
    first[1] = comment({ id: 106, body: body({ ...receipt, expires: time }) });
    first[2] = comment({ id: 107, body: body({ ...receipt, pr: 13 }) });
    const api = { get: vi.fn(async path => path.endsWith('page=1') ? first : [old, newer]) };
    expect((await readReceipts(api, '/repos/o/r', 12, receipt.head, time)).map(item => item.reviewers)).toEqual([['new'], ['reviewer']]);
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it.each(['newer bad base', 'equal-tree group', 'live head changed', 'expiry during admission', 'main moved'])('wait checks %s with fake API and Git', async scenario => {
    let clock = time; let mainReads = 0;
    const group = scenario === 'equal-tree group'; const groupHead = 'f'.repeat(40);
    const event = { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } }, action: 'checks_requested', merge_group: { base_ref: 'refs/heads/main', head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${groupHead}`, base_sha: receipt.base, head_sha: groupHead } };
    const api = { get: vi.fn(async path => {
      if (path.includes('/issues/')) return scenario === 'newer bad base' ? [comment(), comment({ id: 2, body: body({ ...receipt, base: 'e'.repeat(40) }) })] : [comment()];
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: scenario === 'live head changed' ? groupHead : receipt.head } };
      mainReads += 1;
      if (mainReads === 2 && scenario === 'expiry during admission') clock = receipt.expires;
      return { object: { sha: mainReads === 2 && scenario === 'main moved' ? groupHead : receipt.base } };
    }) };
    const runGit = vi.fn(async (_cwd, ...args) => {
      if (args.includes('fetch') && args.includes('e'.repeat(40))) throw new Error('unknown base');
      if (args[0] === 'rev-parse') return receipt.tree;
      if (args[0] === 'merge-base' && args[1] === '--all') return receipt.base;
      return '';
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const wait = waitNativeAdmission({ event, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: group ? 'merge_group' : 'pull_request' }, api, runGit, now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 15000 });
      if (scenario === 'live head changed') await expect(wait).rejects.toThrow('PR head changed');
      else if (scenario === 'expiry during admission') await expect(wait).rejects.toThrow('expired');
      else if (scenario === 'main moved') await expect(wait).rejects.toThrow('main moved');
      else {
        await expect(wait).resolves.toBeUndefined(); expect(log).toHaveBeenLastCalledWith(expect.stringContaining(group ? 'unchanged tree' : 'reviewed PR head'));
        expect(runGit.mock.calls).toContainEqual([expect.any(String), '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', receipt.base, receipt.head, ...(group ? [groupHead] : [])]);
      }
    } finally { log.mockRestore(); }
  });
  it('polls on the injected clock and reports a bounded timeout without Git', async () => {
    let clock = time;
    const api = { get: vi.fn(async path => path.includes('/pulls/') ? { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: receipt.head } } : []) };
    const sleep = vi.fn(async ms => { clock += ms; }); const runGit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitNativeAdmission({ event: { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, now: () => clock, sleep, deadlineMs: 30000 })).rejects.toThrow('bounded 20-minute receipt wait expired');
      expect(sleep.mock.calls).toEqual([[15000], [15000]]); expect(runGit).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
