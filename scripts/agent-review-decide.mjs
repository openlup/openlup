// Native supervisor process evidence, not a signature or remote attestation.
import { createHash } from 'node:crypto';

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
  return requiredReviewers(risk) === 2 ? risk : modeChanged || changedPaths.some(sensitivePath) ? 'behavior' : risk;
}
export function requiredReviewers(risk) { demand(RISKS.includes(risk), 'risk is invalid'); return ['prose', 'routine'].includes(risk) ? 1 : 2; }
function candidateValid(candidate) {
  demand(candidate && ['base', 'head', 'tree'].every(key => SHA.test(candidate[key])) && Array.isArray(candidate.changedPaths) && candidate.changedPaths.every(identity), 'candidate is invalid');
}
function stateValid(session) { demand(session?.version === 2, 'session version must be 2'); }
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
  const { authorSessionId, intent: ignored, ...candidate } = observed;
  const next = session ? structuredClone(session) : { version: 2, authorSessionId, intent, cycle: -1, allowedCycles: 3, history: [] };
  next.cycle += session?.candidate?.tree === candidate.tree ? 0 : 1; next.candidate = candidate; next.preparedAt = now;
  next.history.push({ type: 'prepare', intent, candidate, authorSessionId, at: now, cycle: next.cycle });
  return next;
}
export function recordReport(session, report, now) {
  stateValid(session); demand(session.cycle <= session.allowedCycles, 'record an owner continuation with continue "<note>"', 'needs_owner');
  demand(report && identity(report.reviewer) && !authorIds(session).has(report.reviewer) && report.cold === true, 'reviewer must be cold and independent of the author');
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
export function continueOwner(session, note, now) {
  stateValid(session); demand(identity(note) && Number.isFinite(now) && now >= session.preparedAt && session.history.every(event => event.at <= now), 'owner continuation needs a note and timestamp');
  const next = structuredClone(session); next.allowedCycles += 3; next.history.push({ type: 'continue', note, at: now }); return next;
}
export function verdict(session, observed, now) {
  try {
    stateValid(session); candidateValid(observed); demand(Number.isFinite(now), 'verification time is invalid');
    if (!observed.clean) return result(false, 'dirty', 'commit source changes before verification');
    if (['base', 'head', 'tree'].some(key => session.candidate[key] !== observed[key])) return result(false, 'stale', 'candidate changed; prepare and re-review');
    if (session.cycle > session.allowedCycles) return result(false, 'needs_owner', 'record an owner continuation with continue "<note>"');
    const identities = authorIds(session);
    for (const event of session.history) if (event.type === 'report') {
      demand(event.report.cold === true && identity(event.report.reviewer) && !identities.has(event.report.reviewer), 'reviewer must be cold, independent and unique'); identities.add(event.report.reviewer);
    }
    const reports = currentReports(session).filter(report => report.verdict === 'PASS');
    const floor = requiredReviewers(classifyRisk(observed, latestIntent(session).risk));
    if (reports.length < floor) return result(false, 'needs_agent_review', `${floor} independent PASS reports required`);
    if (reports.some(report => report.at > now)) return result(false, 'invalid', 'report is from the future');
    if (now >= Math.min(...reports.map(report => report.at)) + 86400000) return result(false, 'expired', 'review expired; prepare --new and re-review');
    if (openFindings(session).size) return result(false, 'needs_agent_review', 'close every material finding');
    return result(true, 'reviewed', 'reviewed');
  } catch (error) { return result(false, 'invalid', error.message); }
}
export function receiptSummary(session, pr, now) {
  const decision = verdict(session, session.candidate, now); demand(decision.ok, decision.reason, decision.code);
  demand(Number.isSafeInteger(pr) && pr > 0, 'PR number is invalid');
  const reports = currentReports(session).filter(report => report.verdict === 'PASS');
  return { pr, base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree, risk: classifyRisk(session.candidate, latestIntent(session).risk), reviewers: reports.map(report => report.reviewer), verdict: 'PASS', expires: Math.min(...reports.map(report => report.at)) + 86400000, sessionDigest: digest(session) };
}
export function admit({ receipt, observed, now }) {
  if (!Number.isFinite(now) || !receipt || !Number.isSafeInteger(receipt.pr) || receipt.pr <= 0 || !['base', 'head', 'tree'].every(key => SHA.test(receipt[key])) || !RISKS.includes(receipt.risk) || receipt.verdict !== 'PASS' || !/^[a-f0-9]{64}$/u.test(receipt.sessionDigest) || !Array.isArray(receipt.reviewers) || !receipt.reviewers.every(identity) || new Set(receipt.reviewers).size !== receipt.reviewers.length || !Number.isFinite(receipt.expires) || receipt.expires > now + 86400000) return result(false, 'invalid', 'receipt schema or expiry is invalid');
  if (receipt.expires <= now) return result(false, 'expired', 'review receipt expired');
  if (['pr', 'base', 'head', 'tree'].some(key => receipt[key] !== observed[key])) return result(false, 'stale', 'receipt differs from the live PR candidate');
  if (!observed.baseValid) return result(false, 'stale', 'review base must be the fork point or a landed pinned ancestor');
  const floor = Math.max(requiredReviewers(receipt.risk), requiredReviewers(classifyRisk(observed)));
  if (receipt.reviewers.length < floor) return result(false, 'needs_agent_review', `${floor} independent reviewers required by the diff`);
  return result(true, 'reviewed', 'reviewed');
}
const TRUST_PATHS = [/^\.github\//u, /^scripts\/agent-review-/u, /^scripts\/documentation-git\.ts$/u, /^(?:packages\/[^/]+\/)?package(?:-lock)?\.json$/u, /^supabase\/migrations\//u, /^config\/platform-migration-manifest\.json$/u];
export function carryOver({ reviewedTree, groupTree, baseAncestor, predictedTree, changedPaths = [], movedPaths = [] }) {
  if (!baseAncestor) return result(false, 'stale', 'reviewed base is not an ancestor of the queue base; merge main and re-review');
  if (reviewedTree === groupTree) return result(true, 'reviewed', 'unchanged tree');
  if (predictedTree !== groupTree || movedPaths.some(path => changedPaths.includes(path) || TRUST_PATHS.some(pattern => pattern.test(path)))) return result(false, 'stale', 'group does not carry over; merge main and re-review');
  return result(true, 'reviewed', 'disjoint base move');
}
