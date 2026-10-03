// Native process evidence carried through GitHub, without a model API or signer.
// Run trusted main's copy. Candidates are read as Git objects, never executed.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertAgentReviewFreshness, captureCommittedReviewCandidate, verifyAgentReview } from './agent-review-session.mjs';

const execute = promisify(execFile);
const REPOSITORY = 'openlup/openlup';
const REPOSITORY_ID = 1376035358;
const WORKFLOW = '.github/workflows/published-tree-ci.yml';
const DISPATCH = '.github/workflows/native-review-admission.yml';
const SHA = /^[a-f0-9]{40}$/u;
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' };
const LIMIT = 56000; // Reserve room for binding and JSON transport below 65,535.
const ARTIFACT_LIMIT = 60000;
const EXPANDED_LIMIT = 512000; // Bounded complete lineage; never truncate review evidence.
function demand(ok, message) { if (!ok) throw new Error(`Native admission refused: ${message}`); }
function integer(n) { return Number.isSafeInteger(n) && n > 0; }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function encodeNativeReceipt(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  demand(bytes.length <= EXPANDED_LIMIT, 'receipt exceeds expanded bound; do not truncate evidence');
  if (bytes.length <= LIMIT) return bytes.toString('utf8');
  const receipt = JSON.stringify({ version: 3, encoding: 'gzip-base64', sha256: digest(bytes), data: gzipSync(bytes).toString('base64') });
  demand(Buffer.byteLength(receipt) <= LIMIT, 'receipt exceeds transport bound; do not truncate evidence');
  return receipt;
}
function decodeNativeReceipt(bytes, limit = LIMIT) {
  demand(typeof bytes === 'string' && Buffer.byteLength(bytes) <= limit, 'receipt exceeds transport bound; do not truncate evidence');
  const value = JSON.parse(bytes);
  if (value?.version !== 3) return value;
  demand(Object.keys(value).sort().join(',') === 'data,encoding,sha256,version' && value.encoding === 'gzip-base64'
    && typeof value.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(value.data)
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256), 'compressed receipt schema differs');
  const compressed = Buffer.from(value.data, 'base64');
  demand(compressed.toString('base64') === value.data, 'compressed receipt encoding is not canonical');
  let expanded;
  try { expanded = gunzipSync(compressed, { maxOutputLength: EXPANDED_LIMIT }); }
  catch { throw new Error('Native admission refused: compressed receipt is invalid or exceeds expanded bound'); }
  demand(digest(expanded) === value.sha256, 'compressed receipt digest differs');
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded));
  demand(decoded?.version !== 3, 'nested compressed receipt is refused');
  return decoded;
}
export function parseNativeAdmission(bytes) {
  const value = decodeNativeReceipt(bytes);
  if (value?.version === 2) {
    // Pull-request receipts bind the reviewed PR head and tree, not one run/attempt.
    demand(Object.keys(value).sort().join(',') === 'integration,source,target,version' && value.target && Object.keys(value.target).sort().join(',') === 'event,prNumber,sourceHead', 'receipt schema differs');
    demand(value.target.event === 'pull_request' && integer(value.target.prNumber) && SHA.test(value.target.sourceHead) && value.integration === null, 'source target is invalid');
    demand(value.source?.request && Array.isArray(value.source.reports), 'native states are missing');
    return value;
  }
  demand(value && Object.keys(value).sort().join(',') === 'integration,prNumber,source,targetAttempt,targetRunId,version' && value.version === 1, 'receipt schema differs');
  demand(integer(value.targetRunId) && integer(value.targetAttempt) && integer(value.prNumber), 'target run/attempt/PR is invalid');
  demand(value.source?.request && Array.isArray(value.source.reports) && (value.integration === null || value.integration?.request && Array.isArray(value.integration.reports)), 'native states are missing');
  return value;
}
export async function observeNativeAdmission(api, input) {
  const root = `/repos/${REPOSITORY}`;
  const run = await api.get(`${root}/actions/runs/${input.targetRunId}`);
  demand(run.id === input.targetRunId && run.run_attempt === input.targetAttempt && run.repository?.id === REPOSITORY_ID && run.path === WORKFLOW && ['pull_request', 'merge_group'].includes(run.event) && SHA.test(run.head_sha) && integer(run.workflow_id), 'target workflow identity or attempt differs');
  demand(run.status !== 'completed' || run.conclusion === 'success', 'target run has already failed');
  const pr = await api.get(`${root}/pulls/${input.prNumber}`);
  demand(pr.number === input.prNumber && pr.state === 'open' && pr.draft === false && !pr.merged && pr.base?.repo?.id === REPOSITORY_ID && pr.base.ref === 'main' && SHA.test(pr.head?.sha), 'PR is not the current open main candidate');
  const source = input.source.request.candidate;
  demand(source.head === pr.head.sha, 'PR head changed after source review');
  const commit = await api.get(`${root}/git/commits/${source.head}`);
  demand(commit.sha === source.head && commit.tree?.sha === source.tree, 'reviewed source tree differs');
  if (run.event === 'pull_request') {
    demand(run.head_sha === source.head && run.head_branch === pr.head.ref && integer(pr.head.repo?.id) && run.head_repository?.id === pr.head.repo.id && input.integration === null, 'PR run is not the source review target');
    return { event: run.event, workflowId: run.workflow_id, runId: run.id, attempt: run.run_attempt, prNumber: pr.number, sourceHead: source.head, sourceTree: source.tree };
  }
  const result = await api.graphql(`query { repository(owner:"openlup",name:"openlup") { mergeQueue(branch:"main") { entries(first:100) { totalCount pageInfo { hasNextPage } nodes { id position enqueuedAt baseCommit { oid } headCommit { oid } pullRequest { number headRefOid baseRefName } } } } } }`);
  const entries = result?.repository?.mergeQueue?.entries;
  demand(entries && integer(entries.totalCount) && entries.totalCount <= 100 && entries.pageInfo?.hasNextPage === false && entries.nodes?.length === entries.totalCount && entries.nodes.every(entry => integer(entry?.position)) && new Set(entries.nodes.map(entry => entry.position)).size === entries.totalCount, 'queue membership is unknown or incomplete');
  const matches = entries.nodes.filter(entry => entry.headCommit?.oid === run.head_sha);
  demand(matches.length === 1 && matches[0].position === 1, 'pilot admits only the first single-source group; prior participants require regrouping');
  const entry = matches[0];
  demand(typeof entry.id === 'string' && entry.id.length <= 160 && Number.isFinite(Date.parse(entry.enqueuedAt)) && SHA.test(entry.baseCommit?.oid) && entry.headCommit?.oid === run.head_sha && entry.pullRequest?.number === pr.number && entry.pullRequest?.headRefOid === source.head && entry.pullRequest?.baseRefName === 'main', 'live queue entry does not match the reviewed source/group');
  demand(typeof run.head_branch === 'string' && run.head_branch.startsWith('gh-readonly-queue/main/'), 'group ref is invalid');
  const ref = await api.get(`${root}/git/ref/heads/${run.head_branch}`);
  const main = await api.get(`${root}/git/ref/heads/main`);
  const group = await api.get(`${root}/git/commits/${run.head_sha}`);
  demand(ref.ref === `refs/heads/${run.head_branch}` && ref.object?.sha === run.head_sha && ref.object.type === 'commit' && main.object?.sha === entry.baseCommit.oid && group.sha === run.head_sha && SHA.test(group.tree?.sha), 'group ref, current base or tree changed');
  return { event: run.event, workflowId: run.workflow_id, runId: run.id, attempt: run.run_attempt, prNumber: pr.number, sourceHead: source.head, sourceTree: source.tree, entryId: entry.id, enqueuedAt: entry.enqueuedAt, base: entry.baseCommit.oid, head: run.head_sha, tree: group.tree.sha, ref: ref.ref };
}
async function verifyReviewState(cwd, state, now) {
  const candidate = await captureCommittedReviewCandidate(cwd, state.request.candidate.base, state.request.candidate.head);
  const result = await verifyAgentReview({ cwd, ...state, snapshot: async () => candidate, now });
  demand(result.status === 'reviewed', result.reason ?? 'complete independent native review is missing');
  return candidate;
}
// A base move into admission, identity-binding, dependency or migration machinery never carries a review over.
const TRUST_PATHS = [/^\.github\//u, /^scripts\/agent-review-/u, /^scripts\/documentation-git\.ts$/u, /^(?:packages\/[^/]+\/)?package(?:-lock)?\.json$/u, /^supabase\/migrations\//u, /^config\/platform-migration-manifest\.json$/u];
async function git(cwd, ...args) {
  // The same clean configuration as the object fetch keeps the prediction purely path-based on any runner.
  return (await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', ...args], { timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: GIT_ENV })).stdout;
}
/** A source review carries over to a merge group that is exactly the reviewed change on a base whose net change since the reviewed base avoids its paths and that machinery. */
export async function carryOverSourceReview(cwd, candidate, group) {
  if (group.tree === candidate.tree) return 'unchanged tree';
  let predicted;
  try { await git(cwd, 'merge-base', '--is-ancestor', candidate.base, group.base); predicted = (await git(cwd, 'merge-tree', '--write-tree', `--merge-base=${candidate.base}`, group.base, candidate.head)).trim(); } catch { predicted = null; }
  demand(predicted === group.tree, 'group is not exactly the reviewed change on its queue base; integration review required');
  const moved = (await git(cwd, 'diff', '--name-only', '--no-renames', '-z', candidate.base, group.base)).split('\0').filter(Boolean);
  const own = new Set(candidate.changedPaths);
  demand(!moved.some(path => own.has(path)), 'the base moved under a reviewed path; integration review required');
  demand(!moved.some(path => TRUST_PATHS.some(pattern => pattern.test(path))), 'the base changed review, workflow, dependency or migration machinery; integration review required');
  return 'disjoint base move';
}
/** Admits a merge group with its PR's source receipt when the source review carries over; otherwise the run-keyed route applies. */
export async function verifyGroupSourceAdmission({ cwd, api, input, target, now = Date.now }) {
  const view = { version: 1, targetRunId: target.runId, targetAttempt: target.attempt, prNumber: input.target.prNumber, source: input.source, integration: null };
  const first = await observeNativeAdmission(api, view);
  demand(first.event === 'merge_group' && first.sourceHead === input.target.sourceHead, 'source receipt does not name this merge group');
  const candidate = await verifyReviewState(cwd, input.source, now);
  const basis = await carryOverSourceReview(cwd, candidate, first);
  const final = await observeNativeAdmission(api, view);
  demand(equal(first, final), 'candidate, queue entry or workflow attempt changed during verification');
  assertAgentReviewFreshness(input.source, now());
  return { ...final, basis };
}
export async function verifyNativeAdmission({ cwd, api, input, expected, now = Date.now }) {
  const first = await observeNativeAdmission(api, input);
  if (expected) demand(equal(first, expected), 'target event/request binding changed');
  const verify = state => verifyReviewState(cwd, state, now);
  await verify(input.source);
  if (first.event === 'merge_group') {
    // Entire-tree equality is an objective unchanged-code proof. Groups that the
    // source-receipt carry-over does not admit (see carryOverSourceReview) need
    // two integration reviews here.
    if (first.tree === first.sourceTree) demand(input.integration === null, 'unchanged tree needs no extra review');
    else {
      const state = input.integration;
      demand(state && state.request.intent.risk !== 'prose' && state.request.roles.length === 2 && state.request.candidate.base === first.base && state.request.candidate.head === first.head && state.request.candidate.tree === first.tree, 'changed integration requires two current independent group reviews');
      demand(state.request.version === 1 || state.request.continuation?.mode === 'full', 'changed integration requires fresh full coverage, not inherited focused reviews');
      demand(state.request.intent.criteria === input.source.request.intent.criteria && state.request.authorSessionId === input.source.request.authorSessionId, 'integration changed approved criteria or supervisor');
      const priorIds = new Set([input.source, ...(input.source.history ?? [])].flatMap(round => round.reports.flatMap(report => [report.reviewerId, report.sessionId])));
      demand([state, ...(state.history ?? [])].every(round => round.reports.every(report => !priorIds.has(report.reviewerId) && !priorIds.has(report.sessionId))), 'integration reviewers reused source context');
      await verify(state);
    }
  }
  // Expiry and live identities are sampled again at admission, not at submission.
  await verify(input.source);
  if (input.integration) await verify(input.integration);
  const final = await observeNativeAdmission(api, input);
  demand(equal(first, final), 'candidate, queue entry or workflow attempt changed during verification');
  const admittedAt = now();
  assertAgentReviewFreshness(input.source, admittedAt);
  if (input.integration) assertAgentReviewFreshness(input.integration, admittedAt);
  return final;
}
/** The live PR still carries the reviewed head and tree; with a run, that run is its exact Published Tree CI target. */
export async function observeSourceAdmission(api, input, target = null) {
  const root = `/repos/${REPOSITORY}`;
  const pr = await api.get(`${root}/pulls/${input.target.prNumber}`);
  demand(pr.number === input.target.prNumber && pr.state === 'open' && pr.draft === false && !pr.merged && pr.base?.repo?.id === REPOSITORY_ID && pr.base.ref === 'main' && SHA.test(pr.head?.sha), 'PR is not the current open main candidate');
  const source = input.source.request.candidate;
  demand(source.head === input.target.sourceHead && pr.head.sha === source.head, 'PR head changed after source review');
  const commit = await api.get(`${root}/git/commits/${source.head}`);
  demand(commit.sha === source.head && commit.tree?.sha === source.tree, 'reviewed source tree differs');
  const binding = { event: 'pull_request', prNumber: pr.number, sourceHead: source.head, sourceTree: source.tree };
  if (!target) return binding;
  const run = await api.get(`${root}/actions/runs/${target.runId}`);
  demand(run.id === target.runId && run.run_attempt === target.attempt && run.repository?.id === REPOSITORY_ID && run.path === WORKFLOW && integer(run.workflow_id) && run.event === 'pull_request', 'target workflow identity or attempt differs');
  demand(run.status !== 'completed' || run.conclusion === 'success', 'target run has already failed');
  demand(run.head_sha === source.head && run.head_branch === pr.head.ref && integer(pr.head.repo?.id) && run.head_repository?.id === pr.head.repo.id, 'PR run is not the source review target');
  return { ...binding, runId: run.id, attempt: run.run_attempt, workflowId: run.workflow_id };
}
export async function verifySourceAdmission({ cwd, api, input, target = null, now = Date.now }) {
  const first = await observeSourceAdmission(api, input, target);
  await verifyReviewState(cwd, input.source, now);
  const final = await observeSourceAdmission(api, input, target);
  demand(equal(first, final), 'candidate or workflow attempt changed during verification');
  assertAgentReviewFreshness(input.source, now());
  return final;
}
function apiTransport() {
  async function gh(args, bound = 2 * 1024 * 1024) {
    const { stdout } = await execute('gh', args, { timeout: 30000, maxBuffer: bound }); return stdout;
  }
  return {
    get: async path => JSON.parse(await gh(['api', path])),
    graphql: async query => JSON.parse(await gh(['api', 'graphql', '-f', `query=${query}`])).data,
    download: async path => (await execute('gh', ['api', path], { encoding: 'buffer', timeout: 30000, maxBuffer: 128000 })).stdout,
    gh,
  };
}
async function fetchObjects(cwd, input, identity) {
  const refs = [...new Set([input.source, ...(input.source.history ?? []), ...(input.integration ? [input.integration, ...(input.integration.history ?? [])] : [])].flatMap(state => [state.request.candidate.base, state.request.candidate.head]).concat(identity.base ?? []))];
  demand(refs.length <= 14 && refs.every(ref => SHA.test(ref)), 'review object roots exceed bounds');
  // A literal public remote, no credential helpers, candidate hooks or filters.
  await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', 'https://github.com/openlup/openlup.git', ...refs], { timeout: 120000, maxBuffer: 1024 * 1024, env: GIT_ENV });
}
export async function readNativeAdmissionArtifact(api, input) {
  const name = `native-review-${input.targetRunId}-${input.targetAttempt}`;
  const listing = await api.get(`/repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`);
  demand(Array.isArray(listing.artifacts) && listing.total_count <= 100 && listing.artifacts.length === listing.total_count, 'receipt artifact pagination is incomplete');
  const artifacts = listing.artifacts.filter(artifact => !artifact.expired);
  demand(artifacts.length <= 1, 'multiple receipts for one run/attempt require regrouping');
  for (const artifact of artifacts.sort((a, b) => b.id - a.id)) {
    const receipt = await readTrustedReceipt(api, artifact);
    if (!receipt) continue;
    demand(receipt.input.targetRunId === input.targetRunId && receipt.input.targetAttempt === input.targetAttempt && (input.prNumber === 0 || receipt.input.prNumber === input.prNumber), 'artifact target is stale');
    return receipt;
  }
  return null;
}
/** A source receipt for this PR head. Artifacts failing provenance are skipped: the name is predictable and any run can upload one. */
export async function readSourceAdmissionArtifact(api, prNumber, sourceHead) {
  demand(integer(prNumber) && SHA.test(sourceHead), 'source receipt target is invalid');
  const listing = await api.get(`/repos/${REPOSITORY}/actions/artifacts?name=native-review-pr-${prNumber}-${sourceHead}&per_page=100`);
  demand(Array.isArray(listing.artifacts) && listing.total_count <= 100 && listing.artifacts.length === listing.total_count, 'receipt artifact pagination is incomplete');
  for (const artifact of listing.artifacts.filter(artifact => !artifact.expired).sort((a, b) => b.id - a.id)) {
    let receipt;
    try { receipt = await readTrustedReceipt(api, artifact); } catch { continue; }
    if (receipt?.input?.version === 2 && receipt.input.target?.prNumber === prNumber && receipt.input.target.sourceHead === sourceHead) return receipt;
  }
  return null;
}
async function readTrustedReceipt(api, artifact) {
  const run = await api.get(`/repos/${REPOSITORY}/actions/runs/${artifact.workflow_run.id}`);
  if (run.status !== 'completed') return null;
  const workflow = await api.get(`/repos/${REPOSITORY}/actions/workflows/native-review-admission.yml`);
  demand(workflow.path === DISPATCH && workflow.state === 'active' && workflow.id === run.workflow_id && run.repository?.id === REPOSITORY_ID && run.event === 'workflow_dispatch' && run.path === DISPATCH && run.head_branch === 'main' && run.head_sha === artifact.workflow_run.head_sha && run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1, 'receipt is not from successful trusted-main dispatch; dispatch reruns are refused');
  demand(integer(artifact.id) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128000 && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest), 'artifact identity/bounds are invalid');
  const directory = await mkdtemp(join(tmpdir(), 'native-review-'));
  try {
    const archive = join(directory, 'receipt.zip');
    const bytes = await api.download(`/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`);
    demand(Buffer.isBuffer(bytes) && bytes.length <= 128000 && `sha256:${digest(bytes)}` === artifact.digest, 'downloaded artifact digest differs');
    await writeFile(archive, bytes);
    const names = await execute('unzip', ['-Z1', archive], { timeout: 5000, maxBuffer: 1024 });
    demand(names.stdout.trim() === 'receipt.json', 'artifact contains unexpected entries');
    const output = await execute('unzip', ['-p', archive, 'receipt.json'], { timeout: 5000, maxBuffer: ARTIFACT_LIMIT });
    const receipt = decodeNativeReceipt(output.stdout, ARTIFACT_LIMIT);
    demand(receipt && Object.keys(receipt).sort().join(',') === 'binding,input', 'artifact target is stale');
    return receipt;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function main() {
  const [verb, ...args] = process.argv.slice(2); const cwd = process.cwd();
  if (verb === 'input') {
    const [runId, attempt, pr, sourcePath, integrationPath] = args;
    const input = { version: 1, targetRunId: Number(runId), targetAttempt: Number(attempt), prNumber: Number(pr), source: JSON.parse(await readFile(sourcePath, 'utf8')), integration: integrationPath ? JSON.parse(await readFile(integrationPath, 'utf8')) : null };
    const receipt = encodeNativeReceipt(input); parseNativeAdmission(receipt); console.log(JSON.stringify({ receipt })); return;
  }
  if (verb === 'input-source') {
    const [pr, sourcePath] = args; const source = JSON.parse(await readFile(sourcePath, 'utf8'));
    const input = { version: 2, target: { event: 'pull_request', prNumber: Number(pr), sourceHead: source.request?.candidate?.head }, source, integration: null };
    const receipt = encodeNativeReceipt(input); parseNativeAdmission(receipt); console.log(JSON.stringify({ receipt })); return;
  }
  const api = apiTransport();
  if (verb === 'submit') {
    demand(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_REPOSITORY === REPOSITORY, 'submission must execute trusted main');
    const input = parseNativeAdmission(process.env.NATIVE_REVIEW_RECEIPT);
    if (input.version === 2) {
      await observeSourceAdmission(api, input); await fetchObjects(cwd, input, {});
      const binding = await verifySourceAdmission({ cwd, api, input });
      await writeFile('receipt.json', encodeNativeReceipt({ input, binding }));
      await writeFile(process.env.GITHUB_OUTPUT, `artifact=native-review-pr-${input.target.prNumber}-${input.target.sourceHead}\n`, { flag: 'a' }); return;
    }
    const first = await observeNativeAdmission(api, input); await fetchObjects(cwd, input, first);
    const binding = await verifyNativeAdmission({ cwd, api, input, expected: first });
    await writeFile('receipt.json', encodeNativeReceipt({ input, binding }));
    await writeFile(process.env.GITHUB_OUTPUT, `artifact=native-review-${input.targetRunId}-${input.targetAttempt}\n`, { flag: 'a' }); return;
  }
  demand(verb === 'wait', 'use input, input-source, trusted submit, or admission wait');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  await waitNativeAdmission({ event, env: process.env, api, cwd });
}
export async function waitNativeAdmission({ event, env, api, cwd, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), deadlineMs = 20 * 60 * 1000, fetchObjects: fetch = fetchObjects }) {
  demand(env.GITHUB_REPOSITORY === REPOSITORY, 'use input, input-source, trusted submit, or admission wait');
  const runId = Number(env.GITHUB_RUN_ID); const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  demand(integer(runId) && integer(attempt) && event.repository?.private === false, 'hosted target is invalid');
  const target = env.GITHUB_EVENT_NAME;
  const pr = target === 'pull_request' ? event.number : 0;
  demand(['pull_request', 'merge_group'].includes(target), 'event is unsupported');
  const start = now();
  while (now() - start < deadlineMs) {
    // A group has no PR number in the event. The artifact input is only a hint;
    // authenticated queue membership below independently verifies it.
    const seed = { targetRunId: runId, targetAttempt: attempt, prNumber: pr };
    let receipt;
    try { receipt = await readNativeAdmissionArtifact(api, seed); } catch (error) {
      // The run-keyed name is predictable; on a pull-request run an unusable artifact must not block the source receipt.
      if (target !== 'pull_request') throw error;
      console.log(`run-keyed receipt unusable, trying the source receipt: ${error.message}`); receipt = null;
    }
    if (receipt) {
      const input = parseNativeAdmission(encodeNativeReceipt(receipt.input));
      demand(target === receipt.binding.event && (target !== 'pull_request' || event.pull_request?.head?.sha === receipt.binding.sourceHead) && (target !== 'merge_group' || event.action === 'checks_requested' && event.merge_group?.base_ref === 'refs/heads/main' && event.merge_group.base_sha === receipt.binding.base && event.merge_group.head_sha === receipt.binding.head && event.merge_group.head_ref === receipt.binding.ref && env.GITHUB_SHA === receipt.binding.head && env.GITHUB_REF === receipt.binding.ref), 'receipt differs from hosted event');
      await fetch(cwd, input, receipt.binding);
      await verifyNativeAdmission({ cwd, api, input, expected: receipt.binding, now }); console.log('Native review admission verified for this exact run/attempt.'); return;
    }
    if (target === 'merge_group') {
      // The queue entry names the PR and its reviewed head; authenticated membership is re-checked during verification.
      const entries = (await api.graphql(`query { repository(owner:"openlup",name:"openlup") { mergeQueue(branch:"main") { entries(first:100) { nodes { headCommit { oid } pullRequest { number headRefOid } } } } } }`))?.repository?.mergeQueue?.entries?.nodes ?? [];
      const hint = entries.find(entry => entry?.headCommit?.oid === env.GITHUB_SHA)?.pullRequest;
      const source = integer(hint?.number) && SHA.test(hint?.headRefOid ?? '') ? await readSourceAdmissionArtifact(api, hint.number, hint.headRefOid) : null;
      if (source) {
        const input = parseNativeAdmission(encodeNativeReceipt(source.input));
        demand(input.version === 2 && input.target.prNumber === hint.number && input.target.sourceHead === hint.headRefOid && event.action === 'checks_requested' && event.merge_group?.base_ref === 'refs/heads/main' && event.merge_group.head_sha === env.GITHUB_SHA && event.merge_group.head_ref === env.GITHUB_REF, 'receipt differs from hosted event');
        await fetch(cwd, input, { base: event.merge_group.base_sha });
        let binding = null;
        try { binding = await verifyGroupSourceAdmission({ cwd, api, input, target: { runId, attempt }, now }); }
        catch (error) { console.log(`source receipt does not admit this merge group; waiting for a run-keyed receipt: ${error.message}`); }
        if (binding) {
          demand(binding.base === event.merge_group.base_sha && binding.head === env.GITHUB_SHA && binding.ref === env.GITHUB_REF, 'receipt differs from hosted event');
          console.log(`Native review admission verified for this merge group by its source receipt (${binding.basis}).`); return;
        }
      }
    }
    if (target === 'pull_request') {
      // One source receipt serves every run and attempt of the reviewed PR head.
      const source = await readSourceAdmissionArtifact(api, pr, event.pull_request?.head?.sha);
      if (source) {
        const input = parseNativeAdmission(encodeNativeReceipt(source.input));
        demand(input.version === 2 && input.target.prNumber === event.number && input.target.sourceHead === event.pull_request?.head?.sha, 'receipt differs from hosted event');
        await fetch(cwd, input, {});
        await verifySourceAdmission({ cwd, api, input, target: { runId, attempt }, now }); console.log('Native review admission verified for this reviewed PR head.'); return;
      }
    }
    console.log(`needs_agent_review: submit native receipt for run ${runId}/${attempt}; no maintainer action required`);
    await sleep(15000);
  }
  throw new Error('Native admission refused: bounded receipt wait expired; regroup, do not retry indefinitely');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 1; });
