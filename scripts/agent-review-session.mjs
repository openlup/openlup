// Native supervisor process evidence. This is not a signature, remote attestation,
// or proof that an author-controlled report file came from a platform agent.
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { env as processEnvironment } from 'node:process';
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

/** The review base is the candidate's fork point: the single merge base of HEAD
 * and the observed origin/main. An explicitly pinned predecessor may be ahead
 * of that fork point on HEAD's ancestry; hosted admission waits for it on main.
 */
async function forkPoint(cwd) {
  let bases;
  try { bases = (await git(cwd, '-c', 'core.commitGraph=false', 'merge-base', '--all', 'HEAD', 'origin/main^{commit}')).split('\n').filter(Boolean); } catch { bases = []; }
  demand(bases.length === 1 && SHA.test(bases[0]), 'HEAD has no single fork point with observed origin/main');
  return bases[0];
}

/** Snapshot actual source bytes without executing candidate filters or tools.
 * Ignored local artifacts are outside the source inventory. Dirty tracked and
 * ordinary untracked source is included, including staged changes and deletes.
 */
export async function captureSessionCandidate(cwd, base) {
  cwd = await realpath(cwd);
  const pinned = processEnvironment.OPENLUP_STACK_BASE;
  demand(pinned === undefined || SHA.test(pinned), 'OPENLUP_STACK_BASE must be a full commit digest');
  demand(pinned === undefined || base === undefined || base === pinned, 'stack base differs from the prepared review base');
  base ??= pinned ?? await forkPoint(cwd);
  demand(SHA.test(base), 'base must be a full commit digest');
  const head = (await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const tree = (await git(cwd, 'rev-parse', '--verify', 'HEAD^{tree}')).trim();
  const fork = await forkPoint(cwd);
  try { demand(pinned !== undefined || fork === base, 'fork point changed'); await git(cwd, 'merge-base', '--is-ancestor', fork, base); }
  catch { throw new Error('Agent review required: base is no longer the fork point or its pinned descendant on HEAD; prepare again'); }
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
  return { base, head, tree, clean, workingDigest: digest([...actual.values()]), indexDigest: digest({ index, flags: flags.sort() }), changedPaths, ...(pinned === undefined ? {} : { stackBase: pinned }) };
}

/** Read a committed candidate as data, without checking it out or executing its
 * configuration. Hosted admission must not run a candidate with write tokens.
 * The reconstructed clean index uses the same canonical digests as local review.
 */
export async function captureCommittedReviewCandidate(cwd, base, head, stackBase) {
  demand(stackBase === undefined || stackBase === base, 'stack base differs from the prepared review base');
  const graph = await verifyReviewObjectGraph(cwd, { base, head });
  const entries = reviewTreeEntries(graph, graph.headTree).map(({ path, mode, object }) => ({ path, mode, object })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const before = new Map(reviewTreeEntries(graph, graph.baseTree).map(entry => [entry.path, entry]));
  const after = new Map(entries.map(entry => [entry.path, entry]));
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path)?.object !== after.get(path)?.object || before.get(path)?.mode !== after.get(path)?.mode);
  // Inventory and task scope have different bounds: a small task can review a
  // large tree. The authenticated reader already caps the inventory at 30,000.
  for (const entry of entries) paths([entry.path]);
  const index = entries.map(entry => `${entry.mode} ${entry.object} 0\t${entry.path}`).sort();
  const flags = entries.map(entry => `H ${entry.path}`).sort();
  return { base, head, tree: graph.headTree, clean: true, workingDigest: digest(entries), indexDigest: digest({ index, flags }), changedPaths, ...(stackBase === undefined ? {} : { stackBase }) };
}

function validateIntent(intent) {
  exact(intent, ['risk', 'scope', 'criteria', 'requiredRoles'], 'approved intent');
  demand(['prose', 'routine', 'behavior', 'unknown'].includes(intent.risk), 'risk is invalid'); paths(intent.scope); text(intent.criteria, 'criteria', 64 * 1024);
  demand(Array.isArray(intent.requiredRoles) && intent.requiredRoles.length <= (['prose', 'routine'].includes(intent.risk) ? 1 : 2) && new Set(intent.requiredRoles).size === intent.requiredRoles.length, 'required roles exceed proportional floor');
  if (intent.risk === 'routine') demand(intent.requiredRoles.length === 0 || intent.requiredRoles[0] === 'correctness', 'routine review requires a correctness reviewer');
  intent.requiredRoles.forEach(role => text(role, 'role'));
}
export async function pristineAgentReviewBaseline(cwd) {
  const candidate = await captureSessionCandidate(cwd);
  return { pristine: candidate.clean && candidate.head === candidate.base && candidate.changedPaths.length === 0, candidate };
}

