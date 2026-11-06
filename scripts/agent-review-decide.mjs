// Native supervisor process evidence, not a signature or remote attestation.
import { createHash } from 'node:crypto';
import { NATIVE_CATALOG_CONTROLS } from './reviewed-platform-forward.ts';

export const REVIEW_RULES_VERSION = 3;
export const ECONOMY_RECEIPT_MARKER = '<!-- openlup-native-review-receipt v3 -->';
export const RECEIPT_MARKER = '<!-- openlup-native-review-receipt v2 -->';
const SHA = /^[a-f0-9]{40}$/u;
const RISKS = ['prose', 'routine', 'behavior', 'unknown'];
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function demand(ok, reason, code = 'invalid') { if (!ok) throw new Error(`${code}: ${reason}`); }
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const result = (ok, code, reason) => ({ ok, code, reason });
function sensitivePath(path) {
  return /^(?:\.github|config|db|supabase)(?:\/|$)/iu.test(path) || /\.sql$/iu.test(path) ||
    /(?:^|\/)(?:AGENTS|CLAUDE)(?:\.local)?\.(?:md|txt|rst)$/iu.test(path) ||
    /(?:^|\/)(?:CONTRIBUTING|SECURITY|AI_CONTRIBUTION_POLICY|AGENT_GUIDE)\.(?:md|txt|rst)$/iu.test(path) ||
    /^scripts\/(?:agent-review|check-|oss-|dco-|run-|merge-preview|verify-candidate|packages\/)/iu.test(path) ||
    /^(?:package(?:-lock)?\.json|\.git(?:attributes|ignore)|.*(?:config|policy|security|auth|migration|payment|checkout|subscription|permission|access|credential|secret|token|release|publish|deploy|schema|contract|account|login|otp|cardSetup|paymentCard|customer|invoice).*)$/iu.test(path) ||
    /^(?:packages\/core|server\/(?:bff|adapters|runtime|domains\/(?:accounting|customers|shipping))|src\/(?:integrations|pages\/account|domains\/(?:customers|shipping)))(?:\/|$)/iu.test(path) ||
    /^docs\/platform\/plans\/autonomous-reviewed-delivery/iu.test(path);
}
export function classifyRisk({ changedPaths = [], modeChanged = false }, risk = 'routine') {
  demand(RISKS.includes(risk), 'risk is invalid');
  return requiredReviewers(risk) === 2 ? risk : modeChanged || changedPaths.some(twoReviewerPath) ? 'behavior' : risk;
}
export function requiredReviewers(risk) { demand(RISKS.includes(risk), 'risk is invalid'); return risk === 'behavior' ? 2 : 1; }
function candidateValid(candidate) {
  demand(candidate && ['base', 'head', 'tree'].every(key => SHA.test(candidate[key])) && Array.isArray(candidate.changedPaths) && candidate.changedPaths.every(identity), 'candidate is invalid');
}
function stateValid(session) { demand([2, 3].includes(session?.version), 'session version must be 2; a version-1 session from before 2026-10-19 cannot be converted: delete .context/scratch/agent-review/session.json and prepare again'); }
const latestPrepare = session => session.history.findLast(event => event.type === 'prepare');
const latestIntent = session => latestPrepare(session)?.intent ?? session.intent;
const authorIds = session => new Set([session.authorSessionId, ...session.history.filter(event => event.type === 'prepare').map(event => event.authorSessionId)]);
function currentReports(session) {
  const start = session.history.findLastIndex(event => event.type === 'prepare');
  return session.history.slice(start + 1).filter(event => event.type === 'report').map(event => event.report);
}
function openFindings(session) {
  const open = new Set();
  for (const event of session.history) if (event.type === 'report') {
    for (const finding of event.report.findings) if (finding.material) open.add(finding.id);
    for (const id of event.report.closes) open.delete(id);
  }
  return open;
}
// Earlier source coverage narrows inspection, never the fresh reviewer floor.
const legacyReviewExpiry = session => Math.min(
  ...currentReports(session).filter(report => report.verdict === 'PASS').map(report => report.at + 86400000),
  session.candidate.integration?.expires ?? (currentReports(session).some(report => report.verdict === 'PASS') ? Infinity : session.preparedAt + 86400000),
);
const DAY = 86400000;
const CONTROL_PATHS = new Set([
  'AGENTS.md', 'CONTRIBUTING.md', 'docs/platform/AGENT_GUIDE.md',
  'docs/platform/DOCUMENTATION.md', 'docs/platform/DEVELOPMENT_AND_RELEASE.md',
  'docs/platform/plans/native-review-simplification-proposal.md',
  'docs/platform/plans/ci-base-move-and-receipts.md',
  'docs/platform/plans/oss-m19-review-economy.md',
  'docs/platform/plans/oss-m19-integration-trailer.md',
  '.gitleaksignore', 'packages/ui/smoke/neutrality.ts',
  'scripts/verification-plan.mjs',
  'packages/platform/test/packageBoundary.test.ts',
  'docs/platform/communications-conformance.mjs',
]);
export function protectedCoveragePath(path) {
  if (typeof path !== 'string' || /[\\\x00-\x1f\x7f]/u.test(path) || path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..' || part === '')) return true;
  return sensitivePath(path) || TRUST_PATHS.some(pattern => pattern.test(path)) || CONTROL_PATHS.has(path) || NATIVE_CATALOG_CONTROLS.includes(path) ||
    /^(?:config|db|supabase|\.github|tests\/setup)(?:\/|$)/u.test(path) ||
    /^scripts\/(?:documentation-|reviewed-|ci-|ast-grep\/|agent-context\/|public-ci-|pgtap-|assert-coverage-|site-routes\.|platform-migration-manifest\.|run-|verify-|coverage-|disposable-|oss-|source-|packages\/)/u.test(path) ||
    /^packages\/[^/]+\/scripts\//u.test(path) || /\.api\.md$/u.test(path) ||
    /^docs\/platform\/plans\/autonomous-reviewed-delivery/u.test(path) ||
    /(?:^|\/)(?:AGENTS|AGENT_GUIDE|CLAUDE|CONTRIBUTING|SECURITY|AI_CONTRIBUTION_POLICY)(?:\.local)?\.(?:md|txt|rst)$/iu.test(path) ||
    /(?:manifest|lockfile|release-gates|budget)|\.sql$|(?:^|\/)migrations(?:\/|$)/iu.test(path) ||
    /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/u.test(path) ||
    /^(?:\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|[^/]*config\.[^/]+)$/u.test(path);
}
const RULE_FILE = /(?:^|\/)(?:AGENTS|AGENT_GUIDE|CLAUDE|CONTRIBUTING|SECURITY|AI_CONTRIBUTION_POLICY)(?:\.local)?\.(?:md|txt|rst)$|^\.github\/.*\.md$|(?:^|\/)(?:\.claude|\.agents|\.codex)\/|(?:^|\/)SKILL\.md$/iu;
const twoReviewerPath = path => protectedCoveragePath(path) && !/\.md$/iu.test(path);
export const deltaFloor = (paths, modeChanged = false) => modeChanged || paths.some(twoReviewerPath) ? 2 : paths.every(path => /\.md$/iu.test(path) && !RULE_FILE.test(path)) ? 0 : 1;
export const candidateFloor = (candidate, risk) => requiredReviewers(classifyRisk(candidate, risk)) === 2 ? 2 : deltaFloor(candidate.changedPaths ?? [], candidate.modeChanged);
export function fullReviewReports(session) {
  const reports = currentReports(session).filter(report => report.ordinary !== true && report.cold === true && report.tree === session.candidate.tree && ['PASS', 'FAIL'].includes(report.verdict));
  return reports.length > 0 && reports.length >= candidateFloor(session.candidate, latestIntent(session).risk) ? reports : undefined;
}
function prefixSession(session, end) {
  const history = session.history.slice(0, end); const event = history.findLast(item => item.type === 'prepare');
  demand(event, 'coverage prefix has no candidate');
  const version = history.some(item => item.type === 'rules' || item.candidate?.rules?.version === 3) ? 3 : 2;
  return { ...session, version, history, candidate: event.candidate, preparedAt: event.at };
}
export function coverageState(session) {
  demand(digest(session.candidate) === digest(latestPrepare(session)?.candidate), 'candidate differs from history');
  const start = session.history.findLastIndex(event => event.type === 'prepare');
  const event = session.history[start]; demand(event, 'missing prepare');
  const candidate = event.candidate; const passes = currentReports(session).filter(report => report.verdict === 'PASS');
  demand(passes.every(report => report.ordinary === undefined || report.ordinary === false || report.ordinary === true), 'review scope must be full or delta-only');
  const fullReports = passes.filter(report => report.ordinary !== true); const deltaReports = passes.filter(report => report.ordinary === true);
  let reports = fullReports;
  const edge = candidate.coverage; let inherited; let floor = candidateFloor(candidate, event.intent.risk);
  if (edge) {
    demand(start > 0 && candidate.rules?.version === 3, 'missing enabled coverage policy');
    const prior = prefixSession(session, session.history[start - 1]?.type === 'rules' ? start - 1 : start);
    demand(edge.previous === digest(prior.history) && digest(edge.from) === digest({ base: prior.candidate.base, head: prior.candidate.head, tree: prior.candidate.tree }), 'coverage prefix differs');
    demand(digest(event.intent) === digest(latestIntent(prior)) && event.authorSessionId === latestPrepare(prior).authorSessionId, 'coverage intent or author changed');
    const decision = verdict(prior, prior.candidate, event.at);
    const priorFull = !decision.ok && edge.kind === 'repair' ? fullReviewReports(prior) : undefined;
    demand(decision.ok || priorFull, 'prior coverage is incomplete or unresolved');
    const portable = edge.kind === 'integration' && ['portable-git', 'portable-registry-union', 'portable-resolution'].includes(edge.proof?.kind);
    inherited = priorFull ? {
      earliest: Math.min(...priorFull.map(report => report.at)), expires: Math.min(...priorFull.map(report => report.at + DAY)),
      base: prior.candidate.base, paths: prior.candidate.changedPaths,
    } : prior.version === 2 && portable ? {
      earliest: Math.min(...currentReports(prior).filter(report => report.verdict === 'PASS').map(report => report.at)),
      expires: legacyReviewExpiry(prior), base: prior.candidate.base, paths: prior.candidate.changedPaths,
    } : coverageState(prior);
    if (!portable) demand(prior.candidate.rules?.version === 3, 'coverage policy changed');
    if (edge.kind === 'integration') {
      demand(candidate.integration && (portable || ['git', 'registry-union', 'resolution'].includes(edge.proof?.kind)) && edge.proof.tree === candidate.tree, 'integration proof missing'); floor = 0;
    } else demand(edge.kind === 'repair' && candidate.base === prior.candidate.base && candidate.rules.base === prior.candidate.rules.base && edge.proof?.paths?.length > 0, 'repair delta is missing');
    const delta = edge.kind === 'repair' ? edge.proof.paths : edge.proof.resolution;
    if (delta) {
      floor = deltaFloor(delta, edge.proof.modeChanged === true);
      demand(deltaReports.every(report => report.delta === edge.delta), 'delta reviewer must confirm the exact delta');
      if (fullReports.length) {
        inherited = undefined; floor = candidateFloor(candidate, event.intent.risk);
      } else reports = deltaReports;
    }
  }
  demand(reports.length >= floor, `${floor} independent PASS reports required`, 'needs_agent_review');
  const earliest = inherited?.earliest ?? (reports.length ? Math.min(...reports.map(report => report.at)) : session.preparedAt);
  const expires = Math.min(inherited?.expires ?? Infinity, ...(reports.length ? reports.map(report => report.at + DAY) : [earliest + DAY]), candidate.integration?.expires ?? Infinity);
  return { earliest, expires, base: inherited?.base ?? candidate.base, paths: [...new Set([...(inherited?.paths ?? []), ...candidate.changedPaths])] };
}
const reviewExpiry = session => session.version === 3 ? coverageState(session).expires : legacyReviewExpiry(session);
export function integrationReviewContext(session, observed, { parents, baseAncestor, mechanical = false }, now) {
  if (!session || !verdict(session, session.candidate, now).ok || !baseAncestor ||
    digest(latestIntent(session)) !== digest(observed.intent) ||
    latestPrepare(session).authorSessionId !== observed.authorSessionId ||
    !Array.isArray(parents) || parents.length !== 2 || parents[0] !== session.candidate.head || parents[1] !== observed.base ||
    observed.base === session.candidate.base) return undefined;
  return { base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree, expires: reviewExpiry(session), mechanical };
}
export function prepareCandidate(session, observed, now, fresh = false) {
  candidateValid(observed); demand(Number.isFinite(now), 'prepare time is invalid'); demand(observed.clean, 'commit source changes before prepare', 'dirty');
  demand(identity(observed.authorSessionId) && identity(observed.intent?.criteria), 'author and intent.criteria are required');
  const intent = observed.intent; classifyRisk(observed, intent.risk);
  demand(intent.scope === undefined || (Array.isArray(intent.scope) && observed.changedPaths.every(path => intent.scope.includes(path))), 'changed paths exceed intent.scope');
  if (session) {
    stateValid(session);
    demand(session.history.every(event => event.at <= now), 'prepare time is invalid');
    if (!fresh) {
      demand((latestPrepare(session)?.authorSessionId ?? session.authorSessionId) === observed.authorSessionId && digest(latestIntent(session)) === digest(intent), 'author or intent changed; use prepare --new');
      if (session.candidate.tree === observed.tree && session.candidate.head === observed.head && session.candidate.base === observed.base) return structuredClone(session);
    }
  }
  if (observed.integration) {
    const expected = integrationReviewContext(session, observed, { parents: [session?.candidate.head, observed.base], baseAncestor: true, mechanical: observed.integration.mechanical === true }, now);
    demand(!fresh && expected && digest(expected) === digest(observed.integration), 'integration coverage is invalid');
  }
  const { authorSessionId, intent: ignored, ...candidate } = observed;
  const next = session ? structuredClone(session) : { version: 2, authorSessionId, intent, history: [] };
  if (candidate.rules?.version === 3) {
    if (next.version === 2) next.history.push({ type: 'rules', version: 3, at: now });
    next.version = 3;
  }
  next.candidate = candidate; next.preparedAt = now;
  next.history.push({ type: 'prepare', intent, candidate, authorSessionId, at: now });
  return next;
}
export function recordReport(session, report, now) {
  stateValid(session);
  demand(report && identity(report.reviewer) && !authorIds(session).has(report.reviewer) && report.cold === true, 'reviewer must be cold and independent of the author');
  demand(identity(report.documentation), 'documentation assessment is required');
  demand(!session.history.some(event => event.type === 'report' && event.report.reviewer === report.reviewer), 'reviewer id already used in this session');
  demand(report.tree === session.candidate.tree && ['PASS', 'FAIL'].includes(report.verdict), 'report tree or verdict differs');
  demand(Number.isFinite(now) && now >= session.preparedAt && session.history.every(event => event.at <= now), 'report time is invalid');
  demand(Array.isArray(report.findings) && Array.isArray(report.closes), 'findings and closes must be arrays');
  demand(report.findings.every(finding => identity(finding.id) && identity(finding.summary) && typeof finding.material === 'boolean') && new Set(report.findings.map(finding => finding.id)).size === report.findings.length, 'findings need unique stable ids, summaries and material flags');
  const prior = session.history.filter(event => event.type === 'report').flatMap(event => event.report.findings);
  demand(report.findings.every(finding => prior.every(old => old.id !== finding.id || digest(old) === digest(finding))), 'finding id changed meaning');
  demand(new Set(report.closes).size === report.closes.length && report.closes.every(id => openFindings(session).has(id)), 'closes must name open material findings');
  const next = structuredClone(session); next.history.push({ type: 'report', at: now, report: { ...report, at: now } }); return next;
}
function validateHistory(session) {
  let candidate; let enabled = false; const findings = new Map(); const open = new Set();
  for (const event of session.history) {
    demand(['prepare', 'report', 'continue', 'rules', 'renew'].includes(event.type), 'unknown history event');
    if (event.type === 'rules') { demand(event.version === 3, 'unknown rules transition'); enabled = true; }
    if (event.type === 'prepare') { candidate = event.candidate; candidateValid(candidate); enabled ||= candidate.rules?.version === 3; }
    if (event.type !== 'report') continue;
    const report = event.report;
    if (enabled) demand(identity(report.documentation), 'documentation assessment is required');
    demand(candidate && report.tree === candidate.tree && report.at === event.at && ['PASS', 'FAIL'].includes(report.verdict) &&
      Array.isArray(report.findings) && Array.isArray(report.closes), 'report differs from its historical candidate');
    for (const finding of report.findings) {
      demand(identity(finding.id) && identity(finding.summary) && typeof finding.material === 'boolean' &&
        (!findings.has(finding.id) || digest(findings.get(finding.id)) === digest(finding)), 'finding changed meaning');
      findings.set(finding.id, finding); if (finding.material) open.add(finding.id);
    }
    demand(new Set(report.closes).size === report.closes.length && report.closes.every(id => open.has(id)), 'invalid historical finding closure');
    report.closes.forEach(id => open.delete(id));
  }
}
export function verdict(session, observed, now) {
  try {
    stateValid(session); candidateValid(observed); demand(Number.isFinite(now), 'verification time is invalid');
    if (!observed.clean) return result(false, 'dirty', 'commit source changes before verification');
    if (['base', 'head', 'tree'].some(key => session.candidate[key] !== observed[key])) return result(false, 'stale', 'candidate changed; prepare and re-review');
    const identities = authorIds(session);
    for (const event of session.history) if (event.type === 'report') {
      demand(event.report.cold === true && identity(event.report.reviewer) && !identities.has(event.report.reviewer), 'reviewer must be cold, independent and unique'); identities.add(event.report.reviewer);
    }
    demand(session.history.every((event, index) => Number.isFinite(event.at) && event.at <= now && (index === 0 || event.at >= session.history[index - 1].at)), 'history time is invalid');
    if (session.version === 3) {
      validateHistory(session);
      coverageState(session);
      if (openFindings(session).size) return result(false, 'needs_agent_review', 'close every material finding');
      return result(true, 'reviewed', 'reviewed');
    }
    const reports = currentReports(session).filter(report => report.verdict === 'PASS');
    const floor = candidateFloor(observed, latestIntent(session).risk);
    if (reports.length < floor) return result(false, 'needs_agent_review', `${floor} independent PASS reports required`);
    if (reports.some(report => report.at > now)) return result(false, 'invalid', 'report is from the future');
    if (openFindings(session).size) return result(false, 'needs_agent_review', 'close every material finding');
    return result(true, 'reviewed', 'reviewed');
  } catch (error) { return result(false, error.message.startsWith('needs_agent_review:') ? 'needs_agent_review' : 'invalid', error.message); }
}
export function receiptSummary(session, pr, now) {
  const decision = verdict(session, session.candidate, now); demand(decision.ok, decision.reason, decision.code);
  demand(Number.isSafeInteger(pr) && pr > 0, 'PR number is invalid');
  const reports = currentReports(session).filter(report => report.verdict === 'PASS');
  if (session.version === 3) {
    const summary = { version: 3, pr, base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree,
      risk: classifyRisk(session.candidate, latestIntent(session).risk), verdict: 'PASS', expires: reviewExpiry(session),
      sessionDigest: digest(session), session };
    demand(Buffer.byteLength(JSON.stringify(summary)) <= 1024 * 1024 - 128, 'receipt exceeds bounded transport'); return summary;
  }
  return { pr, base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree, risk: classifyRisk(session.candidate, latestIntent(session).risk), reviewers: reports.map(report => report.reviewer), verdict: 'PASS', expires: reviewExpiry(session), sessionDigest: digest(session) };
}
export function admit({ receipt, observed, now }) {
  if (receipt?.version === 3) {
    try {
      demand(Object.keys(receipt).sort().join(',') === 'base,expires,head,pr,risk,session,sessionDigest,tree,verdict,version', 'v3 receipt keys differ');
      demand(receipt.session?.version === 3 && digest(receipt.session) === receipt.sessionDigest, 'v3 history digest differs');
      // Risk classification and expiry are legacy summary metadata; exact source and history still bind admission.
      demand(RISKS.includes(receipt.risk) && Number.isFinite(receipt.expires), 'v3 summary metadata is invalid');
      const expected = receiptSummary(receipt.session, receipt.pr, now); demand(Object.keys(expected).filter(key => !['risk', 'expires'].includes(key)).every(key => digest(expected[key]) === digest(receipt[key])), 'v3 summary differs');
      demand(observed.baseValid && ['base', 'head', 'tree', 'pr'].every(key => receipt[key] === observed[key]), 'v3 live identity differs');
      if (observed.changedPaths) demand(digest(observed.changedPaths) === digest(receipt.session.candidate.changedPaths) && observed.modeChanged === receipt.session.candidate.modeChanged, 'v3 actual diff differs');
      return result(true, 'reviewed', 'reviewed');
    } catch (error) { return result(false, 'invalid', error.message); }
  }
  if (!Number.isFinite(now) || !receipt || !Number.isSafeInteger(receipt.pr) || receipt.pr <= 0 || !['base', 'head', 'tree'].every(key => SHA.test(receipt[key])) || !RISKS.includes(receipt.risk) || receipt.verdict !== 'PASS' || !/^[a-f0-9]{64}$/u.test(receipt.sessionDigest) || !Array.isArray(receipt.reviewers) || !receipt.reviewers.every(identity) || new Set(receipt.reviewers).size !== receipt.reviewers.length || !Number.isFinite(receipt.expires)) return result(false, 'invalid', 'receipt schema is invalid');
  if (['pr', 'base', 'head', 'tree'].some(key => receipt[key] !== observed[key])) return result(false, 'stale', 'receipt differs from the live PR candidate');
  if (!observed.baseValid) return result(false, 'stale', 'review base must be the exact fork point on main');
  const floor = candidateFloor(observed, receipt.risk);
  if (receipt.reviewers.length < floor) return result(false, 'needs_agent_review', `${floor} independent reviewers required by the diff`);
  return result(true, 'reviewed', 'reviewed');
}
const TRUST_PATHS = [/^\.github\//u, /^scripts\/agent-review-/u, /^scripts\/documentation-git\.ts$/u, /^(?:packages\/[^/]+\/)?package(?:-lock)?\.json$/u, /^(?:db\/platform|supabase)\/migrations\//u, /^config\/platform-migration-manifest\.json$/u];
export function carryOver({ reviewedTree, groupTree, baseAncestor, predictedTree }) {
  if (!baseAncestor) return result(false, 'stale', 'reviewed base is not an ancestor of the queue base; merge main');
  if (reviewedTree === groupTree) return result(true, 'reviewed', 'unchanged tree');
  if (predictedTree !== groupTree) return result(false, 'stale', 'group does not merge cleanly; merge main and review the resolution');
  return result(true, 'reviewed', 'clean merge of the reviewed change');
}
