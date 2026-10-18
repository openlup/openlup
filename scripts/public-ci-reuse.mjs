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
const CHECKS = [...REQUIRED_CONTEXTS, 'test-full', 'pgtap'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const repository = value => value?.id === REPOSITORY_ID && value.full_name === REPOSITORY && value.private === false;

export async function completedMergeGroup({ eventName, ref, sha, checkout, event, token, fetcher = fetch }) {
  if (eventName !== 'push' || ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/u.test(sha ?? '')
    || sha !== checkout || !repository(event?.repository) || event.ref !== ref || event.after !== sha || !token) return false;
  try {
    const get = async path => {
      const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Evidence unavailable');
      return response.json();
    };
    const identity = run => positive(run?.id) && positive(run.workflow_id) && positive(run.run_attempt)
      && run.event === 'merge_group' && run.head_sha === sha && run.path === WORKFLOW
      && repository(run.repository) && repository(run.head_repository)
      && typeof run.head_branch === 'string' && run.head_branch.startsWith('gh-readonly-queue/main/');
    const latestRun = async () => {
      const listing = await get(`/actions/workflows/published-tree-ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=100`);
      const runs = listing.workflow_runs;
      if (!Array.isArray(runs) || runs.length === 0 || runs.length > 100 || listing.total_count !== runs.length
        || new Set(runs.map(run => run?.id)).size !== runs.length || !runs.every(identity)) return undefined;
      return runs.reduce((a, b) => a.id > b.id ? a : b);
    };
    const sameSuccess = (expected, observed) => identity(observed)
      && observed.id === expected.id && observed.workflow_id === expected.workflow_id
      && observed.run_attempt === expected.run_attempt && observed.head_branch === expected.head_branch
      && observed.status === 'completed' && observed.conclusion === 'success';
    const latest = await latestRun();
    if (!latest || !sameSuccess(latest, latest)) return false;
    const run = await get(`/actions/runs/${latest.id}`);
    if (!sameSuccess(latest, run)) return false;
    const result = await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const jobs = result.jobs;
    if (!Array.isArray(jobs) || jobs.length > 100 || result.total_count !== jobs.length
      || !jobs.every(job => positive(job?.id)) || new Set(jobs.map(job => job.id)).size !== jobs.length) return false;
    if (!CHECKS.every(name => {
      const matches = jobs.filter(job => job.name === name);
      return matches.length === 1 && matches[0].head_sha === sha && matches[0].status === 'completed' && matches[0].conclusion === 'success';
    })) return false;
    // A rerun can start while the explicitly addressed old jobs remain readable.
    // Revalidate both latest-run selection and attempt after collecting the proof.
    if (!sameSuccess(run, await latestRun())) return false;
    return sameSuccess(run, await get(`/actions/runs/${run.id}`));
  } catch {
    return false;
  }
}

async function main() {
  let reuse = false;
  try {
    reuse = await completedMergeGroup({
      eventName: processEnvironment.GITHUB_EVENT_NAME, ref: processEnvironment.GITHUB_REF, sha: processEnvironment.GITHUB_SHA,
      checkout: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      event: JSON.parse(readFileSync(processEnvironment.GITHUB_EVENT_PATH, 'utf8')), token: processEnvironment.GH_TOKEN,
    });
  } catch { /* Ordinary execution is the fallback, including malformed local inputs. */ }
  appendFileSync(processEnvironment.GITHUB_OUTPUT, `reuse=${reuse}\n`);
  console.log(reuse ? 'Reusing successful merge-group checks for this exact commit.' : 'Running checks: no complete merge-group proof for this commit.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
