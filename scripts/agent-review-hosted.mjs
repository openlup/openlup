// Install/pin this observer with the protected controller, never execute a PR's
// copy with credentials. The injected transport owns authentication and bounded
// HTTP handling. This library provisions no App, reads no credential and starts
// no webhook server. API: authenticated get(path), post(path, body), patch(path,
// body), returning parsed JSON. App JWT identity reads and installation writes
// belong to the protected transport. Approved expectations must come from its
// own request registry; policy pins repo/workflow bytes and both App identities.
// A distinct protected App, authenticated snapshot/receipt transport, webhook
// authentication, required source settings and one strict admission slot remain
// external activation prerequisites; fixture transports establish none of them.
import { createHash } from 'node:crypto';
import { REQUIRED_CHECKS, verifyReviewReceipt } from './agent-review-gate.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const EXPECTATION_FIELDS = ['publicKey', 'version', 'stage', 'repository', 'base', 'head', 'tree', 'authorityDigest', 'policyDigest', 'requestId', 'risk', 'requiredRoles', 'authorRunId', 'now', 'maxValidityMs'];
function demand(condition, message) {
  if (!condition) throw new Error(`Hosted admission refused: ${message}`);
}
function integer(value) { return Number.isSafeInteger(value) && value > 0; }
function localExpectation(approved, now, maxValidityMs) {
  // These records are selected by the controller's approved request registry,
  // not copied from a request payload, candidate file or reviewer response.
  demand(approved && approved.stage === 'local', 'approved local request is missing');
  const expected = Object.fromEntries(EXPECTATION_FIELDS.map(field => [field, approved[field]]));
  if (now !== undefined) expected.now = now;
  if (maxValidityMs !== undefined) expected.maxValidityMs = maxValidityMs;
  return expected;
}
function input({ api, repository, prNumber, approved, policy }) {
  demand(api && typeof api.get === 'function', 'authenticated API transport is missing');
  demand(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), 'repository is invalid');
  demand(integer(prNumber), 'pull-request number is invalid');
  demand(policy && integer(policy.repositoryId) && integer(policy.workflowId), 'protected repository/workflow policy is missing');
  demand(policy.mechanicalAppId === 15368 && integer(policy.publisherAppId) && policy.publisherAppId !== 15368, 'distinct protected publisher App is required');
  demand(typeof policy.workflowPath === 'string' && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(policy.workflowPath) && DIGEST.test(policy.workflowSha256), 'approved workflow identity is missing');
  demand(approved && approved.repository === repository && approved.stage === 'local' && SHA.test(approved.base) && SHA.test(approved.head) && SHA.test(approved.tree), 'approved candidate binding is missing');
  demand(approved.head !== approved.base, 'baseline is not task approval');
  return `/repos/${repository}`;
}
async function pages(api, path, field) {
  const entries = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await api.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    demand(result && Array.isArray(result[field]) && result[field].length <= 100 && Number.isSafeInteger(result.total_count) && result.total_count >= 0, 'API pagination is malformed');
    entries.push(...result[field]);
    if (result[field].length < 100) {
      demand(entries.length === result.total_count, 'API pagination is incomplete or changed');
      return entries;
    }
  }
  throw new Error('Hosted admission refused: API pagination exceeded bounds');
}
function workflowBytes(file, path) {
  demand(file && file.type === 'file' && file.path === path && file.encoding === 'base64' && SHA.test(file.sha) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 128 * 1024 && typeof file.content === 'string' && file.content.length <= 180 * 1024, 'workflow content is not a bounded file');
  const encoded = file.content.replace(/\s/gu, '');
  const bytes = Buffer.from(encoded, 'base64');
  demand(bytes.length === file.size && bytes.toString('base64') === encoded, 'workflow content encoding is invalid');
  demand(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === file.sha, 'workflow blob identity differs');
  return bytes;
}

/** Observe GitHub directly using a protected, authenticated transport. Expected
 * policy and approved request come from the controller, never candidate bytes.
 * Check `head` remains the API-observed PR head. Integration provenance records
 * the separate test-merge identity; no API head is relabelled as that merge SHA.
 */
