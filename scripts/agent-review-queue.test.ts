import { describe, expect, it, vi } from 'vitest';
import { admit, carryOver, exportAdditions, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { carryOverSourceReview, parseReceipt, readReceipts, waitNativeAdmission } from './agent-review-queue.mjs';

const time = 1000;
const receipt = { pr: 12, base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), risk: 'routine', reviewers: ['reviewer'], verdict: 'PASS', expires: time + 86400000, sessionDigest: 'd'.repeat(64) };
const observed = { ...receipt, baseValid: true, changedPaths: ['source.txt'] };
const body = (value = receipt) => `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const comment = (patch = {}) => ({ id: 1, body: body(), author_association: 'OWNER', user: { login: 'review-owner', type: 'User' }, created_at: '2026-10-19T00:00:00Z', ...patch });
const manifestPath = 'packages/p/package.json';
const manifest = { name: '@openlup/p', version: '0.1.0', exports: { '.': './index.js' } };
const queueManifest = { ...manifest, exports: { ...manifest.exports, './a': './a.js' } };
const headManifest = { ...manifest, exports: { ...manifest.exports, './b': './b.js' } };
const groupManifest = { ...manifest, exports: { ...queueManifest.exports, ...headManifest.exports } };

describe('pure export additions', () => {
  it.each([
    ['new key', manifest, queueManifest, ['./a']],
    ['unchanged', manifest, manifest, []],
    ['nested conditions and reordered object keys',
      { dependencies: { a: '1', b: '2' }, exports: { '.': { import: { types: './index.d.ts', default: './index.js' }, require: './index.cjs' } } },
      { exports: { './a': './a.js', '.': { require: './index.cjs', import: { default: './index.js', types: './index.d.ts' } } }, dependencies: { b: '2', a: '1' } }, null],
    ['reordered nested conditions',
      { exports: { '.': { import: { types: './index.d.ts', default: './index.js' } } } },
      { exports: { '.': { import: { default: './index.js', types: './index.d.ts' } }, './a': './a.js' } }, null],
    ['reordered other top-level value',
      { ...manifest, dependencies: { a: '1', b: '2' } },
      { ...queueManifest, dependencies: { b: '2', a: '1' } }, null],
    ['changed nested target', { exports: { '.': { import: './index.js' } } }, { exports: { '.': { import: './other.js' } } }, null],
    ['removed export', manifest, { ...manifest, exports: {} }, null],
    ['added top-level key', manifest, { ...queueManifest, dependencies: { a: '1' } }, null],
    ['removed top-level key', manifest, { exports: manifest.exports }, null],
    ['replaced top-level key', { name: 'p', exports: {} }, { version: '1', exports: {} }, null],
    ['changed top-level value', manifest, { ...queueManifest, version: '0.2.0' }, null],
    ['string-valued exports before', { exports: './index.js' }, manifest, null],
    ['string-valued exports after', manifest, { exports: './index.js' }, null],
    ['missing exports', {}, { exports: {} }, null],
    ['array exports', { exports: [] }, { exports: {} }, null],
    ['null exports', { exports: null }, { exports: {} }, null],
    ['condition-sugar exports', { exports: { import: './index.js' } }, { exports: { import: './index.js', require: './index.cjs' } }, null],
    ['condition-sugar key added', manifest, { ...queueManifest, exports: { ...queueManifest.exports, default: './index.js' } }, null],
    ['missing object', undefined, manifest, null],
    ['null object', manifest, null, null],
    ['array object', [], manifest, null],
    ['non-plain object', new Date(0), manifest, null],
  ])('%s', (_name, before, after, expected) => {
    expect(exportAdditions(before, after)).toEqual(expected);
  });
});

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
  const manifests = { [manifestPath]: { base: manifest, queueBase: queueManifest, head: headManifest, group: groupManifest } };
  it.each([
    ['disjoint export additions', {}, {}, true],
    ['protected path without PR overlap', {}, { changedPaths: [] }, true],
    ['main modifies existing export', { queueBase: { ...queueManifest, exports: { ...queueManifest.exports, '.': './other.js' } } }, {}, false],
    ['main reorders conditions of an existing export', {
      base: { ...manifest, exports: { '.': { types: './index.d.ts', default: './index.js' } } },
      head: { ...headManifest, exports: { ...headManifest.exports, '.': { types: './index.d.ts', default: './index.js' } } },
      queueBase: { ...queueManifest, exports: { ...queueManifest.exports, '.': { default: './index.js', types: './index.d.ts' } } },
      group: { ...groupManifest, exports: { ...groupManifest.exports, '.': { types: './index.d.ts', default: './index.js' } } },
    }, {}, false],
    ['main removes export', { queueBase: { ...manifest, exports: { './a': './a.js' } } }, {}, false],
    ['main adds dependency', { queueBase: { ...queueManifest, dependencies: { a: '1' } } }, {}, false],
    ['main bumps version', { queueBase: { ...queueManifest, version: '0.2.0' } }, {}, false],
    ['overlapping added key', { head: queueManifest }, {}, false],
    ['PR touches non-export key', { head: { ...headManifest, version: '0.2.0' } }, {}, false],
    ['missing base', { base: undefined }, {}, false],
    ['missing queue base', { queueBase: undefined }, {}, false],
    ['unparseable head', { head: undefined }, {}, false],
    ['missing group manifest', { group: undefined }, {}, false],
    ['group manifest missing main addition', { group: headManifest }, {}, false],
    ['group manifest missing PR addition', { group: queueManifest }, {}, false],
    ['group manifest with extra key', { group: { ...groupManifest, exports: { ...groupManifest.exports, './extra': './extra.js' } } }, {}, false],
    ['missing manifests', {}, { manifests: undefined }, false],
    ['missing manifest entry', {}, { manifests: {} }, false],
    ['root manifest', {}, { movedPaths: ['package.json'], manifests: { 'package.json': manifests[manifestPath] } }, false],
    ['package lockfile', {}, { movedPaths: ['packages/x/package-lock.json'], manifests: { 'packages/x/package-lock.json': manifests[manifestPath] } }, false],
    ['root lockfile', {}, { movedPaths: ['package-lock.json'], manifests: { 'package-lock.json': manifests[manifestPath] } }, false],
    ['wrong predicted tree', {}, { predictedTree: 'f'.repeat(40) }, false],
    ['unlanded base', {}, { baseAncestor: false }, false],
    ['another overlapping path', {}, { movedPaths: [manifestPath, 'source.txt'], changedPaths: [manifestPath, 'source.txt'] }, false],
    ['another protected path', {}, { movedPaths: [manifestPath, '.github/workflows/extra.yml'] }, false],
  ])('export carry-over: %s', (_name, manifestPatch, patch, ok) => {
    const decision = carryOver({ ...facts, movedPaths: [manifestPath], changedPaths: [manifestPath], manifests: { [manifestPath]: { ...manifests[manifestPath], ...manifestPatch } }, ...patch });
    expect(decision.code).toBe(ok ? 'reviewed' : 'stale');
    expect(decision.ok).toBe(ok);
    if (ok) expect(decision.reason).toBe('disjoint base move with export additions');
  });
  it.each(['not JSON', `${RECEIPT_MARKER}\n{}`, `prefix\n${body()}`, `${RECEIPT_MARKER}\n\`\`\`json\n{\n\`\`\``])('ignores malformed receipt %s', value => {
    expect(parseReceipt(value)).toBeNull();
  });
  it.each([
    ['CONTRIBUTOR', { permission: 'admin', role_name: 'admin' }, true],
    ['CONTRIBUTOR', { permission: 'write', role_name: 'write' }, true],
    ['CONTRIBUTOR', { permission: 'write', role_name: 'maintain' }, true],
    ['CONTRIBUTOR', { permission: 'maintain' }, true],
    ['CONTRIBUTOR', { role_name: 'admin' }, true],
    ['CONTRIBUTOR', { role_name: 'maintain' }, true],
    ['CONTRIBUTOR', { role_name: 'write' }, true],
    ['CONTRIBUTOR', { permission: 'write', role_name: 'custom-writer' }, true],
    ['CONTRIBUTOR', { permission: 'read' }, false],
    ['CONTRIBUTOR', { permission: 'none' }, false],
    ['CONTRIBUTOR', { permission: 'read', role_name: 'triage' }, false],
    ['OWNER', { permission: 'read', role_name: 'admin' }, false],
    ['MEMBER', { permission: 'read' }, false],
    ['COLLABORATOR', { permission: 'none' }, false],
    ['NONE', { permission: 'admin' }, true],
    ['OWNER', {}, false],
    ['OWNER', null, false],
  ])('checks repository permission for %s: %j', async (association, access, trusted) => {
    const api = { get: vi.fn(async path => path.includes('/collaborators/') ? access : [comment({ author_association: association })]) };
    const found = await readReceipts(api, '/repos/openlup/openlup', 12, receipt.head, time);
    expect(found).toHaveLength(trusted ? 1 : 0);
    expect(api.get).toHaveBeenCalledWith('/repos/openlup/openlup/collaborators/review-owner/permission');
  });
  it.each(['404', '403', 'network failure'])('refuses a failed permission lookup: %s', async message => {
    const api = { get: vi.fn(async path => {
      if (path.includes('/collaborators/')) throw new Error(message);
      return [comment()];
    }) };
    await expect(readReceipts(api, '/repos/o/r', 12, receipt.head, time)).resolves.toEqual([]);
  });
  it.each([{ login: 'review-bot[bot]', type: 'Bot' }, { login: 'ghost', type: 'Mannequin' }, { type: 'User' }, null])('refuses bots and missing user identity: %j', async user => {
    const api = { get: vi.fn(async () => [comment({ user })]) };
    await expect(readReceipts(api, '/repos/o/r', 12, receipt.head, time)).resolves.toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it('paginates and chooses the newest valid matching comment, ignoring malformed and stale receipts', async () => {
    const old = comment({ id: 2 }); const newer = comment({ id: 3, body: body({ ...receipt, reviewers: ['new'] }) });
    const first = Array.from({ length: 100 }, (_, index) => comment({ id: index + 4, body: 'unrelated' }));
    first[0] = comment({ id: 105, body: body({ ...receipt, head: 'e'.repeat(40) }) });
    first[1] = comment({ id: 106, body: body({ ...receipt, expires: time }) });
    first[2] = comment({ id: 107, body: body({ ...receipt, pr: 13 }) });
    const api = { get: vi.fn(async path => path.includes('/collaborators/') ? { permission: 'admin' } : path.endsWith('page=1') ? first : [old, newer]) };
    expect((await readReceipts(api, '/repos/o/r', 12, receipt.head, time)).map(item => item.reviewers)).toEqual([['new'], ['reviewer']]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
  it.each(['newer bad base', 'equal-tree group', 'live head changed', 'expiry during admission', 'main moved'])('wait checks %s with fake API and Git', async scenario => {
    let clock = time; let mainReads = 0;
    const group = scenario === 'equal-tree group'; const groupHead = 'f'.repeat(40);
    const event = { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } }, action: 'checks_requested', merge_group: { base_ref: 'refs/heads/main', head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${groupHead}`, base_sha: receipt.base, head_sha: groupHead } };
    const api = { get: vi.fn(async path => {
      if (path.includes('/collaborators/')) return { permission: 'admin' };
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
  it.each(['read', 'lookup failure'])('refuses across wait polls, caching only a real permission: %s', async permission => {
    let clock = time;
    const api = { get: vi.fn(async path => {
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: receipt.head } };
      if (path.includes('/collaborators/')) {
        if (permission === 'lookup failure') throw new Error('403');
        return { permission };
      }
      return [comment(), comment({ id: 2, user: { login: 'REVIEW-OWNER', type: 'User' } })];
    }) };
    const sleep = vi.fn(async ms => { clock += ms; }); const runGit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitNativeAdmission({ event: { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, now: () => clock, sleep, deadlineMs: 30000 })).rejects.toThrow('bounded 20-minute receipt wait expired');
      expect(sleep.mock.calls).toEqual([[15000], [15000]]); expect(runGit).not.toHaveBeenCalled();
      const lookups = api.get.mock.calls.filter(([path]) => path.includes('/collaborators/')).length;
      // A real 'read' answer is cached; a failed lookup is retried on every poll, never trusted.
      if (permission === 'read') expect(lookups).toBe(1); else expect(lookups).toBeGreaterThanOrEqual(3);
    } finally { log.mockRestore(); }
  });
});

describe('carry-over manifest adapter', () => {
  const candidate = { base: receipt.base, head: receipt.head, tree: receipt.tree, changedPaths: [manifestPath] };
  const group = { base: 'e'.repeat(40), tree: 'f'.repeat(40) };
  it.each([
    ['valid', undefined, 'valid'],
    ...[candidate.base, group.base, candidate.head, group.tree].flatMap(sha => ['limit', 'missing', 'invalid', 'oversized'].map(failure => [failure, sha, failure])),
  ])('%s blob at %s', async (_name, failingSha, failure) => {
    const values = { [candidate.base]: manifest, [group.base]: queueManifest, [candidate.head]: headManifest, [group.tree]: groupManifest };
    const runGit = vi.fn(async (_cwd, command, ...args) => {
      if (command === 'merge-base') return '';
      if (command === 'merge-tree') return group.tree;
      if (command === 'diff') return `${manifestPath}\0`;
      const sha = args[0].split(':')[0]; const json = JSON.stringify(values[sha]);
      if (sha !== failingSha) return json;
      if (failure === 'missing') throw new Error('missing blob');
      if (failure === 'invalid') return '{';
      if (failure === 'oversized') {
        if (sha === candidate.base) return json.padEnd(1024 * 1024 + 1, ' ');
        return JSON.stringify({ ...values[sha], exports: { ...values[sha].exports, [sha === group.base ? './a' : './b']: 'é'.repeat(524288) } });
      }
      return json.padEnd(1024 * 1024, ' ');
    });
    const decision = await carryOverSourceReview('/fixture', candidate, group, runGit);
    expect(decision.code).toBe(['valid', 'limit'].includes(failure) ? 'reviewed' : 'stale');
    expect(runGit.mock.calls.filter(([, command]) => command === 'show')).toEqual([
      ['/fixture', 'show', `${candidate.base}:${manifestPath}`],
      ['/fixture', 'show', `${group.base}:${manifestPath}`],
      ['/fixture', 'show', `${candidate.head}:${manifestPath}`],
      ['/fixture', 'show', `${group.tree}:${manifestPath}`],
    ]);
  });
  it.each(['package.json', 'package-lock.json', 'packages/x/package-lock.json'])('does not read blobs for %s', async path => {
    const runGit = vi.fn(async (_cwd, command) => command === 'diff' ? `${path}\0` : command === 'merge-tree' ? group.tree : '');
    expect((await carryOverSourceReview('/fixture', candidate, group, runGit)).code).toBe('stale');
    expect(runGit.mock.calls.some(([, command]) => command === 'show')).toBe(false);
  });
});
