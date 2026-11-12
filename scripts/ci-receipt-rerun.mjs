// After a trusted receipt comment, rerun the failed jobs of the current head's
// latest Published Tree CI run once, when native-review is its only failed job.
// This runs from the default branch. It never checks out or executes pull-request
// code, and it only tests the comment body for the receipt marker prefix.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { env as processEnvironment } from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Both receipt formats printed by `agent-review-session.mjs receipt` start with this.
export const RECEIPT_MARKER_PREFIX = '<!-- openlup-native-review-receipt';
export const WORKFLOW_PATH = '.github/workflows/published-tree-ci.yml';
// No job in the workflow needs native-review, so no aggregate fails because of it.
export const RERUN_JOB = 'native-review';
// Hosted admission (readReceipts in agent-review-queue.mjs) trusts a receipt author by
// the same rule: the base permission, or the role name when that is absent.
export const WRITE_PERMISSIONS = ['admin', 'maintain', 'write'];
export const hasWriteAccess = access => WRITE_PERMISSIONS.includes(access?.permission ?? access?.role_name);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const PASSED = new Set(['success', 'skipped', 'neutral']);
const SHA = /^[a-f0-9]{40}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const validSource = source => typeof source?.branch === 'string' && source.branch.length > 0 && positive(source.repositoryId);
const decision = (rerun, reason, run) => rerun ? { rerun, reason, runId: run.id, attempt: run.run_attempt } : { rerun, reason };

export function receiptComment(event) {
  if (event?.action !== 'created') return { ok: false, reason: 'only a newly created comment is considered' };
  if (!event.issue?.pull_request || typeof event.issue.pull_request !== 'object' || !positive(event.issue.number)) return { ok: false, reason: 'comment is not on a pull request' };
  if (typeof event.comment?.body !== 'string' || !event.comment.body.startsWith(RECEIPT_MARKER_PREFIX)) return { ok: false, reason: 'comment is not a review receipt' };
  if (!TRUSTED_ASSOCIATIONS.has(event.comment.author_association)) return { ok: false, reason: 'commenter is not an owner, member or collaborator' };
  const login = event.comment.user?.login;
  if (event.comment.user?.type !== 'User' || typeof login !== 'string' || !login) return { ok: false, reason: 'commenter is not a user account' };
  return { ok: true, pr: event.issue.number, login };
}

// `source` is the pull request's head branch and head repository id.
export function latestRun(runs, headSha, source) {
  if (!Array.isArray(runs) || !SHA.test(headSha ?? '') || !validSource(source)) return undefined;
  // No matching run leaves the initial undefined: no rerun.
  return runs.filter(run => positive(run?.id) && run.head_sha === headSha && run.event === 'pull_request' && run.path === WORKFLOW_PATH
    && run.head_branch === source.branch && run.head_repository?.id === source.repositoryId)
    .reduce((latest, run) => latest === undefined || run.id > latest.id ? run : latest, undefined);
}

// `jobs` are the latest execution of each job of latestRun(runs, headSha, source).
export function selectRerun(runs, jobs, headSha, source) {
  if (!SHA.test(headSha ?? '')) return decision(false, 'pull request head is invalid');
  if (!validSource(source)) return decision(false, 'pull request head branch or repository is invalid');
  const run = latestRun(runs, headSha, source);
  if (!run) return decision(false, 'no Published Tree CI run exists for the current head');
  if (!positive(run.run_attempt)) return decision(false, 'latest run attempt is invalid');
  if (run.status !== 'completed') return decision(false, `latest run ${run.id} is ${run.status}`);
  if (run.conclusion !== 'failure') return decision(false, `latest run ${run.id} concluded ${run.conclusion}`);
  if (!Array.isArray(jobs) || jobs.length === 0) return decision(false, `jobs of run ${run.id} are unavailable`);
  if (!jobs.every(job => positive(job?.id) && job.run_id === run.id && job.head_sha === headSha && positive(job.run_attempt) && job.run_attempt <= run.run_attempt && typeof job.name === 'string')
    || new Set(jobs.map(job => job.name)).size !== jobs.length) return decision(false, `jobs of run ${run.id} are invalid or duplicated`);
  const unfinished = jobs.filter(job => job.status !== 'completed');
  if (unfinished.length > 0) return decision(false, `jobs still running: ${unfinished.map(job => job.name).join(', ')}`);
  const failed = jobs.filter(job => !PASSED.has(job.conclusion));
  if (failed.length !== 1 || failed[0].name !== RERUN_JOB || failed[0].conclusion !== 'failure') {
    return decision(false, failed.length === 0 ? `run ${run.id} has no failed job` : `failed jobs are not only ${RERUN_JOB}: ${failed.map(job => `${job.name}=${job.conclusion}`).join(', ')}`);
  }
  return decision(true, `${RERUN_JOB} is the only failed job of run ${run.id} attempt ${run.run_attempt}`, run);
}

