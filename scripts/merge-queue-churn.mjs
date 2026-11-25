import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { isMigrationQueueSerializedPath } from './agent-review-queue.mjs';
import { documentationGit } from './documentation-git.ts';
import { isUtcMigrationSlot, migrationIdentity } from './migration-slots.mjs';
import { parseStrictJson } from './oss-strict-json.mts';

const day = 86_400_000;
const repository = 'openlup/openlup';
const repositoryId = 1376035358;
const workflowId = 361484090;
const execute = promisify(execFile);
const observedGaps = new WeakMap();
const queueStates = new Set(['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'LOCKED', 'UNMERGEABLE']);
const workflowJobs = new Set(['dco', 'reuse-gate', 'typecheck', 'install-pack', 'install-packages', 'install-proof', 'test-prep',
  'test', 'self-check', 'gitleaks', 'pgtap', 'native-review']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value) ? value : null;
const outcomeByReason = new Map([
  ['merged', 'merged'], ['merge_conflict', 'conflict'], ['failed_checks', 'checks'],
  ['checks_timed_out', 'checks'], ['manual', 'deliberate'], ['dequeued', 'deliberate'],
  ['dequeued_by_user', 'deliberate'], ['roll_back', 'collateral'],
  ['branch_protection_failure', 'branchProtection'],
]);
const aggregateGuards = new Map([
  ['test', 'Require all eight full-root shards and pgTAP to succeed'],
  ['install-proof', 'Require package proof and every browser shard to succeed'],
  ['native-review', 'Require six actual mechanical successes'],
]);
const numericId = value => Number.isSafeInteger(value) && value > 0;
const numericIdText = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/u.test(value) && numericId(Number(value));
const jobLabel = value => typeof value === 'string' && (workflowJobs.has(value) ||
  /^test-full-shard \([1-8]\/8\)$/u.test(value) || /^install-browser \((?:0|6|1,2|3,5|4|1,6|2,4)\)$/u.test(value)) ? value : 'unknown';

export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? time : null;
}

function uniqueRows(rows, field) {
  const unique = new Map();
  for (const row of rows) {
    if (!row || typeof row[field] !== 'string' || !row[field]) throw new Error(`missing ${field}`);
    const previous = unique.get(row[field]);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error(`conflicting ${field}`);
    unique.set(row[field], row);
  }
  return unique.values();
}

function firstFailedJob(jobs) {
  const failures = jobs.filter(job => ['failure', 'timed_out'].includes(job.conclusion));
  const roots = failures.filter(job => job.dependencyGuardFailed !== true);
  if (roots.some(job => timestamp(job.completedAt) === null ||
      (aggregateGuards.has(job.name) && job.dependencyGuardFailed !== false))) return null;
  return roots.sort((a, b) => timestamp(a.completedAt) - timestamp(b.completedAt) || a.id.localeCompare(b.id))[0] ?? null;
}

function attemptBucket(attempt, collateral) {
  if (['failure', 'timed_out'].includes(attempt.conclusion)) return 'failed';
  if (attempt.conclusion === 'cancelled') return 'cancelled';
  if (collateral === 'verified') return 'superseded';
  return attempt.conclusion === 'success' && collateral !== 'unknown' && attempt.superseded !== true ? 'other' : 'unknown';
}

function latencySummary(samples) {
  const times = samples.filter(value => value !== null).sort((a, b) => a - b);
  const percentile = fraction => times[Math.ceil(times.length * fraction) - 1] ?? null;
  return { samples: times.length, missing: samples.length - times.length,
    medianSeconds: percentile(0.5), p95Seconds: percentile(0.95) };
}

function secondsBetween(start, end) {
  const from = timestamp(start), to = timestamp(end);
  return from === null || to === null || to < from ? null : (to - from) / 1000;
}

const ordinaryMigration = path => {
  const identity = migrationIdentity(path);
  return identity && !identity.qualifier && identity.version !== '00000000000000' ? identity : null;
};

function rawGitChanges(git, base, head) {
  const fields = git('diff-tree', '-r', '--raw', '--no-abbrev', '--no-renames', '--no-commit-id', '-z', base, head)
    .toString('utf8').split('\0');
  if (fields.pop() !== '' || fields.length % 2 || fields.length > 10_000) throw new Error('incomplete Git diff');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const part = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADMT])$/u.exec(fields[index]);
    if (!part) throw new Error('invalid raw Git diff');
    const [, oldMode, mode, oldOid, oid, status] = part;
    const path = fields[index + 1];
    changes.push({ path, status, oldMode, mode, oldOid, oid, identity: ordinaryMigration(path) });
  }
  return changes;
}

function commitEvidence(git, id) {
  if (!sha(id) || git('rev-parse', '--verify', `${id}^{commit}`).toString('ascii').trim() !== id) throw new Error('missing exact commit');
  const [parents, stamp] = git('show', '-s', '--no-show-signature', '--format=%P%n%cI', id).toString('ascii').trimEnd().split('\n');
  const date = Date.parse(stamp);
  if (!Number.isFinite(date)) throw new Error('missing Git commit time');
  return { parents: parents ? parents.split(' ') : [], createdAt: new Date(date).toISOString() };
}

