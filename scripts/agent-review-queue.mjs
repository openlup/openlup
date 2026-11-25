// Run trusted main's copy; candidate commits are read as objects, never executed.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { admit, demand, RECEIPT_MARKER, ECONOMY_RECEIPT_MARKER, COMPRESSED_RECEIPT_MARKER, RECEIPT_DETAILS_HEADER } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, carryOverSourceReview, git, validateEconomySession } from './agent-review-session.mjs';
import { RECEIPT_MARKER_PREFIX } from './ci-receipt-rerun.mjs';
import { assertCoLocatedForwardApproval, hasExactManagedForward, isNativeStoreMigrationPath, REVIEWED_FORWARD_PATH } from './reviewed-platform-forward.ts';
import { isChannelIngestMigrationPath, isQualifiedPlatformMigrationPath } from './platform-migration-manifest.ts';
import { REQUIRED_CONTEXTS } from './packages/release-gate.ts';

export { carryOverSourceReview } from './agent-review-session.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
const RECEIPT_LIMIT = 1024 * 1024;
const MIGRATION_QUEUE_EXACT_PATHS = new Set([
  'config/platform-migration-manifest.json',
  REVIEWED_FORWARD_PATH,
  'tests/postgres/current-installation-inventory.json',
]);
const KNOWN_MERGE_QUEUE_STATES = new Set(['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'LOCKED', 'UNMERGEABLE']);
const MERGE_QUEUE_SCAN_LIMIT = 20;
const PR_FILES_MAX_PAGES = 30;
/**
 * Paths that serialize migration PRs through the merge queue so concurrent
 * migration candidates do not burn their single-shot queue attempt on conflict eviction.
 * @param {string} path
 */
export function isMigrationQueueSerializedPath(path) {
  return typeof path === 'string' && (
    MIGRATION_QUEUE_EXACT_PATHS.has(path)
    || path.startsWith('db/platform/migrations/')
    || path.startsWith('supabase/migrations/')
    || path.startsWith('packages/platform/sql/')
  );
}
export async function readPullRequestChangedPaths(api, root, prNumber) {
  const paths = [];
  for (let page = 1; page <= PR_FILES_MAX_PAGES; page += 1) {
    const batch = await api.get(`${root}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    demand(Array.isArray(batch) && batch.length <= 100
      && batch.every(entry => typeof entry?.filename === 'string' && entry.filename.length > 0
        && (entry.previous_filename === undefined || (typeof entry.previous_filename === 'string' && entry.previous_filename.length > 0))
        && (entry.status !== 'renamed' || typeof entry.previous_filename === 'string')),
      'queued PR files response is invalid');
    for (const entry of batch) {
      paths.push(entry.filename);
      if (entry.previous_filename !== undefined) paths.push(entry.previous_filename);
    }
    if (batch.length < 100) return paths;
  }
  throw new Error('queued PR files listing exceeded the bounded pagination limit');
}
export async function findBlockingMigrationQueuePrs({ api, root, owner, name, prNumber }) {
  const queueQuery = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { mergeQueue(branch:"main") { entries(first:${MERGE_QUEUE_SCAN_LIMIT}) { pageInfo { hasNextPage } nodes { state pullRequest { number } } } } } }`;
  const response = await api.get(`/graphql?query=${encodeURIComponent(queueQuery)}`);
  const entries = response?.data?.repository?.mergeQueue?.entries;
  demand(!response?.errors && Array.isArray(entries?.nodes) && typeof entries?.pageInfo?.hasNextPage === 'boolean',
    'merge queue inspection response is invalid');
  demand(!entries.pageInfo.hasNextPage,
    'merge queue exceeds the bounded serialization scan limit; wait and re-run Queue Handoff');
  const activePeers = [];
  const seen = new Set();
  for (const node of entries.nodes) {
    const peerNumber = node?.pullRequest?.number;
    demand(typeof node?.state === 'string' && KNOWN_MERGE_QUEUE_STATES.has(node.state)
      && Number.isSafeInteger(peerNumber) && peerNumber > 0,
      'merge queue entry identity or state is invalid');
    if (node.state === 'UNMERGEABLE' || peerNumber === prNumber || seen.has(peerNumber)) continue;
    seen.add(peerNumber);
    activePeers.push(peerNumber);
  }
  const blockingPrs = [];
  for (const peerNumber of activePeers) {
    const peerPaths = await readPullRequestChangedPaths(api, root, peerNumber);
    if (peerPaths.some(isMigrationQueueSerializedPath)) blockingPrs.push(peerNumber);
  }
  return blockingPrs;
}
/**
 * The queue applies the co-located forward guard only when a PR changes the registry or a reviewed-class migration.
 * @param {readonly string[]} changedPaths
 * @param {(path: string) => boolean} hasUpstreamManagedApproval
 */
export function needsForwardApproval(changedPaths, hasUpstreamManagedApproval = () => false) {
  return changedPaths.includes(REVIEWED_FORWARD_PATH) || changedPaths.some(path => isQualifiedPlatformMigrationPath(path) || isChannelIngestMigrationPath(path) || isNativeStoreMigrationPath(path) || hasUpstreamManagedApproval(path));
}
function decodeGzipText(encoded) {
  const payload = Buffer.from(encoded, 'base64');
  if (payload.toString('base64') !== encoded) throw new Error('base64 is not canonical');
  if (payload[3] !== 0) throw new Error('gzip header is missing or has unsupported flags');
  const options = { maxOutputLength: RECEIPT_LIMIT };
  const buffer = gunzipSync(payload, options);
  // gunzip can ignore trailing bytes or join members. The first deflate stream must end at the final trailer.
  const deflate = payload.subarray(10, -8);
  if (inflateRawSync(deflate, { ...options, info: true }).engine.bytesWritten !== deflate.length) throw new Error('gzip stream has trailing data');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}
function bareReceiptBlock(body) {
  if (body.startsWith(`${COMPRESSED_RECEIPT_MARKER}\n`)) {
    const match = /^```text\n([A-Za-z0-9+/]+={0,2})\n```\n?$/u.exec(body.slice(COMPRESSED_RECEIPT_MARKER.length + 1));
    return match ? { marker: COMPRESSED_RECEIPT_MARKER, payload: match[1] } : null;
  }
  const marker = [RECEIPT_MARKER, ECONOMY_RECEIPT_MARKER].find(value => body.startsWith(`${value}\n`));
  if (!marker) return null;
  const match = /^```json\s*\n([\s\S]*?)\n```\s*$/u.exec(body.slice(marker.length + 1));
  return match ? { marker, payload: match[1] } : null;
}
function framedReceiptBlock(body) {
  const markerEnd = body.indexOf('\n');
  if (markerEnd < 0) return null;
  const marker = body.slice(0, markerEnd);
  if (![RECEIPT_MARKER, ECONOMY_RECEIPT_MARKER, COMPRESSED_RECEIPT_MARKER].includes(marker)) return null;
  const header = `\n${RECEIPT_DETAILS_HEADER}\n\n`;
  const section = body.indexOf(header, markerEnd);
  if (section < 0 || /[^a-zA-Z0-9 \n#|:._?,·-]/u.test(body.slice(markerEnd, section))) return null;
  const match = /^```(json|text)\n([^\r\n]+)\n```\n\n<\/details>\s*$/u.exec(body.slice(section + header.length));
  const gzip = marker === COMPRESSED_RECEIPT_MARKER;
  if (!match || match[1] !== (gzip ? 'text' : 'json')) return null;
  return { marker, payload: match[2] };
}
function decodeReceipt(body) {
  // Bare and framed bodies have different closing delimiters, so they cannot both match.
  const block = bareReceiptBlock(body) ?? framedReceiptBlock(body);
  if (!block) throw new Error('no machine block in the form the receipt command prints');
  const receipt = JSON.parse(block.marker === COMPRESSED_RECEIPT_MARKER ? decodeGzipText(block.payload) : block.payload);
  if (block.marker === RECEIPT_MARKER ? receipt?.version !== undefined : receipt?.version !== 3) {
    throw new Error('receipt version does not match its marker');
  }
  if (receipt === null) throw new Error('receipt JSON is null');
  return receipt;
}
export function parseReceipt(body) {
  if (typeof body !== 'string' || body.length > RECEIPT_LIMIT) return null;
  try { return decodeReceipt(body); } catch { return null; }
}
// Only describe comments parseReceipt already refused. Never expose parser text that quotes the payload.
export function diagnoseReceipt(body) {
  if (typeof body !== 'string') return 'comment body is not text';
  if (body.length > RECEIPT_LIMIT) return 'receipt body exceeds the size limit';
  try { decodeReceipt(body); } catch (error) {
    const message = error.message.replace(/(?:, |^)(?:\.\.\.)?"[\s\S]* is not valid JSON$/u, '') || 'input is not valid JSON';
    const offset = /\bposition (\d+)(?: \(line \d+ column \d+\))?$/u.exec(message)?.[1];
    return message.replace(/[^\x20-\x7e]/gu, '?').slice(0, 160) + (offset === undefined ? '' : ' at offset ' + offset);
  }
  return null;
}
async function readReceiptComments(api, root, pr) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await api.get(`${root}/issues/${pr}/comments?per_page=100&page=${page}`);
    demand(Array.isArray(batch), 'PR comments response is invalid'); comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

export async function readReceipts(api, root, pr, head, now, permissions = new Map(), invalidComments, currentHeadComments, {
  readComments = readReceiptComments, receiptIds,
} = {}) {
  const comments = [...await readComments(api, root, pr)];
  const receipts = [];
  comments.sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at) || b.id - a.id);
  for (const comment of comments) {
    const receipt = parseReceipt(comment.body); const login = comment.user?.login;
    if (receipt === null && typeof comment.body === 'string' && comment.body.startsWith(RECEIPT_MARKER_PREFIX)) invalidComments?.push(comment);
    if (receipt?.pr === pr && receipt.head === head) currentHeadComments?.push(comment);
    if (receipt?.pr !== pr || receipt.head !== head || !admit({ receipt, observed: { ...receipt, baseValid: true }, now }).ok || comment.user?.type !== 'User' || typeof login !== 'string' || !login) continue;
    const key = login.toLowerCase();
    if (!permissions.has(key)) {
      try {
        const access = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
        // The base permission covers custom roles; use role_name only when absent.
        permissions.set(key, ['admin', 'maintain', 'write'].includes(access?.permission ?? access?.role_name));
      } catch { /* A failed lookup never establishes trust; the next poll asks again. */ }
    }
    if (permissions.get(key)) {
      receipts.push(receipt);
      receiptIds?.set(receipt, comment.id);
    }
  }
  return receipts;
}
export async function waitNativeAdmission({ event, env = process.env, api, cwd = process.cwd(), now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), deadlineMs = 3 * 60 * 1000, runGit = git, fastFail = undefined, onCandidate = undefined, committedObjectsOnly = false, readComments = undefined, expectedMain = undefined }) {
  demand(/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? '') && event.repository?.private === false, 'use a public repository GitHub event');
  const root = `/repos/${env.GITHUB_REPOSITORY}`; const group = env.GITHUB_EVENT_NAME === 'merge_group' ? event.merge_group : null;
  const shouldFastFail = fastFail ?? !group;
  demand(['pull_request', 'merge_group'].includes(env.GITHUB_EVENT_NAME), 'only pull_request and merge_group events are supported');
  const match = group && /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-(\d+)-[a-f0-9]+$/u.exec(group.head_ref ?? '');
  const prNumber = group ? Number(match?.[1]) : event.number;
  demand(Number.isSafeInteger(prNumber) && prNumber > 0, 'event must name one PR on main');
  if (group) demand(event.action === 'checks_requested' && group.base_ref === 'refs/heads/main' && SHA.test(group.head_sha) && SHA.test(group.base_sha) && (!env.GITHUB_SHA || env.GITHUB_SHA === group.head_sha) && (!env.GITHUB_REF || env.GITHUB_REF === group.head_ref), 'merge group identity differs from the event');
  const permissions = new Map();
  const start = now(); let reason = 'post a current receipt comment from a user with write, maintain or admin permission';
  let invalidCommentNotice = '';
  while (now() - start < deadlineMs) {
    const pr = await api.get(`${root}/pulls/${prNumber}`);
    demand(pr.number === prNumber && pr.state === 'open' && pr.draft === false && !pr.merged && pr.base?.ref === 'main' && SHA.test(pr.head?.sha), 'PR must be the live open main candidate');
    if (!group) demand(event.pull_request?.head?.sha === pr.head.sha, 'PR head changed; rerun CI for the current head', 'stale');
    const invalidComments = [];
    const currentHeadComments = [];
    const receiptIds = new Map();
    const receipts = await readReceipts(api, root, prNumber, pr.head.sha, now(), permissions, invalidComments, currentHeadComments, { readComments, receiptIds });
    for (const receipt of receipts) {
      const main = (await api.get(`${root}/git/ref/heads/main`)).object?.sha; demand(SHA.test(main) && (expectedMain === undefined || expectedMain === main), 'main commit identity is invalid or changed');
      const historical = receipt.version === 3 ? receipt.session.history.flatMap(event => event.type === 'prepare' ? [event.candidate.base, event.candidate.head] : event.type === 'renew' ? [event.proof.main] : []) : [];
      const refs = [...new Set([receipt.base, receipt.head, main, ...historical, ...(group ? [group.base_sha, group.head_sha] : [])])];
      demand(refs.every(ref => SHA.test(ref)), 'receipt references invalid source objects');
      let candidate; let baseValid; let legacyRules;
      try {
        if (!committedObjectsOnly) {
          await runGit(cwd, '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...refs);
          await runGit(cwd, 'update-ref', 'refs/remotes/origin/main', main);
        }
        candidate = await captureCommittedReviewCandidate(cwd, receipt.base, receipt.head, runGit);
        if (receipt.version === 3) await validateEconomySession(cwd, receipt.session, runGit);
        else legacyRules = await captureReviewRules(cwd, candidate, runGit) === undefined;
        const forks = (await runGit(cwd, 'merge-base', '--all', receipt.head, committedObjectsOnly ? main : 'origin/main')).trim().split('\n');
        baseValid = forks.length === 1 && SHA.test(forks[0]) && receipt.base === forks[0];
      } catch (error) { reason = `receipt objects could not be verified: ${error.message}; post a corrected receipt`; continue; }
      let decision = admit({ receipt, observed: { ...candidate, pr: prNumber, baseValid, legacyRules }, now: now() });
      if (!decision.ok) { reason = `${decision.code}: ${decision.reason}`; continue; }
      const forwardApproval = needsForwardApproval(candidate.changedPaths, path => hasExactManagedForward(cwd, candidate.base, path));
      // The trusted reader checks each change on its own base; moves on main or ahead in the queue do not refuse it.
      if (forwardApproval) assertCoLocatedForwardApproval(cwd, candidate.base, candidate.head);
      if (group) {
        const tree = (await runGit(cwd, 'rev-parse', '--verify', `${group.head_sha}^{tree}`)).trim();
        decision = await carryOverSourceReview(cwd, candidate, { base: group.base_sha, tree, trustedMain: main }, runGit);
        demand(decision.ok, decision.reason, decision.code);
        if (forwardApproval || needsForwardApproval(candidate.changedPaths, path => hasExactManagedForward(cwd, group.base_sha, path))) {
          assertCoLocatedForwardApproval(cwd, group.base_sha, group.head_sha);
        }
      }
      const live = await api.get(`${root}/pulls/${prNumber}`);
      demand(live.head?.sha === pr.head.sha && live.state === 'open' && live.draft === false && !live.merged && live.base?.ref === 'main', 'PR changed during admission; rerun CI', 'stale');
      if (!group) demand((await api.get(`${root}/git/ref/heads/main`)).object?.sha === main, 'main moved during admission; rerun CI', 'stale');
      const final = admit({ receipt, observed: { ...candidate, pr: prNumber, baseValid, legacyRules }, now: now() }); demand(final.ok, final.reason, final.code);
      onCandidate?.(candidate, receiptIds.get(receipt));
      if (!committedObjectsOnly) console.log(`Native review admission verified: ${group ? decision.reason : 'reviewed PR head'}.`); return receipt;
    }
    if (shouldFastFail && receipts.length === 0 && invalidComments.length === 0 && currentHeadComments.length === 0) {
      if (!committedObjectsOnly) console.log(`needs_agent_review: ${reason}`);
      throw new Error(`needs_agent_review: no receipt comment yet for head ${pr.head.sha}; ${reason}; when native-review is the only failed job of the completed run, Native Review Receipt Rerun will rerun it automatically`);
    }
    const invalid = invalidComments[0];
    const v2Remedy = invalid?.body.split('\n', 1)[0] === RECEIPT_MARKER
      ? ' A v2 receipt needs a session prepared on current main.' : '';
    invalidCommentNotice = invalid ? `; receipt comment ${invalid.id}: Review receipt machine block could not be parsed: ${diagnoseReceipt(invalid.body)}. Re-run \`node scripts/agent-review-session.mjs receipt ${prNumber}\` and post its exact output.${v2Remedy}` : '';
    if (!committedObjectsOnly) console.log(`needs_agent_review: ${reason}${invalidCommentNotice}`);
    await sleep(Math.min(15000, Math.max(0, deadlineMs - (now() - start))));
  }
  throw new Error(`needs_agent_review: bounded 3-minute receipt wait expired; ${reason}${invalidCommentNotice}`);
}
export function readLatestSourceJobs(source, jobs) {
  const positive = value => Number.isSafeInteger(value) && value > 0;
  demand(jobs.every(job => positive(job?.id) && job.run_id === source.id && job.head_sha === source.head_sha
    && positive(job.run_attempt) && job.run_attempt <= source.run_attempt) && new Set(jobs.map(job => job.id)).size === jobs.length, 'source jobs identity is invalid or duplicated');
  return [...REQUIRED_CONTEXTS, 'native-review'].map(name => {
    const matches = jobs.filter(job => job.name === name);
    const latest = matches.reduce((attempt, job) => Math.max(attempt, job.run_attempt), 0);
    const selected = matches.filter(job => job.run_attempt === latest);
    demand(selected.length <= 1, `source requires one actual successful latest ${name} check`);
    const job = selected[0];
    return { id: job?.id, name, attempt: latest, status: job?.status, conclusion: job?.conclusion };
  });
}

// A completed source run hands an existing merge request to GitHub's queue once.
// This code runs only from trusted main; source objects are never checked out.
export async function enqueueAfterChecks({ event, env, api, enqueue, cwd = process.cwd(), now = Date.now, runGit = git,
  pauseMergeability = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
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
  const readMergeable = async (checkIntent, beforeRead) => {
    const maxReads = 13;
    for (let reads = 1; ; reads += 1) {
      if (beforeRead) await beforeRead();
      const pr = await live();
      if (!eligible(pr) || !pr.autoMergeRequest || pr.mergeQueueEntry) return null;
      checkIntent?.(pr.autoMergeRequest);
      if (pr.mergeable === 'MERGEABLE') return pr;
      demand(pr.mergeable !== 'CONFLICTING', 'PR conflicts with main; merge main into the branch and push; auto-merge stays armed');
      demand(pr.mergeable === 'UNKNOWN', 'invalid PR mergeability response');
      demand(reads < maxReads, `PR mergeability is still unknown after ${reads} reads; re-run the Queue Handoff job`);
      await pauseMergeability(15_000);
    }
  };
  const skipped = { status: 'skipped', reason: 'PR changed, is unarmed, or is already queued' };
  const attempted = pr => {
    demand(Array.isArray(pr.timelineItems?.nodes) && pr.timelineItems.nodes.length <= 1
      && pr.timelineItems.nodes.every(node => Number.isFinite(Date.parse(node?.createdAt))), 'queue attempt history is invalid');
    return pr.timelineItems.nodes.some(node => Date.parse(node.createdAt) >= Date.parse(pr.autoMergeRequest.enabledAt));
  };
  const initialPr = await readMergeable();
  if (!initialPr) return skipped;
  const intent = initialPr.autoMergeRequest; const login = intent.enabledBy?.login;
  demand(typeof login === 'string' && /^[\w[\].-]+$/u.test(login) && Number.isFinite(Date.parse(intent.enabledAt)), 'auto-merge author identity is invalid');
  if (attempted(initialPr)) return { status: 'skipped', reason: 'this merge intent already entered the queue; no automatic requeue' };
  const access = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
  demand(['write', 'maintain', 'admin'].includes(access?.permission ?? access?.role_name), 'auto-merge author no longer has repository write permission');
  // Partial reruns replace only selected jobs. Read every attempt, then select
  // each required job's latest attempt without recovering an older success.
  const jobs = []; let total;
  for (let page = 1; total === undefined || jobs.length < total; page += 1) {
    const result = await api.get(`${root}/actions/runs/${source.id}/jobs?filter=all&per_page=100&page=${page}`);
    demand(Array.isArray(result.jobs) && result.jobs.length <= 100 && Number.isSafeInteger(result.total_count) && result.total_count >= 0
      && (total === undefined || total === result.total_count), 'source jobs response is incomplete or invalid');
    total = result.total_count;
    demand(result.jobs.length === Math.min(100, total - jobs.length), 'source jobs pagination is incomplete');
    jobs.push(...result.jobs);
  }
  for (const job of readLatestSourceJobs(source, jobs)) {
    demand(job.status === 'completed' && job.conclusion === 'success', `source requires one actual successful latest ${job.name} check`);
  }
  let admittedCandidate;
  await waitNativeAdmission({ event: { repository: event.repository, number, pull_request: { head: { sha: source.head_sha } } },
    env: { GITHUB_REPOSITORY: env.GITHUB_REPOSITORY, GITHUB_EVENT_NAME: 'pull_request' }, api, cwd, now, runGit, fastFail: false,
    onCandidate: observed => { admittedCandidate = observed; },
    sleep: () => { throw new Error('Current native review is unavailable at CI completion; no enqueue retry'); } });
  const pr = await readMergeable(currentIntent => {
    demand(currentIntent.enabledAt === intent.enabledAt && currentIntent.enabledBy?.login === login,
      'mergeability or auto-merge authority changed before enqueue');
  }, sourceCurrent);
  if (!pr) return skipped;
  if (attempted(pr)) return { status: 'skipped', reason: 'this merge intent already entered the queue; no automatic requeue' };
  const finalAccess = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
  demand(['write', 'maintain', 'admin'].includes(finalAccess?.permission ?? finalAccess?.role_name), 'auto-merge authority changed before enqueue');
  demand(Array.isArray(admittedCandidate?.changedPaths), 'native admission did not yield candidate paths');
  if (admittedCandidate.changedPaths.some(isMigrationQueueSerializedPath)) {
    const blockingPrs = await findBlockingMigrationQueuePrs({ api, root, owner, name, prNumber: number });
    if (blockingPrs.length > 0) {
      return {
        status: 'deferred',
        pr: number,
        head: source.head_sha,
        blockingPrs,
        reason: 'another migration PR is already active in the merge queue',
      };
    }
  }
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
    const maxBuffer = path.includes('/files?') ? 32 * 1024 * 1024 : 2 * 1024 * 1024;
    return JSON.parse((await execute('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer })).stdout);
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