// The live pull request, or undefined unless it is an open main candidate.
function candidate(pr, number) {
  return pr?.number === number && pr.state === 'open' && pr.base?.ref === 'main' && SHA.test(pr.head?.sha ?? '')
    && validSource({ branch: pr.head.ref, repositoryId: pr.head.repo?.id }) ? pr : undefined;
}

export async function receiptRerun({ event, repository, api, log = console.log }) {
  if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/u.test(repository ?? '')) throw new Error('repository is invalid');
  const skip = reason => { log(`No rerun: ${reason}.`); return { rerun: false, reason }; };
  const gate = receiptComment(event);
  if (!gate.ok) return skip(gate.reason);
  const root = `repos/${repository}`;
  let access;
  try { access = await api.get(`${root}/collaborators/${encodeURIComponent(gate.login)}/permission`); } catch { /* A failed lookup never establishes trust. */ }
  if (!hasWriteAccess(access)) return skip('commenter has no write, maintain or admin permission');
  const pr = candidate(await api.get(`${root}/pulls/${gate.pr}`), gate.pr);
  if (!pr) return skip('pull request is not an open main candidate');
  const head = pr.head.sha; const source = { branch: pr.head.ref, repositoryId: pr.head.repo.id };
  const listing = await api.get(`${root}/actions/workflows/published-tree-ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`);
  const runs = listing?.workflow_runs;
  if (!Array.isArray(runs) || runs.length > 100 || listing.total_count !== runs.length) return skip('run listing is incomplete or invalid');
  const run = latestRun(runs, head, source);
  let jobs = [];
  if (run?.status === 'completed') {
    const result = await api.get(`${root}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (Array.isArray(result?.jobs) && result.jobs.length <= 100 && result.total_count === result.jobs.length) jobs = result.jobs;
  }
  const selected = selectRerun(runs, jobs, head, source);
  if (!selected.rerun) return skip(selected.reason);
  // Another rerun or push may have started meanwhile; act only on the attempt just read.
  const current = await api.get(`${root}/actions/runs/${selected.runId}`);
  if (current?.id !== selected.runId || current.run_attempt !== selected.attempt || current.status !== 'completed' || current.conclusion !== 'failure'
    || current.head_sha !== head || current.head_branch !== source.branch || current.head_repository?.id !== source.repositoryId) return skip(`run ${selected.runId} changed before the rerun`);
  const live = candidate(await api.get(`${root}/pulls/${gate.pr}`), gate.pr);
  if (!live || live.head.sha !== head || live.head.ref !== source.branch || live.head.repo.id !== source.repositoryId) return skip('pull request head changed before the rerun');
  await api.post(`${root}/actions/runs/${selected.runId}/rerun-failed-jobs`);
  log(`Requested one rerun of the failed jobs: ${selected.reason}.`);
  return selected;
}

async function main() {
  if (processEnvironment.GITHUB_EVENT_NAME !== 'issue_comment') throw new Error('use the issue_comment event');
  const execute = promisify(execFile);
  const gh = async args => (await execute('gh', ['api', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const api = { get: async path => JSON.parse(await gh([path])), post: async path => { await gh(['--method', 'POST', path]); } };
  const event = JSON.parse(await readFile(processEnvironment.GITHUB_EVENT_PATH, 'utf8'));
  await receiptRerun({ event, repository: processEnvironment.GITHUB_REPOSITORY, api });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