function observePullGit(git, subject, selectedChanges) {
  const { base, head, pr, reviewHead } = subject;
  const commits = git('rev-list', '--first-parent', '--max-count=101', `${base}..${head}`).toString('ascii').trim().split('\n').filter(Boolean).reverse();
  const evidence = [];
  if (commits.length === 0 || commits.length > 100 || commits.at(-1) !== head) throw new Error('incomplete PR first-parent history');
  const sourcePaths = new Set();
  const authoredPaths = new Set();
  const reviewIndex = reviewHead === base ? -1 : reviewHead ? commits.indexOf(reviewHead) : -1;
  let parent = base;
  for (const [index, commit] of commits.entries()) {
    const { parents, createdAt } = commitEvidence(git, commit);
    if (parents[0] !== parent) throw new Error('PR base is outside the first-parent history');
    const allChanges = rawGitChanges(git, parent, commit);
    const changes = allChanges.filter(change => change.identity);
    parent = commit;
    const second = parents.length === 2 ? new Map(rawGitChanges(git, parents[1], commit).map(change => [change.path, change])) : null;
    // A merge's second parent distinguishes a source-owned target from an
    // imported target. Its unchanged old path also proves preservation of any
    // main-side add/add entry at that identity.
    const removed = changes.filter(change => sourcePaths.has(change.path) &&
      (change.status === 'D' || (parents.length > 1 && ['M', 'T'].includes(change.status))));
    const added = changes.filter(change => change.status === 'A');
    const provenTargets = new Set();
    const key = ({ identity }) => `${identity.rail}:${identity.name}`;
    for (const old of removed) {
      const sameName = added.filter(change => key(change) === key(old) && change.identity.version !== old.identity.version);
      if (!sameName.length) continue;
      const sourceTargets = second ? sameName.filter(change => second.has(change.path)) : sameName;
      const target = sourceTargets[0] ?? sameName[0];
      const unique = sourceTargets.length === 1 && removed.filter(change => key(change) === key(old)).length === 1;
      const provenMove = parents.length === 1 || (second && !second.has(old.path) && second.get(target.path)?.status === 'A');
      const exact = Boolean(unique && provenMove && old.oldMode === '100644' && target.mode === old.oldMode && target.oid === old.oldOid);
      if (exact) provenTargets.add(target.path);
      const reviewPhase = reviewHead === base || reviewIndex >= 0 ? (index <= reviewIndex ? 'before' : 'after') : null;
      evidence.push({ id: `pr:${pr}:${commit}:${old.path}`, kind: 'rename', pr, commit, createdAt,
        sourcePath: old.path, targetPath: unique ? target.path : null, verified: exact, reviewPhase });
    }
    for (const change of allChanges) {
      if (parents.length === 1) {
        authoredPaths.add(change.path);
        if (change.status === 'D') sourcePaths.delete(change.path);
        if (change.status === 'A' && change.identity) sourcePaths.add(change.path);
      } else if (provenTargets.has(change.path)) {
        sourcePaths.add(change.path);
        authoredPaths.add(change.path);
      } else {
        sourcePaths.delete(change.path);
        authoredPaths.delete(change.path);
      }
    }
  }
  for (const change of selectedChanges) {
    if (change.status === 'A' && change.identity && sourcePaths.has(change.path) && !isUtcMigrationSlot(change.identity.version)) {
      evidence.push({ id: `proposed:${pr}:${head}:${change.path}`, kind: 'invalid', pr, commit: head, createdAt: subject.observedAt,
        sourcePath: change.path, verified: change.mode === '100644' });
    }
  }
  const scoped = selectedChanges.filter(({ path }) => isMigrationQueueSerializedPath(path));
  const scope = scoped.some(({ path }) => authoredPaths.has(path)) ? 'migration' : scoped.length ? 'unknown' : 'ordinary';
  return { evidence, scope };
}

const evidenceId = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,128}$/u.test(value);
const mainRef = value => value === 'main' || value === 'refs/heads/main';

function readAttestations(value) {
  if (value === undefined) return { sourceId: null, reviews: new Map(), entries: new Map() };
  if (value?.repositoryId !== repositoryId || value.baseRef !== 'refs/heads/main' || !evidenceId(value.sourceId) ||
      !Array.isArray(value.reviews) || !Array.isArray(value.entries) || value.reviews.length > 100 || value.entries.length > 1000) {
    throw new Error('invalid offline evidence attestation');
  }
  const reviews = new Map();
  const entries = new Map();
  const removals = new Set();
  const merges = new Set();
  for (const row of value.reviews) {
    if (!numericId(row?.pr) || !sha(row.head) || !evidenceId(row.receiptId) || timestamp(row.reviewedAt) === null || reviews.has(row.pr)) {
      throw new Error('invalid or duplicate attested review');
    }
    reviews.set(row.pr, row);
  }
  for (const row of value.entries) {
    const intent = row?.intent;
    if (!evidenceId(row?.eventId) || !numericId(row.pr) || !sha(row.head) || entries.has(row.eventId) ||
        (intent !== undefined && (!evidenceId(intent?.id) || !['request', 'reserve'].includes(intent.kind) ||
          intent.head !== row.head || timestamp(intent.authorizedAt) === null)) ||
        (row.removalEventId !== undefined && (!evidenceId(row.removalEventId) || removals.has(row.removalEventId))) ||
        (row.mergeEventId !== undefined && (!evidenceId(row.mergeEventId) || merges.has(row.mergeEventId) || !row.removalEventId))) {
      throw new Error('invalid or duplicate attested entry');
    }
    entries.set(row.eventId, row);
    removals.add(row.removalEventId);
    merges.add(row.mergeEventId);
  }
  return { sourceId: value.sourceId, reviews, entries };
}

/** Resolve a bounded set of explicit subjects from Git objects, without updating refs or fetching. */
export function deriveQueueChurnGitEvidence(subjects, cwd = process.cwd(), { reviews = new Map(), events = new Map() } = {}) {
  if (!Array.isArray(subjects) || subjects.length > 100) throw new Error('Git evidence needs at most 100 exact subjects');
  const git = (...args) => documentationGit(cwd, args, undefined, 2 * 1024 * 1024);
  const migrations = [];
  const pulls = new Map();
  const groups = new Map();
  const missing = [];
  const seen = new Set();
  for (const subject of subjects) {
    if (!subject || !['pull', 'landed', 'group'].includes(subject.kind) || !sha(subject.base) || !sha(subject.head) ||
        timestamp(subject.observedAt) === null || (subject.kind !== 'landed' && !numericId(subject.pr)) ||
        (subject.kind === 'landed' && (!numericId(subject.pr) || !evidenceId(subject.mergeEventId))) ||
        (subject.kind === 'group' && !sha(subject.sourceHead))) throw new Error('invalid exact Git evidence subject');
    const key = subject.kind === 'pull' ? `PR #${subject.pr}` : `${subject.kind} ${subject.head}`;
    if (seen.has(key)) throw new Error('duplicate Git evidence subject');
    seen.add(key);
    try {
      commitEvidence(git, subject.base);
      const { parents } = commitEvidence(git, subject.head);
      if (subject.kind !== 'pull' && parents[0] !== subject.base) throw new Error('unverified landing parent');
      if (subject.kind === 'group') {
        if (parents.length !== 2 || parents[1] !== subject.sourceHead) throw new Error('unverified group source parent');
        groups.set(subject.head, { pr: subject.pr, sourceHead: subject.sourceHead });
        continue;
      }
      const changes = rawGitChanges(git, subject.base, subject.head);
      if (subject.kind === 'pull') {
        const review = reviews.get(subject.pr);
        const reviewHead = review && timestamp(review.reviewedAt) <= timestamp(subject.observedAt) ? review.head : undefined;
        const { evidence, scope } = observePullGit(git, { ...subject, reviewHead }, changes);
        if (evidence.some(row => row.kind === 'rename' && row.verified && row.reviewPhase === null)) {
          missing.push(`${key} attested receipt head is unavailable on its first-parent history`);
        }
        if (evidence.some(row => !row.verified)) missing.push(`${key} migration changes lack unique byte-and-mode proof`);
        migrations.push(...evidence);
        pulls.set(subject.head, { pr: subject.pr, scope });
      } else {
        const merge = events.get(subject.mergeEventId);
        if (merge?.kind !== 'merged' || merge.pr !== subject.pr || merge.head !== subject.head ||
            !mainRef(merge.mergeRef) || timestamp(merge.createdAt) === null) {
          missing.push(`${key} exact main merge event unavailable`);
          continue;
        }
        for (const change of changes) {
          if (change.status === 'A' && change.identity && !isUtcMigrationSlot(change.identity.version)) {
            migrations.push({ id: `landed:${subject.head}:${change.path}`, kind: 'invalid', commit: subject.head,
              createdAt: merge.createdAt, sourcePath: change.path, landed: true, verified: change.mode === '100644' });
          }
        }
      }
    } catch {
      missing.push(`${key} committed objects or lineage unavailable`);
    }
  }
  for (const [group, source] of groups) {
    if (pulls.get(source.sourceHead)?.pr !== source.pr) {
      groups.delete(group);
      missing.push(`group ${group} exact source PR subject unavailable`);
    }
  }
  return { migrations, pulls, groups, missing };
}

