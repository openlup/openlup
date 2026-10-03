import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { agentReviewReportBinding, captureCommittedReviewCandidate, captureSessionCandidate, prepareAgentReview, prepareAgentReviewState } from './agent-review-session.mjs';
import { observeNativeAdmission, parseNativeAdmission, readNativeAdmissionArtifact, readSourceAdmissionArtifact, verifyNativeAdmission, verifySourceAdmission, waitNativeAdmission } from './agent-review-queue.mjs';

const roots: string[] = [];
afterEach(async () => { for (const cwd of roots.splice(0)) await rm(cwd, { recursive: true, force: true }); });
async function fixture() {
  const scratch = join(process.cwd(), '.context/scratch'); await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(join(scratch, 'queue-proof-')); roots.push(cwd);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-C', cwd, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q'); await writeFile(join(cwd, 'code.ts'), 'export const n = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(cwd, 'code.ts'), 'export const n = 2;\n'); git('add', '.'); git('commit', '-qm', 'source');
  const head = git('rev-parse', 'HEAD');
  const candidate = await captureCommittedReviewCandidate(cwd, base, head);
  async function state(candidate) {
    const request = await prepareAgentReview({ cwd, base: candidate.base, intent: { risk: 'behavior', scope: candidate.changedPaths, criteria: 'Preserve the approved contract and actual interactions', requiredRoles: [] }, authorSessionId: 'supervisor', now: () => 1000, snapshot: async () => candidate });
    return { request, reports: request.roles.map((role, index) => ({ ...agentReviewReportBinding(request), reviewerId: `${candidate.head}-review-${index}`, sessionId: `${candidate.head}-session-${index}`, role, cold: true, completedAt: 1000, complete: true, coveredScope: candidate.changedPaths, coveredCriteria: true, simplicityChecked: index === 0, verdict: 'pass', materialFindings: [] })) };
  }
  const source = await state(candidate);
  const input = { version: 1, targetRunId: 10, targetAttempt: 1, prNumber: 5, source, integration: null };
  const run = { id: 10, run_attempt: 1, repository: { id: 1376035358 }, path: '.github/workflows/published-tree-ci.yml', workflow_id: 100, event: 'pull_request', head_sha: head, head_branch: 'codex/task', head_repository: { id: 1376035358 }, status: 'in_progress' };
  const pr = { number: 5, state: 'open', draft: false, merged: false, base: { ref: 'main', repo: { id: 1376035358 } }, head: { sha: head, ref: 'codex/task', repo: { id: 1376035358 } } };
  let entry: { id: string; position: number; enqueuedAt: string; baseCommit: { oid: string }; headCommit: { oid: string }; pullRequest: { number: number; headRefOid: string; baseRefName: string } }; let queueBase = base; let queueHead = head;
  const api = {
    get: async (path: string) => {
      if (path.endsWith('/actions/runs/10')) return structuredClone(run);
      if (path.endsWith('/pulls/5')) return structuredClone(pr);
      if (path.includes('/git/commits/')) { const sha = path.split('/').at(-1)!; return { sha, tree: { sha: git('rev-parse', `${sha}^{tree}`) } }; }
      if (path.endsWith('/git/ref/heads/main')) return { ref: 'refs/heads/main', object: { sha: queueBase, type: 'commit' } };
      if (path.includes('/git/ref/heads/gh-readonly-queue')) return { ref: `refs/heads/${run.head_branch}`, object: { sha: queueHead, type: 'commit' } };
      throw new Error(`Unexpected fixture API path ${path}`);
    },
    graphql: async () => ({ repository: { mergeQueue: { entries: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [structuredClone(entry)] } } } }),
  };
  function group(base: string, head: string) {
    queueBase = base; queueHead = head; run.event = 'merge_group'; run.head_sha = head; run.head_branch = 'gh-readonly-queue/main/pr-5-fixture';
    entry = { id: 'entry-1', position: 1, enqueuedAt: '2026-09-27T10:00:00Z', baseCommit: { oid: base }, headCommit: { oid: head }, pullRequest: { number: 5, headRefOid: candidate.head, baseRefName: 'main' } };
  }
  return { cwd, git, base, head, input, run, pr, candidate, state, api, group, get entry() { return entry; } };
}

