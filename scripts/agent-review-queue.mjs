// Native process evidence carried through GitHub, without a model API or signer.
// Run trusted main's copy. Candidates are read as Git objects, never executed.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertAgentReviewFreshness, captureCommittedReviewCandidate, verifyAgentReview } from './agent-review-session.mjs';

const execute = promisify(execFile);
const REPOSITORY = 'openlup/openlup';
const REPOSITORY_ID = 1376035358;
const WORKFLOW = '.github/workflows/published-tree-ci.yml';
const DISPATCH = '.github/workflows/native-review-admission.yml';
const SHA = /^[a-f0-9]{40}$/u;
const LIMIT = 56000; // Reserve room for binding and JSON transport below 65,535.
const ARTIFACT_LIMIT = 60000;
function demand(ok, message) { if (!ok) throw new Error(`Native admission refused: ${message}`); }
function integer(n) { return Number.isSafeInteger(n) && n > 0; }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function parseNativeAdmission(bytes) {
  demand(typeof bytes === 'string' && Buffer.byteLength(bytes) <= LIMIT, 'receipt exceeds transport bound; do not truncate evidence');
  const value = JSON.parse(bytes);
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
    demand(run.head_sha === source.head && run.head_branch === pr.head.ref && run.head_repository?.id === pr.head.repo?.id && input.integration === null, 'PR run is not the source review target');
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
export async function verifyNativeAdmission({ cwd, api, input, expected, now = Date.now }) {
  const first = await observeNativeAdmission(api, input);
  if (expected) demand(equal(first, expected), 'target event/request binding changed');
  async function verify(state) {
    const candidate = await captureCommittedReviewCandidate(cwd, state.request.candidate.base, state.request.candidate.head);
    const result = await verifyAgentReview({ cwd, ...state, snapshot: async () => candidate, now });
    demand(result.status === 'reviewed', result.reason ?? 'complete independent native review is missing');
    return candidate;
  }
  await verify(input.source);
  if (first.event === 'merge_group') {
    // Entire-tree equality is an objective unchanged-code proof. Path disjointness
    // alone cannot exclude behavioural interactions with new main.
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
  await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', 'https://github.com/openlup/openlup.git', ...refs], { timeout: 120000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' } });
}
export async function readNativeAdmissionArtifact(api, input) {
  const name = `native-review-${input.targetRunId}-${input.targetAttempt}`;
  const listing = await api.get(`/repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`);
  demand(Array.isArray(listing.artifacts) && listing.total_count <= 100 && listing.artifacts.length === listing.total_count, 'receipt artifact pagination is incomplete');
  const artifacts = listing.artifacts.filter(artifact => !artifact.expired);
  demand(artifacts.length <= 1, 'multiple receipts for one run/attempt require regrouping');
  for (const artifact of artifacts.sort((a, b) => b.id - a.id)) {
    const run = await api.get(`/repos/${REPOSITORY}/actions/runs/${artifact.workflow_run.id}`);
    if (run.status !== 'completed') continue;
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
      const receipt = JSON.parse(output.stdout);
      demand(receipt && Object.keys(receipt).sort().join(',') === 'binding,input' && receipt.input.targetRunId === input.targetRunId && receipt.input.targetAttempt === input.targetAttempt && (input.prNumber === 0 || receipt.input.prNumber === input.prNumber), 'artifact target is stale');
      return receipt;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return null;
}
async function main() {
  const [verb, ...args] = process.argv.slice(2); const cwd = process.cwd();
  if (verb === 'input') {
    const [runId, attempt, pr, sourcePath, integrationPath] = args;
    const input = { version: 1, targetRunId: Number(runId), targetAttempt: Number(attempt), prNumber: Number(pr), source: JSON.parse(await readFile(sourcePath, 'utf8')), integration: integrationPath ? JSON.parse(await readFile(integrationPath, 'utf8')) : null };
    const receipt = JSON.stringify(input); parseNativeAdmission(receipt); console.log(JSON.stringify({ receipt })); return;
  }
  const api = apiTransport();
  if (verb === 'submit') {
    demand(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_REPOSITORY === REPOSITORY, 'submission must execute trusted main');
    const input = parseNativeAdmission(process.env.NATIVE_REVIEW_RECEIPT);
    const first = await observeNativeAdmission(api, input); await fetchObjects(cwd, input, first);
    const binding = await verifyNativeAdmission({ cwd, api, input, expected: first });
    await writeFile('receipt.json', JSON.stringify({ input, binding }));
    await writeFile(process.env.GITHUB_OUTPUT, `artifact=native-review-${input.targetRunId}-${input.targetAttempt}\n`, { flag: 'a' }); return;
  }
  demand(verb === 'wait' && process.env.GITHUB_REPOSITORY === REPOSITORY, 'use input, trusted submit, or admission wait');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const runId = Number(process.env.GITHUB_RUN_ID); const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  demand(integer(runId) && integer(attempt) && event.repository?.private === false, 'hosted target is invalid');
  const target = process.env.GITHUB_EVENT_NAME;
  const pr = target === 'pull_request' ? event.number : 0;
  demand(['pull_request', 'merge_group'].includes(target), 'event is unsupported');
  const start = Date.now();
  while (Date.now() - start < 20 * 60 * 1000) {
    // A group has no PR number in the event. The artifact input is only a hint;
    // authenticated queue membership below independently verifies it.
    const seed = { targetRunId: runId, targetAttempt: attempt, prNumber: pr };
    const receipt = await readNativeAdmissionArtifact(api, seed);
    if (receipt) {
      const input = parseNativeAdmission(JSON.stringify(receipt.input));
      demand(target === receipt.binding.event && (target !== 'pull_request' || event.pull_request?.head?.sha === receipt.binding.sourceHead) && (target !== 'merge_group' || event.action === 'checks_requested' && event.merge_group?.base_ref === 'refs/heads/main' && event.merge_group.base_sha === receipt.binding.base && event.merge_group.head_sha === receipt.binding.head && event.merge_group.head_ref === receipt.binding.ref && process.env.GITHUB_SHA === receipt.binding.head && process.env.GITHUB_REF === receipt.binding.ref), 'receipt differs from hosted event');
      await fetchObjects(cwd, input, receipt.binding);
      await verifyNativeAdmission({ cwd, api, input, expected: receipt.binding }); console.log('Native review admission verified for this exact run/attempt.'); return;
    }
    console.log(`needs_agent_review: submit native receipt for run ${runId}/${attempt}; no maintainer action required`);
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error('Native admission refused: bounded receipt wait expired; regroup, do not retry indefinitely');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 1; });
