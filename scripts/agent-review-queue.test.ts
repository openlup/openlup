import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { agentReviewReportBinding, captureCommittedReviewCandidate, captureSessionCandidate, prepareAgentReview } from './agent-review-session.mjs';
import { observeNativeAdmission, parseNativeAdmission, readNativeAdmissionArtifact, verifyNativeAdmission } from './agent-review-queue.mjs';

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
  let entry: any; let queueBase = base; let queueHead = head;
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
  it('admits complete source reviews for this PR run and preserves advisory evidence', async () => {
    const f = await fixture(); f.input.source.reports[0].advisoryFindings = ['Optional future polish'];
    expect((await verifyNativeAdmission({ cwd: f.cwd, api: f.api, input: f.input, now: () => 1000 })).sourceHead).toBe(f.head);
  });
  for (const mutation of ['head', 'attempt', 'source-role', 'expired', 'dirty'] as const) it(`refuses ${mutation} before automatic merge`, async () => {
    const f = await fixture();
    if (mutation === 'head') f.pr.head.sha = f.base;
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