describe('native review queue admission', () => {
  it('reconstructs exact clean local evidence while refusing dirty local bytes', async () => {
    const f = await fixture(); expect(await captureSessionCandidate(f.cwd, f.base)).toEqual(f.candidate);
    await writeFile(join(f.cwd, 'code.ts'), 'dirty\n'); expect(await captureSessionCandidate(f.cwd, f.base)).not.toEqual(f.candidate);
    expect(await captureCommittedReviewCandidate(f.cwd, f.base, f.head)).toEqual(f.candidate);
  });
  it('reconstructs a small task in a tree larger than the scope limit', async () => {
    const f = await fixture();
    for (let i = 0; i < 4100; i++) await writeFile(join(f.cwd, `inventory-${i}.txt`), 'same bounded blob\n');
    f.git('add', '.'); f.git('commit', '-qm', 'large baseline'); const base = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/main', base);
    await writeFile(join(f.cwd, 'code.ts'), 'small change\n'); f.git('add', '.'); f.git('commit', '-qm', 'small task');
    const candidate = await captureCommittedReviewCandidate(f.cwd, base, f.git('rev-parse', 'HEAD'));
    expect(candidate.changedPaths).toEqual(['code.ts']); expect(candidate).toEqual(await captureSessionCandidate(f.cwd, base));
  }, 30_000); // 4,100 fixture writes and a commit exceed 10 s under a full parallel local run.
  it('samples freshness after the final live observation', async () => {
    const f = await fixture(); let clock = 1000; let reads = 0; const get = f.api.get;
    f.api.get = async path => { const value = await get(path); if (path.endsWith('/actions/runs/10') && ++reads === 2) clock = 86401001; return value; };
    await expect(verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => clock })).rejects.toThrow('expired');
  });
  it('admits complete source reviews for this PR run and preserves advisory evidence', async () => {
    const f = await fixture(); f.input.source.reports[0].advisoryFindings = ['Optional future polish'];
    expect((await verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 })).sourceHead).toBe(f.head);
  });
  for (const mutation of ['head', 'attempt', 'source-role', 'expired', 'dirty', 'head-repository-missing'] as const) it(`refuses ${mutation} before automatic merge`, async () => {
    const f = await fixture();
    if (mutation === 'head') f.pr.head.sha = f.base;
    if (mutation === 'head-repository-missing') { delete (f.pr.head as { repo?: unknown }).repo; delete (f.run as { head_repository?: unknown }).head_repository; }
    if (mutation === 'attempt') f.run.run_attempt = 2;
    if (mutation === 'source-role') f.input.source.reports.pop();
    if (mutation === 'dirty') f.input.source.request.candidate.clean = false;
    await expect(verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => mutation === 'expired' ? 86401001 : 1000 })).rejects.toThrow('Native admission refused');
  });
  it('unchanged integration tree adds zero reviews without copying source PASS onto group SHA', async () => {
    const f = await fixture(); const tree = f.git('rev-parse', 'HEAD^{tree}');
    const head = f.git('commit-tree', tree, '-p', f.base, '-p', f.head, '-m', 'synthetic group'); f.group(f.base, head);
    const result = await verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 });
    expect(result.head).toBe(head); expect(result.sourceHead).toBe(f.head); expect(result.tree).toBe(tree);
  });
  it('new main interaction blocks until two fresh exact group reviews, source branch stays unchanged', async () => {
    const f = await fixture(); f.git('checkout', '-qb', 'new-main', f.base); await writeFile(join(f.cwd, 'other.ts'), 'new interaction\n'); f.git('add', '.'); f.git('commit', '-qm', 'new main'); const main = f.git('rev-parse', 'HEAD');
    f.git('merge', '--no-ff', f.head, '-m', 'group'); const group = f.git('rev-parse', 'HEAD'); f.group(main, group);
    await expect(verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 })).rejects.toThrow('two current independent');
    const candidate = await captureCommittedReviewCandidate(f.cwd, main, group); f.input.integration = await f.state(candidate);
    expect((await verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 })).base).toBe(main);
    expect(f.pr.head.sha).toBe(f.head); f.input.integration.reports.pop();
    await expect(verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 })).rejects.toThrow();
  });
  for (const mode of ['focused', 'inherited-source-context']) it(`refuses integration ${mode}`, async () => {
    const f = await fixture(); f.git('checkout', '-qb', 'new-main', f.base); await writeFile(join(f.cwd, 'other.ts'), 'new interaction\n'); f.git('add', '.'); f.git('commit', '-qm', 'new main'); const main = f.git('rev-parse', 'HEAD');
    f.git('merge', '--no-ff', f.head, '-m', 'initial group'); const priorHead = f.git('rev-parse', 'HEAD');
    const previous = await f.state(await captureCommittedReviewCandidate(f.cwd, main, priorHead));
    if (mode === 'inherited-source-context') { previous.reports[0].reviewerId = f.input.source.reports[0].reviewerId; previous.reports[0].sessionId = f.input.source.reports[0].sessionId; }
    await writeFile(join(f.cwd, 'code.ts'), 'repair interaction\n'); f.git('add', '.'); f.git('commit', '-qm', 'new group'); const head = f.git('rev-parse', 'HEAD'); f.group(main, head);
    const candidate = await captureCommittedReviewCandidate(f.cwd, main, head);
    const continuation = await prepareAgentReviewState({ cwd: f.cwd, base: main, previous, intent: previous.request.intent, authorSessionId: 'supervisor', snapshot: async () => candidate, repairRisk: 'control', fullRefresh: mode !== 'focused', now: () => 1000 });
    const template = await f.state(candidate);
    continuation.reports = template.reports.map(report => ({ ...report, ...agentReviewReportBinding(continuation.request), coveredScope: continuation.request.continuation.mode === 'full' ? continuation.request.intent.scope : continuation.request.continuation.deltaPaths, closure: { coveredDelta: continuation.request.continuation.deltaPaths, interactionsChecked: true, ordinarySemantics: false, resolvedFindings: [] } }));
    f.input.integration = continuation;
    await expect(verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 })).rejects.toThrow(mode === 'focused' ? 'fresh full coverage' : 'reused source context');
  });
  it('same SHA requeue and changed live identities cannot reuse admission binding', async () => {
    const f = await fixture(); f.group(f.base, f.head); const binding = await observeNativeAdmission(f.api, f.input);
    f.entry.id = 'entry-2'; await expect(verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, expected: binding, now: () => 1000 })).rejects.toThrow('binding changed');
  });
  it('receipts are bounded and retain full evidence rather than truncating it', async () => {
    const f = await fixture(); expect(parseNativeAdmission(JSON.stringify(f.input)).targetRunId).toBe(10);
    expect(() => parseNativeAdmission('x'.repeat(60001))).toThrow('transport bound'); expect(() => parseNativeAdmission(JSON.stringify({ ...f.input, hidden: true }))).toThrow('schema');
  });
});


