// Trusted, read-only queue observation. The adapter supplies immutable GitHub
// identities, pagination links/cursors, and exact Git objects.
import { isDeepStrictEqual } from 'node:util';
import { demand } from './agent-review-decide.mjs';
import { isMigrationQueueSerializedPath, readLatestSourceJobs, waitNativeAdmission } from './agent-review-queue.mjs';
import { assertMergePreflight, git } from './agent-review-session.mjs';
import { parseMigrationGrant, requiresMigrationGrant, verifyFinalizedMigrationHead } from './migration-finalize.mjs';

const REPOSITORY = 'openlup/openlup';
const REPOSITORY_ID = 1376035358;
const BASE_REF = 'refs/heads/main';
const SHA = /^[a-f0-9]{40}$/u;
const GRANT = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CAPACITY = 4;
const QUEUE_STATES = new Set(['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'LOCKED', 'UNMERGEABLE']);
const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ROLES = new Set(['write', 'maintain', 'admin']);
const id = value => Number.isSafeInteger(value) && value > 0;
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function parseQueueCommand(body) {
  if (typeof body !== 'string') return null;
  const match = /^\/openlup-queue (request|cancel|reserve) ([a-f0-9]{40})(?: ([a-f0-9-]+))?\n?(?![\s\S])/u.exec(body);
  if (!match) return null;
  const [, verb, head, grantId] = match;
  if (grantId && (verb !== 'request' || !GRANT.test(grantId))) return null;
  return { verb, head, grantId };
}

// The adapter preserves terminal Link/cursor evidence and any provider count.
// An adapter must not synthesize an empty last page after a failed read.
async function readPages(read, endpoint, args, limit, key) {
  let cursor = null;
  let count;
  const seen = new Set();
  const cursors = new Set();
  const items = [];
  for (let page = 0; page < limit; page += 1) {
    const response = await read(endpoint, ...args, cursor);
    demand(response && Array.isArray(response.items) && response.items.length <= 100 &&
      (response.next === null || (typeof response.next === 'string' && response.next.length > 0)),
    'incomplete page');
    if (page === 0) count = response.count;
    demand(response.count === count && (count === undefined || (Number.isSafeInteger(count) && count >= 0)), 'inconsistent page count');
    for (const item of response.items) {
      const identity = key(item);
      demand(identity !== undefined && identity !== null && !seen.has(identity), 'missing or duplicate page identity');
      seen.add(identity);
      items.push(item);
    }
    demand(count === undefined || items.length <= count, 'page count exceeded');
    if (response.next === null) {
      demand(count === undefined || items.length === count, 'incomplete page count');
      return items;
    }
    demand(response.items.length > 0 && !cursors.has(response.next), 'pagination did not advance');
    cursors.add(response.next);
    cursor = response.next;
  }
  throw new Error('pagination bound exceeded');
}

function boundedReader(adapter, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  return async (method, ...args) => {
    for (let attempt = 0; ; attempt += 1) {
      const remaining = Math.ceil(deadline - performance.now());
      demand(remaining > 0, 'observation deadline expired');
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => adapter[method](...args, signal)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('observation deadline expired')), remaining); }),
        ]);
      } catch (error) {
        if (attempt > 0 || error?.transient !== true) throw error;
      } finally { clearTimeout(timer); }
    }
  };
}

const commandOrder = (a, b) => a.at - b.at || a.id - b.id;