function projectQueue(rows) {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('invalid queue evidence');
  return rows.map(row => {
    if (!evidenceId(row?.id) || !numericId(row.pr)) throw new Error('invalid queue entry identity');
    return { id: row.id, pr: row.pr,
      position: Number.isSafeInteger(row.position) && row.position >= 0 ? row.position : null,
      state: queueStates.has(row.state) ? row.state : null,
      enqueuedAt: timestamp(row.enqueuedAt) === null ? null : row.enqueuedAt,
      entryHead: sha(row.entryHead), actor: ['app', 'human'].includes(row.actor) ? row.actor : 'unknown' };
  });
}

function queueGaps(rows) {
  const gaps = [];
  if (rows.some(row => [row.position, row.state, row.enqueuedAt, row.entryHead].includes(null))) {
    gaps.push('queue entry metadata incomplete');
  }
  if (['id', 'pr', 'position'].some(field => {
    const known = rows.map(row => row[field]).filter(value => value !== null);
    return new Set(known).size !== known.length;
  })) gaps.push('duplicate queue entry ID, PR, or position');
  return gaps;
}

function projectCarryIn(value) {
  if (value == null) return value;
  const keys = { activeQueueEntries: 500, queueEntriesNoLongerObserved: 500, reconciledRuns: 1000, unknownRuns: 1000 };
  return Object.fromEntries(Object.entries(keys).map(([key, max]) => {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > max) throw new Error('invalid carry-in evidence');
    return [key, count];
  }));
}

function projectAttempt(row) {
  const [runId, ordinal, extra] = typeof row.id === 'string' ? row.id.split(':') : [];
  if (extra !== undefined || !numericIdText(runId) || !numericIdText(ordinal) || Number(ordinal) > 20 ||
      !Array.isArray(row.jobs) || row.jobs.length > 1000) throw new Error('invalid attempt evidence');
  const jobs = [...uniqueRows(row.jobs, 'id')].map(job => {
    if (!numericIdText(job.id)) throw new Error('invalid job identity');
    return { id: job.id, name: jobLabel(job.name), conclusion: job.conclusion,
      startedAt: timestamp(job.startedAt) === null ? null : job.startedAt,
      completedAt: timestamp(job.completedAt) === null ? null : job.completedAt,
      reused: job.reused === true,
      dependencyGuardFailed: typeof job.dependencyGuardFailed === 'boolean' ? job.dependencyGuardFailed : undefined };
  });
  return { id: `${runId}:${ordinal}`, groupSha: sha(row.groupSha), sourceHead: sha(row.sourceHead),
    invalidSourceHead: row.sourceHead != null && !sha(row.sourceHead),
    completedAt: timestamp(row.completedAt) === null ? null : row.completedAt,
    complete: typeof row.complete === 'boolean' ? row.complete : null, conclusion: row.conclusion,
    superseded: row.superseded === true, jobs };
}