export async function observeHostedCandidate(options) {
  const { api, repository, prNumber, approved, policy } = options;
  const root = input(options);
  const repo = await api.get(root);
  demand(repo.id === policy.repositoryId && repo.full_name === repository && repo.default_branch === 'main' && repo.private === false, 'repository identity differs');
  const main = await api.get(`${root}/git/ref/heads/main`);
  demand(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === approved.base, 'main has moved from the approved base');
  const pr = await api.get(`${root}/pulls/${prNumber}`);
  demand(pr.number === prNumber && pr.state === 'open' && pr.draft === false && pr.merged === false && pr.base?.repo?.id === policy.repositoryId && pr.base.ref === 'main' && pr.base.sha === approved.base && pr.head?.sha === approved.head && integer(pr.head?.repo?.id) && typeof pr.head.ref === 'string' && pr.mergeable === true && SHA.test(pr.merge_commit_sha), 'current pull-request candidate differs or is not mergeable');
  const head = await api.get(`${root}/git/commits/${approved.head}`);
  demand(head.sha === approved.head && head.tree?.sha === approved.tree, 'reviewed head tree differs');
  const comparison = await api.get(`${root}/compare/${approved.base}...${approved.head}`);
  demand(comparison.status === 'ahead' && comparison.merge_base_commit?.sha === approved.base && integer(comparison.ahead_by) && comparison.behind_by === 0, 'head does not contain the current base');
  const integration = await api.get(`${root}/git/commits/${pr.merge_commit_sha}`);
  demand(integration.sha === pr.merge_commit_sha && integration.tree?.sha === approved.tree && Array.isArray(integration.parents) && integration.parents.length === 2 && integration.parents[0].sha === approved.base && integration.parents[1].sha === approved.head, 'integration parents or tree differ from the reviewed candidate');
  const workflow = await api.get(`${root}/actions/workflows/${policy.workflowId}`);
  demand(workflow.id === policy.workflowId && workflow.path === policy.workflowPath && workflow.state === 'active', 'workflow identity differs');
  const file = await api.get(`${root}/contents/${policy.workflowPath}?ref=${approved.head}`);
  demand(createHash('sha256').update(workflowBytes(file, policy.workflowPath)).digest('hex') === policy.workflowSha256, 'candidate changed the approved workflow');
  const runs = await pages(api, `${root}/actions/workflows/${policy.workflowId}/runs?event=pull_request&head_sha=${approved.head}`, 'workflow_runs');
  const matching = runs.filter(run => run.event === 'pull_request' && run.head_sha === approved.head && run.head_repository?.id === pr.head.repo.id && run.head_branch === pr.head.ref);
  demand(matching.length > 0 && matching.every(run => integer(run.id)), 'no candidate workflow run exists');
  const latestId = Math.max(...matching.map(run => run.id));
  demand(matching.filter(run => run.id === latestId).length === 1, 'duplicate workflow run identity');
  const run = await api.get(`${root}/actions/runs/${latestId}`);
  demand(run.id === latestId && run.workflow_id === policy.workflowId && run.path === policy.workflowPath && run.repository?.id === policy.repositoryId && run.event === 'pull_request' && run.head_sha === approved.head && run.head_repository?.id === pr.head.repo.id && run.head_branch === pr.head.ref && integer(run.run_attempt) && integer(run.check_suite_id) && run.status === 'completed' && run.conclusion === 'success', 'latest workflow attempt is not the successful approved source');
  const initiallyListed = matching.find(entry => entry.id === run.id);
  demand(initiallyListed.workflow_id === run.workflow_id && initiallyListed.path === run.path && initiallyListed.repository?.id === policy.repositoryId && initiallyListed.check_suite_id === run.check_suite_id && initiallyListed.run_attempt === run.run_attempt && initiallyListed.status === 'completed' && initiallyListed.conclusion === 'success', 'initial workflow listing contradicts the observed source or attempt');
  const jobs = await pages(api, `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  demand(jobs.length === REQUIRED_CHECKS.length && new Set(jobs.map(job => job.name)).size === REQUIRED_CHECKS.length && new Set(jobs.map(job => job.id)).size === REQUIRED_CHECKS.length, 'six current job executions are required');
  const checks = [];
  const provenance = [];
  const checkIds = new Set();
  for (const name of REQUIRED_CHECKS) {
    const job = jobs.find(entry => entry.name === name);
    demand(job && integer(job.id) && job.head_sha === approved.head && job.status === 'completed' && job.conclusion === 'success', 'required job is missing, skipped or unsuccessful');
    const prefix = `https://api.github.com${root}/check-runs/`;
    demand(typeof job.check_run_url === 'string' && job.check_run_url.startsWith(prefix) && /^[1-9][0-9]*$/u.test(job.check_run_url.slice(prefix.length)), 'job check identity is invalid');
    const checkId = Number(job.check_run_url.slice(prefix.length));
    demand(integer(checkId) && !checkIds.has(checkId), 'job check identity is duplicate or invalid');
    checkIds.add(checkId);
    const check = await api.get(`${root}/check-runs/${checkId}`);
    demand(check.id === checkId && check.name === name && check.app?.id === policy.mechanicalAppId && check.check_suite?.id === run.check_suite_id && check.head_sha === approved.head && check.status === 'completed' && check.conclusion === 'success', 'required check did not actually succeed from the approved source');
    const identity = { repositoryId: repo.id, workflowId: workflow.id, workflowPath: workflow.path, workflowBlob: file.sha, workflowSha256: policy.workflowSha256, appId: check.app.id, runId: run.id, attempt: run.run_attempt, jobId: job.id, checkId, base: approved.base, head: approved.head, integration: integration.sha, integrationTree: integration.tree.sha };
    const source = `github-actions:${check.app.id}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
    const runId = `${run.id}/${run.run_attempt}/${job.id}/${checkId}`;
    demand(source.length <= 160 && runId.length <= 160, 'check provenance exceeds receipt bounds');
    checks.push({ name, source, runId, head: check.head_sha, status: 'completed', conclusion: 'SUCCESS' });
    provenance.push(identity);
  }
  // Re-read identities after observing all jobs. A concurrent rerun or base/head
  // movement cannot silently turn a mixed observation into an accepted result.
  const latest = await api.get(`${root}/actions/runs/${run.id}`);
  const finalRuns = await pages(api, `${root}/actions/workflows/${policy.workflowId}/runs?event=pull_request&head_sha=${approved.head}`, 'workflow_runs');
  const finalMatching = finalRuns.filter(entry => entry.event === 'pull_request' && entry.head_sha === approved.head && entry.head_repository?.id === pr.head.repo.id && entry.head_branch === pr.head.ref);
  const finalMain = await api.get(`${root}/git/ref/heads/main`);
  const finalPr = await api.get(`${root}/pulls/${prNumber}`);
  demand(finalMatching.length > 0 && finalMatching.every(entry => integer(entry.id)) && new Set(finalMatching.map(entry => entry.id)).size === finalMatching.length && Math.max(...finalMatching.map(entry => entry.id)) === run.id, 'a newer workflow run appeared during observation');
  const listed = finalMatching.find(entry => entry.id === run.id);
  demand(listed.workflow_id === policy.workflowId && listed.path === policy.workflowPath && listed.repository?.id === policy.repositoryId && listed.check_suite_id === run.check_suite_id && listed.run_attempt === run.run_attempt && listed.status === 'completed' && listed.conclusion === 'success', 'final workflow listing contradicts the observed source or attempt');
  demand(latest.id === run.id && latest.workflow_id === policy.workflowId && latest.path === policy.workflowPath && latest.repository?.id === policy.repositoryId && latest.event === 'pull_request' && latest.head_sha === approved.head && latest.head_repository?.id === pr.head.repo.id && latest.head_branch === pr.head.ref && latest.check_suite_id === run.check_suite_id && latest.run_attempt === run.run_attempt && latest.status === 'completed' && latest.conclusion === 'success', 'workflow source or attempt changed during observation');
  demand(finalMain.ref === 'refs/heads/main' && finalMain.object?.type === 'commit' && finalMain.object.sha === approved.base && finalPr.number === prNumber && finalPr.state === 'open' && finalPr.draft === false && finalPr.merged === false && finalPr.base?.repo?.id === policy.repositoryId && finalPr.base.ref === 'main' && finalPr.base.sha === approved.base && finalPr.head?.sha === approved.head && finalPr.head?.repo?.id === pr.head.repo.id && finalPr.head.ref === pr.head.ref && finalPr.mergeable === true && finalPr.merge_commit_sha === integration.sha, 'candidate changed during observation');
  return {
    expectation: { ...localExpectation(approved), stage: 'hosted', checks: checks.map(({ name, source, runId, head: sha }) => ({ name, source, runId, head: sha })) },
    checks, provenance,
    candidate: { base: approved.base, head: approved.head, tree: approved.tree, integration: integration.sha, integrationTree: integration.tree.sha },
  };
}

/** Routing hints only, after the service authenticates its webhook. Empty run
 * pull_requests is normal: find registered requests by repository/head instead.
 * Every route re-observes GitHub; event payloads confer no approval authority.
 */
export function routeAdmissionEvent(event, payload) {
  const repository = payload?.repository?.full_name;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) return null;
  if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'edited', 'closed'].includes(payload.action) && integer(payload.number)) {
    return { kind: 'candidate', repository, prNumber: payload.number };
  }
  if (event === 'push' && payload.ref === 'refs/heads/main') return { kind: 'base', repository };
  if (event === 'workflow_run' && ['requested', 'in_progress', 'completed'].includes(payload.action) && payload.workflow_run?.event === 'pull_request' && SHA.test(payload.workflow_run.head_sha)) {
    return { kind: 'ci', repository, head: payload.workflow_run.head_sha };
  }
  return null;
}

/** Protected App aggregate publisher. Its success proves authenticated local
 * review plus freshly observed hosted execution, not a signed hosted receipt.
 * Call only inside the controller's single admission slot. Repository protection
 * must require this App ID; a same-name Actions check is not its evidence.
 */
export async function publishHostedAdmission(options) {
  const { api, approved, policy, envelope } = options;
  const root = input(options);
  demand(options.now === undefined || typeof options.now === 'function', 'trusted clock must be a function');
  const clock = options.now ?? Date.now;
  demand(typeof api.post === 'function' && typeof api.patch === 'function', 'protected App write transport is missing');
  const app = await api.get('/app');
  demand(app.id === policy.publisherAppId, 'authenticated publisher App differs');
  const pending = await api.post(`${root}/check-runs`, { name: 'review-admission', head_sha: approved.head, status: 'in_progress', output: { title: 'Admission pending', summary: 'Authenticated review and current hosted execution are being verified.' } });
  demand(integer(pending.id) && pending.name === 'review-admission' && pending.head_sha === approved.head && pending.app?.id === policy.publisherAppId, 'published aggregate identity differs');
  try {
    // A protected clock is sampled separately. An accurate starting timestamp
    // cannot prove that a receipt remains valid after remote observation.
    const expected = localExpectation(approved, clock(), options.maxValidityMs ?? approved.maxValidityMs);
    const review = verifyReviewReceipt(envelope, expected);
    const aggregate = await api.get(`${root}/check-runs/${pending.id}`);
    demand(aggregate.id === pending.id && aggregate.name === 'review-admission' && aggregate.head_sha === approved.head && aggregate.app?.id === policy.publisherAppId && aggregate.status === 'in_progress', 'aggregate source or candidate changed');
    const observed = await observeHostedCandidate(options);
    verifyReviewReceipt(envelope, { ...expected, now: clock() });
    const completed = await api.patch(`${root}/check-runs/${pending.id}`, { status: 'completed', conclusion: 'success', output: { title: 'Admission verified', summary: `Authenticated request ${review.requestId}; six current successful executions; integration tree matches the reviewed candidate.` } });
    demand(completed.id === pending.id && completed.name === 'review-admission' && completed.app?.id === policy.publisherAppId && completed.head_sha === approved.head && completed.status === 'completed' && completed.conclusion === 'success', 'aggregate success response differs');
    return { aggregateId: pending.id, ...observed };
  } catch (error) {
    // A refusal is failure, never skipped/neutral. A failed write leaves the check
    // non-successful. Report a fixed message rather than echoing remote input.
    await api.patch(`${root}/check-runs/${pending.id}`, { status: 'completed', conclusion: 'failure', output: { title: 'Admission refused', summary: 'Required current authenticated review or hosted evidence is absent or invalid.' } }).catch(() => {});
    throw error;
  }
}