async function observeIntent(read, pr, now) {
  const comments = await readPages(read, 'comments', [pr], 10, row => row?.id);
  const timeline = await readPages(read, 'timeline', [pr], 10, row => row?.id);
  const authority = new Map();
  const history = [];
  if (pr.commandHistoryComplete !== true) return { uncertain: true, timeline };
  for (const action of timeline) {
    if (!['command_edited', 'command_deleted', 'command_minimized'].includes(action.type)) continue;
    demand(SHA.test(action.head) && id(action.commentId) && Number.isFinite(instant(action.at)), 'unknown command moderation');
    if (action.head === pr.head && action.reconciled !== true) {
      history.push({ id: action.commentId, at: instant(action.at), uncertain: true });
    }
  }
  for (const comment of comments) {
    const command = parseQueueCommand(comment?.body);
    if (command?.head !== pr.head || comment.author?.type !== 'User' || !ASSOCIATIONS.has(comment.association)) continue;
    const actor = comment.author;
    const at = instant(comment.createdAt);
    demand(id(comment.id) && id(actor.id) && typeof actor.login === 'string' && actor.login.length > 0 &&
      comment.repositoryId === REPOSITORY_ID && comment.pr === pr.number && Number.isFinite(at) && at <= now, 'unverified command identity');
    const updatedAt = instant(comment.updatedAt);
    const unedited = comment.edited === false && comment.minimized === false && updatedAt === at;
    if (!unedited) {
      history.push({ at: Math.max(at, Number.isFinite(updatedAt) ? updatedAt : at), id: comment.id, uncertain: true });
      continue;
    }
    if (!authority.has(actor.id)) authority.set(actor.id, await read('permission', actor));
    const access = authority.get(actor.id);
    history.push({ ...command, at, id: comment.id, actorId: actor.id, uncertain: access?.userId !== actor.id || !ROLES.has(access.permission) });
  }
  let intent;
  let reservation;
  let uncertain = false;
  for (const command of history.sort(commandOrder)) {
    if (command.uncertain) {
      intent = undefined;
      reservation = undefined;
      uncertain = true;
    } else if (command.verb === 'reserve') {
      intent = undefined;
      reservation = command;
    } else if (command.verb === 'cancel') {
      intent = undefined;
      reservation = undefined;
      uncertain = false;
    } else {
      reservation = undefined;
      if (intent?.grantId !== command.grantId || !intent) intent = command;
      uncertain = false;
    }
  }
  return { intent, reservation, uncertain, timeline };
}

async function observePaths(read, subject) {
  const rows = await readPages(read, 'files', [subject], 30, row => row?.filename);
  demand(rows.every(row => row.head === subject.head && typeof row.filename === 'string' && row.filename.length > 0 &&
    (!('previousFilename' in row) || (typeof row.previousFilename === 'string' && row.previousFilename.length > 0)) &&
    (row.status !== 'renamed' || typeof row.previousFilename === 'string')), 'invalid exact-head paths');
  return [...new Set(rows.flatMap(row => [row.filename, row.previousFilename].filter(Boolean)))].sort();
}

function grantOccupancy(record, now, appId) {
  demand(record?.appId === appId && typeof record.envelope === 'string' &&
    ['active', 'expired', 'revoked', 'unknown'].includes(record.state) &&
    ['released', 'live', 'unknown', 'none'].includes(record.occupancy), 'invalid grant provenance or occupancy');
  const grant = parseMigrationGrant(record.envelope);
  demand(grant.grantId === record.grantId && grant.repositoryId === REPOSITORY_ID && grant.baseRef === BASE_REF,
    'grant identity does not match the state record');
  const issued = instant(grant.issuedAt); const expires = instant(grant.expiresAt);
  demand(issued <= now, 'grant issue time is in the future');
  const active = record.state === 'active' && expires > now && record.occupancy !== 'released';
  return { grant, active: active && record.occupancy === 'none', occupied: active || ['live', 'unknown'].includes(record.occupancy) };
}

function validSourceRun(run, main) {
  return run?.repository?.id === REPOSITORY_ID && id(run.id) && run.workflow_id === main.workflowId && id(run.run_attempt) &&
    run.event === 'pull_request' && run.path === '.github/workflows/published-tree-ci.yml' && SHA.test(run.head_sha) &&
    id(run.head_repository?.id) && typeof run.head_branch === 'string' && run.head_branch.length > 0 &&
    typeof run.status === 'string';
}

