// Native supervisor process evidence. This is not a signature, remote attestation,
// or proof that an author-controlled report file came from a platform agent.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { reviewTreeEntries, verifyReviewObjectGraph } from './agent-review-hook.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const INPUT_BYTES = 1024 * 1024;
const STATE_BYTES = 8 * 1024 * 1024;
const EVIDENCE = 'native-supervisor-process-evidence';
function demand(value, message) { if (!value) throw new Error(`Agent review required: ${message}`); }
function text(value, label, bound = 160) { demand(typeof value === 'string' && value.length > 0 && value.length <= bound && !/[\u0000-\u001f\u007f]/u.test(value), `${label} is invalid`); }
function exact(value, fields, label) { demand(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), `${label} schema is invalid`); }
function paths(values, allowEmpty = false) {
  demand(Array.isArray(values) && (allowEmpty || values.length > 0) && values.length <= 4096 && new Set(values).size === values.length, 'scope is invalid');
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
const REPAIR_RISKS = ['ordinary', 'security', 'control', 'schema', 'instructions', 'unknown'];
const MAX_REPAIRS = 2;
class NeedsRescope extends Error {}
function rescope(value, message) { if (!value) throw new NeedsRescope(`Agent review needs rescope: ${message}`); }
function sensitivePath(path) {
  return /^(?:\.github|config|db|supabase)(?:\/|$)/iu.test(path) || /\.sql$/iu.test(path) ||
    /(?:^|\/)(?:AGENTS|CLAUDE)(?:\.local)?\.(?:md|txt|rst)$/iu.test(path) ||
    /(?:^|\/)(?:CONTRIBUTING|SECURITY|AI_CONTRIBUTION_POLICY|AGENT_GUIDE)\.(?:md|txt|rst)$/iu.test(path) ||
    /^scripts\/(?:agent-review|check-|oss-|dco-|run-|packages\/)/iu.test(path) ||
    /^(?:package(?:-lock)?\.json|\.git(?:attributes|ignore)|.*(?:config|policy|security|auth|migration).*)$/iu.test(path) ||
    /^docs\/platform\/plans\/autonomous-reviewed-delivery/iu.test(path);
}
function requestRoles(intent, continuation) {
  if (continuation?.mode === 'closure') return ['closure'];
  const roles = [...intent.requiredRoles];
  const count = continuation ? 2 : intent.risk === 'prose' ? 1 : 2;
  for (const role of ['correctness', 'security']) if (roles.length < count && !roles.includes(role)) roles.push(role);
  return roles;
}
function validateFinding(finding) {
  const fields = ['mechanism', 'precondition', 'requirement', 'effect'];
  if (Object.hasOwn(finding ?? {}, 'risk')) fields.push('risk');
  exact(finding, fields, 'finding');
  for (const field of ['mechanism', 'precondition', 'requirement', 'effect']) text(finding[field], field, 4096);
  if (Object.hasOwn(finding, 'risk')) demand(REPAIR_RISKS.includes(finding.risk), 'finding risk is invalid');
}
function validateRequest(request) {
  const fields = ['version', 'evidence', 'id', 'authorSessionId', 'candidate', 'intent', 'roles', 'preparedAt'];
  if (request?.version === 2) fields.push('continuation');
  exact(request, fields, 'request');
  demand([1, 2].includes(request.version) && request.evidence === EVIDENCE, 'request version/evidence is invalid'); text(request.id, 'request ID'); text(request.authorSessionId, 'author session'); validateIntent(request.intent); validateCandidate(request.candidate);
  demand(Number.isSafeInteger(request.preparedAt) && request.preparedAt >= 0, 'request time is invalid');
  if (request.version === 2) {
    const continuation = request.continuation;
    exact(continuation, ['cycle', 'mode', 'priorDigest', 'deltaPaths', 'findings', 'repairRisk'], 'continuation');
    demand(Number.isSafeInteger(continuation.cycle) && continuation.cycle >= 1 && continuation.cycle <= MAX_REPAIRS && ['closure', 'focused', 'full'].includes(continuation.mode) && DIGEST.test(continuation.priorDigest), 'repair lineage is invalid');
    paths(continuation.deltaPaths, continuation.mode === 'full'); demand(continuation.mode === 'full' || continuation.deltaPaths.every(path => request.intent.scope.includes(path)), 'repair delta exceeds approved scope');
    demand(REPAIR_RISKS.includes(continuation.repairRisk), 'repair risk is invalid');
    demand(Array.isArray(continuation.findings) && continuation.findings.length <= 384, 'finding cards exceed bounds');
    const ids = new Set();
    for (const card of continuation.findings) { exact(card, ['id', 'finding'], 'finding card'); demand(DIGEST.test(card.id) && !ids.has(card.id), 'finding card ID is invalid or duplicated'); ids.add(card.id); validateFinding(card.finding); }
    if (continuation.mode === 'closure') demand(continuation.repairRisk === 'ordinary' && !continuation.deltaPaths.some(sensitivePath) && continuation.findings.every(card => card.finding.risk === 'ordinary'), 'sensitive or unknown repair/finding requires full reviews');
  }
  demand(equal(request.roles, requestRoles(request.intent, request.continuation)), 'request roles differ from approved risk floor');
  demand(request.candidate.changedPaths.every(path => request.intent.scope.includes(path)), 'candidate exceeds approved scope');
  if (request.intent.risk === 'prose') {
    const ordinaryDocuments = request.candidate.changedPaths.every(path => /\.(?:md|txt|rst)$/iu.test(path) && !sensitivePath(path));
    demand(ordinaryDocuments, 'prose risk cannot cover code, workflow, or control-instruction changes; automatically prepare fresh behavior reviews');
  }
}
export async function prepareAgentReview({ cwd, intent, authorSessionId, now = Date.now, snapshot = captureSessionCandidate, base }) {
  validateIntent(intent); text(authorSessionId, 'author session');
  const candidate = await snapshot(cwd, base); validateCandidate(candidate);
  const request = { version: 1, evidence: EVIDENCE, id: randomUUID(), authorSessionId, candidate, intent: structuredClone(intent), roles: requestRoles(intent), preparedAt: now() };
  validateRequest(request); return request;
}
function validateReport(request, report) {
  const fields = ['requestId', 'requestDigest', 'reviewerId', 'sessionId', 'role', 'cold', 'completedAt', 'candidate', 'complete', 'coveredScope', 'coveredCriteria', 'simplicityChecked', 'verdict', 'materialFindings'];
  if (Object.hasOwn(report ?? {}, 'advisoryFindings')) fields.push('advisoryFindings');
  if (request.version === 2) fields.push('closure');
  exact(report, fields, 'native agent report');
  demand(report.requestId === request.id && report.requestDigest === digest(request) && equal(report.candidate, request.candidate), 'report covers a different request or candidate');
  text(report.reviewerId, 'native reviewer ID'); text(report.sessionId, 'native session ID');
  demand(report.reviewerId !== request.authorSessionId && report.sessionId !== request.authorSessionId && report.cold === true && request.roles.includes(report.role), 'reviewer is author, not cold, or has an unrequested role');
  demand(Number.isSafeInteger(report.completedAt) && report.completedAt >= request.preparedAt, 'report predates request');
  demand(typeof report.complete === 'boolean' && typeof report.coveredCriteria === 'boolean' && typeof report.simplicityChecked === 'boolean' && ['pass', 'fail'].includes(report.verdict), 'report flags are invalid');
  const coverage = request.version === 2 && request.continuation.mode !== 'full' ? request.continuation.deltaPaths : [...new Set([...request.intent.scope, ...(request.continuation?.deltaPaths ?? [])])];
  paths(report.coveredScope); demand(equal([...report.coveredScope].sort(), [...coverage].sort()), 'review coverage differs from required scope');
  demand(Array.isArray(report.materialFindings) && report.materialFindings.length <= 64, 'findings exceed bounds'); report.materialFindings.forEach(validateFinding);
  if (Object.hasOwn(report, 'advisoryFindings')) { demand(Array.isArray(report.advisoryFindings) && report.advisoryFindings.length <= 64, 'advice exceeds bounds'); report.advisoryFindings.forEach(finding => text(finding, 'advice', 4096)); }
  if (request.version === 2) {
    exact(report.closure, ['coveredDelta', 'interactionsChecked', 'ordinarySemantics', 'resolvedFindings'], 'closure evidence');
    paths(report.closure.coveredDelta, request.continuation.mode === 'full'); demand(equal([...report.closure.coveredDelta].sort(), [...request.continuation.deltaPaths].sort()), 'closure coverage differs from actual repair delta');
    demand(typeof report.closure.interactionsChecked === 'boolean' && typeof report.closure.ordinarySemantics === 'boolean' && Array.isArray(report.closure.resolvedFindings) && report.closure.resolvedFindings.length <= 384 && new Set(report.closure.resolvedFindings).size === report.closure.resolvedFindings.length && report.closure.resolvedFindings.every(id => DIGEST.test(id)), 'closure flags/findings are invalid');
    demand(report.closure.resolvedFindings.every(id => request.continuation.findings.some(card => card.id === id)), 'closure resolves unknown finding cards');
  }
}
function reportPasses(request, report) {
  demand(report.complete && report.coveredCriteria && report.verdict === 'pass' && report.materialFindings.length === 0, 'review has incomplete coverage or unresolved material findings');
  if (request.version === 2) {
    demand(report.closure.interactionsChecked && equal([...report.closure.resolvedFindings].sort(), request.continuation.findings.map(card => card.id).sort()), 'repair interactions or material finding closure is incomplete');
    demand(request.continuation.mode !== 'closure' || report.closure.ordinarySemantics, 'closure reviewer found sensitive or unknown semantics; prepare full reviews');
  }
}
function validateRound(request, reports, { complete = false, time = Infinity, maxAgeMs = 86400000, identities = new Set() } = {}) {
  validateRequest(request); demand(Array.isArray(reports) && reports.length <= request.roles.length, 'report count is invalid');
  demand(time >= request.preparedAt && time - request.preparedAt <= maxAgeMs, 'review request expired');
  const roles = new Set();
  for (const report of reports) {
    validateReport(request, report); demand(report.completedAt <= time, 'report completion is in the future');
    demand(![report.reviewerId, report.sessionId].some(id => identities.has(id)) && !roles.has(report.role), 'reviewer/session/role is duplicated');
    identities.add(report.reviewerId); identities.add(report.sessionId); roles.add(report.role);
    if (complete) {
      demand(report.complete && report.coveredCriteria && (report.verdict === 'pass' || report.materialFindings.length > 0), 'prior review round is incomplete or failed without material evidence');
      if (report.verdict === 'pass' && report.materialFindings.length === 0) reportPasses(request, report);
    }
  }
  if (complete) demand(roles.size === request.roles.length && reports.some(report => report.simplicityChecked), 'prior review round lacks required coverage or simplicity');
  return identities;
}
function unresolvedCards(history) {
  const cards = new Map();
  for (const round of history) {
    let closed = round.reports.length === round.request.roles.length && round.reports.some(report => report.simplicityChecked);
    try { round.reports.forEach(report => reportPasses(round.request, report)); } catch { closed = false; }
    if (closed) for (const report of round.reports) for (const id of report.closure?.resolvedFindings ?? []) cards.delete(id);
    for (const report of round.reports) report.materialFindings.forEach((finding, index) => { const id = digest({ requestDigest: digest(round.request), reviewerId: report.reviewerId, index, finding }); cards.set(id, { id, finding: structuredClone(finding) }); });
  }
  return [...cards.values()];
}
function validateLineage(state, time, maxAgeMs) {
  const fields = Object.hasOwn(state ?? {}, 'history') ? ['request', 'reports', 'history'] : ['request', 'reports']; exact(state, fields, 'session state');
  const history = state.history ?? []; demand(Array.isArray(history) && history.length <= MAX_REPAIRS, 'repair history exceeds bounds');
  const allRounds = [...history, state];
  let anchor = 0;
  for (let index = 1; index < allRounds.length; index += 1) if (allRounds[index].request?.continuation?.mode === 'full') anchor = index;
  const identities = new Set();
  for (let index = 0; index <= history.length; index += 1) {
    const round = index === history.length ? state : history[index];
    if (index < history.length) exact(round, ['request', 'reports'], 'prior round');
    const request = round.request;
    validateRequest(request);
    if (index === 0) demand(request.version === 1, 'repair lineage root is missing');
    else {
      const previous = history[index - 1].request;
      demand(request.version === 2 && request.continuation.cycle === index && request.continuation.priorDigest === digest(history.slice(0, index)), 'repair lineage digest or cycle differs');
      demand(equal(request.continuation.findings, unresolvedCards(history.slice(0, index))), 'material finding cards were erased or altered');
      demand(equal(request.intent, previous.intent) && request.authorSessionId === previous.authorSessionId && (request.continuation.mode === 'full' || request.candidate.base === previous.candidate.base) && request.candidate.clean && (request.continuation.mode === 'full' || previous.candidate.clean) && (request.continuation.mode === 'full' || request.candidate.head !== previous.candidate.head && request.candidate.workingDigest !== previous.candidate.workingDigest) && request.preparedAt >= previous.preparedAt && history[index - 1].reports.every(report => report.completedAt <= request.preparedAt), 'repair criteria, scope, base, or committed lineage differs');
    }
    validateRound(request, round.reports, { complete: index < history.length && (index + 1 < history.length ? history[index + 1].request : state.request).continuation.mode !== 'full', time, maxAgeMs: index < anchor ? Infinity : maxAgeMs, identities });
  }
  return { history, identities };
}
/** Authenticate ancestor commits and compare tree entries, including deletions and modes. */
export async function captureAgentReviewDelta(cwd, previous, candidate) {
  const graph = await verifyReviewObjectGraph(cwd, { base: previous.head, head: candidate.head, tree: candidate.tree });
  demand(graph.baseTree === previous.tree, 'prior tree differs from authenticated commit');
  const before = new Map(reviewTreeEntries(graph, graph.baseTree).map(entry => [entry.path, entry]));
  const after = new Map(reviewTreeEntries(graph, graph.headTree).map(entry => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.mode !== after.get(path)?.mode || before.get(path)?.object !== after.get(path)?.object).sort();
}
async function current(request, cwd, snapshot) { validateRequest(request); demand(equal(await snapshot(cwd, request.candidate.base), request.candidate), 'candidate changed; prepare fresh independent reviews'); }
async function currentLineage(cwd, state, delta) {
  const rounds = [...(state.history ?? []), state];
  for (let index = 1; index < rounds.length; index += 1) demand(equal(await delta(cwd, rounds[index - 1].request.candidate, rounds[index].request.candidate), rounds[index].request.continuation.deltaPaths), 'actual committed repair delta differs from lineage');
}
/** Prepare is idempotent; continuation never erases findings or restarts its budget. */
export async function prepareAgentReviewState({ previous, repairRisk = 'unknown', fullRefresh = false, delta = captureAgentReviewDelta, maxAgeMs = 86400000, ...options }) {
  demand(REPAIR_RISKS.includes(repairRisk) && typeof fullRefresh === 'boolean', 'repair risk or refresh is invalid');
  const request = await prepareAgentReview(options);
  if (!previous) return { request, reports: [] };
  const now = options.now ?? Date.now; const time = now();
  // Validate bindings before reusing any state, including failed/partial unchanged rounds.
  validateLineage(previous, time, Infinity); await currentLineage(options.cwd, previous, delta);
  rescope(equal(previous.request.intent, request.intent) && previous.request.authorSessionId === request.authorSessionId, 'approved intent or author changed; a changed execution approach is required');
  if (equal(previous.request.candidate, request.candidate)) {
    if (!fullRefresh) return structuredClone(previous);
    // Recovery is unnecessary for a terminal current pass, even if requested.
    let reviewed = true;
    try { validateLineage(previous, time, maxAgeMs); validateRound(previous.request, previous.reports, { complete: true, time, maxAgeMs }); previous.reports.forEach(report => reportPasses(previous.request, report)); } catch { reviewed = false; }
    if (reviewed) return structuredClone(previous);
  }
  rescope((previous.history?.length ?? 0) < MAX_REPAIRS, 'two automatic repair cycles are exhausted; change execution approach');
  demand(request.candidate.clean, 'repair requires clean committed candidates');
  let priorComplete = previous.request.candidate.clean;
  try { validateLineage(previous, time, maxAgeMs); validateRound(previous.request, previous.reports, { complete: true, time, maxAgeMs }); } catch { priorComplete = false; }
  const history = [...(previous.history ?? []), { request: previous.request, reports: previous.reports }];
  let deltaPaths;
  try { deltaPaths = await delta(options.cwd, previous.request.candidate, request.candidate); } catch (error) { if (error.message.includes('not an authenticated ancestor')) throw new NeedsRescope('Agent review needs rescope: nonancestor integration requires a changed execution approach'); throw error; }
  const findings = unresolvedCards(history);
  const mode = fullRefresh || !priorComplete || previous.request.candidate.base !== request.candidate.base ? 'full' : repairRisk === 'ordinary' && !deltaPaths.some(sensitivePath) && findings.every(card => card.finding.risk === 'ordinary') ? 'closure' : 'focused';
  paths(deltaPaths, mode === 'full');
  request.version = 2; request.continuation = { cycle: history.length, mode, priorDigest: digest(history), deltaPaths, findings, repairRisk }; request.roles = requestRoles(request.intent, request.continuation);
  const state = { request, reports: [], history: structuredClone(history) }; validateLineage(state, time, maxAgeMs); return state;
}
export async function recordAgentReview({ cwd, request, reports = [], history, report, snapshot = captureSessionCandidate, delta = captureAgentReviewDelta, now = Date.now }) {
  const state = { request, reports, ...(history ? { history } : {}) }; const { identities } = validateLineage(state, now(), 86400000);
  await current(request, cwd, snapshot); await currentLineage(cwd, state, delta); validateReport(request, report);
  demand(report.completedAt <= now(), 'report completion is in the future'); demand(reports.length < request.roles.length, 'report count exceeds requested roles');
  demand(!reports.some(previous => previous.role === report.role) && ![report.reviewerId, report.sessionId].some(id => identities.has(id)), 'reviewer/session/role is duplicated; findings cannot be overwritten');
  return [...structuredClone(reports), structuredClone(report)];
}
/** Return actionable needs without asking a maintainer to approve a verdict. */
export async function verifyAgentReview({ cwd, request, reports = [], history, snapshot = captureSessionCandidate, delta = captureAgentReviewDelta, now = Date.now, maxAgeMs = 86400000 }) {
  try {
    demand(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 86400000, 'review freshness bound is invalid');
    const state = { request, reports, ...(history ? { history } : {}) }; validateLineage(state, now(), maxAgeMs);
    const observed = await snapshot(cwd, request.candidate.base);
    if (!equal(observed, request.candidate) && (history?.length ?? 0) >= MAX_REPAIRS) throw new NeedsRescope('Agent review needs rescope: two automatic repair cycles are exhausted; change execution approach');
    demand(equal(observed, request.candidate), 'candidate changed; prepare fresh independent reviews');
    demand(request.candidate.clean, 'final review requires a clean committed candidate; commit and prepare fresh reviews'); await currentLineage(cwd, state, delta);
    reports.forEach(report => reportPasses(request, report));
    const missingRoles = request.roles.filter(role => !reports.some(report => report.role === role));
    if (missingRoles.length) return { status: 'needs_agent_review', evidence: EVIDENCE, request, missingRoles, reason: 'Spawn fresh native platform agents for these roles, then record their observed reports.' };
    demand(reports.some(report => report.simplicityChecked), 'simplicity perspective is missing');
    await current(request, cwd, snapshot);
    const finalTime = now();
    try { validateLineage(state, finalTime, maxAgeMs); } catch { throw new Error('Agent review required: review expired or clock changed during final source scan'); }
    return { status: 'reviewed', evidence: EVIDENCE, requestId: request.id, requestDigest: digest(request), candidate: request.candidate, reviewerIds: reports.map(report => report.reviewerId), verifiedAt: finalTime };
  } catch (error) { return { status: error instanceof NeedsRescope ? 'needs_rescope' : 'needs_agent_review', evidence: EVIDENCE, reason: error.message, requestId: request?.id ?? null }; }
}
export function agentReviewReportBinding(request) { validateRequest(request); return { requestId: request.id, requestDigest: digest(request), candidate: structuredClone(request.candidate) }; }

async function boundedJson(path, maximum = INPUT_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat(); demand(metadata.isFile() && metadata.size <= maximum, 'input is not bounded JSON');
    const bytes = Buffer.alloc(maximum + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat();
    demand(bytesRead === metadata.size && after.size === metadata.size && after.mtimeMs === metadata.mtimeMs && after.ctimeMs === metadata.ctimeMs, 'JSON input changed or exceeds bounds');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}
async function sessionDirectory(cwd, create = false) {
  demand(await realpath(cwd) === cwd && (await lstat(cwd)).isDirectory(), 'checkout directory is not canonical');
  let directory = cwd;
  for (const name of ['.context', 'scratch', 'agent-review']) {
    directory = join(directory, name);
    let metadata;
    try { metadata = await lstat(directory); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      // Validate the existing parent before each individual mkdir. Never use a
      // recursive mkdir through an unchecked operational-directory ancestor.
      demand(await realpath(dirname(directory)) === dirname(directory), 'session ancestor is a symlink');
      await mkdir(directory, { mode: 0o700 }); metadata = await lstat(directory);
    }
    demand(metadata.isDirectory() && !metadata.isSymbolicLink() && await realpath(directory) === directory, 'session ancestor is a symlink or not a directory');
  }
}
export function serializeAgentReviewState(state) {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  demand(Buffer.byteLength(serialized) <= STATE_BYTES, 'aggregate session state exceeds 8 MiB; previous state is preserved');
  return serialized;
}
async function saveState(cwd, directory, path, state) {
  const serialized = serializeAgentReviewState(state);
  await sessionDirectory(cwd, true);
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = undefined;
    await sessionDirectory(cwd);
    // Replacing a directory entry never truncates the old inode or any of its
    // hardlinks. The temporary inode is created exclusively in this directory.
    await rename(temporary, path);
  } finally { if (handle) await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function sessionTransaction(cwd, directory, operation) {
  await sessionDirectory(cwd, true);
  const path = join(directory, '.session.lock');
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Agent review required: session transaction is busy; retry after the active prepare/record finishes. Existing locks are never stolen.'); throw error; }
  try { return await operation(); }
  finally { await handle.close(); await unlink(path); }
}
async function main() {
  const [verb, input] = process.argv.slice(2); demand(['prepare', 'record', 'verify', 'status'].includes(verb), 'use prepare <intent.json>, record <observed-report.json>, verify, or status');
  const cwd = await realpath(process.cwd()); const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  await sessionDirectory(cwd);
  const operation = async () => {
  if (verb === 'prepare') {
    const spec = await boundedJson(input ?? join(directory, 'intent.json'));
    demand(Object.keys(spec).every(key => ['intent', 'authorSessionId', 'base', 'repairRisk', 'fullRefresh'].includes(key)) && Object.hasOwn(spec, 'intent'), 'supervisor request schema is invalid');
    spec.authorSessionId ??= process.env.CODEX_THREAD_ID; spec.base ??= (await git(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
    let previous; try { previous = await boundedJson(path, STATE_BYTES); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state;
    try { state = await prepareAgentReviewState({ cwd, ...spec, previous }); }
    catch (error) { if (!(error instanceof NeedsRescope)) throw error; console.log(JSON.stringify({ status: 'needs_rescope', evidence: EVIDENCE, reason: error.message })); process.exitCode = 1; return; }
    if (!equal(state, previous)) await saveState(cwd, directory, path, state);
    console.log(JSON.stringify(await verifyAgentReview({ cwd, ...state }), null, 2));
  } else {
    let state; try { state = await boundedJson(path, STATE_BYTES); } catch (error) { if (error.code === 'ENOENT') {
      const baseline = await pristineAgentReviewBaseline(cwd);
      const result = baseline.pristine ? { status: 'pristine_baseline', evidence: EVIDENCE, candidate: baseline.candidate } : { status: 'needs_agent_review', evidence: EVIDENCE, reason: 'Prepare a request from the approved intent before native review.' };
      console.log(JSON.stringify(result)); process.exitCode = verb === 'verify' && !baseline.pristine ? 1 : 0; return;
    } throw error; }
    validateLineage(state, Date.now(), Infinity);
    if (verb === 'record') { state.reports = await recordAgentReview({ cwd, ...state, report: await boundedJson(input) }); await saveState(cwd, directory, path, state); }
    const result = await verifyAgentReview({ cwd, ...state }); console.log(JSON.stringify(result, null, 2)); if (verb === 'verify' && result.status !== 'reviewed') process.exitCode = 1;
  }
  };
  if (verb === 'prepare' || verb === 'record') await sessionTransaction(cwd, directory, operation); else await operation();
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 1; });
