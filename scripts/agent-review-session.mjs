// Native supervisor process evidence. This is not a signature, remote attestation,
// or proof that an author-controlled report file came from a platform agent.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { reviewTreeEntries, verifyReviewObjectGraph } from './agent-review-hook.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const EVIDENCE = 'native-supervisor-process-evidence';
function demand(value, message) { if (!value) throw new Error(`Agent review required: ${message}`); }
function text(value, label, bound = 160) { demand(typeof value === 'string' && value.length > 0 && value.length <= bound && !/[\u0000-\u001f\u007f]/u.test(value), `${label} is invalid`); }
function exact(value, fields, label) { demand(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), `${label} schema is invalid`); }
function paths(values) {
  demand(Array.isArray(values) && values.length > 0 && values.length <= 4096 && new Set(values).size === values.length, 'scope is invalid');
  for (const value of values) { text(value, 'scope path', 4096); demand(!isAbsolute(value) && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !value.includes('\\'), 'scope path escapes checkout'); }
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function git(cwd, ...args) {
  const { stdout } = await execute('/usr/bin/git', ['--no-replace-objects', '--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, ...args], { env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null' }, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Snapshot actual source bytes without executing candidate filters or tools.
 * Ignored local artifacts are outside the source inventory. Dirty tracked and
 * ordinary untracked source is included, including staged changes and deletes.
 */
export async function captureSessionCandidate(cwd, base) {
  cwd = await realpath(cwd);
  base ??= (await git(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
  demand(SHA.test(base), 'base must be a full commit digest');
  const head = (await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const tree = (await git(cwd, 'rev-parse', '--verify', 'HEAD^{tree}')).trim();
  demand((await git(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim() === base, 'base differs from observed origin/main');
  const graph = await verifyReviewObjectGraph(cwd, { head, tree, base });
  const flags = (await git(cwd, 'ls-files', '-v', '-z')).split('\0').filter(Boolean);
  demand(flags.every(entry => entry[0] !== 'S' && entry[0] === entry[0].toUpperCase()), 'index flags conceal source');
  const index = (await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean).sort();
  const indexed = index.map(entry => { const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t(.+)$/u.exec(entry); demand(match, 'index contains unsupported modes or unresolved conflicts'); return match[3]; });
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const headEntries = reviewTreeEntries(graph, graph.headTree);
  const baseline = new Map(reviewTreeEntries(graph, graph.baseTree).map(entry => [entry.path, entry]));
  const inventory = [...new Set([...reviewTreeEntries(graph, graph.headTree).map(entry => entry.path), ...indexed, ...untracked])].sort();
  demand(inventory.length <= 30000, 'source inventory exceeds bounds');
  let total = 0;
  const actual = new Map();
  for (const name of inventory) {
    paths([name]);
    const path = join(cwd, name); const part = relative(cwd, path);
    demand(!part.startsWith(`..${sep}`), 'source escapes checkout');
    let metadata;
    try { metadata = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    demand(await realpath(dirname(path)) === dirname(path), 'source ancestor is a symlink');
    let bytes; let mode;
    if (metadata.isSymbolicLink()) { bytes = await readlink(path, { encoding: 'buffer' }); mode = '120000'; }
    else {
      demand(metadata.isFile() && metadata.size <= 128 * 1024 * 1024, 'source is not a bounded regular file');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat(); demand(before.isFile() && before.size === metadata.size && before.size <= 128 * 1024 * 1024, 'source changed while opening');
        bytes = await handle.readFile(); const after = await handle.stat();
        demand(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, 'source changed while reading');
        mode = before.mode & 0o100 ? '100755' : '100644';
      } finally { await handle.close(); }
    }
    total += bytes.length; demand(total <= 128 * 1024 * 1024, 'source bytes exceed bounds');
    actual.set(name, { path: name, mode, object: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
  }
  const changedPaths = [...new Set([...baseline.keys(), ...actual.keys()])].filter(name => baseline.get(name)?.mode !== actual.get(name)?.mode || baseline.get(name)?.object !== actual.get(name)?.object).sort();
  demand((await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim() === head && equal((await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean).sort(), index), 'candidate changed during source scan');
  const expectedIndex = headEntries.map(entry => `${entry.mode} ${entry.object} 0\t${entry.path}`).sort();
  const committed = new Map(headEntries.map(entry => [entry.path, entry]));
  const clean = equal(index, expectedIndex) && actual.size === committed.size && [...actual].every(([name, entry]) => entry.mode === committed.get(name)?.mode && entry.object === committed.get(name)?.object);
  return { base, head, tree, clean, workingDigest: digest([...actual.values()]), indexDigest: digest({ index, flags: flags.sort() }), changedPaths };
}

function validateIntent(intent) {
  exact(intent, ['risk', 'scope', 'criteria', 'requiredRoles'], 'approved intent');
  demand(['prose', 'behavior', 'unknown'].includes(intent.risk), 'risk is invalid'); paths(intent.scope); text(intent.criteria, 'criteria', 64 * 1024);
  demand(Array.isArray(intent.requiredRoles) && intent.requiredRoles.length <= (intent.risk === 'prose' ? 1 : 2) && new Set(intent.requiredRoles).size === intent.requiredRoles.length, 'required roles exceed proportional floor');
  intent.requiredRoles.forEach(role => text(role, 'role'));
}
export async function pristineAgentReviewBaseline(cwd) {
  const candidate = await captureSessionCandidate(cwd);
  return { pristine: candidate.clean && candidate.head === candidate.base && candidate.changedPaths.length === 0, candidate };
}

function validateCandidate(candidate) {
  exact(candidate, ['base', 'head', 'tree', 'clean', 'workingDigest', 'indexDigest', 'changedPaths'], 'candidate');
  demand(['base', 'head', 'tree'].every(field => SHA.test(candidate[field])) && ['workingDigest', 'indexDigest'].every(field => DIGEST.test(candidate[field])), 'candidate digest is invalid'); demand(typeof candidate.clean === 'boolean', 'candidate clean flag is invalid'); paths(candidate.changedPaths);
}
function validateRequest(request) {
  exact(request, ['version', 'evidence', 'id', 'authorSessionId', 'candidate', 'intent', 'roles', 'preparedAt'], 'request');
  demand(request.version === 1 && request.evidence === EVIDENCE, 'request version/evidence is invalid'); text(request.id, 'request ID'); text(request.authorSessionId, 'author session'); validateIntent(request.intent); validateCandidate(request.candidate);
  demand(Number.isSafeInteger(request.preparedAt) && request.preparedAt >= 0, 'request time is invalid');
  const roles = [...request.intent.requiredRoles];
  for (const role of ['correctness', 'security']) if (roles.length < (request.intent.risk === 'prose' ? 1 : 2) && !roles.includes(role)) roles.push(role);
  demand(equal(request.roles, roles), 'request roles differ from approved risk floor');
  demand(request.candidate.changedPaths.every(path => request.intent.scope.includes(path)), 'candidate exceeds approved scope');
}
export async function prepareAgentReview({ cwd, intent, authorSessionId, now = Date.now, snapshot = captureSessionCandidate, base }) {
  validateIntent(intent); text(authorSessionId, 'author session');
  const candidate = await snapshot(cwd, base); validateCandidate(candidate);
  const roles = [...intent.requiredRoles];
  for (const role of ['correctness', 'security']) if (roles.length < (intent.risk === 'prose' ? 1 : 2) && !roles.includes(role)) roles.push(role);
  const request = { version: 1, evidence: EVIDENCE, id: randomUUID(), authorSessionId, candidate, intent: structuredClone(intent), roles, preparedAt: now() };
  validateRequest(request); return request;
}
function validateReport(request, report) {
  exact(report, ['requestId', 'requestDigest', 'reviewerId', 'sessionId', 'role', 'cold', 'completedAt', 'candidate', 'complete', 'coveredScope', 'coveredCriteria', 'simplicityChecked', 'verdict', 'materialFindings'], 'native agent report');
  demand(report.requestId === request.id && report.requestDigest === digest(request) && equal(report.candidate, request.candidate), 'report covers a different request or candidate');
  text(report.reviewerId, 'native reviewer ID'); text(report.sessionId, 'native session ID');
  demand(report.reviewerId !== request.authorSessionId && report.sessionId !== request.authorSessionId && report.cold === true && request.roles.includes(report.role), 'reviewer is author, not cold, or has an unrequested role');
  demand(Number.isSafeInteger(report.completedAt) && report.completedAt >= request.preparedAt, 'report predates request');
  demand(typeof report.complete === 'boolean' && typeof report.coveredCriteria === 'boolean' && typeof report.simplicityChecked === 'boolean' && ['pass', 'fail'].includes(report.verdict), 'report flags are invalid');
  paths(report.coveredScope); demand(equal([...report.coveredScope].sort(), [...request.intent.scope].sort()), 'review coverage differs from approved scope');
  demand(Array.isArray(report.materialFindings) && report.materialFindings.length <= 64, 'findings exceed bounds');
  for (const finding of report.materialFindings) { exact(finding, ['mechanism', 'precondition', 'requirement', 'effect'], 'finding'); for (const field of Object.keys(finding)) text(finding[field], field, 4096); }
}
async function current(request, cwd, snapshot) { validateRequest(request); demand(equal(await snapshot(cwd, request.candidate.base), request.candidate), 'candidate changed; prepare fresh independent reviews'); }
export async function recordAgentReview({ cwd, request, reports = [], report, snapshot = captureSessionCandidate, now = Date.now }) {
  await current(request, cwd, snapshot); validateReport(request, report);
  demand(report.completedAt <= now(), 'report completion is in the future');
  demand(Array.isArray(reports) && reports.length < request.roles.length, 'report count exceeds requested roles');
  for (const previous of reports) { validateReport(request, previous); demand(previous.role !== report.role && ![previous.reviewerId, previous.sessionId].some(id => [report.reviewerId, report.sessionId].includes(id)), 'reviewer/session/role is duplicated; findings cannot be overwritten'); }
  return [...structuredClone(reports), structuredClone(report)];
}
/** Return actionable needs without asking a maintainer to approve a verdict. */
export async function verifyAgentReview({ cwd, request, reports = [], snapshot = captureSessionCandidate, now = Date.now, maxAgeMs = 24 * 60 * 60 * 1000 }) {
  try {
    await current(request, cwd, snapshot);
    demand(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 24 * 60 * 60 * 1000, 'review freshness bound is invalid');
    demand(request.candidate.clean, 'final review requires a clean committed candidate; commit and prepare fresh reviews');
    const time = now(); demand(time >= request.preparedAt && time - request.preparedAt <= maxAgeMs, 'review request expired');
    demand(Array.isArray(reports) && reports.length <= request.roles.length, 'report count is invalid');
    const ids = new Set(); const sessions = new Set(); const roles = new Set();
    for (const report of reports) {
      validateReport(request, report); demand(report.completedAt <= time, 'report completion is in the future');
      demand(![report.reviewerId, report.sessionId].some(id => ids.has(id) || sessions.has(id)) && !roles.has(report.role), 'reviewer/session/role is duplicated');
      ids.add(report.reviewerId); sessions.add(report.sessionId); roles.add(report.role);
      demand(report.complete && report.coveredCriteria && report.verdict === 'pass' && report.materialFindings.length === 0, 'review has incomplete coverage or unresolved material findings');
    }
    const missingRoles = request.roles.filter(role => !roles.has(role));
    if (missingRoles.length) return { status: 'needs_agent_review', evidence: EVIDENCE, request, missingRoles, reason: 'Spawn fresh native platform agents for these roles, then record their observed reports.' };
    demand(reports.some(report => report.simplicityChecked), 'simplicity perspective is missing');
    await current(request, cwd, snapshot);
    const finalTime = now(); demand(finalTime >= request.preparedAt && finalTime - request.preparedAt <= maxAgeMs && reports.every(report => report.completedAt <= finalTime), 'review expired or clock changed during final source scan');
    return { status: 'reviewed', evidence: EVIDENCE, requestId: request.id, requestDigest: digest(request), candidate: request.candidate, reviewerIds: [...ids], verifiedAt: finalTime };
  } catch (error) { return { status: 'needs_agent_review', evidence: EVIDENCE, reason: error.message, requestId: request?.id ?? null }; }
}
export function agentReviewReportBinding(request) { validateRequest(request); return { requestId: request.id, requestDigest: digest(request), candidate: structuredClone(request.candidate) }; }

async function boundedJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat(); demand(metadata.isFile() && metadata.size <= 1024 * 1024, 'input is not bounded JSON');
    const bytes = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat();
    demand(bytesRead === metadata.size && after.size === metadata.size && after.mtimeMs === metadata.mtimeMs && after.ctimeMs === metadata.ctimeMs, 'JSON input changed or exceeds bounds');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}
async function saveState(directory, path, state) {
  await mkdir(directory, { recursive: true }); demand(await realpath(directory) === directory, 'session directory is a symlink');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { demand((await handle.stat()).isFile(), 'session state is not regular'); await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); } finally { await handle.close(); }
}
async function main() {
  const [verb, input] = process.argv.slice(2); demand(['prepare', 'record', 'verify', 'status'].includes(verb), 'use prepare <intent.json>, record <observed-report.json>, verify, or status');
  const cwd = await realpath(process.cwd()); const directory = join(cwd, '.context'); const path = join(directory, 'agent-review-session.json');
  if (verb === 'prepare') {
    const spec = await boundedJson(input ?? join(directory, 'agent-review-intent.json'));
    demand(Object.keys(spec).every(key => ['intent', 'authorSessionId', 'base'].includes(key)) && Object.hasOwn(spec, 'intent'), 'supervisor request schema is invalid');
    spec.authorSessionId ??= process.env.CODEX_THREAD_ID; spec.base ??= (await git(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
    const request = await prepareAgentReview({ cwd, ...spec });
    let previous; try { previous = await boundedJson(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    demand(!previous?.reports?.some(report => report.materialFindings?.length > 0) || previous.request.candidate.workingDigest !== request.candidate.workingDigest, 'unresolved material findings require a changed source candidate before fresh review');
    await saveState(directory, path, { request, reports: [] });
    console.log(JSON.stringify(await verifyAgentReview({ cwd, request }), null, 2));
  } else {
    let state; try { state = await boundedJson(path); } catch (error) { if (error.code === 'ENOENT') {
      const baseline = await pristineAgentReviewBaseline(cwd);
      const result = baseline.pristine ? { status: 'pristine_baseline', evidence: EVIDENCE, candidate: baseline.candidate } : { status: 'needs_agent_review', evidence: EVIDENCE, reason: 'Prepare a request from the approved intent before native review.' };
      console.log(JSON.stringify(result)); process.exitCode = verb === 'verify' && !baseline.pristine ? 1 : 0; return;
    } throw error; }
    exact(state, ['request', 'reports'], 'session state');
    if (verb === 'record') { state.reports = await recordAgentReview({ cwd, ...state, report: await boundedJson(input) }); await saveState(directory, path, state); }
    const result = await verifyAgentReview({ cwd, ...state }); console.log(JSON.stringify(result, null, 2)); if (verb === 'verify' && result.status !== 'reviewed') process.exitCode = 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 1; });