async function observeCandidate(read, pr, main, reservations, now) {
  const row = { pr: pr.number, head: pr.head };
  const hold = (reason, extra) => ({ row: { ...row, reason, ...extra } });
  try {
    const { intent, reservation, uncertain, timeline } = await observeIntent(read, pr, now);
    if (uncertain) return hold('evidence_unknown');
    demand(timeline.every(action => typeof action?.type === 'string' &&
      (!action.type.startsWith('queue_') || SHA.test(action.head))), 'ambiguous queue history');
    const attempts = timeline.filter(action => action.head === pr.head && action.type.startsWith('queue_'));
    if (attempts.length > 0) {
      const kinds = [...new Set(attempts.map(action => action.type))].sort();
      if (kinds.some(kind => !['queue_added', 'queue_failed', 'queue_manual_removal', 'queue_collateral_rebuild'].includes(kind))) return hold('evidence_unknown');
      return hold('operator_diagnosis', { history: kinds });
    }
    if (!intent) return hold(reservation ? 'reserve_requested' : 'request_required',
      reservation ? { commandId: reservation.id } : undefined);
    if (pr.draft) return hold('draft');
    const paths = await observePaths(read, pr);
    const runs = await readPages(read, 'sourceRuns', [pr], 10, run => run?.id);
    demand(runs.every(run => validSourceRun(run, main)), 'invalid source run evidence');
    const matching = runs.filter(run => run.head_sha === pr.head && run.head_repository.id === pr.sourceRepositoryId && run.head_branch === pr.sourceBranch);
    const source = matching.reduce((latest, run) => !latest || run.id > latest.id ? run : latest, null);
    if (!source || source.status !== 'completed' || !['success', 'failure'].includes(source.conclusion)) return hold('waiting_for_ci');
    const jobs = await readPages(read, 'sourceJobs', [source], 10, job => job?.id);
    const checks = readLatestSourceJobs(source, jobs);
    const failed = checks.filter(job => job.status === 'completed' && !['success', null, undefined].includes(job.conclusion));
    if (failed.length > 0) return hold('operator_diagnosis', { checks: failed.map(job => job.name) });
    if (checks.some(job => job.status !== 'completed' || job.conclusion !== 'success')) return hold('waiting_for_ci');
    const { review, integration } = await read('review', pr, main, now);
    if (review?.status === 'missing') return hold('needs_review');
    demand(review?.status === 'verified' && review.head === pr.head && review.main === main.sha &&
      typeof review.receiptId === 'string' && review.receiptId.length > 0, 'review identity is unknown');
    if (integration?.status === 'conflict') return hold('needs_landing');
    demand(integration?.status === 'clean' && integration.head === pr.head && integration.main === main.sha &&
      SHA.test(integration.tree), 'integration is unknown');
    const migration = paths.some(isMigrationQueueSerializedPath);
    let reservationId;
    if (migration) {
      const reserved = reservations.find(({ grant, active }) => active && grant.grantId === intent.grantId &&
        grant.prNumber === pr.number && grant.prNodeId === pr.nodeId)?.grant;
      const finalization = await read('finalization', pr, main, reserved, now);
      demand(finalization?.head === pr.head && finalization.main === main.sha &&
        typeof finalization.requiresGrant === 'boolean', 'migration finalization scope is unknown');
      if (finalization.requiresGrant || intent.grantId) {
        if (!reserved || finalization.status !== 'verified' || finalization.grantId !== intent.grantId ||
          finalization.orderingDigest !== reserved.orderingDigest ||
          !isDeepStrictEqual(finalization.moves, reserved.moves)) return hold('migration_reserved');
        reservationId = reserved.grantId;
      }
    } else if (intent.grantId) return hold('evidence_unknown');
    return {
      row: { ...row, status: 'proposal', commandId: intent.id, commandActorId: intent.actorId,
        runId: source.id, runAttempt: source.run_attempt, jobs: checks.map(({ id, name, attempt }) => ({ id, name, attempt })), receiptId: review.receiptId,
        tree: integration.tree, ...(reservationId ? { grantId: reservationId } : {}) },
      paths, migration, requestedAt: intent.at,
    };
  } catch {
    return hold('evidence_unknown');
  }
}

// A complete observation is required before making any selection. Proposed
// heads occupy the same paths and lane as entries during this calculation.
export function planQueueAdmission({ eligible, occupied: current, held: blocked, positions }) {
  const occupied = [...current];
  const held = [...blocked];
  const proposed = [];
  for (const { row, paths, migration } of eligible.toSorted((a, b) => a.requestedAt - b.requestedAt || a.row.pr - b.row.pr)) {
    const overlaps = occupied.filter(peer => peer.paths.some(path => paths.includes(path)));
    const lane = migration ? occupied.filter(peer => peer.lane && !(peer.grantId && peer.grantId === row.grantId)) : [];
    const blockers = [...overlaps, ...lane];
    const reason = overlaps.length ? 'overlapping_paths' : lane.length ? 'migration_reserved' : positions >= CAPACITY ? 'capacity' : null;
    if (reason) {
      held.push({ pr: row.pr, head: row.head, reason, blockingPrs: [...new Set(blockers.map(peer => peer.pr))].sort((a, b) => a - b) });
    } else {
      positions += 1;
      occupied.push({ pr: row.pr, paths, lane: migration });
      proposed.push(row);
    }
  }
  held.sort((a, b) => a.pr - b.pr);
  return { proposed, held };
}