function validateCandidate(candidate) {
  demand(candidate && typeof candidate === 'object', 'candidate schema is invalid');
  exact(candidate, ['base', 'head', 'tree', 'clean', 'workingDigest', 'indexDigest', 'changedPaths', ...(Object.hasOwn(candidate, 'stackBase') ? ['stackBase'] : [])], 'candidate');
  demand(!Object.hasOwn(candidate, 'stackBase') || candidate.stackBase === candidate.base, 'candidate stack base differs');
  demand(['base', 'head', 'tree'].every(field => SHA.test(candidate[field])) && ['workingDigest', 'indexDigest'].every(field => DIGEST.test(candidate[field])), 'candidate digest is invalid'); demand(typeof candidate.clean === 'boolean', 'candidate clean flag is invalid'); paths(candidate.changedPaths);
}
const REPAIR_RISKS = ['ordinary', 'security', 'control', 'schema', 'instructions', 'unknown'];
// Cycles 1-3 are automatic. After a cycle 3 that did not pass, a rethink record
// unlocks two more automatic cycles; cycle 6 needs an explicit owner continuation.
const RETHINK_CYCLE = 4;
const OWNER_CYCLE = 6;
const MAX_CYCLES = 6;
const FULL_CYCLES = [3, RETHINK_CYCLE, OWNER_CYCLE];
const RETHINK_DECISIONS = ['keep', 'change', 'narrow', 'intent'];
class NeedsRescope extends Error {}
function rescope(value, message) { if (!value) throw new NeedsRescope(`Agent review needs rescope: ${message}`); }
// Explicit owner regrouping is process evidence, not an authenticated owner signature.
function validateRegroup(regroup) {
  exact(regroup, ['priorRequestDigest', 'priorIntentDigest', 'nextIntentDigest', 'ownerDecision'], 'owner regroup');
  demand(['priorRequestDigest', 'priorIntentDigest', 'nextIntentDigest'].every(field => DIGEST.test(regroup[field])), 'owner regroup digest is invalid');
  text(regroup.ownerDecision, 'owner regroup decision', 4096);
}
function assertRegroup(regroup, previous, request) {
  validateRegroup(regroup);
  demand(regroup.priorRequestDigest === digest(previous) && regroup.priorIntentDigest === digest(previous.intent) && regroup.nextIntentDigest === digest(request.intent), 'owner regroup differs from exact previous request or approved intent');
  demand(!equal(previous.intent, request.intent) && previous.authorSessionId === request.authorSessionId && ['behavior', 'unknown'].includes(request.intent.risk) && previous.intent.scope.every(path => request.intent.scope.includes(path)) && request.intent.scope.some(path => !previous.intent.scope.includes(path)), 'owner regroup requires same author, expanded scope and full review risk');
}
// Owner continuation is process evidence, not an authenticated owner signature.
function validateOwnerContinuation(approval) {
  exact(approval, ['priorRequestDigest', 'candidateDigest', 'ownerDecision'], 'owner continuation');
  demand(DIGEST.test(approval.priorRequestDigest) && DIGEST.test(approval.candidateDigest), 'owner continuation digest is invalid');
  text(approval.ownerDecision, 'owner continuation decision', 4096);
}
function assertOwnerContinuation(approval, previous, request, regroup) {
  validateOwnerContinuation(approval);
  demand(approval.priorRequestDigest === digest(previous) && approval.candidateDigest === digest(request.candidate), 'owner continuation differs from exact previous request or candidate');
  demand((equal(previous.intent, request.intent) || regroup) && previous.authorSessionId === request.authorSessionId, 'owner continuation requires unchanged intent and author, or an owner regroup');
}
// A rethink is the supervisor's process evidence with one fresh cold simplicity
// reviewer, not an owner decision. It accounts for every finding card so far.
function validateRethink(rethink) {
  exact(rethink, ['priorRequestDigest', 'reviewerId', 'sessionId', 'completedAt', 'findingClasses', 'pattern', 'rootCause', 'simplicityCheck', 'alternatives', 'decision', 'rationale', 'lesson'], 'rethink');
  demand(DIGEST.test(rethink.priorRequestDigest) && Number.isSafeInteger(rethink.completedAt) && rethink.completedAt >= 0, 'rethink binding is invalid');
  text(rethink.reviewerId, 'rethink reviewer ID'); text(rethink.sessionId, 'rethink session ID');
  for (const field of ['pattern', 'rootCause', 'simplicityCheck', 'rationale']) text(rethink[field], `rethink ${field}`, 4096);
  demand(Array.isArray(rethink.findingClasses) && rethink.findingClasses.length <= 64, 'rethink finding classes exceed bounds');
  for (const group of rethink.findingClasses) { exact(group, ['class', 'findingIds'], 'rethink finding class'); text(group.class, 'rethink class'); demand(Array.isArray(group.findingIds) && group.findingIds.length > 0 && group.findingIds.length <= 384 && group.findingIds.every(id => DIGEST.test(id)), 'rethink finding IDs are invalid'); }
  demand(Array.isArray(rethink.alternatives) && rethink.alternatives.length > 0 && rethink.alternatives.length <= 16, 'rethink alternatives are missing or exceed bounds'); rethink.alternatives.forEach(item => text(item, 'rethink alternative', 1024));
  demand(RETHINK_DECISIONS.includes(rethink.decision), 'rethink decision is invalid');
  text(rethink.lesson, 'rethink lesson', 240); demand(rethink.lesson.includes('→'), 'rethink lesson must read "pattern → simpler path"');
}
function assertRethink(rethink, history, request, identities) {
  validateRethink(rethink);
  const previous = history.at(-1);
  demand(rethink.priorRequestDigest === digest(previous.request), 'rethink differs from exact previous request');
  demand(![rethink.reviewerId, rethink.sessionId].some(id => id === request.authorSessionId || identities.has(id)), 'rethink reviewer is the author or not fresh');
  demand(rethink.completedAt >= previous.request.preparedAt && previous.reports.every(report => report.completedAt <= rethink.completedAt) && rethink.completedAt <= request.preparedAt, 'rethink predates the previous round or follows the request');
  const grouped = rethink.findingClasses.flatMap(group => group.findingIds);
  demand(new Set(grouped).size === grouped.length && equal([...grouped].sort(), allCards(history).map(card => card.id).sort()), 'rethink must group every finding card so far exactly once');
  demand((rethink.decision === 'intent') === Boolean(request.continuation.regroup), 'an intent-change rethink requires an owner regroup; other decisions keep the approved intent');
  identities.add(rethink.reviewerId); identities.add(rethink.sessionId);
}
function sensitivePath(path) {
  return /^(?:\.github|config|db|supabase)(?:\/|$)/iu.test(path) || /\.sql$/iu.test(path) ||
    /(?:^|\/)(?:AGENTS|CLAUDE)(?:\.local)?\.(?:md|txt|rst)$/iu.test(path) ||
    /(?:^|\/)(?:CONTRIBUTING|SECURITY|AI_CONTRIBUTION_POLICY|AGENT_GUIDE)\.(?:md|txt|rst)$/iu.test(path) ||
    /^scripts\/(?:agent-review|check-|oss-|dco-|run-|merge-preview|verify-candidate|packages\/)/iu.test(path) ||
    /^(?:package(?:-lock)?\.json|\.git(?:attributes|ignore)|.*(?:config|policy|security|auth|migration|payment|checkout|subscription|permission|access|credential|secret|token|release|publish|deploy|schema|contract|account|login|otp|cardSetup|paymentCard|customer|invoice).*)$/iu.test(path) ||
    /^(?:packages\/core|server\/(?:bff|adapters|runtime|domains\/(?:accounting|customers|shipping))|src\/(?:integrations|pages\/account|domains\/(?:customers|shipping)))(?:\/|$)/iu.test(path) ||
    /^docs\/platform\/plans\/autonomous-reviewed-delivery/iu.test(path);
}
async function routineModeChanged(cwd, candidate) {
  const graph = await verifyReviewObjectGraph(cwd, { base: candidate.base, head: candidate.head, tree: candidate.tree });
  const before = new Map(reviewTreeEntries(graph, graph.baseTree).map(entry => [entry.path, entry.mode]));
  const after = new Map(reviewTreeEntries(graph, graph.headTree).map(entry => [entry.path, entry.mode]));
  return candidate.changedPaths.some(path => {
    const oldMode = before.get(path), newMode = after.get(path);
    if (oldMode === '120000' || newMode === '120000') return true;
    if (oldMode === undefined) return newMode !== '100644';
    if (newMode === undefined) return oldMode !== '100644';
    return oldMode !== newMode;
  });
}
function requestRoles(intent, continuation) {
  if (continuation?.mode === 'closure') return ['closure'];
  const roles = [...intent.requiredRoles];
  const count = continuation ? 2 : ['prose', 'routine'].includes(intent.risk) ? 1 : 2;
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
  if (request?.version === 1 && Object.hasOwn(request, 'simplicityPreCheck')) fields.push('simplicityPreCheck');
  exact(request, fields, 'request');
  demand([1, 2].includes(request.version) && request.evidence === EVIDENCE, 'request version/evidence is invalid'); text(request.id, 'request ID'); text(request.authorSessionId, 'author session'); validateIntent(request.intent); validateCandidate(request.candidate);
  demand(Number.isSafeInteger(request.preparedAt) && request.preparedAt >= 0, 'request time is invalid');
  if (Object.hasOwn(request, 'simplicityPreCheck')) text(request.simplicityPreCheck, 'simplicity pre-check', 2048);
  if (request.version === 2) {
    const continuation = request.continuation;
    const fields = ['cycle', 'mode', 'priorDigest', 'deltaPaths', 'findings', 'repairRisk'];
    for (const optional of ['regroup', 'ownerContinuation', 'rethink']) if (Object.hasOwn(continuation, optional)) fields.push(optional);
    exact(continuation, fields, 'continuation');
    if (Object.hasOwn(continuation, 'regroup')) { validateRegroup(continuation.regroup); demand(continuation.mode === 'full', 'owner regroup requires full coverage'); }
    demand(Number.isSafeInteger(continuation.cycle) && continuation.cycle >= 1 && continuation.cycle <= MAX_CYCLES && ['closure', 'focused', 'full'].includes(continuation.mode) && DIGEST.test(continuation.priorDigest), 'repair lineage is invalid');
    demand(!FULL_CYCLES.includes(continuation.cycle) || continuation.mode === 'full', 'cycles 3, 4 and 6 require full coverage');
    // Cycle 3 accepts an owner continuation recorded before it became automatic.
    if (Object.hasOwn(continuation, 'ownerContinuation')) {
      validateOwnerContinuation(continuation.ownerContinuation);
      demand([3, OWNER_CYCLE].includes(continuation.cycle) && continuation.ownerContinuation.candidateDigest === digest(request.candidate), 'owner continuation applies to the exact full candidate of cycle 6');
    } else demand(continuation.cycle !== OWNER_CYCLE, 'cycle 6 requires explicit owner continuation');
    if (Object.hasOwn(continuation, 'rethink')) { validateRethink(continuation.rethink); demand(continuation.cycle === RETHINK_CYCLE, 'a rethink record applies only at the cycle 4 transition'); }
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
  if (request.intent.risk === 'routine') demand(request.candidate.changedPaths.every(path => !sensitivePath(path)), 'routine risk cannot cover control, trust-boundary or public-contract paths; prepare behavior reviews');
}
export async function prepareAgentReview({ cwd, intent, authorSessionId, now = Date.now, snapshot = captureSessionCandidate, modeCheck = routineModeChanged, base, simplicityPreCheck }) {
  validateIntent(intent); text(authorSessionId, 'author session');
  const candidate = await snapshot(cwd, base); validateCandidate(candidate);
  const request = { version: 1, evidence: EVIDENCE, id: randomUUID(), authorSessionId, candidate, intent: structuredClone(intent), roles: requestRoles(intent), preparedAt: now(), ...(simplicityPreCheck === undefined ? {} : { simplicityPreCheck }) };
  validateRequest(request);
  if (intent.risk === 'routine') demand(!await modeCheck(cwd, candidate), 'routine risk cannot cover mode or symlink changes; prepare behavior reviews');
  return request;
}
function validateReport(request, report) {
  const fields = ['requestId', 'requestDigest', 'reviewerId', 'sessionId', 'role', 'cold', 'completedAt', 'candidate', 'complete', 'coveredScope', 'coveredCriteria', 'simplicityChecked', 'verdict', 'materialFindings'];
  if (Object.hasOwn(report ?? {}, 'advisoryFindings')) fields.push('advisoryFindings');
  if (request.version === 1 && request.intent.risk === 'routine') fields.push('routineSemantics');
  if (request.version === 2) fields.push('closure');
  exact(report, fields, 'native agent report');
  demand(report.requestId === request.id && report.requestDigest === digest(request) && equal(report.candidate, request.candidate), 'report covers a different request or candidate');
  text(report.reviewerId, 'native reviewer ID'); text(report.sessionId, 'native session ID');
  demand(report.reviewerId !== request.authorSessionId && report.sessionId !== request.authorSessionId && report.cold === true && request.roles.includes(report.role), 'reviewer is author, not cold, or has an unrequested role');
  demand(Number.isSafeInteger(report.completedAt) && report.completedAt >= request.preparedAt, 'report predates request');
  demand(typeof report.complete === 'boolean' && typeof report.coveredCriteria === 'boolean' && typeof report.simplicityChecked === 'boolean' && ['pass', 'fail'].includes(report.verdict), 'report flags are invalid');
  if (request.version === 1 && request.intent.risk === 'routine') demand(typeof report.routineSemantics === 'boolean', 'routine semantic assessment is missing');
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
  if (request.version === 1 && request.intent.risk === 'routine') demand(report.routineSemantics, 'routine reviewer found elevated or uncertain semantics; prepare two full behavior reviews');
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
function passed(round) {
  if (round.reports.length !== round.request.roles.length || !round.reports.some(report => report.simplicityChecked)) return false;
  try { round.reports.forEach(report => reportPasses(round.request, report)); return true; } catch { return false; }
}
function roundCards(round) {
  return round.reports.flatMap(report => report.materialFindings.map((finding, index) => ({ id: digest({ requestDigest: digest(round.request), reviewerId: report.reviewerId, index, finding }), finding: structuredClone(finding) })));
}
function unresolvedCards(history) {
  const cards = new Map();
  for (const round of history) {
    if (passed(round)) for (const report of round.reports) for (const id of report.closure?.resolvedFindings ?? []) cards.delete(id);
    for (const card of roundCards(round)) cards.set(card.id, card);
  }
  return [...cards.values()];
}
function allCards(history) { return [...new Map(history.flatMap(roundCards).map(card => [card.id, card])).values()]; }
/** Why the cycle after this state cannot start automatically, or null. */
function cycleGate(state, { rethink = false, owner = false } = {}) {
  const cycle = (state.history?.length ?? 0) + 1;
  if (cycle > MAX_CYCLES) return 'six review cycles are exhausted; change the execution approach with the owner';
  if (cycle === OWNER_CYCLE && !owner) return 'cycle 6 requires an explicit owner continuation';
  if (cycle === RETHINK_CYCLE && !rethink && !passed(state)) return 'cycle 3 did not pass; record a rethink with a fresh simplicity reviewer before cycle 4';
  return null;
}
function validateLineage(state, time, maxAgeMs) {
  const fields = Object.hasOwn(state ?? {}, 'history') ? ['request', 'reports', 'history'] : ['request', 'reports']; exact(state, fields, 'session state');
  const history = state.history ?? []; demand(Array.isArray(history) && history.length <= MAX_CYCLES, 'repair history exceeds bounds');
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
      if (request.continuation.regroup) assertRegroup(request.continuation.regroup, previous, request);
      if (request.continuation.ownerContinuation) assertOwnerContinuation(request.continuation.ownerContinuation, previous, request, request.continuation.regroup);
      if (request.continuation.rethink) assertRethink(request.continuation.rethink, history.slice(0, index), request, identities);
      else demand(index !== RETHINK_CYCLE || passed(history[index - 1]), 'cycle 4 after a cycle 3 that did not pass requires a rethink record');
      demand((equal(request.intent, previous.intent) || request.continuation.regroup) && request.authorSessionId === previous.authorSessionId && (request.continuation.mode === 'full' || request.candidate.base === previous.candidate.base) && request.candidate.clean && (request.continuation.mode === 'full' || previous.candidate.clean) && (request.continuation.mode === 'full' || request.candidate.head !== previous.candidate.head && request.candidate.workingDigest !== previous.candidate.workingDigest) && request.preparedAt >= previous.preparedAt && history[index - 1].reports.every(report => report.completedAt <= request.preparedAt), 'repair criteria, scope, base, or committed lineage differs');
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
export async function prepareAgentReviewState({ previous, repairRisk = 'unknown', fullRefresh = false, regroup, ownerContinuation, rethink, simplicityPreCheck, delta = captureAgentReviewDelta, maxAgeMs = 86400000, ...options }) {
  demand(REPAIR_RISKS.includes(repairRisk) && typeof fullRefresh === 'boolean', 'repair risk or refresh is invalid');
  // The root request records the author's simplicity pre-check; continuations inherit it through history.
  const request = await prepareAgentReview(previous ? options : { ...options, simplicityPreCheck });
  if (!previous) { demand(regroup === undefined && ownerContinuation === undefined && rethink === undefined, 'owner regroup, owner continuation and rethink require preserved previous state'); return { request, reports: [] }; }
  const now = options.now ?? Date.now; const time = now();
  // Validate bindings before reusing any state, including failed/partial unchanged rounds.
  validateLineage(previous, time, Infinity); await currentLineage(options.cwd, previous, delta);
  const intentChanged = !equal(previous.request.intent, request.intent);
  rescope(previous.request.authorSessionId === request.authorSessionId && (!intentChanged || regroup !== undefined), 'approved intent or author changed; a changed execution approach is required');
  if (intentChanged) { assertRegroup(regroup, previous.request, request); demand(fullRefresh, 'owner regroup requires explicit full refresh'); }
  const preservedRegroup = regroup !== undefined && [...(previous.history ?? []), previous].some(round => equal(regroup, round.request.continuation?.regroup) && equal(round.request.intent, request.intent));
  if (!intentChanged && regroup !== undefined) demand(preservedRegroup, 'owner regroup is not the preserved transition');
  const cycle = (previous.history?.length ?? 0) + 1;
  const preservedOwnerContinuation = ownerContinuation !== undefined && equal(ownerContinuation, previous.request.continuation?.ownerContinuation) && equal(previous.request.candidate, request.candidate);
  if (ownerContinuation !== undefined && !preservedOwnerContinuation) {
    assertOwnerContinuation(ownerContinuation, previous.request, request, intentChanged ? regroup : undefined);
    demand(cycle === OWNER_CYCLE && fullRefresh, 'owner continuation applies at cycle 6 with explicit full refresh');
  }
  // A repeated spec may carry the rethink already preserved in lineage; only a new one starts cycle 4.
  const preservedRethink = rethink !== undefined && [...(previous.history ?? []), previous].some(round => equal(rethink, round.request.continuation?.rethink));
  const newRethink = rethink !== undefined && !preservedRethink;
  if (newRethink) { validateRethink(rethink); demand(cycle === RETHINK_CYCLE, 'a rethink record applies only at the cycle 4 transition'); }
  if (!intentChanged && equal(previous.request.candidate, request.candidate)) {
    if (preservedOwnerContinuation) return structuredClone(previous);
    if (preservedRegroup) return structuredClone(previous);
    if (rethink !== undefined && equal(rethink, previous.request.continuation?.rethink)) return structuredClone(previous);
    if (!fullRefresh) return structuredClone(previous);
    // Recovery is unnecessary for a terminal current pass, even if requested.
    let reviewed = true;
    try { validateLineage(previous, time, maxAgeMs); validateRound(previous.request, previous.reports, { complete: true, time, maxAgeMs }); previous.reports.forEach(report => reportPasses(previous.request, report)); } catch { reviewed = false; }
    if (reviewed) return structuredClone(previous);
  }
  const gate = cycleGate(previous, { rethink: newRethink, owner: ownerContinuation !== undefined && !preservedOwnerContinuation }); rescope(!gate, gate);
  demand(request.candidate.clean, 'repair requires clean committed candidates');
  let priorComplete = previous.request.candidate.clean;
  try { validateLineage(previous, time, maxAgeMs); validateRound(previous.request, previous.reports, { complete: true, time, maxAgeMs }); } catch { priorComplete = false; }
  const history = [...(previous.history ?? []), { request: previous.request, reports: previous.reports }];
  let deltaPaths;
  try { deltaPaths = await delta(options.cwd, previous.request.candidate, request.candidate); } catch (error) { if (error.message.includes('not an authenticated ancestor')) throw new NeedsRescope('Agent review needs rescope: nonancestor integration requires a changed execution approach'); throw error; }
  const findings = unresolvedCards(history);
  const mode = fullRefresh || !priorComplete || previous.request.candidate.base !== request.candidate.base || FULL_CYCLES.includes(history.length) ? 'full' : repairRisk === 'ordinary' && !deltaPaths.some(sensitivePath) && findings.every(card => card.finding.risk === 'ordinary') ? 'closure' : 'focused';
  paths(deltaPaths, mode === 'full');
  request.version = 2; request.continuation = { cycle: history.length, mode, priorDigest: digest(history), deltaPaths, findings, repairRisk }; if (intentChanged) request.continuation.regroup = structuredClone(regroup); if (ownerContinuation !== undefined) request.continuation.ownerContinuation = structuredClone(ownerContinuation); if (newRethink) request.continuation.rethink = structuredClone(rethink);
  request.roles = requestRoles(request.intent, request.continuation);
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
export async function verifyAgentReview({ cwd, request, reports = [], history, snapshot = captureSessionCandidate, delta = captureAgentReviewDelta, modeCheck = routineModeChanged, now = Date.now, maxAgeMs = 86400000 }) {
  try {
    demand(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 86400000, 'review freshness bound is invalid');
    const state = { request, reports, ...(history ? { history } : {}) }; validateLineage(state, now(), maxAgeMs);
    const observed = await snapshot(cwd, request.candidate.base);
    const gate = equal(observed, request.candidate) ? null : cycleGate(state);
    if (gate) throw new NeedsRescope(`Agent review needs rescope: ${gate}`);
    demand(equal(observed, request.candidate), 'candidate changed; prepare fresh independent reviews');
    if (request.intent.risk === 'routine') demand(!await modeCheck(cwd, request.candidate), 'routine risk cannot cover mode or symlink changes; prepare behavior reviews');
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
/** Every reviewer and session identity a state has used, rethink reviewers included. */
export function agentReviewIdentities(state) {
  return new Set([...(state.history ?? []), state].flatMap(round => [...round.reports.flatMap(report => [report.reviewerId, report.sessionId]), ...(round.request.continuation?.rethink ? [round.request.continuation.rethink.reviewerId, round.request.continuation.rethink.sessionId] : [])]));
}
export function agentReviewReportBinding(request) { validateRequest(request); return { requestId: request.id, requestDigest: digest(request), candidate: structuredClone(request.candidate) }; }

/** Last synchronous freshness sample after hosted identity reads. It does not
 * replace source/lineage validation; no network work may follow before admission.
 */
export function assertAgentReviewFreshness(state, time = Date.now()) {
  validateLineage(state, time, 86400000);
  validateRound(state.request, state.reports, { complete: true, time });
  state.reports.forEach(report => reportPasses(state.request, report));
}

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
// Local prediction and heavy proof share this existing registered entrypoint,
// keeping independently evolving publication aggregates out of this change.
function previewGit(cwd, args) {
  return execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 30000,
    env: { PATH: processEnvironment.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null',
      GIT_AUTHOR_NAME: 'Local merge preview', GIT_AUTHOR_EMAIL: 'preview@example.invalid', GIT_COMMITTER_NAME: 'Local merge preview', GIT_COMMITTER_EMAIL: 'preview@example.invalid' },
  }).trim();
}
export function checkMergePreview({ cwd, target = 'origin/main', checks = [
  [process.execPath, '--experimental-strip-types', 'scripts/oss-published-tree-check.ts', '--policy'],
  [process.execPath, '--experimental-strip-types', 'scripts/oss-published-tree-check.ts', '--inventory'],
] }) {
  const base = previewGit(cwd, ['rev-parse', '--verify', `${target}^{commit}`]);
  const head = previewGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const sourceTree = previewGit(cwd, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (![base, head, sourceTree].every(value => SHA.test(value))) throw new Error('merge-preview: invalid comparison identity');
  const objects = join(previewGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'objects');
  if (/[\r\n]/u.test(objects)) throw new Error('merge-preview: object store path cannot be represented safely');
  const directory = mkdtempSync(join(tmpdir(), 'openlup-merge-preview-'));
  try {
    previewGit(directory, ['init', '-q']);
    mkdirSync(join(directory, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(directory, '.git', 'objects', 'info', 'alternates'), `${resolve(objects)}\n`);
    let tree;
    try { tree = previewGit(directory, ['-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', 'merge-tree', '--write-tree', base, head]); }
    catch (error) {
      const conflicts = String(error.stdout ?? '').split('\n').filter(line => /^CONFLICT /u.test(line));
      throw new Error(`merge-preview: cannot merge ${base} and ${head}; merge main into this branch, resolve and regenerate, then obtain the required fresh review. ${conflicts.join(' ')}`);
    }
    if (!SHA.test(tree)) throw new Error('merge-preview: prediction did not produce one tree');
    if (tree === sourceTree) return { base, head, tree, basis: 'unchanged tree' };
    const merged = previewGit(directory, ['commit-tree', tree, '-p', base, '-p', head, '-m', 'Local merge preview; not for publication']);
    previewGit(directory, ['checkout', '-q', '--detach', merged]);
    const env = { ...processEnvironment };
    for (const name of Object.keys(env)) if (/^(?:GITHUB_|GIT_|GH_)/u.test(name) || name === 'OPENLUP_STACK_BASE') delete env[name];
    for (const [command, ...args] of checks) {
      const checkArgs = args.includes('--policy') ? [...args, '--docs-base', base] : args;
      const run = spawnSync(command, checkArgs, { cwd: directory, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
      if (run.error || run.status !== 0) throw new Error(`merge-preview: combined tree failed ${args.join(' ')}\n${run.error?.message ?? run.stderr ?? ''}\n${run.stdout ?? ''}`);
    }
    return { base, head, tree, basis: 'combined policy and inventory passed' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function heavyLeaseDirectory(cwd) {
  return join(tmpdir(), `openlup-heavy-${createHash('sha256').update(await realpath(cwd)).digest('hex')}`);
}
export async function withHeavyLease(action, { directory, waitMs = 0, pollMs = 1000 } = {}) {
  if (!directory) throw new Error('heavy verification: a worktree lease directory is required');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 1800000) throw new Error('heavy verification: invalid bounded wait');
  const owner = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const started = Date.now(); let nextNotice = 0;
  for (;;) {
    try { await mkdir(directory, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stat;
      try { stat = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('heavy verification: lease path is not a regular directory');
      if (Date.now() - started >= waitMs) throw new Error(`heavy verification: bounded wait expired; inspect ${directory}/owner.json, leave the other owner and its processes alone`);
      if (Date.now() >= nextNotice) { console.log(`heavy verification: waiting for this worktree's output lease (${Math.floor((Date.now() - started) / 1000)}s)`); nextNotice = Date.now() + 30000; }
      await sleep(pollMs);
    }
  }
  try {
    await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return await action();
  } finally {
    const current = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    if (current.token !== owner.token) throw new Error('heavy verification: ownership changed; refusing to remove the lease');
    await rm(directory, { recursive: true });
  }
}
export function runHeavyCommand(command, args, cwd, env = processEnvironment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    const forward = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const interrupt = () => forward('SIGINT'); const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve(signal ? 1 : code ?? 1); });
  });
}
export function heavyCommandEnvironment(directory, parent = processEnvironment) {
  const env = { ...parent, OPENLUP_HEAVY_ACTIVE: directory };
  // The pin belongs to this candidate's preflight. Test fixtures and child
  // repositories must resolve their own bases, not inherit another repo's pin.
  delete env.OPENLUP_STACK_BASE;
  delete env.OPENLUP_VERIFY_EXPECTED;
  return env;
}
function brokerCommand(command, args, directory, resource) {
  if (processEnvironment.CI === 'true' || processEnvironment.AI_RESOURCE_GATE_ACTIVE === '1') return [command, args];
  for (const entry of (processEnvironment.PATH ?? '').split(delimiter).filter(Boolean)) {
    const executable = join(entry, 'ai-resource-gate');
    try { accessSync(executable, constants.X_OK); } catch { continue; }
    if (!resource || !/^[a-z][a-z0-9:-]{0,127}$/u.test(resource)) throw new Error('heavy verification: select the existing broker profile with --resource, for example openlup:coverage, openlup:build or openlup:typecheck');
    return [executable, ['run', '--wait', `${resource}:${basename(directory)}`, '--', command, ...args]];
  }
  return [command, args];
}
export async function verifyCandidateCommand({ cwd, command, args = [], resource, lease, preflight = localPreflight, snapshot = captureSessionCandidate, run = runHeavyCommand }) {
  const directory = lease?.directory ?? await heavyLeaseDirectory(cwd);
  if (processEnvironment.OPENLUP_HEAVY_ACTIVE === directory) throw new Error('heavy verification: nested wrapper refused; run the underlying required command directly inside the outer wrapper');
  const before = await snapshot(cwd);
  if (processEnvironment.OPENLUP_VERIFY_EXPECTED && JSON.stringify(before) !== processEnvironment.OPENLUP_VERIFY_EXPECTED) throw new Error('heavy verification: source changed while waiting for host capacity');
  if (!before.clean) throw new Error('heavy verification: commit source changes before final proof');
  await preflight(cwd, before);
  const finish = async code => {
    if (JSON.stringify(await snapshot(cwd, before.base)) !== JSON.stringify(before)) throw new Error('heavy verification: source changed; this run is superseded and supplies no final evidence');
    if (code === 0 && preflight === localPreflight) await nativeReview(cwd);
    return code;
  };
  // The broker admits a fresh invocation of this verifier, not the expensive
  // command directly. It rechecks frozen identity, review and merge prediction
  // after the host-capacity wait and before starting any heavy work.
  const [broker, brokerArgs] = brokerCommand(process.execPath, [fileURLToPath(import.meta.url), 'verify-command', ...(resource ? ['--resource', resource] : []), '--', command, ...args], directory, resource);
  if (broker !== process.execPath) return finish(await run(broker, brokerArgs, cwd, { ...processEnvironment, OPENLUP_VERIFY_EXPECTED: JSON.stringify(before) }));
  return withHeavyLease(async () => {
    if (JSON.stringify(await snapshot(cwd, before.base)) !== JSON.stringify(before)) throw new Error('heavy verification: source changed while waiting');
    // The native evidence may expire or main may advance while this command waits.
    await preflight(cwd, before);
    if (JSON.stringify(await snapshot(cwd, before.base)) !== JSON.stringify(before)) throw new Error('heavy verification: source changed during cheap preflight');
    return finish(await run(command, args, cwd, heavyCommandEnvironment(directory)));
  }, { ...lease, directory });
}
async function nativeReview(cwd) {
  if (await runHeavyCommand(process.execPath, ['scripts/agent-review-session.mjs', 'verify'], cwd) !== 0) throw new Error('heavy verification: current independent native review is required');
}
async function localPreflight(cwd, candidate) {
  for (const args of [
    ['--experimental-strip-types', 'scripts/oss-published-tree-check.ts', '--policy', '--docs-base', candidate.base],
    ['--experimental-strip-types', 'scripts/oss-published-tree-check.ts', '--inventory'],
  ]) if (await runHeavyCommand(process.execPath, args, cwd) !== 0) throw new Error('heavy verification: cheap policy/inventory check failed');
  console.log(`merge-preview: ${JSON.stringify(checkMergePreview({ cwd }))}`);
  await nativeReview(cwd);
}

async function main() {
  if (process.argv[2] === 'verify-command') {
    const options = process.argv.slice(3);
    const resource = options[0] === '--resource' ? options.splice(0, 2)[1] : undefined;
    const [separator, command, ...args] = options;
    if (separator !== '--' || !command) {
      console.error('usage: node scripts/agent-review-session.mjs verify-command [--resource <existing-broker-resource>] -- <required-check-command> [args...]');
      process.exitCode = 2; return;
    }
    process.exitCode = await verifyCandidateCommand({ cwd: process.cwd(), command, args, resource });
    return;
  }
  const [verb, input] = process.argv.slice(2); demand(['prepare', 'record', 'verify', 'status'].includes(verb), 'use prepare <intent.json>, record <observed-report.json>, verify, status, or verify-command [--resource <profile>] -- <command>');
  const cwd = await realpath(process.cwd()); const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  await sessionDirectory(cwd);
  const operation = async () => {
  if (verb === 'prepare') {
    const spec = await boundedJson(input ?? join(directory, 'intent.json'));
    demand(Object.keys(spec).every(key => ['intent', 'authorSessionId', 'base', 'repairRisk', 'fullRefresh', 'regroup', 'ownerContinuation', 'rethink', 'simplicityPreCheck'].includes(key)) && Object.hasOwn(spec, 'intent'), 'supervisor request schema is invalid');
    spec.authorSessionId ??= processEnvironment.CODEX_THREAD_ID; spec.base ??= processEnvironment.OPENLUP_STACK_BASE ?? await forkPoint(cwd);
    let previous; try { previous = await boundedJson(path, STATE_BYTES); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    demand(previous || spec.simplicityPreCheck, 'a first request needs simplicityPreCheck: read Review lessons in CONTRIBUTING.md and name the smallest adequate alternative considered');
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
