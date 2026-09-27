// Evidence verifier, not a reviewer or CI observer. A protected controller must
// compute the expectations and sign observations; author-selected inputs confer
// no admission authority. No keys are provisioned by this module.
import { createPublicKey, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const REQUIRED_CHECKS = ['dco', 'typecheck', 'install-proof', 'test', 'self-check', 'gitleaks'];
const LIMIT = 128 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function demand(condition, message) {
  if (!condition) throw new Error(`Review refused: ${message}`);
}

function record(value, fields, label) {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  demand(Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)), `${label} has an unsupported schema`);
}

function identifier(value, label) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value), `${label} is invalid`);
}

function decoded(value, maximum, label) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maximum / 3) * 4, `${label} exceeds bounds`);
  demand(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), `${label} is not canonical base64`);
  const bytes = Buffer.from(value, 'base64');
  demand(bytes.length <= maximum && bytes.toString('base64') === value, `${label} is not canonical base64`);
  return bytes;
}

function checkIdentity(check, label) {
  record(check, ['name', 'source', 'runId', 'head'], label);
  for (const field of ['name', 'source', 'runId']) identifier(check[field], `${label}.${field}`);
  demand(SHA.test(check.head), `${label}.head is invalid`);
}

/** Verify a controller-signed receipt against independently supplied expectations.
 * Times are epoch milliseconds. `publicKey` is an Ed25519 SPKI PEM public key.
 * `checks`, for hosted admission, contains the six independently observed exact
 * {name, source, runId, head} identities. Passing an author's expectations here
 * does not prove independence: protecting this caller is an activation prerequisite.
 */
