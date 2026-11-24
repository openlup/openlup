import { env as processEnvironment } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildQueueChurnReport, collectQueueChurn, renderQueueChurnSummary } from './merge-queue-churn.mjs';

const since = '2099-11-10T00:00:00Z';
const until = '2099-11-11T00:00:00Z';
const coverage = { events: true, attempts: true, migrations: true };
const attestation = { repositoryId: 1376035358, baseRef: 'refs/heads/main', sourceId: 'independent-fixture',
  reviews: [], entries: [] };
const time = (seconds: number) => new Date(Date.parse(since) + seconds * 1000).toISOString();

describe('merge queue churn', () => {
  it('counts carry-in, removals and exact latency once within the interval', () => {
    const entry = { id: 'entry-1', pr: 5, kind: 'added', scope: 'migration', createdAt: time(-5) };
    const events = [
      entry, entry,
      { id: 'entry-2', pr: 6, kind: 'added', scope: 'ordinary', actor: 'app', createdAt: time(4), intentAt: time(0) },
      { id: 'removed-1', pr: 5, kind: 'removed', reason: 'merged', beforeCommit: 'b'.repeat(40), createdAt: time(6), entryId: 'entry-1' },
      { id: 'merge-1', pr: 5, kind: 'merged', mergeRef: 'main', head: 'b'.repeat(40), createdAt: time(5) },
      { id: 'removed-2', kind: 'removed', reason: 'manual', createdAt: time(10) },
      { id: 'removed-3', kind: 'removed', reason: 'merge_conflict', createdAt: until },
    ];
    const report = buildQueueChurnReport({ since, until, coverage, events, attempts: [], attestations: {
      ...attestation, entries: [
        { eventId: 'entry-1', pr: 5, head: 'a'.repeat(40), removalEventId: 'removed-1', mergeEventId: 'merge-1' },
        { eventId: 'entry-2', pr: 6, head: 'a'.repeat(40), intent: {
          id: 'command-2', kind: 'request', head: 'a'.repeat(40), authorizedAt: time(0),
        } },
      ],
    } });
    expect(report.timeline).toMatchObject({ entries: 1, actors: { app: 1 }, removals: { merged: 1, deliberate: 1 } });
    expect(report.latency.unknown.entryToMerge).toEqual({ samples: 1, missing: 0, medianSeconds: 10, p95Seconds: 10 });
    expect(report.latency.unknown.intentToEntry.medianSeconds).toBe(4);
    expect(report.timeline.removals).not.toHaveProperty('conflict');
  });

  it('charges successful siblings to the failed attempt and identifies the underlying shard', () => {
    const job = (id: string, name: string, conclusion: string, startedAt: string, completedAt: string) =>
      ({ id, name, conclusion, startedAt, completedAt });
    const jobs = [
      job('42', 'test-full-shard (3/8)', 'failure', time(-10), time(15)),
      { ...job('43', 'test', 'failure', time(15), time(16)), dependencyGuardFailed: true },
      { ...job('44', 'native-review', 'failure', time(16), time(17)), dependencyGuardFailed: true },
      job('45', 'test-full-shard (4/8)', 'success', time(0), time(10)),
    ];
    const attempts = [
      { id: '11:1', conclusion: 'failure', completedAt: time(17), superseded: true, jobs: [...jobs, jobs[0]] },
      { id: '11:2', conclusion: 'success', completedAt: time(30), jobs: [
        { ...job('46', 'test', 'success', time(10), time(30)), reused: true },
      ] },
      { id: '12:1', conclusion: 'cancelled', completedAt: time(35), jobs: [
        job('47', 'test-full-shard (3/8)', 'cancelled', time(30), time(35)),
      ] },
    ];
    const report = buildQueueChurnReport({ since, until, coverage, events: [], attempts });
    expect(report.groups.failures).toEqual([{ attemptId: '11:1', jobId: '42', jobName: 'test-full-shard (3/8)',
      groupSha: null, sourceHead: null, completedAt: time(17), jobCompletedAt: time(15), url: 'https://github.com/openlup/openlup/actions/runs/11/job/42' }]);
    expect(report.groups.jobSeconds).toEqual({ failed: 27, cancelled: 5, superseded: 0, other: 0, unknown: 0 });
    expect(report.groups).toMatchObject({ observedJobSeconds: 32, wastedJobSeconds: 32 });
  });

  it('keeps an incomplete migration sample distinct from verified churn', () => {
    const migrations = [
      { id: 'one', kind: 'rename', verified: true, reviewPhase: 'before', createdAt: time(4) },
      { id: 'two', kind: 'rename', verified: false, createdAt: time(5) },
      { id: 'three', kind: 'invalid', verified: true, historical: true, createdAt: time(6) },
      { id: 'four', kind: 'invalid', verified: true, landed: true, createdAt: time(7) },
    ];
    const report = buildQueueChurnReport({ since, until, coverage: { events: true, attempts: true }, events: [], attempts: [], migrations });
    expect(report.migrations).toEqual({ beforeReview: 0, afterReview: 0, invalidProposed: 0, invalidLanded: 0, unknown: 3 });
    expect(renderQueueChurnSummary(report)).toContain('Partial evidence in migrations.');
    expect(() => buildQueueChurnReport({ since, until: '2099-11-31T00:00:00Z', coverage, events: [], attempts: [] }))
      .toThrow('invalid UTC interval');
  });

  it('uses exact attempt and job reads on older runs and marks a cold collection partial', async () => {
    const requested: string[] = [];
    let mismatched = false;
    const repository = { full_name: 'openlup/openlup', id: 1376035358 };
    const run = { repository, id: 19, event: 'merge_group', workflow_id: 361484090, path: '.github/workflows/published-tree-ci.yml',
      run_attempt: 2, head_sha: 'a'.repeat(40) };
    const read = async (args: string[]) => {
      requested.push(args.join(' '));
      const path = args.find(arg => arg.startsWith('repos/'));
      if (args.includes('search/issues')) return [{ total_count: 1, items: [{ number: 5, repository_url: 'https://api.github.com/repos/openlup/openlup' }] }];
      if (args[0] === 'graphql') {
        const queue = { mergeQueue: { entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } };
        const pull = { pullRequest: { number: 5, baseRefName: 'main',
          timelineItems: { totalCount: 2, pageInfo: { hasPreviousPage: false }, nodes: [
            { __typename: 'AddedToMergeQueueEvent', id: 'entry', createdAt: time(-10), actor: { __typename: 'User' } },
            { __typename: 'RemovedFromMergeQueueEvent', id: 'remove', createdAt: time(5), reason: 'merged' },
          ] } } };
        return { data: { repository: { nameWithOwner: 'openlup/openlup', databaseId: 1376035358,
          ...(args.join(' ').includes('mergeQueue(') ? queue : pull) } } };
      }
      if (path?.includes('/workflows/')) return [{ workflow_runs: [run], total_count: 1 }];
      const ordinal = Number(/\/attempts\/(\d)/u.exec(path ?? '')?.[1]);
      return path?.includes('/jobs') ? [{ total_count: 1, jobs: [
        { run_id: 19, run_attempt: ordinal, head_sha: mismatched && ordinal === 2 ? 'b'.repeat(40) : run.head_sha, id: ordinal, name: 'test', conclusion: 'success',
          started_at: time(ordinal === 1 ? -35 : 1), completed_at: time(ordinal === 1 ? -15 : 5) },
      ] }] : { ...run, workflow_id: mismatched && ordinal === 2 ? 99 : run.workflow_id, run_attempt: ordinal, status: 'completed', conclusion: 'success',
        updated_at: time(ordinal === 1 ? -15 : 5) };
    };
    const evidence = await collectQueueChurn({ since, until }, read);
    const report = buildQueueChurnReport(evidence);
    expect(requested.filter(request => request.includes('/attempts/'))).toHaveLength(4);
    expect(report.partial).toEqual(['events', 'attempts', 'migrations', 'latency']);
    expect(report.latency.unknown.entryToMerge).toMatchObject({ medianSeconds: null, missing: 1 });
    expect(report.groups.observedJobSeconds).toBe(4);
    mismatched = true;
    const invalid = buildQueueChurnReport(await collectQueueChurn({ since, until }, read));
    expect(invalid.groups.observedJobSeconds).toBe(0);
    expect(invalid.timeline.removals).toEqual({ merged: 1 });
    expect(invalid.missing.attempts).toEqual(expect.arrayContaining([
      'run 19 attempt 2 metadata identity unavailable', 'run 19 attempt 2 job identity mismatch',
    ]));
  });
});