describe('immutable native artifact transport', () => {
  async function artifactFixture() {
    const f = await fixture(); const binding = await observeNativeAdmission(f.api, f.input);
    await writeFile(join(f.cwd, 'receipt.json'), JSON.stringify({ input: f.input, binding }));
    execFileSync('zip', ['-q', 'receipt.zip', 'receipt.json'], { cwd: f.cwd });
    const bytes = await readFile(join(f.cwd, 'receipt.zip'));
    const artifact = { id: 123, expired: false, workflow_run: { id: 20, head_sha: f.base }, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length };
    const run = { id: 20, workflow_id: 200, repository: { id: 1376035358 }, path: '.github/workflows/native-review-admission.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: f.base, status: 'completed', conclusion: 'success', run_attempt: 1 };
    const api = {
      get: async (path: string) => path.includes('/actions/artifacts?') ? { total_count: 1, artifacts: [artifact] } : path.endsWith('/actions/runs/20') ? run : { id: 200, path: run.path, state: 'active' },
      download: async () => bytes,
    };
    return { f, api, run, artifact, binding };
  }
  it('reads immutable exact target artifact with archive digest verification', async () => {
    const { f, api, binding } = await artifactFixture(); expect((await readNativeAdmissionArtifact(api, f.input)).binding).toEqual(binding);
  });
  it('routes group PR hints from receipt rather than absent event PR number', async () => {
    const { f, api } = await artifactFixture(); expect((await readNativeAdmissionArtifact(api, { ...f.input, prNumber: 0 })).input.prNumber).toBe(5);
  });
  for (const mutation of ['branch', 'workflow', 'producer-attempt', 'digest', 'target-attempt', 'duplicate', 'extra-file']) it(`refuses ${mutation}`, async () => {
    const { f, api, run, artifact } = await artifactFixture();
    if (mutation === 'branch') run.head_branch = 'codex/untrusted';
    if (mutation === 'workflow') run.workflow_id = 300;
    if (mutation === 'producer-attempt') run.run_attempt = 2;
    if (mutation === 'digest') artifact.digest = `sha256:${'0'.repeat(64)}`;
    if (mutation === 'target-attempt') f.input.targetAttempt = 2;
    if (mutation === 'duplicate') { const get = api.get; api.get = async path => path.includes('/actions/artifacts?') ? { total_count: 2, artifacts: [artifact, { ...artifact, id: 124 }] } : get(path); }
    if (mutation === 'extra-file') {
      await writeFile(join(f.cwd, 'extra.json'), '{}'); execFileSync('zip', ['-q', 'receipt.zip', 'extra.json'], { cwd: f.cwd });
      const bytes = await readFile(join(f.cwd, 'receipt.zip')); artifact.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`; artifact.size_in_bytes = bytes.length; api.download = async () => bytes;
    }
    await expect(readNativeAdmissionArtifact(api, f.input)).rejects.toThrow('Native admission refused');
  });
});

describe('source-keyed pull-request receipts', () => {
  async function sourceFixture() {
    const f = await fixture();
    const input = { version: 2, target: { event: 'pull_request', prNumber: 5, sourceHead: f.head }, source: f.input.source, integration: null };
    const dispatch = { id: 20, workflow_id: 200, repository: { id: 1376035358 }, path: '.github/workflows/native-review-admission.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: f.base, status: 'completed', conclusion: 'success', run_attempt: 1 };
    const listings = new Map<string, Array<Record<string, unknown>>>(); const downloads = new Map<number, Buffer>();
    let calls: string[] = [];
    async function upload(name: string, receipt: unknown, id: number, mutate: (artifact: Record<string, unknown>) => void = () => {}) {
      const dir = await mkdtemp(join(f.cwd, `artifact-${id}-`)); await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt));
      execFileSync('zip', ['-q', 'receipt.zip', 'receipt.json'], { cwd: dir }); const bytes = await readFile(join(dir, 'receipt.zip'));
      const artifact: Record<string, unknown> = { id, expired: false, workflow_run: { id: 20, head_sha: f.base }, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length };
      mutate(artifact); downloads.set(id, bytes); listings.set(name, [...(listings.get(name) ?? []), artifact]);
    }
    const api = {
      get: async (path: string) => {
        calls.push(path);
        const name = /[?&]name=([^&]+)/u.exec(path)?.[1];
        if (name) { const artifacts = listings.get(name) ?? []; return { total_count: artifacts.length, artifacts: structuredClone(artifacts) }; }
        if (path.endsWith('/actions/runs/20')) return structuredClone(dispatch);
        if (path.endsWith('/actions/workflows/native-review-admission.yml')) return { id: 200, path: dispatch.path, state: 'active' };
        if (path.endsWith(`/actions/runs/${f.run.id}`)) return structuredClone(f.run);
        return f.api.get(path.replace(`/actions/runs/${f.run.id}`, '/actions/runs/10'));
      },
      graphql: f.api.graphql,
      download: async (path: string) => downloads.get(Number(path.split('/').at(-2)))!,
    };
    let clock = 1000;
    const event: { number?: number; repository: { private: boolean }; pull_request: { head: { sha: string } }; action?: string; merge_group?: Record<string, string> } = { number: 5, repository: { private: false }, pull_request: { head: { sha: f.head } } };
    const env: Record<string, string> = { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_RUN_ID: '10', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'pull_request' };
    const submit = async () => ({ input, binding: await verifySourceAdmission({ cwd: f.cwd, api, input, now: () => clock }) });
    const wait = () => waitNativeAdmission({ event, env, api, cwd: f.cwd, now: () => clock, sleep: async (ms: number) => { clock += ms; }, fetchObjects: async () => {} });
    const sourceName = (pr = 5, head = f.head) => `native-review-pr-${pr}-${head}`;
    return { f, input, dispatch, upload, api, event, env, submit, wait, sourceName, setClock: (value: number) => { clock = value; }, calls: () => calls, resetCalls: () => { calls = []; } };
  }
  it('R1 admits a later run of the reviewed head with a receipt submitted before any run existed', async () => {
    const s = await sourceFixture(); s.resetCalls(); const receipt = await s.submit();
    expect(s.calls().some(path => path.includes('/actions/runs/'))).toBe(false);
    await s.upload(s.sourceName(), receipt, 123); await expect(s.wait()).resolves.toBeUndefined();
  });
  it('R2 admits a new attempt and a later run of the same head without resubmission', async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123);
    s.f.run.run_attempt = 2; s.env.GITHUB_RUN_ATTEMPT = '2'; await expect(s.wait()).resolves.toBeUndefined();
    s.f.run.id = 11; s.f.run.run_attempt = 1; s.env.GITHUB_RUN_ID = '11'; s.env.GITHUB_RUN_ATTEMPT = '1'; await expect(s.wait()).resolves.toBeUndefined();
  });
  it('R3 refuses a receipt for a different head of the same PR', async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123);
    s.event.pull_request.head.sha = s.f.base; s.f.pr.head.sha = s.f.base; s.f.run.head_sha = s.f.base;
    await expect(s.wait()).rejects.toThrow('bounded receipt wait expired');
  });
  it('R4 refuses the same head under another PR number', async () => {
    const s = await sourceFixture(); const receipt = await s.submit();
    await s.upload(s.sourceName(6), receipt, 123); s.event.number = 6;
    await expect(s.wait()).rejects.toThrow('bounded receipt wait expired');
  });
  it('R5 refuses a review that has expired by admission', async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123); s.setClock(86401001);
    await expect(s.wait()).rejects.toThrow('Native admission refused');
  });
  it('R6 refuses submission for a draft PR, and admission once the PR is closed', async () => {
    const s = await sourceFixture(); s.f.pr.draft = true; await expect(s.submit()).rejects.toThrow('not the current open main candidate');
    s.f.pr.draft = false; await s.upload(s.sourceName(), await s.submit(), 123); s.f.pr.state = 'closed';
    await expect(s.wait()).rejects.toThrow('not the current open main candidate');
  });
  it('R7 still admits a run-keyed receipt for its exact run and attempt', async () => {
    const s = await sourceFixture(); const binding = await observeNativeAdmission(s.api, s.f.input);
    await s.upload('native-review-10-1', { input: s.f.input, binding }, 123); await expect(s.wait()).resolves.toBeUndefined();
  });
  it('R8 merge groups ignore source receipts', async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123);
    const tree = s.f.git('rev-parse', 'HEAD^{tree}'); const head = s.f.git('commit-tree', tree, '-p', s.f.base, '-p', s.f.head, '-m', 'synthetic group'); s.f.group(s.f.base, head);
    s.env.GITHUB_EVENT_NAME = 'merge_group'; s.env.GITHUB_SHA = head; s.env.GITHUB_REF = `refs/heads/${s.f.run.head_branch}`;
    Object.assign(s.event, { number: undefined, action: 'checks_requested', merge_group: { base_ref: 'refs/heads/main', base_sha: s.f.base, head_sha: head, head_ref: s.env.GITHUB_REF } });
    await expect(s.wait()).rejects.toThrow('bounded receipt wait expired');
  });
  for (const mutation of ['head-repository', 'workflow-file'] as const) it(`R9 refuses a run with a different ${mutation}`, async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123);
    if (mutation === 'head-repository') s.f.run.head_repository.id = 999;
    if (mutation === 'workflow-file') s.f.run.path = '.github/workflows/other.yml';
    await expect(s.wait()).rejects.toThrow('Native admission refused');
  });
  it('skips a receipt under this PR head name whose target names another PR', async () => {
    const s = await sourceFixture(); const receipt = await s.submit();
    await s.upload(s.sourceName(), { ...receipt, input: { ...receipt.input, target: { ...receipt.input.target, prNumber: 7 } } }, 124);
    await expect(s.wait()).rejects.toThrow('bounded receipt wait expired');
  });
  it('R10 skips a newer artifact that fails provenance and admits an older valid one', async () => {
    const s = await sourceFixture(); const receipt = await s.submit();
    await s.upload(s.sourceName(), receipt, 123); await s.upload(s.sourceName(), receipt, 124, artifact => { artifact.digest = `sha256:${'0'.repeat(64)}`; });
    expect((await readSourceAdmissionArtifact(s.api, 5, s.f.head))?.input.target.sourceHead).toBe(s.f.head);
    await expect(s.wait()).resolves.toBeUndefined();
  });
  it('admits the source receipt when a run-keyed artifact for this pull-request run fails its checks', async () => {
    const s = await sourceFixture(); const binding = await observeNativeAdmission(s.api, s.f.input);
    await s.upload('native-review-10-1', { input: s.f.input, binding }, 122, artifact => { artifact.digest = `sha256:${'0'.repeat(64)}`; });
    await s.upload(s.sourceName(), await s.submit(), 123); await expect(s.wait()).resolves.toBeUndefined();
  });
  it('still refuses a merge group whose run-keyed artifact fails its checks', async () => {
    const s = await sourceFixture();
    const tree = s.f.git('rev-parse', 'HEAD^{tree}'); const head = s.f.git('commit-tree', tree, '-p', s.f.base, '-p', s.f.head, '-m', 'synthetic group'); s.f.group(s.f.base, head);
    const binding = await observeNativeAdmission(s.api, s.f.input);
    await s.upload('native-review-10-1', { input: s.f.input, binding }, 122, artifact => { artifact.digest = `sha256:${'0'.repeat(64)}`; });
    s.env.GITHUB_EVENT_NAME = 'merge_group'; s.env.GITHUB_SHA = head; s.env.GITHUB_REF = `refs/heads/${s.f.run.head_branch}`;
    Object.assign(s.event, { number: undefined, action: 'checks_requested', merge_group: { base_ref: 'refs/heads/main', base_sha: s.f.base, head_sha: head, head_ref: s.env.GITHUB_REF } });
    await expect(s.wait()).rejects.toThrow('downloaded artifact digest differs');
  });
  it('refuses a source receipt when the pull request and its run carry no head repository id', async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123);
    delete (s.f.pr.head as { repo?: unknown }).repo; delete (s.f.run as { head_repository?: unknown }).head_repository;
    await expect(s.wait()).rejects.toThrow('Native admission refused');
  });
  it('refuses when the live PR head moved although the event still names the reviewed head', async () => {
    const s = await sourceFixture(); await s.upload(s.sourceName(), await s.submit(), 123); s.f.pr.head.sha = s.f.base;
    await expect(s.wait()).rejects.toThrow('PR head changed after source review');
  });
  it('refuses an incomplete listing of more than 100 source receipts', async () => {
    const s = await sourceFixture(); const receipt = await s.submit();
    for (let id = 200; id < 301; id++) await s.upload(s.sourceName(), receipt, id);
    await expect(readSourceAdmissionArtifact(s.api, 5, s.f.head)).rejects.toThrow('pagination is incomplete');
  }, 30_000);
  it('parses only the exact source receipt schema', async () => {
    const s = await sourceFixture(); expect(parseNativeAdmission(JSON.stringify(s.input)).target.prNumber).toBe(5);
    expect(() => parseNativeAdmission(JSON.stringify({ ...s.input, integration: s.input.source }))).toThrow('source target is invalid');
    expect(() => parseNativeAdmission(JSON.stringify({ ...s.input, targetRunId: 10 }))).toThrow('schema');
  });
});
