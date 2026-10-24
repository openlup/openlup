// Run trusted main's copy; candidate commits are read as objects, never executed.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { admit, demand, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, carryOverSourceReview, git } from './agent-review-session.mjs';
import { assertCoLocatedForwardApproval, REVIEWED_FORWARD_PATH } from './reviewed-platform-forward.ts';
import { REQUIRED_CONTEXTS } from './packages/release-gate.ts';

export { carryOverSourceReview } from './agent-review-session.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
export function parseReceipt(body) {
  if (typeof body !== 'string' || body.length > 1024 * 1024 || !body.startsWith(`${RECEIPT_MARKER}\n`)) return null;
  const match = /^```json\s*\n([\s\S]*?)\n```\s*$/u.exec(body.slice(RECEIPT_MARKER.length + 1));
  try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
}
export async function readReceipts(api, root, pr, head, now, permissions = new Map()) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await api.get(`${root}/issues/${pr}/comments?per_page=100&page=${page}`);
    demand(Array.isArray(batch), 'PR comments response is invalid'); comments.push(...batch);
    if (batch.length < 100) break;
  }
  const receipts = [];
  comments.sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at) || b.id - a.id);
  for (const comment of comments) {
    const receipt = parseReceipt(comment.body); const login = comment.user?.login;
    if (receipt?.pr !== pr || receipt.head !== head || !admit({ receipt, observed: { ...receipt, baseValid: true }, now }).ok || comment.user?.type !== 'User' || typeof login !== 'string' || !login) continue;
    const key = login.toLowerCase();
    if (!permissions.has(key)) {
      try {
        const access = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
        // The base permission covers custom roles; use role_name only when absent.
        permissions.set(key, ['admin', 'maintain', 'write'].includes(access?.permission ?? access?.role_name));
      } catch { /* A failed lookup never establishes trust; the next poll asks again. */ }
    }
    if (permissions.get(key)) receipts.push(receipt);
  }
  return receipts;
}
export async function waitNativeAdmission({ event, env = process.env, api, cwd = process.cwd(), now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), deadlineMs = 20 * 60 * 1000, runGit = git }) {
  demand(/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? '') && event.repository?.private === false, 'use a public repository GitHub event');
  const root = `/repos/${env.GITHUB_REPOSITORY}`; const group = env.GITHUB_EVENT_NAME === 'merge_group' ? event.merge_group : null;
  demand(['pull_request', 'merge_group'].includes(env.GITHUB_EVENT_NAME), 'only pull_request and merge_group events are supported');
  const match = group && /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-(\d+)-[a-f0-9]+$/u.exec(group.head_ref ?? '');
  const prNumber = group ? Number(match?.[1]) : event.number;
  demand(Number.isSafeInteger(prNumber) && prNumber > 0, 'event must name one PR on main');
  if (group) demand(event.action === 'checks_requested' && group.base_ref === 'refs/heads/main' && SHA.test(group.head_sha) && SHA.test(group.base_sha) && (!env.GITHUB_SHA || env.GITHUB_SHA === group.head_sha) && (!env.GITHUB_REF || env.GITHUB_REF === group.head_ref), 'merge group identity differs from the event');
  const permissions = new Map();
  const start = now(); let reason = 'post a current receipt comment from a user with write, maintain or admin permission';
  while (now() - start < deadlineMs) {
    const pr = await api.get(`${root}/pulls/${prNumber}`);
    demand(pr.number === prNumber && pr.state === 'open' && pr.draft === false && !pr.merged && pr.base?.ref === 'main' && SHA.test(pr.head?.sha), 'PR must be the live open main candidate');
    if (!group) demand(event.pull_request?.head?.sha === pr.head.sha, 'PR head changed; rerun CI for the current head', 'stale');
    const receipts = await readReceipts(api, root, prNumber, pr.head.sha, now(), permissions);
    for (const receipt of receipts) {
      const main = (await api.get(`${root}/git/ref/heads/main`)).object?.sha; demand(SHA.test(main), 'main commit identity is invalid');
      const refs = [...new Set([receipt.base, receipt.head, main, ...(group ? [group.base_sha, group.head_sha] : [])])];
      let candidate; let baseValid;
      try {
        await runGit(cwd, '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...refs);
        await runGit(cwd, 'update-ref', 'refs/remotes/origin/main', main);
        candidate = await captureCommittedReviewCandidate(cwd, receipt.base, receipt.head, runGit);
        const forks = (await runGit(cwd, 'merge-base', '--all', receipt.head, 'origin/main')).trim().split('\n');
        baseValid = forks.length === 1 && SHA.test(forks[0]) && receipt.base === forks[0];
      } catch (error) { reason = `receipt objects could not be verified: ${error.message}; post a corrected receipt`; continue; }
      let decision = admit({ receipt, observed: { ...candidate, pr: prNumber, baseValid }, now: now() });
      if (!decision.ok) { reason = `${decision.code}: ${decision.reason}`; continue; }
      if (candidate.changedPaths.includes(REVIEWED_FORWARD_PATH)) assertCoLocatedForwardApproval(cwd, candidate.base, candidate.head, main);
      if (group) {
        const tree = (await runGit(cwd, 'rev-parse', '--verify', `${group.head_sha}^{tree}`)).trim();
        decision = await carryOverSourceReview(cwd, candidate, { base: group.base_sha, tree }, runGit);
        demand(decision.ok, decision.reason, decision.code);
        if (candidate.changedPaths.includes(REVIEWED_FORWARD_PATH)) assertCoLocatedForwardApproval(cwd, group.base_sha, group.head_sha, main);
      }
      const live = await api.get(`${root}/pulls/${prNumber}`);
      demand(live.head?.sha === pr.head.sha && live.state === 'open' && live.draft === false && !live.merged && live.base?.ref === 'main', 'PR changed during admission; rerun CI', 'stale');
      demand((await api.get(`${root}/git/ref/heads/main`)).object?.sha === main, 'main moved during admission; rerun CI', 'stale');
      const final = admit({ receipt, observed: { ...candidate, pr: prNumber, baseValid }, now: now() }); demand(final.ok, final.reason, final.code);
      console.log(`Native review admission verified: ${group ? decision.reason : 'reviewed PR head'}.`); return receipt;
    }
    console.log(`needs_agent_review: ${reason}`); await sleep(Math.min(15000, Math.max(0, deadlineMs - (now() - start))));
  }
  throw new Error(`needs_agent_review: bounded 20-minute receipt wait expired; ${reason}`);
}
// A completed source run hands an existing merge request to GitHub's queue once.
// This code runs only from trusted main; source objects are never checked out.
export async function enqueueAfterChecks({ event, env, api, enqueue, cwd = process.cwd(), now = Date.now, runGit = git }) {
  const repository = value => value?.id === 1376035358 && value.full_name === env.GITHUB_REPOSITORY && value.private === false;
  const positive = value => Number.isSafeInteger(value) && value > 0;
  demand(env.GITHUB_EVENT_NAME === 'workflow_run' && /^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? '') && env.GITHUB_REF === 'refs/heads/main'
    && event.action === 'completed' && repository(event.repository), 'enqueue requires the public repository main workflow_run event');
  const source = event.workflow_run; const root = `/repos/${env.GITHUB_REPOSITORY}`;
  const [owner, name] = env.GITHUB_REPOSITORY.split('/');
  const identity = run => positive(run?.id) && positive(run.workflow_id) && positive(run.run_attempt) && run.event === 'pull_request'
    && run.path === '.github/workflows/published-tree-ci.yml' && repository(run.repository) && SHA.test(run.head_sha)
    && positive(run.head_repository?.id) && /^[\w.-]+$/u.test(run.head_repository?.owner?.login ?? '') && typeof run.head_branch === 'string' && run.head_branch.length > 0;
  demand(identity(source) && source.status === 'completed' && ['success', 'failure'].includes(source.conclusion), 'source must be a completed Published Tree CI pull-request run');
  const sameRun = run => identity(run) && run.id === source.id && run.workflow_id === source.workflow_id && run.run_attempt === source.run_attempt
    && run.head_sha === source.head_sha && run.head_branch === source.head_branch && run.head_repository.id === source.head_repository.id
    && run.head_repository.owner.login === source.head_repository.owner.login && run.status === 'completed' && run.conclusion === source.conclusion;
  const sourceCurrent = async () => {
    demand(sameRun(await api.get(`${root}/actions/runs/${source.id}`)), 'source run or attempt changed');
    const listing = await api.get(`${root}/actions/workflows/published-tree-ci.yml/runs?event=pull_request&head_sha=${source.head_sha}&per_page=100`);
    demand(Array.isArray(listing.workflow_runs) && listing.workflow_runs.length > 0 && listing.workflow_runs.length <= 100
      && listing.total_count === listing.workflow_runs.length && listing.workflow_runs.every(identity)
      && new Set(listing.workflow_runs.map(run => run.id)).size === listing.workflow_runs.length, 'source run listing is incomplete or invalid');
    const matching = listing.workflow_runs.filter(run => run.head_sha === source.head_sha && run.head_branch === source.head_branch && run.head_repository.id === source.head_repository.id);
    demand(matching.length > 0 && sameRun(matching.reduce((a, b) => a.id > b.id ? a : b)), 'a newer source run or attempt supersedes this completion');
  };
  await sourceCurrent();
  const head = encodeURIComponent(`${source.head_repository.owner.login}:${source.head_branch}`);
  const pulls = await api.get(`${root}/pulls?state=open&base=main&head=${head}&per_page=100`);
  demand(Array.isArray(pulls) && pulls.length < 100, 'live PR lookup is incomplete or invalid');
  const candidates = pulls.filter(pr => pr.state === 'open' && !pr.merged && pr.base?.ref === 'main' && pr.base.repo?.id === event.repository.id
    && pr.head?.sha === source.head_sha && pr.head.repo?.id === source.head_repository.id && pr.head.ref === source.head_branch);
  if (candidates.length === 0) return { status: 'skipped', reason: 'source head is no longer a live main PR' };
  demand(candidates.length === 1 && positive(candidates[0].number), 'source head must identify exactly one live main PR');
  const number = candidates[0].number;
  const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { pullRequest(number:${number}) { id number state isDraft merged baseRefName headRefOid mergeable autoMergeRequest { enabledAt enabledBy { login } } mergeQueueEntry { id } timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT]) { nodes { ... on AddedToMergeQueueEvent { createdAt } } } } } }`;
  const live = async () => {
    const response = await api.get(`/graphql?query=${encodeURIComponent(query)}`);
    demand(!response.errors && response.data?.repository?.pullRequest?.number === number, 'live queue response is invalid');
    return response.data.repository.pullRequest;
  };
  const eligible = pr => pr.state === 'OPEN' && pr.isDraft === false && pr.merged === false && pr.baseRefName === 'main' && pr.headRefOid === source.head_sha;
  const attempted = pr => {
    demand(Array.isArray(pr.timelineItems?.nodes) && pr.timelineItems.nodes.length <= 1
      && pr.timelineItems.nodes.every(node => Number.isFinite(Date.parse(node?.createdAt))), 'queue attempt history is invalid');
    return pr.timelineItems.nodes.some(node => Date.parse(node.createdAt) >= Date.parse(pr.autoMergeRequest.enabledAt));
  };
  let pr = await live();
  if (!eligible(pr) || !pr.autoMergeRequest || pr.mergeQueueEntry) return { status: 'skipped', reason: 'PR changed, is unarmed, or is already queued' };
  demand(pr.mergeable === 'MERGEABLE', 'PR mergeability is conflicting or unknown; diagnose without retrying enqueue');
  const intent = pr.autoMergeRequest; const login = intent.enabledBy?.login;
  demand(typeof login === 'string' && /^[\w[\].-]+$/u.test(login) && Number.isFinite(Date.parse(intent.enabledAt)), 'auto-merge author identity is invalid');
  if (attempted(pr)) return { status: 'skipped', reason: 'this merge intent already entered the queue; no automatic requeue' };
  const access = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
  demand(['write', 'maintain', 'admin'].includes(access?.permission ?? access?.role_name), 'auto-merge author no longer has repository write permission');
  const result = await api.get(`${root}/actions/runs/${source.id}/attempts/${source.run_attempt}/jobs?per_page=100`);
  demand(Array.isArray(result.jobs) && result.jobs.length <= 100 && result.total_count === result.jobs.length
    && result.jobs.every(job => positive(job?.id)) && new Set(result.jobs.map(job => job.id)).size === result.jobs.length, 'source jobs response is incomplete or invalid');
  for (const name of [...REQUIRED_CONTEXTS, 'native-review']) {
    const matches = result.jobs.filter(job => job.name === name);
    demand(matches.length === 1 && matches[0].head_sha === source.head_sha && matches[0].status === 'completed' && matches[0].conclusion === 'success', `source requires one actual successful ${name} check`);
  }
  const admitted = await waitNativeAdmission({ event: { repository: event.repository, number, pull_request: { head: { sha: source.head_sha } } },
    env: { GITHUB_REPOSITORY: env.GITHUB_REPOSITORY, GITHUB_EVENT_NAME: 'pull_request' }, api, cwd, now, runGit,
    sleep: () => { throw new Error('Current native review is unavailable at CI completion; no enqueue retry'); } });
  await sourceCurrent();
  pr = await live();
  if (!eligible(pr) || !pr.autoMergeRequest || pr.mergeQueueEntry) return { status: 'skipped', reason: 'PR changed, is unarmed, or is already queued' };
  demand(pr.mergeable === 'MERGEABLE' && pr.autoMergeRequest.enabledAt === intent.enabledAt && pr.autoMergeRequest.enabledBy?.login === login,
    'mergeability or auto-merge authority changed before enqueue');
  if (attempted(pr)) return { status: 'skipped', reason: 'this merge intent already entered the queue; no automatic requeue' };
  const finalAccess = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
  demand(['write', 'maintain', 'admin'].includes(finalAccess?.permission ?? finalAccess?.role_name), 'auto-merge authority changed before enqueue');
  demand(now() < admitted.expires, 'native review expired before enqueue');
  const queued = await enqueue({ pullRequestId: pr.id, expectedHeadOid: source.head_sha, jump: false });
  demand(typeof queued?.id === 'string' && queued.id.length > 0, 'enqueue did not confirm a queue entry');
  const after = await live();
  demand(after.headRefOid === source.head_sha && (after.mergeQueueEntry?.id === queued.id || after.merged === true), 'enqueue read-back did not confirm the exact head queue entry or completed merge');
  return { status: 'enqueued', pr: number, head: source.head_sha, entry: queued.id };
}
async function main() {
  demand(['wait', 'enqueue'].includes(process.argv[2]) && process.argv.length === 3, 'use wait or enqueue');
  const env = process.env;
  const api = { get: async path => {
    const args = path.startsWith('/graphql?query=') ? ['api', 'graphql', '-f', `query=${decodeURIComponent(path.slice('/graphql?query='.length))}`] : ['api', path];
    return JSON.parse((await execute('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  } };
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  if (process.argv[2] === 'wait') await waitNativeAdmission({ event, env, api });
  else {
    demand(typeof env.OPENLUP_QUEUE_TOKEN === 'string' && env.OPENLUP_QUEUE_TOKEN.length > 0, 'enqueue requires the dedicated queue App token');
    const enqueue = async input => {
      const query = 'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,jump:false}){mergeQueueEntry{id}}}';
      const response = JSON.parse((await execute('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `id=${input.pullRequestId}`, '-f', `head=${input.expectedHeadOid}`],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...env, GH_TOKEN: env.OPENLUP_QUEUE_TOKEN } })).stdout);
      demand(!response.errors, 'GitHub refused queue admission'); return response.data?.enqueuePullRequest?.mergeQueueEntry;
    };
    console.log(JSON.stringify(await enqueueAfterChecks({ event, env, api, enqueue })));
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
