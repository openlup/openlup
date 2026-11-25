import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { demand } from './agent-review-decide.mjs';
import { findBlockingMigrationQueuePrs, isMigrationQueueSerializedPath, readLatestSourceJobs,
  readPullRequestChangedPaths } from './agent-review-queue.mjs';
import { SIGN_OFF } from './dco-signoff-check.ts';
import { githubRead, graphRead, observeTimeline, timestamp } from './merge-queue-churn.mjs';

const root = '/repos/openlup/openlup';
const repositoryId = 1376035358;
const workflowId = 361484090;
const workflow = '.github/workflows/published-tree-ci.yml';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const failedRemoval = new Set(['failed_checks', 'checks_timed_out']);

async function livePull(read, number) {
  return graphRead(read, `isPrivate mergeCommitTitle mergeCommitMessage mergeQueue(branch:"main"){configuration{mergeMethod}}
    ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:${number}){id number state isDraft merged baseRefName headRefOid mergeable title body
      autoMergeRequest{enabledAt} mergeQueueEntry{id}}`);
}

async function removalGroups(read, number) {
  const events = await observeTimeline(read, number, message => { throw new Error(message); }, { includeSignature: true });
  const removals = events.filter(event => event.kind === 'removed');
  demand(removals.length <= 20, 'queue removal history exceeded the inspection bound');
  const groups = [];
  for (const event of removals) {
    demand(sha(event.beforeCommit) && typeof event.reason === 'string' && event.reason.length > 0,
      'queue removal lacks a synthetic commit or reason');
    demand(event.githubSigned === true, 'queue removal commit lacks a valid GitHub signature');
    const group = await read([`${root}/commits/${event.beforeCommit}`]);
    demand(Array.isArray(group?.parents), 'queue removal commit parents are unavailable');
    const [base, source] = group.parents;
    // OpenLup uses MERGE. A signed GitHub queue merge commit for this PR
    // identifies the source as parent two; the timeline SHA is the group SHA.
    demand(group?.sha === event.beforeCommit && group.parents.length === 2 && sha(base?.sha) && sha(source?.sha)
      && group.commit?.verification?.verified === true
      && typeof group.commit?.message === 'string' && group.commit.message.split('\n', 1)[0].endsWith(` (#${number})`),
    'queue removal cannot be linked to an exact source head');
    groups.push({ ...event, head: source.sha, base: base.sha });
  }
  return groups;
}

async function passingRetest(read, removal, number) {
  const branch = `gh-readonly-queue/main/pr-${number}-${removal.base}`;
  const listing = await read([`${root}/actions/workflows/published-tree-ci.yml/runs?event=merge_group&head_sha=${removal.beforeCommit}&per_page=100`]);
  const runs = listing?.workflow_runs;
  const exactRun = run => id(run?.id) && id(run.run_attempt) && run.event === 'merge_group' && run.path === workflow &&
    run.workflow_id === workflowId && run.repository?.id === repositoryId && run.repository.private === false &&
    run.head_sha === removal.beforeCommit && run.head_branch === branch;
  demand(Array.isArray(runs) && runs.length <= 100 && listing.total_count === runs.length &&
    new Set(runs.map(run => run?.id)).size === runs.length && runs.every(exactRun), 'exact group run history is incomplete');
  // A new run or a green source run is insufficient. Observe a rerun of the
  // removed group and require every required job's latest result.
  const run = runs.reduce((latest, candidate) => !latest || latest.id < candidate.id ? candidate : latest, null);
  if (!run || run.run_attempt < 2 || run.status !== 'completed' || run.conclusion !== 'success') return null;
  const attempt = await read([`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}`]);
  demand(exactRun(attempt) && attempt.id === run.id && attempt.run_attempt === run.run_attempt &&
    attempt.status === 'completed' && attempt.conclusion === 'success', 'exact group rerun identity is unavailable or changed');
  const startedAt = timestamp(attempt.run_started_at);
  demand(startedAt !== null, 'exact group rerun start time is unavailable');
  if (startedAt <= timestamp(removal.createdAt)) return null;
  const pages = await read(['--paginate', '--slurp', `${root}/actions/runs/${run.id}/jobs?filter=all&per_page=100`]);
  demand(Array.isArray(pages) && pages.length > 0 && pages.length <= 10, 'exact group jobs exceeded the evidence bound');
  const total = pages[0]?.total_count;
  demand(id(total) && total <= 1000 && pages.length === Math.ceil(total / 100) &&
    pages.every((page, index) => page?.total_count === total && Array.isArray(page.jobs) &&
      page.jobs.length === Math.min(100, total - index * 100)), 'exact group jobs are incomplete');
  const checks = readLatestSourceJobs(run, pages.flatMap(page => page.jobs));
  if (checks.some(job => job.status !== 'completed' || job.conclusion !== 'success')) return null;
  return {
    witness: { group: removal.beforeCommit, runId: run.id, attempt: run.run_attempt },
    jobs: checks.map(({ id, name, attempt }) => ({ id, name, attempt })),
  };
}