export function verifyReviewReceipt(envelope, expected) {
  const expectationFields = ['publicKey', 'version', 'stage', 'repository', 'base', 'head', 'tree', 'authorityDigest', 'policyDigest', 'requestId', 'risk', 'requiredRoles', 'authorRunId', 'now', 'maxValidityMs'];
  record(expected, expected?.stage === 'hosted' || Object.hasOwn(expected ?? {}, 'checks') ? [...expectationFields, 'checks'] : expectationFields, 'trusted expectations');
  demand(expected.version === 1, 'unsupported protocol version');
  demand(['local', 'hosted'].includes(expected.stage), 'unsupported admission stage');
  demand(['prose', 'behavior', 'unknown'].includes(expected.risk), 'unsupported risk classification');
  for (const field of ['repository', 'requestId', 'authorRunId']) identifier(expected[field], `expected ${field}`);
  for (const field of ['base', 'head', 'tree']) demand(SHA.test(expected[field]), `expected ${field} is invalid`);
  for (const field of ['authorityDigest', 'policyDigest']) demand(DIGEST.test(expected[field]), `expected ${field} is invalid`);
  demand(Number.isSafeInteger(expected.now) && expected.now >= 0, 'trusted current time is invalid');
  demand(Number.isSafeInteger(expected.maxValidityMs) && expected.maxValidityMs > 0, 'trusted validity window is invalid');
  demand(Array.isArray(expected.requiredRoles) && expected.requiredRoles.length <= 8, 'trusted roles are invalid');
  for (const role of expected.requiredRoles) identifier(role, 'required role');
  demand(new Set(expected.requiredRoles).size === expected.requiredRoles.length, 'duplicate required roles');
  record(envelope, ['payload', 'signature'], 'signed envelope');
  const bytes = decoded(envelope.payload, LIMIT, 'payload');
  const signature = decoded(envelope.signature, 64, 'signature');
  demand(signature.length === 64, 'signature has invalid length');
  demand(typeof expected.publicKey === 'string' && expected.publicKey.length <= 8192, 'trusted public key is invalid');
  const key = createPublicKey(expected.publicKey);
  demand(key.asymmetricKeyType === 'ed25519', 'trusted key must be Ed25519');
  demand(verify(null, bytes, key, signature), 'signature does not authenticate payload');
  // Parsing follows signature authentication, including strict UTF-8 decoding.
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const bindingFields = ['version', 'stage', 'repository', 'base', 'head', 'tree', 'authorityDigest', 'policyDigest', 'requestId', 'risk'];
  record(payload, [...bindingFields, 'issuedAt', 'expiresAt', 'unresolvedMaterialFindings', 'reviewers', 'checks'], 'receipt payload');
  for (const field of bindingFields) demand(payload[field] === expected[field], `${field} differs from trusted expectations`);
  demand(expected.head !== expected.base, 'baseline is not task approval');
  demand(Number.isSafeInteger(payload.issuedAt) && payload.issuedAt >= 0 && Number.isSafeInteger(payload.expiresAt), 'receipt timestamps are invalid');
  demand(payload.issuedAt <= expected.now, 'receipt is not yet valid');
  demand(payload.expiresAt > expected.now && payload.expiresAt > payload.issuedAt, 'receipt has expired or has invalid validity');
  demand(payload.expiresAt - payload.issuedAt <= expected.maxValidityMs, 'receipt exceeds trusted validity window');
  demand(payload.unresolvedMaterialFindings === 0, 'material findings remain unresolved');
  demand(Array.isArray(payload.reviewers) && payload.reviewers.length >= (expected.risk === 'prose' ? 1 : 2) && payload.reviewers.length <= 8, 'insufficient or excessive reviewer executions');
  const ids = new Set();
  const runs = new Set();
  const roles = new Set();
  let simplicity = false;
  for (const reviewer of payload.reviewers) {
    record(reviewer, ['id', 'runId', 'role', 'cold', 'complete', 'verdict', 'simplicityChecked'], 'reviewer');
    for (const field of ['id', 'runId', 'role']) identifier(reviewer[field], `reviewer ${field}`);
    demand(!ids.has(reviewer.id) && !runs.has(reviewer.runId), 'duplicate reviewer identity or run');
    demand(reviewer.runId !== expected.authorRunId, 'author execution cannot review itself');
    demand(reviewer.cold === true && reviewer.complete === true && reviewer.verdict === 'pass', 'review is not cold, complete and passing');
    demand(typeof reviewer.simplicityChecked === 'boolean', 'reviewer simplicity coverage is invalid');
    ids.add(reviewer.id);
    runs.add(reviewer.runId);
    roles.add(reviewer.role);
    simplicity ||= reviewer.simplicityChecked;
  }
  demand(simplicity, 'simplicity perspective was not reviewed');
  demand(expected.requiredRoles.every((role) => roles.has(role)), 'required reviewer role or specialist coverage is missing');
  demand(Array.isArray(payload.checks), 'checks must be an array');
  if (expected.stage === 'local') {
    demand(!Object.hasOwn(expected, 'checks') || (Array.isArray(expected.checks) && expected.checks.length === 0), 'local expectations must not select hosted checks');
    demand(payload.checks.length === 0, 'local receipt must not claim hosted admission');
  } else {
    demand(Array.isArray(expected.checks) && expected.checks.length === REQUIRED_CHECKS.length && payload.checks.length === REQUIRED_CHECKS.length, 'hosted check coverage is incomplete');
    const seen = new Set();
    for (const check of expected.checks) {
      checkIdentity(check, 'trusted check');
      demand(REQUIRED_CHECKS.includes(check.name) && !seen.has(check.name) && check.head === expected.head, 'trusted check identity or candidate is invalid');
      seen.add(check.name);
    }
    seen.clear();
    for (const check of payload.checks) {
      record(check, ['name', 'source', 'runId', 'head', 'status', 'conclusion'], 'hosted check');
      const wanted = expected.checks.find((entry) => entry.name === check.name);
      demand(wanted && !seen.has(check.name), 'missing, duplicate or unexpected hosted check');
      for (const field of ['name', 'source', 'runId', 'head']) demand(check[field] === wanted[field], `hosted check ${field} differs from trusted observation`);
      demand(check.status === 'completed' && check.conclusion === 'SUCCESS', 'hosted check did not complete with SUCCESS');
      seen.add(check.name);
    }
  }
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('Review refused: library-only verifier; invoke from a protected caller.\n');
  process.exitCode = 1;
}