// All reads are injected. A wake has no role in selection, so missed, duplicate
// and coalesced wakes can reuse the same complete observation.
async function observeSweep(read, now, appId) {
  const main = await read('main');
  demand(main?.repositoryId === REPOSITORY_ID && main.repository === REPOSITORY &&
    main.ref === BASE_REF && SHA.test(main.sha) && id(main.workflowId), 'unknown repository or base');
  const entries = await readPages(read, 'queue', [main], 5, entry => entry?.id);
  const grants = await readPages(read, 'grants', [main], 5, grant => grant?.grantId);
  const reservations = grants.map(grant => grantOccupancy(grant, now, appId));
  const prs = await readPages(read, 'pulls', [main], 10, pr => pr?.number);
  demand(prs.every(pr => id(pr.number) && typeof pr.nodeId === 'string' && pr.nodeId.length > 0 &&
    SHA.test(pr.head) && pr.repositoryId === REPOSITORY_ID && pr.baseRef === BASE_REF && pr.state === 'open' &&
    id(pr.sourceRepositoryId) && typeof pr.sourceBranch === 'string' && pr.sourceBranch.length > 0 &&
    typeof pr.armed === 'boolean' && typeof pr.draft === 'boolean'), 'incomplete main PR list');
  demand(entries.every(entry => typeof entry.id === 'string' && entry.id.length > 0 && id(entry.position) &&
    id(entry.pr) && SHA.test(entry.head) && QUEUE_STATES.has(entry.state)) &&
    new Set(entries.map(entry => entry.position)).size === entries.length &&
    new Set(entries.map(entry => entry.pr)).size === entries.length, 'unknown queue occupancy');
  const occupied = [];
  const held = [];
  const eligible = [];
  for (const entry of entries) {
    const paths = await observePaths(read, { number: entry.pr, head: entry.head });
    occupied.push({ pr: entry.pr, paths, lane: paths.some(isMigrationQueueSerializedPath) });
  }
  for (const { grant, occupied: holdsLane } of reservations) {
    if (holdsLane) occupied.push({ pr: grant.prNumber, paths: [], lane: true, grantId: grant.grantId });
  }
  for (const pr of prs) {
    const entry = entries.find(item => item.pr === pr.number);
    if (entry) {
      held.push({ pr: pr.number, head: pr.head, reason: entry.head === pr.head ? 'already_queued' : 'evidence_unknown', entryId: entry.id });
    } else if (pr.armed) {
      const paths = await observePaths(read, pr);
      occupied.push({ pr: pr.number, paths, lane: paths.some(isMigrationQueueSerializedPath) });
      held.push({ pr: pr.number, head: pr.head, reason: 'already_armed' });
    } else {
      const result = await observeCandidate(read, pr, main, reservations, now);
      if (result.row.status === 'proposal') eligible.push(result);
      else held.push(result.row);
    }
  }
  const positions = entries.length + prs.filter(pr => pr.armed && !entries.some(entry => entry.pr === pr.number)).length;
  const decision = planQueueAdmission({ eligible, occupied, held, positions });
  const occupancy = {
    entries: entries.toSorted((a, b) => a.position - b.position),
    grants: grants.toSorted((a, b) => a.grantId.localeCompare(b.grantId, 'en')),
    eligible: eligible.toSorted((a, b) => a.row.pr - b.row.pr),
    inputs: occupied.toSorted((a, b) => a.pr - b.pr || (a.grantId ?? '').localeCompare(b.grantId ?? '', 'en')),
  };
  return { main: main.sha, workflowId: main.workflowId, ...decision, occupancy };
}