/** Compute observed results from separately collected, sanitized GitHub and Git evidence. */
export function buildQueueChurnReport(input, now = Date.now(), cwd = process.cwd()) {
  const endOfDay = Math.floor(now / day) * day;
  const { since = new Date(endOfDay - 7 * day).toISOString(), until = new Date(endOfDay).toISOString(),
    coverage, events, attempts, migrations: unverified = [], gitSubjects = [] } = input;
  if (!Array.isArray(events) || events.length > 20_000) throw new Error('invalid timeline evidence');
  const candidates = new Map([...uniqueRows(events, 'id')].map(event => [event.id, event]));
  const attested = readAttestations(input.attestations);
  const git = deriveQueueChurnGitEvidence(gitSubjects, cwd, { reviews: attested.reviews, events: candidates });
  const migrations = [...git.migrations, ...(Array.isArray(unverified) ? unverified.map(row => ({ ...row, verified: false })) : [])];
  if ((input.since === undefined) !== (input.until === undefined)) throw new Error('supply both interval endpoints');
  const from = timestamp(since), to = timestamp(until);
  if (from === null || to === null || from >= to) throw new Error('invalid UTC interval');
  const inWindow = value => {
    const time = timestamp(value);
    return time !== null && time >= from && time < to;
  };
  if (!Array.isArray(events) || !Array.isArray(attempts) || !Array.isArray(unverified) ||
      [events, attempts, migrations].some(rows => rows.length > 20_000)) throw new Error('invalid evidence arrays');
  const currentQueue = input.currentQueue === undefined ? undefined : projectQueue(input.currentQueue);
  const snapshot = currentQueue === undefined ? null : normalizeSnapshot(input.snapshot, Infinity);
  const currentQueueGaps = currentQueue === undefined ? [] : queueGaps(currentQueue);
  if (snapshot && !snapshot.queueComplete) currentQueueGaps.push('queue snapshot completeness not established');
  const partial = ['events', 'attempts', 'migrations', ...(input.currentQueue === undefined ? [] : ['currentQueue'])]
    .filter(feed => coverage?.[feed] !== true || (feed === 'migrations' && (git.missing.length > 0 || unverified.length > 0)) ||
      (feed === 'currentQueue' && currentQueueGaps.length > 0));
  const liveGaps = observedGaps.get(input);
  const missing = Object.fromEntries(partial.map(feed => {
    const dimensions = [...(liveGaps?.[feed] ?? [])];
    if (feed === 'currentQueue') dimensions.push(...currentQueueGaps);
    if (feed === 'migrations') {
      dimensions.push(...git.missing);
      if (unverified.length) dimensions.push('preclassified observations have no committed Git proof');
    }
    return [feed, dimensions.length ? dimensions : ['coverage not established']];
  }));
  const missingLinks = { entryHead: 0, entryScope: 0, authorizedIntent: 0, mergeAttempt: 0, conflictingAttestations: 0 };
  const exactEntries = new Map();
  const exactRemovals = new Map();
  for (const row of attested.entries.values()) {
    const event = candidates.get(row.eventId);
    if (event?.kind !== 'added' || event.pr !== row.pr || (event.sourceHead && event.sourceHead !== row.head)) {
      missingLinks.conflictingAttestations++;
      continue;
    }
    const scope = git.pulls.get(row.head)?.pr === row.pr ? git.pulls.get(row.head).scope : 'unknown';
    const entry = { row, event, scope };
    exactEntries.set(event.id, entry);
    if (!row.removalEventId) continue;
    const removal = candidates.get(row.removalEventId);
    if (removal?.kind !== 'removed' || removal.pr !== row.pr || secondsBetween(event.createdAt, removal.createdAt) === null) {
      missingLinks.conflictingAttestations++;
      continue;
    }
    exactRemovals.set(removal.id, entry);
  }
  const timeline = { entries: 0, removalsByReason: Object.create(null), unlinkedRemovals: 0, actors: { app: 0, human: 0, unknown: 0 }, removals: {}, missingTimestamps: 0 };
  const latency = Object.fromEntries(['migration', 'ordinary', 'unknown'].map(kind =>
    [kind, { intentToEntry: [], entryToMerge: [] }]));
  for (const event of candidates.values()) {
    if (timestamp(event.createdAt) === null) timeline.missingTimestamps++;
    if (!inWindow(event.createdAt)) continue;
    if (event.kind === 'added') {
      timeline.entries++;
      const actor = ['app', 'human'].includes(event.actor) ? event.actor : 'unknown';
      timeline.actors[actor]++;
      const exact = exactEntries.get(event.id);
      const elapsed = secondsBetween(exact?.row.intent?.authorizedAt, event.createdAt);
      if (!exact) missingLinks.entryHead++;
      if (!exact || exact.scope === 'unknown') missingLinks.entryScope++;
      if (elapsed === null) missingLinks.authorizedIntent++;
      latency[exact?.scope ?? 'unknown'].intentToEntry.push(elapsed);
    } else if (event.kind === 'removed') {
      const reason = typeof event.reason === 'string' ? event.reason.toLowerCase() : '';
      const bucket = outcomeByReason.get(reason) ?? 'unknown';
      const reportedReason = outcomeByReason.has(reason) ? reason : 'unknown';
      timeline.removalsByReason[reportedReason] = (timeline.removalsByReason[reportedReason] ?? 0) + 1;
      if (!exactRemovals.has(event.id)) timeline.unlinkedRemovals++;
      timeline.removals[bucket] = (timeline.removals[bucket] ?? 0) + 1;
    } else if (event.kind !== 'merged') {
      throw new Error('unknown queue event kind');
    }
  }
  const matchedMerges = new Map();
  for (const [removalId, entry] of exactRemovals) {
    if (!entry.row.mergeEventId) continue;
    const merge = candidates.get(entry.row.mergeEventId);
    const removal = candidates.get(removalId);
    const elapsed = secondsBetween(entry.event.createdAt, merge?.createdAt);
    if (merge?.kind !== 'merged' || merge.pr !== entry.row.pr || !mainRef(merge.mergeRef) || !sha(merge.head) ||
        removal.reason?.toLowerCase() !== 'merged' || removal.beforeCommit !== merge.head ||
        elapsed === null || secondsBetween(merge.createdAt, removal.createdAt) === null) {
      missingLinks.conflictingAttestations++;
      continue;
    }
    matchedMerges.set(merge.id, { elapsed, scope: entry.scope });
  }
  const queueMergedPrs = new Set([...candidates.values()]
    .filter(event => event.kind === 'removed' && event.reason?.toLowerCase() === 'merged').map(event => event.pr));
  for (const event of candidates.values()) {
    if (event.kind !== 'merged' || !mainRef(event.mergeRef) || !inWindow(event.createdAt)) continue;
    const match = matchedMerges.get(event.id);
    if (!match && !queueMergedPrs.has(event.pr)) continue;
    if (!match) missingLinks.mergeAttempt++;
    if (match?.scope === 'unknown') missingLinks.entryScope++;
    latency[match?.scope ?? 'unknown'].entryToMerge.push(match?.elapsed ?? null);
  }
  const mergedPrs = new Set([...candidates.values()].filter(event => event.kind === 'merged' && mainRef(event.mergeRef)).map(event => event.pr));
  for (const event of candidates.values()) {
    if (event.kind === 'removed' && event.reason?.toLowerCase() === 'merged' &&
        inWindow(event.createdAt) && !mergedPrs.has(event.pr)) {
      missingLinks.mergeAttempt++;
      latency.unknown.entryToMerge.push(null);
    }
  }
  if (Object.values(missingLinks).some(count => count > 0)) {
    partial.push('latency');
    missing.latency = Object.entries(missingLinks).filter(([, count]) => count > 0).map(([field, count]) => `${field} missing or conflicting for ${count} observations`);
  }
  const collateralGroups = new Map();
  let unlinkedCollateralRemovals = 0;
  for (const removal of candidates.values()) {
    if (removal.kind !== 'removed' || removal.reason?.toLowerCase() !== 'roll_back') continue;
    const group = sha(removal.beforeCommit);
    const source = git.groups.get(group);
    const linked = group && source?.pr === removal.pr && timestamp(removal.createdAt) !== null;
    if (group && (linked || !collateralGroups.has(group))) collateralGroups.set(group, linked ? 'verified' : 'unknown');
    if (!linked && inWindow(removal.createdAt)) unlinkedCollateralRemovals++;
  }
  const groups = { unlinkedCollateralRemovals, failedAttemptsWithoutProducer: 0, attempts: {}, runs: 0, syntheticHeads: 0, unknownSourceHeads: 0, latestReadiness: [], failures: [], missingTimestamps: 0, jobsWithoutTimings: 0, unfinishedAttempts: 0,
    jobSeconds: { failed: 0, cancelled: 0, superseded: 0, other: 0, unknown: 0 } };
  const jobIds = new Set();
  const readiness = new Map();
  const windowRunIds = new Set();
  const windowGroupHeads = new Set();
  const uniqueAttempts = [...uniqueRows(attempts, 'id')].map(projectAttempt);
  for (const attempt of uniqueAttempts) {
    const { jobs } = attempt;
    const run = /^(\d+):(\d+)$/u.exec(attempt.id);
    const groupSha = sha(attempt.groupSha);
    const source = git.groups.get(groupSha);
    const sourceHead = source && !attempt.invalidSourceHead && (!attempt.sourceHead || attempt.sourceHead === source.sourceHead) ? source.sourceHead : null;
    const collateral = collateralGroups.get(groupSha);
    const bucket = attemptBucket(attempt, collateral === 'verified' && !sourceHead ? 'unknown' : collateral);
    const prior = run && readiness.get(run[1]);
    if (run && (!prior || Number(run[2]) > prior.attempt)) {
      readiness.set(run[1], { runId: run[1], attempt: Number(run[2]), groupSha, sourceHead, outcome: bucket,
        complete: attempt.complete ?? (timestamp(attempt.completedAt) !== null), url: `https://github.com/${repository}/actions/runs/${run[1]}` });
    }
    if (timestamp(attempt.completedAt) === null) {
      groups.missingTimestamps++;
      if (attempt.complete === false) groups.unfinishedAttempts++;
    }
    if (inWindow(attempt.completedAt)) {
      if (run) windowRunIds.add(run[1]);
      if (groupSha) windowGroupHeads.add(groupSha);
      if (!sourceHead) groups.unknownSourceHeads++;
      groups.attempts[bucket] = (groups.attempts[bucket] ?? 0) + 1;
      if (bucket === 'failed') {
        const failure = firstFailedJob(jobs);
        if (!failure) groups.failedAttemptsWithoutProducer++;
        const runId = /^(\d+):\d+$/u.exec(attempt.id)?.[1];
        const jobId = failure?.id ?? null;
        groups.failures.push({ attemptId: attempt.id, groupSha: sha(attempt.groupSha),
          sourceHead, jobId, jobName: failure?.name ?? null,
          completedAt: attempt.completedAt, jobCompletedAt: failure?.completedAt ?? null,
          url: runId ? `https://github.com/${repository}/actions/runs/${runId}${
            /^\d+$/u.test(jobId ?? '') ? `/job/${jobId}` : ''}` : null });
      }
    }
    for (const job of jobs) {
      if (jobIds.has(job.id)) throw new Error('job execution belongs to multiple attempts');
      jobIds.add(job.id);
      if (job.reused === true || job.conclusion === 'skipped') continue;
      const start = timestamp(job.startedAt), finish = timestamp(job.completedAt);
      if (start === null || finish === null || finish < start) {
        groups.jobsWithoutTimings++;
      } else {
        groups.jobSeconds[bucket] += Math.max(0, Math.min(to, finish) - Math.max(from, start)) / 1000;
      }
    }
  }
  if (groups.failedAttemptsWithoutProducer || groups.unlinkedCollateralRemovals) {
    if (!partial.includes('attempts')) partial.push('attempts');
    const dimensions = missing.attempts ?? [];
    if (groups.failedAttemptsWithoutProducer) dimensions.push(`first failure evidence incomplete for ${groups.failedAttemptsWithoutProducer} attempts`);
    if (groups.unlinkedCollateralRemovals) dimensions.push(`exact group linkage unavailable for ${groups.unlinkedCollateralRemovals} collateral removals`);
    missing.attempts = dimensions;
  }
  const migrationEvidence = { beforeReview: 0, afterReview: 0, invalidProposed: 0, invalidLanded: 0, unknown: 0 };
  for (const observation of uniqueRows(migrations, 'id')) {
    if (!inWindow(observation.createdAt) || observation.historical === true) continue;
    if (observation.kind === 'rename' && observation.verified === true) {
      if (observation.reviewPhase === 'before') migrationEvidence.beforeReview++;
      else if (observation.reviewPhase === 'after') migrationEvidence.afterReview++;
      else migrationEvidence.unknown++;
    } else if (observation.kind === 'invalid' && observation.verified === true) {
      if (observation.landed === true) migrationEvidence.invalidLanded++;
      else migrationEvidence.invalidProposed++;
    } else {
      migrationEvidence.unknown++;
    }
  }
  groups.runs = windowRunIds.size;
  groups.syntheticHeads = windowGroupHeads.size;
  groups.latestReadiness = [...readiness.values()];
  groups.observedJobSeconds = Object.values(groups.jobSeconds).reduce((sum, value) => sum + value, 0);
  groups.wastedJobSeconds = groups.jobSeconds.failed + groups.jobSeconds.cancelled + groups.jobSeconds.superseded;
  const latencies = Object.fromEntries(Object.entries(latency).map(([kind, samples]) =>
    [kind, { intentToEntry: latencySummary(samples.intentToEntry), entryToMerge: latencySummary(samples.entryToMerge) }]));
  return { schemaVersion: 1, since, until, partial, missing, counts: { events: candidates.size, attempts: uniqueAttempts.length,
    migrationObservations: migrations.length }, timeline, groups, migrations: migrationEvidence, latency: latencies,
    migrationGitEvidence: git.migrations.filter(row => inWindow(row.createdAt)),
    linkage: { attestedSource: attested.sourceId, missing: missingLinks,
      matchedEntries: [...exactEntries.values()].filter(({ event, row }) =>
        inWindow(event.createdAt) || (matchedMerges.has(row.mergeEventId) && inWindow(candidates.get(row.mergeEventId)?.createdAt))).map(({ event, row, scope }) => ({
        eventId: event.id, pr: row.pr, head: row.head, scope,
        intent: secondsBetween(row.intent?.authorizedAt, event.createdAt) === null ? null : {
          id: row.intent.id, kind: row.intent.kind, authorizedAt: row.intent.authorizedAt,
        },
        mergeEventId: matchedMerges.has(row.mergeEventId) ? row.mergeEventId : null,
      })),
    },
    ...(currentQueue === undefined ? {} : { currentQueue, carryIn: projectCarryIn(input.carryIn), snapshot: snapshot ?? undefined }) };
}