export async function checkQueueArm({ number, head, read = githubRead }) {
  demand(id(number) && sha(head), 'usage: node scripts/merge-queue-check-arm.mjs <PR-number> <reviewed-head>');
  const outcome = (status, reason, extra) => ({ status, pr: number, head, reason, ...extra });
  const sweep = async () => {
    const live = await livePull(read, number);
    const pr = live.pullRequest;
    demand(live.isPrivate === false && pr?.number === number && typeof pr.id === 'string' && pr.id.length > 0 &&
      pr.state === 'OPEN' && pr.isDraft === false && pr.merged === false && pr.baseRefName === 'main' &&
      pr.headRefOid === head, 'PR must be the exact current open, non-draft head targeting main');
    demand(sha(live.ref?.target?.oid), 'protected main commit identity is unavailable');
    demand(pr.autoMergeRequest === null || timestamp(pr.autoMergeRequest?.enabledAt) !== null,
      'auto-merge intent is unknown');
    demand(pr.mergeQueueEntry === null || (typeof pr.mergeQueueEntry?.id === 'string' && pr.mergeQueueEntry.id.length > 0),
      'queue membership is unknown');
    if (pr.mergeQueueEntry !== null) return outcome('held', 'already_queued');
    if (pr.autoMergeRequest !== null) return outcome('held', 'already_armed');
    if (pr.mergeable === 'CONFLICTING') return outcome('held', 'merge_conflict');
    demand(pr.mergeable === 'MERGEABLE', 'mergeability is unknown; refresh and diagnose if it persists');
    demand(live.mergeQueue?.configuration?.mergeMethod === 'MERGE' &&
      live.mergeCommitTitle === 'PR_TITLE' && live.mergeCommitMessage === 'PR_BODY' &&
      typeof pr.title === 'string' && pr.title.length > 0 && typeof pr.body === 'string',
    'GitHub queue commit message configuration is unknown or unsupported');
    if (!SIGN_OFF.test(`${pr.title} (#${number})\n\n${pr.body}`)) return outcome('held', 'missing_synthetic_dco');

    const removals = (await removalGroups(read, number)).filter(event => event.head === head);
    if (removals.length >= 2) return outcome('held', 'repeated_same_head_removal');
    const removal = removals[0];
    const retest = removal && failedRemoval.has(removal.reason) ? await passingRetest(read, removal, number) : null;
    if (removal && !retest) return outcome('held', 'operator_diagnosis', { removal: removal.reason, group: removal.beforeCommit });

    const api = { get: path => path.startsWith('/graphql?query=')
      ? read(['graphql', '-f', `query=${decodeURIComponent(path.slice('/graphql?query='.length))}`])
      : read([path]) };
    const paths = await readPullRequestChangedPaths(api, root, number);
    if (paths.some(isMigrationQueueSerializedPath)) {
      const blockingPrs = await findBlockingMigrationQueuePrs({ api, root, owner: 'openlup', name: 'openlup', prNumber: number });
      if (blockingPrs.length) return outcome('deferred', 'migration_peer_active', { blockingPrs });
    }
    return { live, paths, removals, retest };
  };

  try {
    const initial = await sweep();
    if (initial.status) return initial;
    const current = await sweep();
    if (current.status) return current;
    demand(isDeepStrictEqual(initial, current), 'evidence changed between reads; check the current PR again');
    const final = await livePull(read, number);
    demand(isDeepStrictEqual(final, current.live), 'PR or queue configuration changed during observation');
    return outcome('ready', 'preflight_passed', current.retest ? { retest: current.retest.witness } : undefined);
  } catch (error) {
    return outcome('held', 'evidence_unknown', { detail: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [pr, head, ...extra] = process.argv.slice(2);
    demand(extra.length === 0 && /^[1-9][0-9]*$/u.test(pr ?? ''), 'usage: node scripts/merge-queue-check-arm.mjs <PR-number> <reviewed-head>');
    const signal = AbortSignal.timeout(90_000);
    const decision = await checkQueueArm({ number: Number(pr), head, read: args => githubRead(args, signal) });
    console.log(JSON.stringify(decision));
    process.exitCode = decision.status === 'ready' ? 0 : 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