it('preserves independent review failures when another required job also failed', () => {
  const jobs = [
    { id: '1', name: 'native-review', conclusion: 'failure', dependencyGuardFailed: false, startedAt: time(0), completedAt: time(4) },
    { id: '2', name: 'dco', conclusion: 'failure', startedAt: time(0), completedAt: time(8) },
  ];
  const report = buildQueueChurnReport({ since, until, coverage, events: [],
    attempts: [{ id: '12:1', conclusion: 'failure', completedAt: time(9), jobs }] });
  expect(report.groups.failures[0]?.jobId).toBe('1');
});

it('keeps other feeds when the PR discovery read fails', async () => {
  const read = async (args: string[]) => {
    if (args.includes('search/issues')) throw new Error('fixture failure');
    if (args[0] === 'graphql') return { data: { repository: { nameWithOwner: 'openlup/openlup', databaseId: 1376035358,
      mergeQueue: { entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } } } };
    return [{ workflow_runs: [], total_count: 0 }];
  };
  const evidence = await collectQueueChurn({ since, until }, read);
  expect(evidence.currentQueue).toEqual([]);
  expect(evidence.missing.events).toContain('PR discovery unavailable');
});

it('discovers carry-in from a prior snapshot, follows timeline cursors, and refreshes the current queue', async () => {
  const calls: string[] = [];
  const repository = { full_name: 'openlup/openlup', id: 1376035358 };
  const read = async (args: string[]) => {
    const query = args.join(' ');
    calls.push(query);
    if (query.includes('search/issues')) return [{ items: [], total_count: 0 }];
    if (query.includes('/workflows/')) return [{ workflow_runs: [], total_count: 0 }];
    if (query.includes('/runs/44/attempts/1/jobs')) return [{ jobs: [], total_count: 0 }];
    if (query.includes('/runs/44/attempts/1')) return { id: 44, run_attempt: 1, status: 'completed', conclusion: 'failure', updated_at: time(8),
      repository, event: 'merge_group', workflow_id: 361484090, path: '.github/workflows/published-tree-ci.yml', head_sha: 'b'.repeat(40) };
    if (query.includes('/runs/44')) return { id: 44, repository, status: 'completed', event: 'merge_group', workflow_id: 361484090,
      path: '.github/workflows/published-tree-ci.yml', run_attempt: 1, head_sha: 'b'.repeat(40) };
    const connection = query.includes('mergeQueue(')
      ? { mergeQueue: { entries: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
        { id: 'current-q-id', position: 1, enqueuedAt: time(7), state: 'QUEUED', headCommit: { oid: 'c'.repeat(40) },
          pullRequest: { number: 5 }, enqueuer: { __typename: 'User' } },
      ] } } }
      : { pullRequest: { number: 5, baseRefName: 'main', timelineItems: { totalCount: 2,
        ...(query.includes('before:"older"') ? {
          pageInfo: { hasPreviousPage: false },
          nodes: [{ id: 'old-add', __typename: 'AddedToMergeQueueEvent', createdAt: time(-100), actor: { __typename: 'User' } }],
        } : {
          pageInfo: { hasPreviousPage: true, startCursor: 'older' },
          nodes: [{ id: 'old-remove', __typename: 'RemovedFromMergeQueueEvent', createdAt: time(3), reason: 'merged' }],
        }),
      } } };
    return { data: { repository: { nameWithOwner: repository.full_name, databaseId: repository.id, ...connection } } };
  };
  const evidence = await collectQueueChurn({ since, until, now: Date.parse(until), priorSnapshot: {
    schemaVersion: 1, repository: repository.full_name, capturedAt: since, queueComplete: true,
    queue: [{ id: 'prior-q-id', pr: 5 }], activeRunIds: [44],
  } }, read);
  const report = buildQueueChurnReport(evidence);
  expect(calls.some(query => query.includes('before:"older"'))).toBe(true);
  expect(report.currentQueue).toMatchObject([{ id: 'current-q-id', state: 'QUEUED' }]);
  expect(report.missing.events).toContain(`carry-in queue population at ${since} is unproven`);
  expect(report.latency.unknown.entryToMerge).toMatchObject({ medianSeconds: null, missing: 1 });
  expect(report.groups.latestReadiness).toMatchObject([{ runId: '44', outcome: 'failed' }]);
  expect(report.groups.unknownSourceHeads).toBe(1);
  expect(report.snapshot.activeRunIds).toEqual([]);
  expect(report.carryIn).toEqual({ activeQueueEntries: 0, queueEntriesNoLongerObserved: 1, reconciledRuns: 1, unknownRuns: 0 });
});