export function renderQueueChurnSummary(report) {
  const attested = report.linkage.attestedSource
    ? 'Uses independently supplied offline attestations. The report checks their event and Git identities.'
    : 'Historical authorization and review attestations were unavailable.';
  const status = report.partial.length ? `Partial evidence in ${report.partial.join(', ')}.` : 'All supplied feeds are complete.';
  return [
    '## Merge queue churn',
    '',
    `UTC interval ${report.since} to ${report.until}. ${status}`,
    attested,
    '',
    ...Object.entries(report.missing).flatMap(([feed, dimensions]) => dimensions.map(dimension => `- ${feed}: ${dimension}`)),
    '',
    `- Queue entries ${report.timeline.entries}`,
    `- Conflict removals ${report.timeline.removals.conflict ?? 0}`,
    `- Check or timeout removals ${report.timeline.removals.checks ?? 0}`,
    `- Observed wasted job seconds ${report.groups.wastedJobSeconds} of ${report.groups.observedJobSeconds}`,
    `- Completed attempts with unknown source head ${report.groups.unknownSourceHeads}`,
    `- Current queue entries ${report.currentQueue?.length ?? 'unobserved'}`,
    ...Object.entries(report.latency).flatMap(([kind, sample]) => [
      ['intent to entry', sample.intentToEntry], ['entry to merge', sample.entryToMerge],
    ].map(([label, values]) => `- ${kind} ${label} seconds, median ${values.medianSeconds ?? 'unknown'}, p95 ${values.p95Seconds ?? 'unknown'} (n=${values.samples}, missing=${values.missing})`)),
    `- Missing attempt timestamps ${report.groups.missingTimestamps}, unfinished attempts ${report.groups.unfinishedAttempts}, jobs with missing or censored timing ${report.groups.jobsWithoutTimings}`,
    `- Invalid proposed migration versions ${report.migrations.invalidProposed}, invalid landed versions ${report.migrations.invalidLanded}, unknown migration observations ${report.migrations.unknown}`,
    `- Verified migration renames before review ${report.migrations.beforeReview} and after review ${report.migrations.afterReview}`,
    '',
    ...report.groups.failures.slice(0, 20).map(({ attemptId, groupSha, jobName, url }) => {
      const label = attemptId.replace(/[^\w:-]/gu, '?');
      const name = (jobName ?? 'unidentified job').replace(/[^\w ()/.-]/gu, '?');
      return `- Failed attempt ${url ? `[${label}](${url})` : label}, ${name}${groupSha ? ` (${groupSha})` : ''}`;
    }),
    '',
  ].join('\n');
}

