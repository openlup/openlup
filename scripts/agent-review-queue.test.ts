import { describe, expect, it, vi } from 'vitest';
import { admit, carryOver, exportAdditions, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { carryOverSourceReview, enqueueAfterChecks, parseReceipt, readReceipts, waitNativeAdmission } from './agent-review-queue.mjs';
import { REQUIRED_CONTEXTS } from './packages/release-gate.ts';

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

function handoffFixture() {
  const repository = { id: 1376035358, full_name: 'openlup/openlup', private: false, owner: { login: 'openlup' } };
  const run = { id: 100, workflow_id: 42, run_attempt: 1, event: 'pull_request', path: '.github/workflows/published-tree-ci.yml', repository,
    head_repository: structuredClone(repository), head_sha: receipt.head, head_branch: 'task/queue', status: 'completed', conclusion: 'success', pull_requests: [] };
  const pr = { number: receipt.pr, state: 'open', draft: false, merged: false, base: { ref: 'main', repo: repository },
    head: { sha: receipt.head, ref: run.head_branch, repo: structuredClone(repository) } };
  const queuePr = { id: 'PR_12', number: receipt.pr, state: 'OPEN', isDraft: false, merged: false, baseRefName: 'main', headRefOid: receipt.head,
    mergeable: 'MERGEABLE', autoMergeRequest: { enabledAt: '2026-10-24T12:00:00Z', enabledBy: { login: 'merge-owner' } }, mergeQueueEntry: null as null | { id: string },
    timelineItems: { nodes: [] as { createdAt: string }[] } };
  const jobs = [...REQUIRED_CONTEXTS, 'native-review'].map((name, index) => ({ id: index + 1, name, run_id: run.id, run_attempt: 1, head_sha: receipt.head, status: 'completed', conclusion: 'success' }));
  const f = { event: { action: 'completed', repository, workflow_run: structuredClone(run) },
    env: { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_REF: 'refs/heads/main' }, run, pr, queuePr,
    pulls: [pr], listing: { total_count: 1, workflow_runs: [run] }, result: { total_count: jobs.length, jobs }, comments: [comment()],
    permission: 'write', clock: time, getHook: (_path: string) => {} };
  const api = { get: vi.fn(async (path: string) => {
    f.getHook(path);
    if (path.startsWith('/graphql?')) return { data: { repository: { pullRequest: structuredClone(f.queuePr) } } };
    if (path.includes('/collaborators/')) return { permission: f.permission };
    if (path.includes('/jobs?')) {
      const page = Number(new URL(path, 'https://example.invalid').searchParams.get('page'));
      return { total_count: f.result.total_count, jobs: structuredClone(f.result.jobs.slice((page - 1) * 100, page * 100)) };
    }
    if (path.includes('/actions/workflows/')) return structuredClone(f.listing);
    if (path.includes('/actions/runs/')) return structuredClone(f.run);
    if (path.includes('/pulls?')) return structuredClone(f.pulls);
    if (path.includes('/pulls/')) return structuredClone(f.pr);
    if (path.includes('/issues/')) return structuredClone(f.comments);
    if (path.includes('/git/ref/')) return { object: { sha: receipt.base } };
    throw new Error(`unexpected read ${path}`);
  }) };
  const runGit = vi.fn(async (_cwd: string, ...args: string[]) => {
    if (args[0] === 'rev-parse') return receipt.tree;
    if (args[0] === 'merge-base' && args[1] === '--all') return receipt.base;
    if (args[0] === 'diff') return `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0source.txt\0`;
    return '';
  });
  const enqueue = vi.fn(async () => { f.queuePr.mergeQueueEntry = { id: 'QUEUE_1' }; return { id: 'QUEUE_1' }; });
  return { ...f, api, runGit, enqueue, execute: () => enqueueAfterChecks({ event: f.event, env: f.env, api, runGit, enqueue, now: () => f.clock }), state: f };
}

describe('CI completion queue handoff', () => {
  it.each([false, true])('enqueues one armed reviewed source head, including fork=%s and empty run pull_requests', async fork => {
    const f = handoffFixture();
    if (fork) {
      f.run.head_repository.id = 123; f.run.head_repository.owner.login = 'contributor';
      f.pr.head.repo.id = 123; f.pr.head.repo.owner.login = 'contributor'; f.event.workflow_run = structuredClone(f.run);
    }
    await expect(f.execute()).resolves.toEqual({ status: 'enqueued', pr: 12, head: receipt.head, entry: 'QUEUE_1' });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ pullRequestId: 'PR_12', expectedHeadOid: receipt.head, jump: false });
    expect(f.api.get).toHaveBeenCalledWith(expect.stringContaining(`head=${encodeURIComponent(`${fork ? 'contributor' : 'openlup'}:task/queue`)}`));
    expect(f.runGit).toHaveBeenCalledWith(expect.any(String), 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', receipt.base, receipt.head);
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/issues/'))).toHaveLength(1);
  });
  it.each([
    ['wrong repository', (f: ReturnType<typeof handoffFixture>) => { f.event.repository.id = 2; }],
    ['private repository', (f: ReturnType<typeof handoffFixture>) => { f.event.repository.private = true; }],
    ['untrusted event', (f: ReturnType<typeof handoffFixture>) => { f.env.GITHUB_EVENT_NAME = 'pull_request'; }],
    ['non-main checkout', (f: ReturnType<typeof handoffFixture>) => { f.env.GITHUB_REF = 'refs/pull/12/merge'; }],
    ['wrong workflow', (f: ReturnType<typeof handoffFixture>) => { f.event.workflow_run.path = '.github/workflows/forged.yml'; }],
    ['merge-group source', (f: ReturnType<typeof handoffFixture>) => { f.event.workflow_run.event = 'merge_group'; }],
    ['cancelled source', (f: ReturnType<typeof handoffFixture>) => { f.event.workflow_run.conclusion = 'cancelled'; }],
    ['rerun', (f: ReturnType<typeof handoffFixture>) => { f.run.run_attempt++; }],
    ['newer source run', (f: ReturnType<typeof handoffFixture>) => { f.listing.workflow_runs.push({ ...f.run, id: 101 }); f.listing.total_count++; }],
    ['truncated listing', (f: ReturnType<typeof handoffFixture>) => { f.listing.total_count++; }],
    ['ambiguous PR', (f: ReturnType<typeof handoffFixture>) => { f.pulls.push({ ...f.pr, number: 13 }); }],
    ['conflict', (f: ReturnType<typeof handoffFixture>) => { f.queuePr.mergeable = 'CONFLICTING'; }],
    ['unknown mergeability', (f: ReturnType<typeof handoffFixture>) => { f.queuePr.mergeable = 'UNKNOWN'; }],
    ['lost merge authority', (f: ReturnType<typeof handoffFixture>) => { f.state.permission = 'read'; }],
    ['missing native receipt', (f: ReturnType<typeof handoffFixture>) => { f.state.comments = []; }],
    ['expired native receipt', (f: ReturnType<typeof handoffFixture>) => { f.state.clock = receipt.expires; }],
    ['insufficient review floor', (f: ReturnType<typeof handoffFixture>) => { f.runGit.mockImplementation(async (_cwd, ...args) => args[0] === 'diff' ? `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0AGENTS.md\0` : args[0] === 'rev-parse' ? receipt.tree : args[0] === 'merge-base' ? receipt.base : ''); }],
    ['missing check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs.pop(); f.result.total_count--; }],
    ['skipped check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.conclusion = 'skipped'; }],
    ['failed required check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.conclusion = 'failure'; }],
    ['duplicate check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs.push({ ...f.result.jobs[0]!, id: 88 }); f.result.total_count++; }],
    ['wrong check SHA', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.head_sha = receipt.base; }],
    ['wrong check run', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.run_id++; }],
    ['future check attempt', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.run_attempt++; }],
    ['truncated jobs', (f: ReturnType<typeof handoffFixture>) => { f.result.total_count++; }],
  ])('refuses %s without a mutation or polling', async (_name, change) => {
    const f = handoffFixture(); change(f);
    await expect(f.execute()).rejects.toThrow(); expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/issues/')).length).toBeLessThanOrEqual(1);
  });
  it.each(['unarmed', 'already queued', 'head moved', 'draft'])('skips %s without a mutation', async scenario => {
    const f = handoffFixture();
    if (scenario === 'unarmed') Object.assign(f.queuePr, { autoMergeRequest: null });
    if (scenario === 'already queued') f.queuePr.mergeQueueEntry = { id: 'EXISTING' };
    if (scenario === 'head moved') f.pr.head.sha = receipt.base;
    if (scenario === 'draft') f.queuePr.isDraft = true;
    await expect(f.execute()).resolves.toMatchObject({ status: 'skipped' }); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['head', 'disarmed', 'queued', 'attempt', 'intent', 'permission', 'expiry'])('revalidates a late %s change before enqueue', async change => {
    const f = handoffFixture(); let reads = 0;
    f.state.getHook = path => {
      if (!path.includes('/actions/runs/100') || path.includes('/jobs?')) return;
      if (++reads !== 2) return;
      if (change === 'head') f.queuePr.headRefOid = receipt.base;
      if (change === 'disarmed') Object.assign(f.queuePr, { autoMergeRequest: null });
      if (change === 'queued') f.queuePr.mergeQueueEntry = { id: 'OTHER' };
      if (change === 'attempt') f.run.run_attempt++;
      if (change === 'intent') f.queuePr.autoMergeRequest.enabledAt = '2026-10-24T12:01:00Z';
      if (change === 'permission') f.state.permission = 'read';
      if (change === 'expiry') f.state.clock = receipt.expires;
    };
    if (['head', 'disarmed', 'queued'].includes(change)) await expect(f.execute()).resolves.toMatchObject({ status: 'skipped' });
    else await expect(f.execute()).rejects.toThrow();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('does not retry a GitHub enqueue refusal', async () => {
    const f = handoffFixture(); f.enqueue.mockRejectedValue(new Error('required conversation unresolved'));
    await expect(f.execute()).rejects.toThrow('required conversation unresolved'); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('does not claim queue success for a different head observed after its single enqueue', async () => {
    const f = handoffFixture();
    f.enqueue.mockImplementation(async () => { f.queuePr.mergeQueueEntry = { id: 'QUEUE_1' }; f.queuePr.headRefOid = receipt.base; return { id: 'QUEUE_1' }; });
    await expect(f.execute()).rejects.toThrow('exact head'); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('allows aggregate failure when only a non-required diagnostic failed and all seven required checks passed', async () => {
    const f = handoffFixture(); f.run.conclusion = 'failure'; f.event.workflow_run.conclusion = 'failure';
    f.result.jobs.push({ ...f.result.jobs[0]!, id: 88, name: 'pgtap', conclusion: 'failure' }); f.result.total_count++;
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' }); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('uses six untouched first-attempt successes and the successful native-only partial rerun', async () => {
    const f = handoffFixture(); f.run.run_attempt = 2; f.event.workflow_run = structuredClone(f.run);
    const native = f.result.jobs.find(job => job.name === 'native-review')!;
    f.result.jobs.push({ ...native, id: 88, run_attempt: 2 }); f.result.total_count++;
    native.conclusion = 'failure';
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/actions/runs/100/jobs?filter=all&per_page=100&page=1');
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ pullRequestId: 'PR_12', expectedHeadOid: receipt.head, jump: false });
  });
  it.each(['failure', 'skipped', 'pending', 'ambiguous latest'])('never recovers an earlier success over a later %s required job', async outcome => {
    const f = handoffFixture(); f.run.run_attempt = 2; f.event.workflow_run = structuredClone(f.run);
    const later = { ...f.result.jobs[0]!, id: 88, run_attempt: 2, conclusion: outcome === 'pending' ? 'success' : outcome === 'ambiguous latest' ? 'success' : outcome,
      status: outcome === 'pending' ? 'in_progress' : 'completed' };
    f.result.jobs.push(later); f.result.total_count++;
    if (outcome === 'ambiguous latest') { f.result.jobs.push({ ...later, id: 89 }); f.result.total_count++; }
    await expect(f.execute()).rejects.toThrow('latest dco'); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['complete', 'count changed', 'duplicate across pages', 'missing page'])('requires complete same-run job history pagination: %s', async scenario => {
    const f = handoffFixture();
    const filler = Array.from({ length: 100 }, (_, index) => ({ ...f.result.jobs[0]!, id: 100 + index, name: `diagnostic ${index}` }));
    f.result.jobs.push(...filler); f.result.total_count += filler.length;
    if (scenario === 'duplicate across pages') f.result.jobs[100]!.id = f.result.jobs[0]!.id;
    f.state.getHook = path => {
      if (!path.endsWith('page=2')) return;
      if (scenario === 'count changed') f.result.total_count++;
      if (scenario === 'missing page') f.result.jobs.splice(100);
    };
    if (scenario === 'complete') await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    else { await expect(f.execute()).rejects.toThrow(); expect(f.enqueue).not.toHaveBeenCalled(); }
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/actions/runs/100/jobs?filter=all&per_page=100&page=2');
  });
  it.each(['before', 'equal', 'after'])('bounds queue attempts to the current merge intent: prior event %s arming', async boundary => {
    const f = handoffFixture();
    f.queuePr.timelineItems.nodes = [{ createdAt: boundary === 'before' ? '2026-10-24T11:59:59Z' : boundary === 'equal' ? f.queuePr.autoMergeRequest.enabledAt : '2026-10-24T12:00:01Z' }];
    await expect(f.execute()).resolves.toMatchObject({ status: boundary === 'before' ? 'enqueued' : 'skipped' });
    expect(f.enqueue).toHaveBeenCalledTimes(boundary === 'before' ? 1 : 0);
  });
  it('does not requeue when another actor queued and removed this intent during admission', async () => {
    const f = handoffFixture();
    f.state.getHook = path => { if (path.includes('/issues/')) f.queuePr.timelineItems.nodes = [{ createdAt: f.queuePr.autoMergeRequest.enabledAt }]; };
    await expect(f.execute()).resolves.toMatchObject({ status: 'skipped' }); expect(f.enqueue).not.toHaveBeenCalled();
  });
});

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
        await expect(wait).resolves.toEqual(receipt); expect(log).toHaveBeenLastCalledWith(expect.stringContaining(group ? 'unchanged tree' : 'reviewed PR head'));
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