it('retains the first timeline page and marks its uncovered PR when the next page fails', async () => {
  const read = async (args: string[]) => {
    const query = args.join(' ');
    if (query.includes('search/issues')) return [{ items: [{ number: 5, repository_url: 'https://api.github.com/repos/openlup/openlup' }], total_count: 1 }];
    if (query.includes('/workflows/')) return [{ workflow_runs: [], total_count: 0 }];
    if (query.includes('before:')) throw new Error('next page lost');
    const connection = query.includes('mergeQueue(')
      ? { mergeQueue: { entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } }
      : { pullRequest: { number: 5, baseRefName: 'main', timelineItems: {
        totalCount: 2, pageInfo: { hasPreviousPage: true, startCursor: 'older' },
        nodes: [{ id: 'new-remove', __typename: 'RemovedFromMergeQueueEvent', createdAt: time(4), reason: 'roll_back' }],
      } } };
    return { data: { repository: { nameWithOwner: 'openlup/openlup', databaseId: 1376035358, ...connection } } };
  };
  const report = buildQueueChurnReport(await collectQueueChurn({ since, until }, read));
  expect(report.missing.events).toContain('PR #5 timeline incomplete page 2');
  expect(report.timeline.removals).toEqual({ collateral: 1 });
  expect(report.timeline.unlinkedRemovals).toBe(1);
  expect(report.currentQueue).toEqual([]);
});