const actions = `repos/${repository}/actions/`;
const workflow = '.github/workflows/published-tree-ci.yml';
const actorClass = actor => actor?.__typename === 'User' ? 'human'
  : actor?.__typename === 'Bot' && actor.id === 'BOT_kgDOFLVR4A' ? 'app' : 'unknown';

export async function githubRead(args, signal) {
  try {
    const result = await execute('gh', ['api', ...args], { signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (cause) {
    const transient = cause.killed === true || /HTTP (?:429|50[0234])\b/u.test(String(cause.stderr ?? ''));
    throw Object.assign(new Error('GitHub queue evidence read failed'), { transient });
  }
}

function normalizeSnapshot(value, start) {
  if (value === undefined) return null;
  const capturedAt = timestamp(value?.capturedAt);
  if (value?.schemaVersion !== 1 || value.repository !== repository || capturedAt === null || capturedAt > start ||
      !Array.isArray(value.queue) || value.queue.length > 500 || !Array.isArray(value.activeRunIds) ||
      value.activeRunIds.length > 1000 || !value.queue.every(entry => numericId(entry?.pr) && evidenceId(entry.id)) ||
      !value.activeRunIds.every(numericId) || new Set(value.activeRunIds).size !== value.activeRunIds.length) {
    throw new Error('invalid prior queue snapshot for the requested interval');
  }
  const queue = projectQueue(value.queue);
  return { schemaVersion: 1, repository, capturedAt: value.capturedAt,
    queueComplete: value.queueComplete === true && queueGaps(queue).length === 0,
    queue, activeRunIds: [...value.activeRunIds] };
}

function readList(pages, key, identity, limit, missing, label) {
  const collected = new Map();
  const count = pages?.[0]?.total_count;
  if (!Array.isArray(pages) || !Number.isSafeInteger(count) || count < 0) {
    missing.add(`${label} count unavailable`);
    if (!Array.isArray(pages)) return [];
  }
  for (const page of pages.slice(0, Math.ceil(limit / 100))) {
    if (page?.total_count !== count || !Array.isArray(page?.[key]) || page[key].length > 100) {
      missing.add(`${label} inconsistent pages`);
      continue;
    }
    if (page.incomplete_results === true) missing.add(`${label} provider marked incomplete`);
    for (const row of page[key]) {
      const id = identity(row);
      if (!numericId(id) || collected.has(id)) {
        missing.add(`${label} missing or duplicate IDs`);
        continue;
      }
      collected.set(id, row);
    }
  }
  if (count !== collected.size || pages.length > Math.ceil(limit / 100)) missing.add(`${label} exceeded bounds or omitted rows`);
  return [...collected.values()];
}

function graphRepository(response) {
  const result = response?.data?.repository;
  if (response?.errors?.length || result?.nameWithOwner !== repository || result.databaseId !== repositoryId) throw new Error('unverified GraphQL repository');
  return result;
}

export async function graphRead(read, selection) {
  return graphRepository(await read(['graphql', '-f',
    `query=query{repository(owner:"openlup",name:"openlup"){nameWithOwner databaseId ${selection}}}`]));
}

async function graphPages({ read, selection, field, limit, report, label, reverse = false, filtered = false }) {
  const rows = new Map();
  const cursors = new Set();
  let cursor = '';
  let count;
  for (let page = 0; page < limit; page++) {
    try {
      const result = await graphRead(read, selection(cursor));
      const conn = field(result);
      const info = conn?.pageInfo;
      if (!Number.isSafeInteger(conn?.totalCount) || conn.totalCount < 0 ||
          !Array.isArray(conn.nodes) || conn.nodes.length > 100 || !info ||
          (page > 0 && conn.totalCount !== count)) throw new Error('unstable GraphQL connection');
      count = conn.totalCount;
      const previous = rows.size;
      for (const row of conn.nodes) {
        if (typeof row?.id !== 'string' || rows.has(row.id)) throw new Error('nonunique GraphQL node');
        rows.set(row.id, row);
      }
      const further = reverse ? info.hasPreviousPage : info.hasNextPage;
      // GitHub timeline itemTypes filters the nodes, while totalCount still
      // describes the outer timeline. Exhaust the filtered cursors within it.
      if (further === false && (filtered ? rows.size <= count : rows.size === count)) return [...rows.values()];
      const next = reverse ? info.startCursor : info.endCursor;
      if (further !== true || typeof next !== 'string' || !next || cursors.has(next) ||
          rows.size === previous || rows.size >= count) throw new Error('incomplete GraphQL cursor evidence');
      cursors.add(next);
      cursor = `,${reverse ? 'before' : 'after'}:${JSON.stringify(next)}`;
    } catch {
      report(`${label} incomplete page ${page + 1}`);
      break;
    }
    if (page === limit - 1) report(`${label} exceeded ${limit} pages`);
  }
  return [...rows.values()];
}

async function observeCurrentQueue(read, report) {
  const rows = await graphPages({ read, report, label: 'main queue', limit: 5,
    selection: cursor => `mergeQueue(branch:"main"){entries(first:100${cursor}){totalCount
      pageInfo{hasNextPage endCursor} nodes{id position state enqueuedAt headCommit{oid} pullRequest{number}
      enqueuer{__typename ... on Bot{id}}}}}`,
    field: result => result.mergeQueue?.entries });
  const entries = [];
  for (const row of rows) {
    if (!evidenceId(row.id) || !numericId(row.pullRequest?.number) || !Number.isSafeInteger(row.position) || row.position < 0 ||
        timestamp(row.enqueuedAt) === null || !queueStates.has(row.state)) {
      report('main queue invalid entry identity');
      continue;
    }
    if (!sha(row.headCommit?.oid)) report('main queue entry head unavailable');
    entries.push({ id: row.id, pr: row.pullRequest.number, position: row.position, state: row.state,
      enqueuedAt: row.enqueuedAt, entryHead: sha(row.headCommit?.oid), actor: actorClass(row.enqueuer) });
  }
  if (new Set(entries.map(entry => entry.pr)).size !== entries.length ||
      new Set(entries.map(entry => entry.position)).size !== entries.length) report('main queue duplicate PR or position');
  return entries.sort((a, b) => a.position - b.position);
}

export async function observeTimeline(read, pr, report, { includeSignature = false } = {}) {
  const rows = await graphPages({ read, report, label: `PR #${pr} timeline`, limit: 10, reverse: true, filtered: true,
    selection: cursor => `pullRequest(number:${pr}){number baseRefName
      timelineItems(last:100${cursor},itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,MERGED_EVENT]){
      totalCount pageInfo{hasPreviousPage startCursor} nodes{__typename
        ... on AddedToMergeQueueEvent{id createdAt actor{__typename ... on Bot{id}}}
        ... on RemovedFromMergeQueueEvent{id createdAt reason beforeCommit{oid${includeSignature ? ' signature{isValid wasSignedByGitHub}' : ''}}}
        ... on MergedEvent{id createdAt mergeRefName commit{oid}}}}}`,
    field: result => result.pullRequest?.number === pr && result.pullRequest.baseRefName === 'main'
      ? result.pullRequest.timelineItems : null });
  const results = [];
  for (const row of rows) {
    if (timestamp(row.createdAt) === null) report(`PR #${pr} timeline missing timestamp`);
    const event = { id: row.id, pr, createdAt: row.createdAt };
    if (row.__typename === 'AddedToMergeQueueEvent') {
      results.push({ ...event, kind: 'added', actor: actorClass(row.actor) });
    } else if (row.__typename === 'RemovedFromMergeQueueEvent') {
      const removal = { ...event, kind: 'removed', reason: row.reason, beforeCommit: sha(row.beforeCommit?.oid) };
      if (includeSignature) {
        const signature = row.beforeCommit?.signature;
        removal.githubSigned = signature?.isValid === true && signature.wasSignedByGitHub === true;
      }
      results.push(removal);
    } else if (row.__typename === 'MergedEvent') {
      if (!sha(row.commit?.oid) || !mainRef(row.mergeRefName)) report(`PR #${pr} exact main merge commit unavailable`);
      results.push({ ...event, kind: 'merged', head: sha(row.commit?.oid), mergeRef: mainRef(row.mergeRefName) ? 'refs/heads/main' : null });
    } else {
      report(`PR #${pr} timeline unknown event`);
    }
  }
  return results;
}

function validRun(run) {
  return run?.repository?.full_name === repository && run.repository.id === repositoryId && run.workflow_id === workflowId && run.event === 'merge_group' && run.path === workflow &&
    numericId(run.id) && numericId(run.run_attempt) && run.run_attempt <= 20 && sha(run.head_sha) !== null;
}

function guardFailureEvidence(job) {
  const name = aggregateGuards.get(job.name);
  if (!name || !Array.isArray(job.steps)) return undefined;
  const guards = job.steps.filter(step => step?.name === name);
  if (guards.length !== 1) return undefined;
  if (guards[0].conclusion === 'failure') return true;
  if (guards[0].conclusion === 'success' && job.steps.every(step => step?.status === 'completed' && typeof step.conclusion === 'string') &&
      job.steps.some(step => step !== guards[0] && ['failure', 'timed_out'].includes(step.conclusion))) return false;
  return undefined;
}

async function collectAttempt(read, run, ordinal, report) {
  const path = `${actions}runs/${run.id}/attempts/${ordinal}`;
  const [attempt, pages] = await Promise.allSettled([read([path]), read(['--paginate', '--slurp', `${path}/jobs?per_page=100`])]);
  const value = attempt.status === 'fulfilled' ? attempt.value : null;
  const meta = validRun(value) && value.id === run.id && value.run_attempt === ordinal && value.head_sha === run.head_sha ? value : null;
  if (!meta) report(`run ${run.id} attempt ${ordinal} metadata identity unavailable`);
  const jobs = pages.status === 'fulfilled'
    ? readList(pages.value, 'jobs', job => job?.id, 1000, { add: report }, `run ${run.id} attempt ${ordinal} jobs`) : [];
  const exactJobs = jobs.filter(job => job.run_id === run.id && job.run_attempt === ordinal && job.head_sha === run.head_sha);
  if (pages.status !== 'fulfilled') report(`run ${run.id} attempt ${ordinal} jobs unavailable`);
  else if (exactJobs.length !== jobs.length) report(`run ${run.id} attempt ${ordinal} job identity mismatch`);
  return { id: `${run.id}:${ordinal}`, groupSha: run.head_sha, conclusion: meta?.conclusion ?? null,
    sourceHead: null, complete: meta ? meta.status === 'completed' : null,
    completedAt: meta?.status === 'completed' ? meta.updated_at : null,
    jobs: exactJobs.map(job => ({
      id: String(job.id), name: typeof job.name === 'string' ? job.name.slice(0, 96).replace(/[^\w ()/.-]/gu, '?') : 'unknown', conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
      dependencyGuardFailed: guardFailureEvidence(job),
    })) };
}

async function observeInBatches(inputs, size, observe) {
  const results = [];
  for (let start = 0; start < inputs.length; start += size) {
    results.push(...await Promise.all(inputs.slice(start, start + size).map(observe)));
  }
  return results;
}

/** Read one advisory sample. A prior snapshot seeds discovery; Git/receipt evidence is a separate offline input. */
export async function collectQueueChurn({ since, until, priorSnapshot, gitSubjects = [], attestations, now = Date.now() }, read = githubRead) {
  if (since === undefined && until === undefined) {
    const endOfDay = Math.floor(now / day) * day;
    since = new Date(endOfDay - 7 * day).toISOString();
    until = new Date(endOfDay).toISOString();
  }
  const start = timestamp(since), finish = timestamp(until);
  if (start === null || finish === null || finish <= start || finish - start > 14 * day) {
    throw new Error('GitHub collection requires a UTC interval of at most 14 days');
  }
  const prior = normalizeSnapshot(priorSnapshot, start);
  if (!Array.isArray(gitSubjects) || gitSubjects.length > 100) throw new Error('Git evidence needs at most 100 exact subjects');
  const attested = readAttestations(attestations);
  const requestedPrs = [...gitSubjects.map(subject => subject?.pr),
    ...attested.reviews.keys(), ...[...attested.entries.values()].map(entry => entry.pr)].filter(numericId);
  const signal = AbortSignal.timeout(300_000);
  const readBounded = async args => {
    signal.throwIfAborted();
    try { return await read(args, signal); }
    catch (error) {
      if (error?.transient !== true) throw error;
      signal.throwIfAborted();
      return read(args, signal);
    }
  };
  const gaps = { events: new Set(), attempts: new Set(), currentQueue: new Set(),
    migrations: new Set(['exact Git lineage and receipt evidence unavailable in the API collection']) };
  const eventGap = message => gaps.events.add(message);
  const attemptGap = message => gaps.attempts.add(message);
  const queue = observeCurrentQueue(readBounded, message => gaps.currentQueue.add(message));
  const [prPages, runPages, currentQueue] = await Promise.all([
    readBounded(['--paginate', '--slurp', '--method', 'GET', 'search/issues',
      '-f', `q=repo:${repository} is:pr base:main updated:>=${since}`, '-f', 'per_page=100']).catch(() => {
      eventGap('PR discovery unavailable');
      return [];
    }),
    readBounded(['--paginate', '--slurp', '--method', 'GET', `${actions}workflows/published-tree-ci.yml/runs`,
      '-f', 'event=merge_group', '-f', `created=${new Date(start - day).toISOString()}..${until}`, '-f', 'per_page=100']).catch(() => {
      attemptGap('merge-group run discovery unavailable');
      return [];
    }),
    queue,
  ]);
  const discovered = readList(runPages, 'workflow_runs', run => run?.id, 1000, gaps.attempts, 'merge-group run discovery');
  const runs = new Map();
  for (const run of discovered) {
    if (validRun(run)) runs.set(run.id, run);
    else attemptGap('unverified workflow run identity');
  }
  const priorRuns = (prior?.activeRunIds ?? []).filter(id => !runs.has(id));
  for (const run of await observeInBatches(priorRuns, 8, async id => {
    try {
      const run = await readBounded([`${actions}runs/${id}`]);
      if (run.id === id && validRun(run)) return run;
    } catch { /* Keep other observed runs. */ }
    attemptGap(`prior active run ${id} unavailable`);
    return null;
  })) if (run) runs.set(run.id, run);
  const prRows = readList(prPages, 'items', pr => pr?.number, 1000, gaps.events, 'PR discovery').filter(pr => {
    if (pr.repository_url === `https://api.github.com/repos/${repository}`) return true;
    eventGap('unverified discovery PR repository');
    return false;
  });
  const prs = [...new Set([
    ...requestedPrs, ...(prior?.queue ?? []).map(entry => entry.pr), ...currentQueue.map(entry => entry.pr),
    ...prRows.map(pr => pr.number),
    ...[...runs.values()].map(run => /^gh-readonly-queue\/main\/pr-(\d+)-[a-f0-9]+$/u.exec(run.head_branch)?.[1])
      .filter(Boolean).map(Number).filter(numericId),
  ])];
  if (prs.length > 1000) eventGap('PR timeline population exceeds 1000');
  if (runs.size > 1000) attemptGap('combined merge-group run population exceeds 1000');
  const selectedRuns = [...runs.values()].slice(0, 1000);
  const tasks = selectedRuns.flatMap(run => Array.from({ length: run.run_attempt }, (_, index) => [run, index + 1]));
  const [timeline, attempts] = await Promise.all([
    observeInBatches(prs.slice(0, 1000), 8, pr => observeTimeline(readBounded, pr, eventGap)),
    observeInBatches(tasks, 4, ([run, ordinal]) => collectAttempt(readBounded, run, ordinal, attemptGap)),
  ]);
  if (!prior || prior.queueComplete !== true || timestamp(prior.capturedAt) !== start) {
    eventGap(`carry-in queue population at ${since} is unproven`);
  }
  const byId = new Map();
  for (const event of timeline.flat()) {
    if (byId.has(event.id)) {
      byId.set(event.id, null);
      eventGap('duplicate timeline event across PRs');
    } else byId.set(event.id, event);
  }
  const events = [...byId.values()].filter(Boolean);
  const queueIds = new Set(currentQueue.map(entry => entry.id));
  const carryIn = prior ? {
    activeQueueEntries: prior.queue.filter(entry => queueIds.has(entry.id)).length,
    queueEntriesNoLongerObserved: prior.queue.filter(entry => !queueIds.has(entry.id)).length,
    reconciledRuns: prior.activeRunIds.filter(id => runs.has(id)).length,
    unknownRuns: prior.activeRunIds.filter(id => !runs.has(id)).length,
  } : null;
  // Run creation is a discovery hint: an already completed older run may be rerun after the snapshot.
  attemptGap(`reruns created before ${new Date(start - day).toISOString()} outside the prior active list are unproven`);
  const snapshot = { schemaVersion: 1, repository, capturedAt: new Date(now).toISOString(),
    queueComplete: gaps.currentQueue.size === 0, queue: currentQueue,
    activeRunIds: selectedRuns.filter(run => run.status !== 'completed').map(run => run.id) };
  const missing = Object.fromEntries(Object.entries(gaps).map(([key, value]) => [key, [...value].sort()]));
  const result = { since, until, coverage: Object.fromEntries(Object.entries(gaps).map(([key, value]) => [key, value.size === 0])),
    missing, events, attempts, gitSubjects, attestations, currentQueue, carryIn, snapshot };
  observedGaps.set(result, structuredClone(missing));
  return result;
}
const stdinLimit = 8 * 1024 * 1024;
const usage = 'usage: node scripts/merge-queue-churn.mjs --offline [json|markdown] < evidence.json or --github [<since> <until>] [json|markdown] [--stdin < envelope.json]';
const offlineFields = ['schemaVersion', 'since', 'until', 'coverage', 'missing', 'events', 'attempts', 'migrations',
  'gitSubjects', 'attestations', 'currentQueue', 'carryIn', 'snapshot'];
const enrichmentFields = ['priorSnapshot', 'subjects', 'attestations'];

async function readStdinEvidence() {
  if (process.stdin.isTTY) throw new Error('supply JSON evidence on stdin');
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > stdinLimit) throw new Error('stdin evidence exceeds 8 MiB');
    chunks.push(chunk);
  }
  if (!length) throw new Error('stdin evidence is empty');
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    const parsed = parseStrictJson(json, 'stdin');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected object');
    return parsed;
  } catch {
    throw new Error('stdin evidence must be a UTF-8 JSON object with unique keys');
  }
}

