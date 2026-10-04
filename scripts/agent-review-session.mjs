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

/** The review base is the candidate's fork point: the single merge base of HEAD
 * and the observed origin/main. It stays put while main moves ahead, and moves
 * when HEAD integrates main or main is rewritten.
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
  base ??= await forkPoint(cwd);
  demand(SHA.test(base), 'base must be a full commit digest');
  const head = (await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const tree = (await git(cwd, 'rev-parse', '--verify', 'HEAD^{tree}')).trim();
  demand(await forkPoint(cwd) === base, 'base is no longer the fork point of HEAD and observed origin/main; prepare again');
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

/** Read a committed candidate as data, without checking it out or executing its
 * configuration. Hosted admission must not run a candidate with write tokens.
 * The reconstructed clean index uses the same canonical digests as local review.
 */
export async function captureCommittedReviewCandidate(cwd, base, head) {
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
  return { base, head, tree: graph.headTree, clean: true, workingDigest: digest(entries), indexDigest: digest({ index, flags }), changedPaths };
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
  exact(candidate, ['base', 'head', 'tree', 'clean', 'workingDigest', 'indexDigest', 'changedPaths'], 'candidate');
  demand(['base', 'head', 'tree'].every(field => SHA.test(candidate[field])) && ['workingDigest', 'indexDigest'].every(field => DIGEST.test(candidate[field])), 'candidate digest is invalid'); demand(typeof candidate.clean === 'boolean', 'candidate clean flag is invalid'); paths(candidate.changedPaths);
}
const REPAIR_RISKS = ['ordinary', 'security', 'control', 'schema', 'instructions', 'unknown'];
const MAX_REPAIRS = 2;
const MAX_OWNER_CYCLES = MAX_REPAIRS + 3;
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
// Bounded SQL/RLS recovery consumes existing owner cycles; automatic limits remain unchanged.
const RLS_RECOVERY_ADDITIONS = [
  "docs/platform/plans/autonomous-reviewed-delivery.md",
  "scripts/agent-review-session.mjs",
  "scripts/agent-review-session.test.ts",
  "supabase/migrations/20261004123000_runtime_capability_rls_closure.sql"
];
const RLS_RECOVERY_SCOPE = [
  "CONTRIBUTING.md",
  "config/openlup-publication-catalog.json",
  "config/openlup-source-release-contract.json",
  "config/reviewed-platform-forwards.json",
  "docs/platform/ARCHITECTURE_AND_EXTENSIONS.md",
  "docs/platform/CANONICAL_CONTRACTS.md",
  "docs/platform/DATA_AND_MIGRATIONS.md",
  "docs/platform/plans/autonomous-reviewed-delivery.md",
  "docs/platform/plans/public-ci-known-red.md",
  "scripts/agent-review-session.mjs",
  "scripts/agent-review-session.test.ts",
  "scripts/reviewed-platform-forward.ts",
  "scripts/source-preview-release.test.ts",
  "src/lib/subscriptionOwnEngineRpcBoundary.test.ts",
  "supabase/migrations/20261004120000_runtime_capabilities.sql",
  "supabase/migrations/20261004123000_runtime_capability_rls_closure.sql",
  "supabase/tests/operator_contact_correction_test.sql",
  "supabase/tests/operator_subscription_actions_test.sql",
  "supabase/tests/runtime_capability_boundary_test.sql",
  "supabase/tests/subscription_renewal_due_lock_runtime_test.sql"
];
const RLS_RECOVERY_CRITERION = "RLS recovery: retire exactly eight legacy cross-customer browser policies; preserve customer-own access and distributor own membership read, prove actual authenticated role isolation, merge exact contraction admission before introducing the corrected managed forward, and preserve all review history and automatic limits.";
function rlsRecoveryIntent(intent) {
  return equal([...intent.scope].sort(), RLS_RECOVERY_SCOPE) && intent.risk === 'behavior' && equal(intent.requiredRoles, ['correctness', 'security']) && intent.criteria.endsWith(` ${RLS_RECOVERY_CRITERION}`);
}
function ownerCycleLimit(intent) { return MAX_OWNER_CYCLES + (rlsRecoveryIntent(intent) ? 1 : 0); }
function assertOwnerContinuation(approval, previous, request, regroup, cycle) {
  validateOwnerContinuation(approval);
  demand(approval.priorRequestDigest === digest(previous) && approval.candidateDigest === digest(request.candidate), 'owner continuation differs from exact previous request or candidate');
  const additions = request.intent.scope.filter(path => !previous.intent.scope.includes(path)).sort();
  const consumerScope = cycle !== 5 && equal(additions, ['packages/core/scripts/core-package-consumer-audit.ts', 'packages/core/test/consumerTooling.test.ts']);
  const checkoutScope = cycle === 5 && equal(additions, ['.github/workflows/published-tree-ci.yml']);
  const rlsScope = cycle === 4 && equal(additions, RLS_RECOVERY_ADDITIONS) && rlsRecoveryIntent(request.intent) && request.intent.criteria === `${previous.intent.criteria} ${RLS_RECOVERY_CRITERION}`;
  const scopeOnly = regroup && ((consumerScope || checkoutScope) && equal(previous.intent.criteria, request.intent.criteria) || rlsScope) && previous.intent.risk === request.intent.risk && equal(previous.intent.requiredRoles, request.intent.requiredRoles);
  const rlsFeature = cycle === 5 && previous.continuation?.cycle === 4 && previous.continuation?.regroup && rlsRecoveryIntent(previous.intent) && equal(previous.intent, request.intent);
  const rlsFinal = cycle === 6 && previous.continuation?.cycle === 5 && previous.continuation.ownerContinuation && rlsRecoveryIntent(previous.intent) && equal(previous.intent, request.intent) && !previous.candidate.changedPaths.includes('supabase/migrations/20261004123000_runtime_capability_rls_closure.sql') && request.candidate.changedPaths.includes('supabase/migrations/20261004123000_runtime_capability_rls_closure.sql');
  demand((cycle < 5 && equal(previous.intent, request.intent) || scopeOnly || rlsFeature || rlsFinal) && previous.authorSessionId === request.authorSessionId, 'owner continuation requires unchanged criteria, risk, roles and author; remaining owner cycle requires its exact scope addition');
}
function sensitivePath(path) {
  return /^(?:\.github|config|db|supabase)(?:\/|$)/iu.test(path) || /\.sql$/iu.test(path) ||
    /(?:^|\/)(?:AGENTS|CLAUDE)(?:\.local)?\.(?:md|txt|rst)$/iu.test(path) ||
    /(?:^|\/)(?:CONTRIBUTING|SECURITY|AI_CONTRIBUTION_POLICY|AGENT_GUIDE)\.(?:md|txt|rst)$/iu.test(path) ||
    /^scripts\/(?:agent-review|check-|oss-|dco-|run-|packages\/)/iu.test(path) ||
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
  exact(request, fields, 'request');
  demand([1, 2].includes(request.version) && request.evidence === EVIDENCE, 'request version/evidence is invalid'); text(request.id, 'request ID'); text(request.authorSessionId, 'author session'); validateIntent(request.intent); validateCandidate(request.candidate);
  demand(Number.isSafeInteger(request.preparedAt) && request.preparedAt >= 0, 'request time is invalid');
  if (request.version === 2) {
    const continuation = request.continuation;
    const fields = ['cycle', 'mode', 'priorDigest', 'deltaPaths', 'findings', 'repairRisk'];
    if (Object.hasOwn(continuation, 'regroup')) fields.push('regroup');
    if (Object.hasOwn(continuation, 'ownerContinuation')) fields.push('ownerContinuation');
    exact(continuation, fields, 'continuation');
    if (Object.hasOwn(continuation, 'regroup')) { validateRegroup(continuation.regroup); demand(continuation.mode === 'full', 'owner regroup requires full coverage'); }
    demand(Number.isSafeInteger(continuation.cycle) && continuation.cycle >= 1 && continuation.cycle <= ownerCycleLimit(request.intent) && ['closure', 'focused', 'full'].includes(continuation.mode) && DIGEST.test(continuation.priorDigest), 'repair lineage is invalid');
    if (Object.hasOwn(continuation, 'ownerContinuation')) {
      validateOwnerContinuation(continuation.ownerContinuation);
      demand(continuation.cycle > MAX_REPAIRS && continuation.mode === 'full' && (!continuation.regroup || [4, 5].includes(continuation.cycle)) && (continuation.cycle !== 5 || continuation.regroup !== undefined || rlsRecoveryIntent(request.intent)) && continuation.ownerContinuation.candidateDigest === digest(request.candidate), 'owner continuation requires exact full candidate; scope expansion requires its exact owner-approved consumer, checkout or RLS route');
    } else demand(continuation.cycle <= MAX_REPAIRS, 'third, fourth or checkout fifth cycle requires explicit owner continuation');
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
export async function prepareAgentReview({ cwd, intent, authorSessionId, now = Date.now, snapshot = captureSessionCandidate, modeCheck = routineModeChanged, base }) {
  validateIntent(intent); text(authorSessionId, 'author session');
  const candidate = await snapshot(cwd, base); validateCandidate(candidate);
  const request = { version: 1, evidence: EVIDENCE, id: randomUUID(), authorSessionId, candidate, intent: structuredClone(intent), roles: requestRoles(intent), preparedAt: now() };
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
  const history = state.history ?? []; demand(Array.isArray(history) && history.length <= ownerCycleLimit(state.request.intent), 'repair history exceeds bounds');
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
      if (request.continuation.ownerContinuation) assertOwnerContinuation(request.continuation.ownerContinuation, previous, request, request.continuation.regroup, request.continuation.cycle);
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
export async function prepareAgentReviewState({ previous, repairRisk = 'unknown', fullRefresh = false, regroup, ownerContinuation, delta = captureAgentReviewDelta, maxAgeMs = 86400000, ...options }) {
  demand(REPAIR_RISKS.includes(repairRisk) && typeof fullRefresh === 'boolean', 'repair risk or refresh is invalid');
  const request = await prepareAgentReview(options);
  if (!previous) { demand(regroup === undefined && ownerContinuation === undefined, 'owner regroup requires preserved previous state; owner continuation also requires history'); return { request, reports: [] }; }
  const now = options.now ?? Date.now; const time = now();
  // Validate bindings before reusing any state, including failed/partial unchanged rounds.
  validateLineage(previous, time, Infinity); await currentLineage(options.cwd, previous, delta);
  const intentChanged = !equal(previous.request.intent, request.intent);
  rescope(previous.request.authorSessionId === request.authorSessionId && (!intentChanged || regroup !== undefined), 'approved intent or author changed; a changed execution approach is required');
  if (intentChanged) { assertRegroup(regroup, previous.request, request); demand(fullRefresh, 'owner regroup requires explicit full refresh'); }
  const preservedRegroup = regroup !== undefined && [...(previous.history ?? []), previous].some(round => equal(regroup, round.request.continuation?.regroup) && equal(round.request.intent, request.intent));
  if (!intentChanged && regroup !== undefined) demand(preservedRegroup, 'owner regroup is not the preserved transition');
  const preservedOwnerContinuation = ownerContinuation !== undefined && equal(ownerContinuation, previous.request.continuation?.ownerContinuation) && equal(previous.request.candidate, request.candidate);
  if (ownerContinuation !== undefined && !preservedOwnerContinuation) {
    assertOwnerContinuation(ownerContinuation, previous.request, request, intentChanged ? regroup : undefined, (previous.history?.length ?? 0) + 1);
    demand((previous.history?.length ?? 0) >= MAX_REPAIRS && (previous.history?.length ?? 0) < ownerCycleLimit(request.intent) && fullRefresh && (regroup === undefined || intentChanged && [3, 4].includes(previous.history?.length ?? 0)), 'owner continuation requires exhausted automatic budget, a remaining owner cycle and explicit full refresh');
  }
  if (!intentChanged && equal(previous.request.candidate, request.candidate)) {
    if (preservedOwnerContinuation) return structuredClone(previous);
    if (preservedRegroup) return structuredClone(previous);
    if (!fullRefresh) return structuredClone(previous);
    // Recovery is unnecessary for a terminal current pass, even if requested.
    let reviewed = true;
    try { validateLineage(previous, time, maxAgeMs); validateRound(previous.request, previous.reports, { complete: true, time, maxAgeMs }); previous.reports.forEach(report => reportPasses(previous.request, report)); } catch { reviewed = false; }
    if (reviewed) return structuredClone(previous);
  }
  rescope((previous.history?.length ?? 0) < MAX_REPAIRS || ownerContinuation !== undefined && !preservedOwnerContinuation && (previous.history?.length ?? 0) < ownerCycleLimit(request.intent), 'two automatic repair cycles are exhausted; change execution approach');
  demand(request.candidate.clean, 'repair requires clean committed candidates');
  let priorComplete = previous.request.candidate.clean;
  try { validateLineage(previous, time, maxAgeMs); validateRound(previous.request, previous.reports, { complete: true, time, maxAgeMs }); } catch { priorComplete = false; }
  const history = [...(previous.history ?? []), { request: previous.request, reports: previous.reports }];
  let deltaPaths;
  try { deltaPaths = await delta(options.cwd, previous.request.candidate, request.candidate); } catch (error) { if (error.message.includes('not an authenticated ancestor')) throw new NeedsRescope('Agent review needs rescope: nonancestor integration requires a changed execution approach'); throw error; }
  const findings = unresolvedCards(history);
  const mode = fullRefresh || !priorComplete || previous.request.candidate.base !== request.candidate.base ? 'full' : repairRisk === 'ordinary' && !deltaPaths.some(sensitivePath) && findings.every(card => card.finding.risk === 'ordinary') ? 'closure' : 'focused';
  paths(deltaPaths, mode === 'full');
  request.version = 2; request.continuation = { cycle: history.length, mode, priorDigest: digest(history), deltaPaths, findings, repairRisk }; if (intentChanged) request.continuation.regroup = structuredClone(regroup); if (ownerContinuation !== undefined) request.continuation.ownerContinuation = structuredClone(ownerContinuation);
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
    if (!equal(observed, request.candidate) && (history?.length ?? 0) >= MAX_REPAIRS) throw new NeedsRescope('Agent review needs rescope: two automatic repair cycles are exhausted; change execution approach');
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
async function main() {
  const [verb, input] = process.argv.slice(2); demand(['prepare', 'record', 'verify', 'status'].includes(verb), 'use prepare <intent.json>, record <observed-report.json>, verify, or status');
  const cwd = await realpath(process.cwd()); const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  await sessionDirectory(cwd);
  const operation = async () => {
  if (verb === 'prepare') {
    const spec = await boundedJson(input ?? join(directory, 'intent.json'));
    demand(Object.keys(spec).every(key => ['intent', 'authorSessionId', 'base', 'repairRisk', 'fullRefresh', 'regroup', 'ownerContinuation'].includes(key)) && Object.hasOwn(spec, 'intent'), 'supervisor request schema is invalid');
    spec.authorSessionId ??= process.env.CODEX_THREAD_ID; spec.base ??= await forkPoint(cwd);
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