it('counts only first-parent, byte-identical source renames and distinct malformed Git introductions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openlup-churn-git-'));
  let clock = 0;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd, encoding: 'utf8', env: { PATH: processEnvironment.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: time(clock), GIT_COMMITTER_DATE: time(clock) },
  }).trim();
  const sql = (name: string) => `db/platform/migrations/${name}.sql`;
  const mirror = (name: string) => `packages/platform/sql/${name}.sql`;
  const put = (path: string, value: string) => {
    const absolute = join(cwd, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, value);
  };
  const move = (from: string, to: string) => renameSync(join(cwd, from), join(cwd, to));
  const commit = (at: number, name: string) => {
    clock = at;
    git('add', '-A');
    git('commit', '-qm', name);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    put(sql('20261125310000_historical'), 'select 0;');
    const base = commit(-5, 'issued history');
    put(sql('20270231000000_imported'), 'select 1;');
    const landed = commit(2, 'landed on main');
    git('checkout', '-qb', 'task', base);
    put(sql('20270101000000_demo'), 'select 2;');
    put(mirror('20270101000000_demo'), 'select 2;');
    put(sql('20270101000002_changed'), 'select 3;');
    commit(3, 'draft');
    move(sql('20270101000000_demo'), sql('20270101000001_demo'));
    move(mirror('20270101000000_demo'), mirror('20270101000001_demo'));
    const reviewed = commit(4, 'move before receipt');
    put(sql('20271301000000_bad_source'), 'select 5;');
    commit(5, 'draft source introduction');
    clock = 6;
    git('merge', '--no-ff', '--no-commit', '-q', landed);
    move(sql('20270101000001_demo'), sql('20270101000003_demo'));
    move(mirror('20270101000001_demo'), mirror('20270101000003_demo'));
    move(sql('20270101000002_changed'), sql('20270101000004_changed'));
    put(sql('20270101000004_changed'), 'select 4;');
    commit(6, 'finalize after receipt and edit another SQL file');
    const pull = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const group = git('commit-tree', tree, '-p', landed, '-p', pull, '-m', 'synthetic group');
    const events = [
      { id: 'entry', kind: 'added', pr: 5, sourceHead: pull, createdAt: time(7), intentAt: time(6) },
      { id: 'main-merge', kind: 'merged', pr: 4, head: landed, mergeRef: 'main', createdAt: time(2) },
      { id: 'collateral', kind: 'removed', pr: 5, reason: 'roll_back', beforeCommit: group, createdAt: time(8) },
    ];
    const attestations = { ...attestation, reviews: [{ pr: 5, head: reviewed, receiptId: 'receipt-5', reviewedAt: time(4) }],
      entries: [{ eventId: 'entry', pr: 5, head: pull, intent: { id: 'command-5', kind: 'request', head: pull, authorizedAt: time(6) } }] };
    const jobs = [{ id: '20', name: 'test', conclusion: 'success', startedAt: time(5), completedAt: time(7) }];
    const attempts = [
      { id: '1:1', groupSha: group, conclusion: 'failure', completedAt: time(7), jobs: [] },
      { id: '1:2', groupSha: group, conclusion: 'success', completedAt: time(7), jobs },
      { id: '2:1', groupSha: 'a'.repeat(40), conclusion: 'success', completedAt: time(7), superseded: true,
        jobs: [{ ...jobs[0], id: '21' }] },
    ];
    const subjects = [
      { kind: 'pull', pr: 5, base, head: pull, reviewHead: reviewed, observedAt: time(7) },
      { kind: 'landed', pr: 4, base, head: landed, mergeEventId: 'main-merge', observedAt: time(2) },
      { kind: 'group', pr: 5, base: landed, head: group, sourceHead: pull, observedAt: time(8) },
    ];
    const report = buildQueueChurnReport({ since, until, coverage, events, attempts, gitSubjects: subjects, attestations }, Date.parse(until), cwd);
    expect(report.migrations).toEqual({ beforeReview: 1, afterReview: 1, invalidProposed: 1, invalidLanded: 1, unknown: 1 });
    expect(report.latency.migration.intentToEntry.medianSeconds).toBe(1);
    expect(report.groups.failures[0]?.sourceHead).toBe(pull);
    const invalidSource = buildQueueChurnReport({ since, until, coverage, events, gitSubjects: subjects, attestations,
      attempts: [{ ...attempts[0], sourceHead: 'not-a-commit' }] }, Date.parse(until), cwd);
    expect(invalidSource.groups.failures[0]?.sourceHead).toBeNull();
    expect(invalidSource.groups.unknownSourceHeads).toBe(1);
    expect(report.groups.jobSeconds).toMatchObject({ superseded: 2, unknown: 2 });
    expect(report.groups.unlinkedCollateralRemovals).toBe(0);
    const incomplete = buildQueueChurnReport({ since, until, coverage, events, attempts,
      gitSubjects: [{ ...subjects[0], reviewHead: reviewed }, { ...subjects[1], mergeEventId: 'unobserved-merge' },
        { ...subjects[2], sourceHead: reviewed }] },  Date.parse(until), cwd);
    expect(incomplete.migrations).toMatchObject({ beforeReview: 0, afterReview: 0, invalidLanded: 0, unknown: 3 });
    expect(incomplete.missing.migrations).toContainEqual(expect.stringContaining('exact main merge event unavailable'));
    expect(incomplete.groups.failures[0]?.sourceHead).toBeNull();
    expect(incomplete.groups.jobSeconds).toMatchObject({ superseded: 0, unknown: 4 });
    expect(incomplete.groups.unlinkedCollateralRemovals).toBe(1);
    expect(incomplete.missing.migrations).toEqual(expect.arrayContaining([expect.stringContaining('attested receipt head is unavailable'),
      expect.stringContaining('committed objects or lineage unavailable')]));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('joins live timeline rows to an offline attestation by exact IDs and refuses a nearby different PR', async () => {
  const head = 'a'.repeat(40);
  let invalidOrder = false;
  let reportedRemovalHead: string | null = 'b'.repeat(40);
  const read = async (args: string[]) => {
    const query = args.join(' ');
    if (query.includes('search/issues')) return [{ items: [], total_count: 0 }];
    if (query.includes('/workflows/')) return [{ workflow_runs: [], total_count: 0 }];
    const pr = Number(/pullRequest\(number:(\d+)\)/u.exec(query)?.[1]);
    const nodes = [
      { id: `add-${pr}`, __typename: 'AddedToMergeQueueEvent', createdAt: time(-4) },
      { id: `merge-${pr}`, __typename: 'MergedEvent', createdAt: time(2), mergeRefName: 'main', commit: { oid: 'b'.repeat(40) } },
      { id: `remove-${pr}`, __typename: 'RemovedFromMergeQueueEvent', createdAt: time(invalidOrder ? 1 : 3), reason: 'merged',
        beforeCommit: reportedRemovalHead ? { oid: reportedRemovalHead } : null },
    ];
    const connection = query.includes('mergeQueue(')
      ? { mergeQueue: { entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } }
      : { pullRequest: { number: pr, baseRefName: 'main', timelineItems: {
        totalCount: 3, nodes, pageInfo: { hasPreviousPage: false },
      } } };
    return { data: { repository: { nameWithOwner: 'openlup/openlup', databaseId: 1376035358, ...connection } } };
  };
  const attestations = { ...attestation, entries: [
    { eventId: 'add-5', pr: 5, head, removalEventId: 'remove-5', mergeEventId: 'merge-5' },
    { eventId: 'add-6', pr: 6, head, removalEventId: 'remove-6', mergeEventId: 'merge-5' },
  ] };
  await expect(collectQueueChurn({ since, until, attestations }, read)).rejects.toThrow('duplicate attested entry');
  attestations.entries[1]!.mergeEventId = 'merge-7';
  const evidence = await collectQueueChurn({ since, until, attestations, priorSnapshot: {
    schemaVersion: 1, repository: 'openlup/openlup', capturedAt: since, queueComplete: true,
    queue: [{ pr: 7, id: 'q-7' }], activeRunIds: [],
  } }, read);
  const report = buildQueueChurnReport(evidence);
  expect(report.latency.unknown.entryToMerge).toEqual({ medianSeconds: 6, p95Seconds: 6, samples: 1, missing: 2 });
  expect(report.linkage).toMatchObject({ attestedSource: 'independent-fixture', missing: { conflictingAttestations: 1, mergeAttempt: 2 } });
  expect(report.linkage.matchedEntries).toEqual([{ eventId: 'add-5', pr: 5, head, scope: 'unknown', intent: null, mergeEventId: 'merge-5' }]);
  invalidOrder = true;
  const impossible = buildQueueChurnReport(await collectQueueChurn({ since, until, attestations }, read));
  expect(impossible.latency.unknown.entryToMerge).toMatchObject({ samples: 0, missing: 2 });
  expect(impossible.linkage.missing.conflictingAttestations).toBe(2);
  invalidOrder = false;
  for (const unverifiedHead of ['c'.repeat(40), null]) {
    reportedRemovalHead = unverifiedHead;
    const unverified = buildQueueChurnReport(await collectQueueChurn({ since, until, attestations }, read));
    expect(unverified.latency.unknown.entryToMerge).toMatchObject({ samples: 0, missing: 2 });
    expect(unverified.linkage.missing.conflictingAttestations).toBe(2);
  }
});

it.each(['untimed producer', 'unclassified aggregate'])('marks first failure unknown with an %s', issue => {
  const jobs = [
    { id: '1', name: 'dco', conclusion: 'failure', startedAt: time(0), completedAt: time(4) },
    { id: '2', name: issue === 'untimed producer' ? 'gitleaks' : 'native-review', conclusion: 'failure',
      startedAt: time(0), completedAt: issue === 'untimed producer' ? null : time(3) },
  ];
  const report = buildQueueChurnReport({ since, until, coverage, events: [],
    attempts: [{ id: '12:1', conclusion: 'failure', completedAt: time(5), jobs }] });
  expect(report.groups.failures[0]?.jobId).toBeNull();
  expect(report.groups.failedAttemptsWithoutProducer).toBe(1);
  expect(report.missing.attempts).toContain('first failure evidence incomplete for 1 attempts');
  expect(renderQueueChurnSummary(report)).toContain('ordinary intent to entry seconds, median unknown, p95 unknown');
  expect(renderQueueChurnSummary(report)).toContain('Invalid proposed migration versions 0, invalid landed versions 0');
});

const reportCli = (args: string[], input: string | Buffer, env = processEnvironment) =>
  spawnSync(process.execPath, [fileURLToPath(new URL('./merge-queue-churn.mjs', import.meta.url)), ...args], {
    input, encoding: 'utf8', env,
  });

it('accepts offline stdin and distinguishes complete, partial and malformed results', () => {
  const evidence = { since, until, events: [], attempts: [], coverage };
  const complete = reportCli(['--offline'], JSON.stringify(evidence));
  expect(complete.status).toBe(0);
  expect(JSON.parse(complete.stdout)).toMatchObject({ since, until, partial: [] });
  const partial = reportCli(['--offline', 'markdown'], JSON.stringify({
    ...evidence, coverage: { ...coverage, events: false },
  }));
  expect(partial.status).toBe(2);
  expect(partial.stdout).toContain('Partial evidence in events');
  const invalidInputs = [
    { args: ['--offline'], input: '{"events":[],"events":[]}', reason: 'unique keys' },
    { args: ['--offline'], input: '', reason: 'stdin evidence is empty' },
    { args: ['--offline'], input: '[]', reason: 'JSON object' },
    { args: ['--offline'], input: ' '.repeat(8 * 1024 * 1024 + 1), reason: 'exceeds 8 MiB' },
    { args: ['--offline'], input: Buffer.from([0xff]), reason: 'UTF-8' },
    { args: ['--offline'], input: '{"unexpected":[]}', reason: 'unknown fields' },
    { args: ['--offline', '--stdin'], input: '{}', reason: 'usage' },
    { args: ['--offline', '/path/evidence.json'], input: '{}', reason: 'usage' },
    { args: ['--github', '--stdin'], input: '{"since":"ignored"}', reason: 'unknown fields' },
    { args: ['--github', '--stdin'], input: '{"subjects":{}}', reason: 'subjects must be an array' },
  ];
  for (const { args, input, reason } of invalidInputs) {
    const result = reportCli(args, input);
    expect(result.status, args.join(' ')).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(reason);
  }
});

it('uses live stdin attestations to discover and bind exact timeline rows', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'openlup-churn-cli-'));
  try {
    const queue = { mergeQueue: { entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } };
    const pull = { pullRequest: { number: 44, baseRefName: 'main', timelineItems: {
      totalCount: 1, pageInfo: { hasPreviousPage: false }, nodes: [
        { __typename: 'AddedToMergeQueueEvent', id: 'added-44', createdAt: time(12) },
      ],
    } } };
    const response = (value: object) => JSON.stringify({ data: { repository: {
      nameWithOwner: 'openlup/openlup', databaseId: 1376035358, ...value,
    } } });
    writeFileSync(join(scratch, 'gh'), `#!/bin/sh
case "$*" in
  *"pullRequest(number:44)"*) printf '%s' '${response(pull)}' ;;
  *"mergeQueue(branch:"*) printf '%s' '${response(queue)}' ;;
  *search/issues*) printf '%s' '[{"total_count":0,"items":[]}]' ;;
  *"/runs"*) printf '%s' '[{"total_count":0,"workflow_runs":[]}]' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const head = 'a'.repeat(40);
    const result = reportCli(['--github', since, until, '--stdin'], JSON.stringify({
      attestations: { ...attestation, entries: [{ eventId: 'added-44', pr: 44, head,
        intent: { id: 'command-44', kind: 'request', head, authorizedAt: time(2) },
      }] },
    }), { ...processEnvironment, PATH: [scratch, processEnvironment.PATH].join(delimiter) });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      timeline: { entries: 1 }, latency: { unknown: { intentToEntry: { medianSeconds: 10, samples: 1 } } },
      linkage: { matchedEntries: [{ eventId: 'added-44', pr: 44, head }] },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it('projects saved evidence without echoing opaque fields, comments, or actor email', () => {
  const privateText = 'private comment from alice@example.invalid';
  const queue = [{ id: 'queue-1', pr: 44, position: 0, state: 'QUEUED', enqueuedAt: time(1),
    actor: { email: 'alice@example.invalid' }, entryHead: 'a'.repeat(40), comment: privateText }];
  const evidence = {
    since, until, coverage: { ...coverage, events: false, currentQueue: true },
    missing: { events: [privateText] },
    events: [{ id: 'remove-1', pr: 44, kind: 'removed', reason: 'overflow_private_payload', createdAt: time(8) }],
    attempts: [{ id: '44:1', conclusion: 'failure', completedAt: time(8), complete: { comment: privateText },
      jobs: [{ id: '45', name: privateText, conclusion: 'failure', startedAt: time(1), completedAt: time(7), body: privateText }],
    }],
    currentQueue: queue,
    carryIn: { activeQueueEntries: 1, queueEntriesNoLongerObserved: 0, reconciledRuns: 1, unknownRuns: 0, body: privateText },
    snapshot: { schemaVersion: 1, repository: 'openlup/openlup', capturedAt: time(9), queueComplete: true,
      queue, activeRunIds: [44], raw: privateText },
  };
  for (const format of ['json', 'markdown']) {
    const result = reportCli(['--offline', format], JSON.stringify(evidence));
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('alice@example.invalid');
    expect(result.stdout).not.toContain('overflow_private_payload');
    if (format === 'json') {
      const report = JSON.parse(result.stdout);
      expect(report.missing.events).toEqual(['coverage not established']);
      expect(report.currentQueue).toEqual([{
        id: 'queue-1', pr: 44, position: 0, state: 'QUEUED', enqueuedAt: time(1), actor: 'unknown', entryHead: 'a'.repeat(40),
      }]);
      expect(report.snapshot).toEqual({ schemaVersion: 1, repository: 'openlup/openlup', capturedAt: time(9),
        queueComplete: true, queue: report.currentQueue, activeRunIds: [44] });
      expect(report.carryIn).toEqual({ activeQueueEntries: 1, queueEntriesNoLongerObserved: 0, reconciledRuns: 1, unknownRuns: 0 });
      expect(report.groups.latestReadiness[0]?.complete).toBe(true);
      expect(report.groups.failures[0]?.jobName).toBe('unknown');
    }
  }
  for (const ids of [{ attempt: privateText, job: '45' }, { attempt: '44:1', job: privateText }]) {
    const result = reportCli(['--offline'], JSON.stringify({ ...evidence,
      attempts: [{ ...evidence.attempts[0], id: ids.attempt, jobs: [{ ...evidence.attempts[0]!.jobs[0], id: ids.job }] }],
    }));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('alice@example.invalid');
  }
});

it('downgrades incomplete and duplicate offline queue observations, including the saved snapshot', () => {
  const queueEntry = { id: 'entry-1', pr: 44, position: 0, state: 'QUEUED', enqueuedAt: time(1), entryHead: 'a'.repeat(40) };
  const evidence = { since, until, events: [], attempts: [], coverage: { ...coverage, currentQueue: true } };
  for (const { queue, gap } of [
    { queue: [{ id: 'entry-1', pr: 44 }], gap: 'queue entry metadata incomplete' },
    { queue: [queueEntry, { ...queueEntry, id: 'entry-2', pr: 45 }], gap: 'duplicate queue entry ID, PR, or position' },
    { queue: [queueEntry, { ...queueEntry, position: 1 }], gap: 'duplicate queue entry ID, PR, or position' },
  ]) {
    const result = reportCli(['--offline'], JSON.stringify({ ...evidence, currentQueue: queue, snapshot: {
      schemaVersion: 1, repository: 'openlup/openlup', capturedAt: since, queueComplete: true, queue, activeRunIds: [],
    } }));
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.partial).toContain('currentQueue');
    expect(report.missing.currentQueue).toContain(gap);
    expect(report.currentQueue).toHaveLength(queue.length);
    expect(report.snapshot.queueComplete).toBe(false);
  }
});