export async function observeQueueAdmission({ adapter, observedAt, appId, timeoutMs = 300_000 }) {
  demand(Number.isFinite(observedAt) && id(appId) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000, 'invalid observation inputs');
  const read = boundedReader(adapter, timeoutMs);
  let initial;
  try {
    initial = await observeSweep(read, observedAt, appId);
    const current = await observeSweep(read, observedAt, appId);
    demand(isDeepStrictEqual(initial, current), 'observations changed before reconciliation');
    const live = await read('main');
    demand(live?.repositoryId === REPOSITORY_ID && live.repository === REPOSITORY &&
      live.ref === BASE_REF && live.sha === current.main && live.workflowId === current.workflowId,
    'main changed during reconciliation');
    const { main, proposed, held } = current;
    return { status: 'observed', main, proposed, held };
  } catch {
    return { status: 'held', main: initial?.main ?? null, proposed: [], held: [], reason: 'evidence_unknown' };
  }
}

// This local Git adapter reuses the source/group review and merge prediction
// owners. Git objects are supplied by the caller, and no refs are changed.
export async function verifyQueueReview({ api, cwd, pr, main, observedAt, readComments, runGit = git }) {
  demand(typeof readComments === 'function', 'review requires a complete bounded comment reader');
  let candidate;
  let receiptId;
  try {
    await waitNativeAdmission({
      api, cwd, runGit, now: () => observedAt, committedObjectsOnly: true, readComments, expectedMain: main.sha,
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: REPOSITORY },
      event: { repository: { id: REPOSITORY_ID, private: false }, number: pr.number, pull_request: { head: { sha: pr.head } } },
      sleep: () => { throw new Error('no verified exact-head receipt'); },
      onCandidate: (value, commentId) => { candidate = value; receiptId = commentId; },
    });
  } catch (error) {
    if (error.message.startsWith('needs_agent_review: no receipt comment yet') || error.message === 'no verified exact-head receipt') {
      return { review: { status: 'missing' } };
    }
    throw error;
  }
  demand(id(receiptId), 'receipt comment identity is invalid');
  const review = { status: 'verified', head: pr.head, main: main.sha, receiptId: String(receiptId) };
  let tree;
  try {
    await assertMergePreflight(cwd, candidate, {
      env: {},
      runGit: async (root, ...args) => {
        if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return main.sha;
        const output = await runGit(root, ...args);
        if (args[0] === 'merge-tree' && args[2] === main.sha) tree = output.trim();
        return output;
      },
    });
  } catch (error) {
    if (!error.message.startsWith('merge_preflight: candidate conflicts')) throw error;
    return { review, integration: { status: 'conflict', head: pr.head, main: main.sha } };
  }
  return { review, integration: { status: 'clean', head: pr.head, main: main.sha, tree } };
}

// Provider functions are read-only. A local observer binds the production
// review implementation to the same bounded, structured comment history.
export function createLocalQueueReadAdapter({ reads, cwd, runGit = git }) {
  const endpoints = ['main', 'queue', 'grants', 'pulls', 'comments', 'timeline', 'permission', 'files', 'sourceRuns', 'sourceJobs'];
  const adapter = Object.fromEntries(endpoints.map(method => [method, reads[method].bind(reads)]));
  return {
    ...adapter,
    finalization: async (pr, main, grant, observedAt, signal) => {
      const requiresGrant = requiresMigrationGrant(cwd, main.sha, pr.head);
      const scope = { head: pr.head, main: main.sha, requiresGrant };
      if (!grant) return scope;
      const evidence = await reads.finalizationRecord(pr, grant.grantId, signal);
      if (evidence?.grantId !== grant.grantId || evidence.head !== pr.head || !SHA.test(evidence.base) ||
          typeof evidence.measuredInventorySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.measuredInventorySha256)) return scope;
      const proof = await verifyFinalizedMigrationHead(cwd, {
        grant, base: evidence.base, head: pr.head, liveMain: main.sha,
        measuredInventorySha256: evidence.measuredInventorySha256, now: () => observedAt,
      });
      return { ...proof, ...scope, status: 'verified' };
    },
    review: (pr, main, observedAt, signal) => verifyQueueReview({
      cwd, pr, main, observedAt, runGit,
      api: { get: path => reads.reviewResource(path, signal) },
      readComments: async () => {
        const read = (method, ...args) => adapter[method](...args, signal);
        const comments = await readPages(read, 'comments', [pr], 10, comment => comment?.id);
        return comments.map(comment => ({
          id: comment.id, body: comment.body, user: comment.author,
          author_association: comment.association, created_at: comment.createdAt, updated_at: comment.updatedAt,
        }));
      },
    }),
  };
}
