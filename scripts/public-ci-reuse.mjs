// A main push may reuse completed checks of the very same merge-group commit.
// Missing, ambiguous or unavailable evidence means running the normal commands.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { env as processEnvironment } from 'node:process';
import { REQUIRED_CONTEXTS } from './packages/release-gate.ts';

const REPOSITORY = 'openlup/openlup';
const REPOSITORY_ID = 1376035358;
const WORKFLOW = '.github/workflows/published-tree-ci.yml';
const CHECKS = [...REQUIRED_CONTEXTS, 'pgtap'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const repository = value => value?.id === REPOSITORY_ID && value.full_name === REPOSITORY && value.private === false;

class ReuseEvidenceError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

const shortStatus = value => (typeof value === 'string' && value.length > 0 ? value.slice(0, 32) : 'missing');

export async function completedMergeGroup({
  eventName,
  ref,
  sha,
  checkout,
  event,
  token,
  fetcher = fetch,
  attempts = 3,
  delaysMs = [2000, 5000],
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onReason = undefined,
}) {
  const fail = reason => {
    onReason?.(reason);
    return false;
  };
  if (eventName !== 'push') return fail(`eventName ${shortStatus(eventName)} is not push`);
  if (ref !== 'refs/heads/main') return fail(`ref ${shortStatus(ref)} is not refs/heads/main`);
  if (!/^[a-f0-9]{40}$/u.test(sha ?? '')) return fail('invalid commit SHA');
  if (sha !== checkout) return fail('checkout SHA does not match push SHA');
  if (!repository(event?.repository)) return fail('untrusted event repository');
  if (event.ref !== ref || event.after !== sha) return fail('event ref or after SHA mismatch');
  if (!token) return fail('missing GitHub token');

  const get = async path => {
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      const detail = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error';
      throw new ReuseEvidenceError(`GitHub API ${detail}`, true);
    }
    if (!response.ok) throw new ReuseEvidenceError(`GitHub API HTTP ${response.status}`, true);
    try {
      return await response.json();
    } catch {
      throw new ReuseEvidenceError('malformed GitHub API JSON', false);
    }
  };
  const identity = run => positive(run?.id) && positive(run.workflow_id) && positive(run.run_attempt)
    && run.event === 'merge_group' && run.head_sha === sha && run.path === WORKFLOW
    && repository(run.repository) && repository(run.head_repository)
    && typeof run.head_branch === 'string' && run.head_branch.startsWith('gh-readonly-queue/main/');
  const latestRun = async () => {
    const listing = await get(`/actions/workflows/published-tree-ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=100`);
    const runs = listing.workflow_runs;
    if (!Array.isArray(runs) || listing.total_count !== runs.length || runs.length > 100) {
      throw new ReuseEvidenceError('invalid workflow_runs listing', false);
    }
    if (runs.length === 0) throw new ReuseEvidenceError('no merge_group workflow runs found yet', true);
    if (new Set(runs.map(run => run?.id)).size !== runs.length || !runs.every(identity)) {
      throw new ReuseEvidenceError('untrusted or duplicate workflow run metadata', false);
    }
    return runs.reduce((a, b) => a.id > b.id ? a : b);
  };
  const sameSuccess = (expected, observed) => identity(observed)
    && observed.id === expected.id && observed.workflow_id === expected.workflow_id
    && observed.run_attempt === expected.run_attempt && observed.head_branch === expected.head_branch
    && observed.status === 'completed' && observed.conclusion === 'success';
  const verifyOnce = async () => {
    const latest = await latestRun();
    if (latest.status !== 'completed') throw new ReuseEvidenceError(`merge_group run status is ${shortStatus(latest.status)}`, true);
    if (!sameSuccess(latest, latest)) throw new ReuseEvidenceError(`merge_group run conclusion is ${shortStatus(latest.conclusion)}`, false);
    const run = await get(`/actions/runs/${latest.id}`);
    if (!identity(run) || run.id !== latest.id || run.workflow_id !== latest.workflow_id
      || run.run_attempt !== latest.run_attempt || run.head_branch !== latest.head_branch) {
      throw new ReuseEvidenceError('merge_group run identity changed', false);
    }
    if (run.status !== 'completed') throw new ReuseEvidenceError(`merge_group run status is ${shortStatus(run.status)}`, true);
    if (!sameSuccess(latest, run)) throw new ReuseEvidenceError(`merge_group run conclusion is ${shortStatus(run.conclusion)}`, false);
    const result = await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const jobs = result.jobs;
    if (!Array.isArray(jobs) || jobs.length > 100 || result.total_count !== jobs.length
      || !jobs.every(job => positive(job?.id)) || new Set(jobs.map(job => job.id)).size !== jobs.length) {
      throw new ReuseEvidenceError('invalid jobs listing', false);
    }
    for (const name of CHECKS) {
      const matches = jobs.filter(job => job.name === name);
      if (matches.length !== 1) throw new ReuseEvidenceError(`missing or duplicate check ${name}`, false);
      const job = matches[0];
      if (job.head_sha !== sha) throw new ReuseEvidenceError(`check ${name} head_sha mismatch`, false);
      if (job.status !== 'completed') throw new ReuseEvidenceError(`check ${name} status is ${shortStatus(job.status)}`, true);
      if (job.conclusion !== 'success') throw new ReuseEvidenceError(`check ${name} conclusion is ${shortStatus(job.conclusion)}`, false);
    }
    // A rerun can start while the explicitly addressed old jobs remain readable.
    // Revalidate both latest-run selection and attempt after collecting the proof.
    const revalidatedLatest = await latestRun();
    if (!sameSuccess(run, revalidatedLatest)) {
      throw new ReuseEvidenceError(
        'merge_group run superseded during verification',
        revalidatedLatest.status !== 'completed',
      );
    }
    const revalidatedRun = await get(`/actions/runs/${run.id}`);
    if (!sameSuccess(run, revalidatedRun)) {
      throw new ReuseEvidenceError(
        'merge_group run superseded during verification',
        identity(revalidatedRun) && revalidatedRun.status !== 'completed',
      );
    }
    return true;
  };

  const maxAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  let lastReason = 'evidence unavailable';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await verifyOnce();
    } catch (error) {
      const retryable = error instanceof ReuseEvidenceError && error.retryable;
      lastReason = error instanceof ReuseEvidenceError ? error.message : 'unexpected verification error';
      if (!retryable || attempt >= maxAttempts) return fail(lastReason);
      const delay = delaysMs[attempt - 1] ?? delaysMs.at(-1) ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }
  return fail(lastReason);
}

async function main() {
  let reuse = false;
  let reason = 'malformed local inputs';
  try {
    reuse = await completedMergeGroup({
      eventName: processEnvironment.GITHUB_EVENT_NAME, ref: processEnvironment.GITHUB_REF, sha: processEnvironment.GITHUB_SHA,
      checkout: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      event: JSON.parse(readFileSync(processEnvironment.GITHUB_EVENT_PATH, 'utf8')), token: processEnvironment.GH_TOKEN,
      onReason: value => { reason = value; },
    });
  } catch { /* Ordinary execution is the fallback, including malformed local inputs. */ }
  appendFileSync(processEnvironment.GITHUB_OUTPUT, `reuse=${reuse}\n`);
  console.log(reuse ? 'Reusing successful merge-group checks for this exact commit.' : `Running checks: no complete merge-group proof for this commit (${reason}).`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