async function runCli(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true,
    options: { github: { type: 'boolean' }, offline: { type: 'boolean' }, stdin: { type: 'boolean' } } });
  const github = values.github === true;
  if (github === (values.offline === true) || (!github && values.stdin)) throw new Error(usage);
  const endpointCount = github && positionals.length > 1 ? 2 : 0;
  const [since, until] = endpointCount ? positionals : [];
  const format = positionals[endpointCount] ?? 'json';
  if (positionals.length > endpointCount + 1 || !['json', 'markdown'].includes(format)) throw new Error(usage);
  const input = !github || values.stdin ? await readStdinEvidence() : {};
  const allowed = github ? enrichmentFields : offlineFields;
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('stdin evidence contains unknown fields');
  if (github && input.subjects !== undefined && !Array.isArray(input.subjects)) throw new Error('stdin subjects must be an array');
  if (!github && input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error('stdin evidence has an unsupported schema version');
  const evidence = github ? await collectQueueChurn({ since, until, priorSnapshot: input.priorSnapshot,
    gitSubjects: input.subjects, attestations: input.attestations }) : input;
  const report = buildQueueChurnReport(evidence);
  process.stdout.write(format === 'json' ? JSON.stringify(report, null, 2) + '\n' : renderQueueChurnSummary(report));
  return report.partial.length ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
