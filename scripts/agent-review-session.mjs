// Local Git and state adapters for native supervisor process evidence.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { env as processEnvironment } from 'node:process';
import { ECONOMY_RECEIPT_MARKER, coverageState, digest, protectedCoveragePath, ordinaryRepairPath, renewCoverage, carryOver, continueOwner, demand, integrationReviewContext, prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER, verdict } from './agent-review-decide.mjs';
import { REGISTRY_PATHS, registryUnion } from './agent-review-registry.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
export async function git(cwd, ...args) {
  return (await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...processEnvironment, PATH: '/usr/bin:/bin' } })).stdout;
}
export async function captureCommittedReviewCandidate(cwd, base, head, runGit = git) {
  demand(SHA.test(base) && SHA.test(head), 'base and head must be full commit digests');
  const tree = (await runGit(cwd, 'rev-parse', '--verify', `${head}^{tree}`)).trim();
  const raw = (await runGit(cwd, 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head)).split('\0').filter(Boolean);
  const changedPaths = []; let modeChanged = false;
  for (let index = 0; index < raw.length; index += 2) {
    const modes = /^:(\d{6}) (\d{6}) /u.exec(raw[index]); demand(modes && raw[index + 1], 'unreadable diff');
    changedPaths.push(raw[index + 1]);
    const [oldMode, newMode] = modes.slice(1);
    modeChanged ||= oldMode === '120000' || newMode === '120000' || (oldMode === '000000' ? newMode !== '100644' : newMode === '000000' ? oldMode !== '100644' : oldMode !== newMode);
  }
  return { base, head, tree, changedPaths, modeChanged, clean: true };
}
export async function captureSessionCandidate(cwd, base, { runGit = git, env = processEnvironment } = {}) {
  const head = (await runGit(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const forks = (await runGit(cwd, 'merge-base', '--all', head, 'origin/main')).trim().split('\n');
  demand(forks.length === 1 && SHA.test(forks[0]), 'HEAD must have a single fork point with origin/main');
  const pinned = env.OPENLUP_STACK_BASE;
  demand(pinned === undefined || SHA.test(pinned), 'OPENLUP_STACK_BASE must be a full commit digest');
  base ??= pinned ?? forks[0];
  if (pinned) {
    demand(base === pinned, 'stack base changed', 'stale');
    try { await runGit(cwd, 'merge-base', '--is-ancestor', forks[0], base); await runGit(cwd, 'merge-base', '--is-ancestor', base, head); }
    catch { throw new Error('invalid: OPENLUP_STACK_BASE must lie between the fork point and HEAD'); }
  } else demand(base === forks[0], 'fork point changed; prepare again', 'stale');
  const candidate = await captureCommittedReviewCandidate(cwd, base, head, runGit);
  candidate.clean = !(await runGit(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).context/scratch')).length;
  return candidate;
}
async function ancestor(runGit, cwd, base, head) {
  try { await runGit(cwd, 'merge-base', '--is-ancestor', base, head); return true; } catch { return false; }
}
// Normalize lineage evidence only; the candidate/receipt still binds the actual tip.
async function integrationParents(cwd, head) {
  const [parentLine, tree] = (await git(cwd, 'show', '-s', '--format=%P%n%T', head)).trimEnd().split('\n');
  const parents = parentLine.split(' ').filter(Boolean);
  if (parents.length !== 1) return parents;
  // Pretty-printed %B truncates at NUL; validate the complete raw message instead.
  const commit = await git(cwd, 'cat-file', 'commit', head); const boundary = commit.indexOf('\n\n');
  if (boundary < 0 || commit.includes('\0')) return parents;
  const [subject, ...body] = commit.slice(boundary + 2).trimEnd().split('\n');
  if (!subject?.trim() || body[0] !== '' ||
    !body.some(line => /^OpenLup-Doc-Impact:[ \t]*\S/u.test(line)) ||
    !body.every(line => line === '' || /^(?:OpenLup-Doc-Impact|Signed-off-by):[ \t]*\S[^\r\n]*$/u.test(line))) return parents;
  const [mergeParents, mergeTree] = (await git(cwd, 'show', '-s', '--format=%P%n%T', parents[0])).trim().split('\n');
  const joined = mergeParents.split(' ').filter(Boolean);
  // Do not recurse: two trailer commits, or a trailer on a non-merge, cannot qualify.
  return tree === mergeTree && joined.length === 2 ? joined : parents;
}
export async function carryOverSourceReview(cwd, candidate, group, runGit = git) {
  const baseAncestor = await ancestor(runGit, cwd, candidate.base, group.base);
  let predictedTree; let movedPaths = []; const manifests = {};
  if (baseAncestor && candidate.tree !== group.tree) {
    try { predictedTree = (await runGit(cwd, 'merge-tree', '--write-tree', `--merge-base=${candidate.base}`, group.base, candidate.head)).trim(); } catch { predictedTree = null; }
    movedPaths = (await runGit(cwd, 'diff', '--name-only', '--no-renames', '-z', candidate.base, group.base)).split('\0').filter(Boolean);
    for (const path of movedPaths.filter(path => /^packages\/[\w.-]+\/package\.json$/u.test(path))) {
      const [base, queueBase, head, merged] = await Promise.all([candidate.base, group.base, candidate.head, group.tree].map(async sha => {
        try {
          const blob = await runGit(cwd, 'show', `${sha}:${path}`);
          return Buffer.byteLength(blob, 'utf8') <= 1024 * 1024 ? JSON.parse(blob) : undefined;
        } catch { return undefined; }
      }));
      manifests[path] = { base, queueBase, head, group: merged };
    }
  }
  return carryOver({ reviewedTree: candidate.tree, groupTree: group.tree, baseAncestor, predictedTree, changedPaths: candidate.changedPaths, movedPaths, manifests });
}
// Source objects are parsed, never imported as candidate modules.
export async function captureReviewRules(cwd, candidate, runGit = git) {
  let source;
  try { source = await runGit(cwd, 'show', `${candidate.base}:scripts/agent-review-decide.mjs`); } catch { return undefined; }
  if (!/^export const REVIEW_RULES_VERSION = 3;$/mu.test(source)) return undefined;
  const snapshot = async revision => {
    const rows = (await runGit(cwd, 'ls-tree', '-rz', '--full-tree', revision)).split('\0').filter(Boolean);
    return digest(rows.filter(row => {
      const path = row.slice(row.indexOf('\t') + 1);
      return protectedCoveragePath(path) && !REGISTRY_PATHS.includes(path);
    }).sort());
  };
  return { version: 3, base: await snapshot(candidate.base), head: await snapshot(candidate.head) };
}
async function objectInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', ...args],
      { env: { ...processEnvironment, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16 * 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(`Git object write refused: ${error}`)); });
    child.stdin.end(input);
  });
}
async function replaceTreeBlobs(cwd, tree, replacements) {
  const rows = (await git(cwd, 'ls-tree', '-z', tree)).split('\0').filter(Boolean);
  const output = [];
  for (const row of rows) {
    const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row); demand(match, 'unreadable merge tree');
    const [, mode, type, oid, name] = match;
    let next = replacements.get(name) ?? oid;
    const nested = new Map([...replacements].filter(([path]) => path.startsWith(name + '/')).map(([path, value]) => [path.slice(name.length + 1), value]));
    if (nested.size) { demand(type === 'tree', 'registry parent is not a tree'); next = await replaceTreeBlobs(cwd, oid, nested); }
    output.push(`${mode} ${type} ${next}\t${name}\0`);
  }
  demand([...replacements.keys()].every(path => rows.some(row => path === row.slice(row.indexOf('\t') + 1) || path.startsWith(row.slice(row.indexOf('\t') + 1) + '/'))), 'registry absent from merge tree');
  return objectInput(cwd, ['mktree', '-z'], output.join(''));
}
export async function proveReviewIntegration(cwd, previous, current) {
  const parents = await integrationParents(cwd, current.head);
  demand(parents.length === 2 && parents[0] === previous.head && parents[1] === current.base, 'integration parents differ');
  demand(await ancestor(git, cwd, previous.base, current.base), 'integration base ancestry differs');
  const own = (await captureCommittedReviewCandidate(cwd, previous.base, previous.head)).changedPaths;
  const moved = (await captureCommittedReviewCandidate(cwd, previous.base, current.base)).changedPaths;
  const registries = moved.filter(path => REGISTRY_PATHS.includes(path));
  demand(!moved.some(path => !registries.includes(path) && (own.includes(path) || protectedCoveragePath(path))), 'main touched candidate or machinery path');
  let prediction; let conflicts = [];
  try { prediction = (await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', previous.head, current.base)).split('\0')[0]; }
  catch (error) {
    if (error.code !== 1) throw error;
    const parts = error.stdout.split('\0'); prediction = parts.shift(); conflicts = parts.filter(Boolean);
    demand(conflicts.length > 0 && conflicts.every(path => registries.includes(path)), 'nonregistry integration conflict');
  }
  demand(SHA.test(prediction), 'merge prediction missing'); const replacements = new Map();
  for (const path of registries) {
    const blobs = [];
    for (const revision of [previous.base, previous.head, current.base]) {
      const rows = (await git(cwd, 'ls-tree', revision, '--', path)).trim(); demand(rows.startsWith('100644 blob '), 'unsupported registry mode');
      blobs.push(await git(cwd, 'show', `${revision}:${path}`));
    }
    const union = registryUnion(path, ...blobs);
    // Clean Git remains authoritative if it preserves the exact same registry
    // entries. Conflicting carriers require the deterministic union bytes.
    if (conflicts.includes(path)) replacements.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
    else {
      const actual = await git(cwd, 'show', `${prediction}:${path}`);
      demand(registryUnion(path, actual, actual, actual) === registryUnion(path, union, union, union), 'clean registry merge differs from exact union');
    }
  }
  if (replacements.size) prediction = await replaceTreeBlobs(cwd, prediction, replacements);
  demand(prediction === current.tree, 'integration whole tree differs from prediction');
  return { kind: conflicts.length ? 'registry-union' : 'git', tree: prediction, own, moved };
}
async function hasProductionConsumer(cwd, head, paths) {
  const code = paths.filter(path => /\.(?:[cm]?[jt]sx?|json)$/u.test(path)); const seen = new Set();
  for (let index = 0; index < code.length; index++) {
    const path = code[index]; if (seen.has(path)) continue; seen.add(path);
    if (/^(?:packages\/[^/]+\/src|server|api)\//u.test(path)) return true;
    let matches;
    try {
      matches = await git(cwd, 'grep', '-l', '-z', '-F', '-e', posix.basename(path).replace(/\.[^.]+$/u, ''), head, '--',
        'src', 'server', 'api', 'packages/*/src', 'packages/*/test', 'scripts', 'examples', 'tests');
    } catch (error) { if (error.code === 1) continue; throw error; }
    for (const row of matches.split('\0').filter(Boolean)) {
      const importer = row.slice(row.indexOf(':') + 1);
      if (!/\.[cm]?[jt]sx?$/u.test(importer)) continue;
      const source = await git(cwd, 'show', `${head}:${importer}`);
      for (const match of source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)(["'])([^"'\r\n]+)\1/gu)) {
        const specifier = match[2];
        const target = specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(importer), specifier))
          : specifier.startsWith('@/') ? 'src/' + specifier.slice(2) : specifier;
        const stem = target.replace(/\.[cm]?[jt]sx?$/u, '');
        if ([target, stem, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '/index.ts', '/index.js'].map(suffix => stem + suffix)].includes(path)) {
          const testOnly = !protectedCoveragePath(importer) && (ordinaryRepairPath(importer) || /^(?:tests\/|packages\/[^/]+\/test\/)/u.test(importer));
          if (!testOnly) return true; code.push(importer);
        }
      }
    }
  }
  return false;
}
export async function captureCoverageEdge(cwd, session, observed, now) {
  if (!session || !verdict(session, session.candidate, now).ok || !observed.rules || !session.candidate.rules ||
    session.candidate.rules.head !== observed.rules.head ||
    digest(observed.intent) !== digest(session.history.findLast(event => event.type === 'prepare').intent) ||
    observed.authorSessionId !== session.history.findLast(event => event.type === 'prepare').authorSessionId) return undefined;
  // An unlanded stack base remains eligible for ordinary full review only.
  if (!await ancestor(git, cwd, observed.base, 'origin/main')) return undefined;
  let proof; let kind;
  if (session.candidate.base !== observed.base) {
    try { proof = await proveReviewIntegration(cwd, session.candidate, observed); kind = 'integration'; }
    catch { return undefined; }
  } else {
    const delta = await captureCommittedReviewCandidate(cwd, session.candidate.head, observed.head);
    const commits = (await git(cwd, 'rev-list', '--merges', `${session.candidate.head}..${observed.head}`)).trim();
    if (!await ancestor(git, cwd, session.candidate.head, observed.head) || commits || delta.modeChanged || !delta.changedPaths.length || !delta.changedPaths.every(ordinaryRepairPath) || await hasProductionConsumer(cwd, observed.head, delta.changedPaths)) return undefined;
    proof = { paths: delta.changedPaths, modeChanged: false }; kind = 'repair';
  }
  return { kind, previous: digest(session.history), from: { base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree },
    delta: digest(await git(cwd, 'diff', '--binary', '--no-renames', session.candidate.head, observed.head)), proof };
}
export async function captureRenewalProof(cwd, session, runGit = git) {
  const candidate = session.candidate; const rules = await captureReviewRules(cwd, candidate, runGit);
  demand(rules && digest(rules) === digest(candidate.rules), 'renewal tree policy changed');
  const main = (await runGit(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
  const anchor = coverageState(session);
  demand(await ancestor(runGit, cwd, anchor.base, main), 'renewal base is not on main');
  const touched = (await runGit(cwd, 'log', '--full-history', '--diff-merges=separate', '--format=', '--name-only', '--no-renames', '-z', `${anchor.base}..${main}`)).split('\0').filter(Boolean);
  demand(!touched.some(path => anchor.paths.includes(path) || protectedCoveragePath(path)), 'main touched candidate or machinery path');
  return { main, untouched: true };
}
// Trusted admission and local verify rederive every recorded exceptional edge.
export async function validateEconomySession(cwd, session, runGit = git) {
  if (session.version !== 3) return;
  for (let index = 0; index < session.history.length; index++) {
    const event = session.history[index];
    if (event.type === 'prepare') {
      const actual = await captureCommittedReviewCandidate(cwd, event.candidate.base, event.candidate.head, runGit);
      for (const key of ['base', 'head', 'tree', 'changedPaths', 'modeChanged']) demand(digest(actual[key]) === digest(event.candidate[key]), 'recorded candidate diff differs');
      const rules = await captureReviewRules(cwd, actual, runGit);
      demand(rules === undefined ? event.candidate.rules === undefined :
        event.candidate.rules !== undefined && digest(rules) === digest(event.candidate.rules), 'recorded policy or base rules differ');
      if (event.candidate.coverage) {
        const prefix = session.history.slice(0, session.history[index - 1]?.type === 'rules' ? index - 1 : index); const prior = prefix.findLast(item => item.type === 'prepare');
        const before = { ...session, candidate: prior.candidate, history: prefix, preparedAt: prior.at, cycle: prior.cycle };
        const edge = await captureCoverageEdge(cwd, before, { ...actual, rules, intent: event.intent, authorSessionId: event.authorSessionId }, event.at);
        demand(digest(edge) === digest(event.candidate.coverage), 'recorded coverage proof differs');
      }
    } else if (event.type === 'renew') {
      const history = session.history.slice(0, index); const prior = history.findLast(item => item.type === 'prepare');
      const prefix = { ...session, history, candidate: prior.candidate, preparedAt: prior.at, cycle: prior.cycle };
      const proof = await captureRenewalProof(cwd, prefix, runGit); demand(await ancestor(runGit, cwd, event.proof.main, proof.main), 'renewal main ancestry changed');
    }
  }
}
export async function assertMergePreflight(cwd, candidate, { runGit = git, env = processEnvironment } = {}) {
  const main = (await runGit(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
  demand(SHA.test(main), 'origin/main commit identity is invalid');
  // A stacked candidate may be reviewed before its prerequisite lands. Hosted
  // admission still requires its exact pin on main before it can enter the queue.
  if (env.OPENLUP_STACK_BASE === candidate.base && !await ancestor(runGit, cwd, candidate.base, main)) return;
  let tree;
  try { tree = (await runGit(cwd, 'merge-tree', '--write-tree', main, candidate.head)).trim(); }
  catch (error) {
    if (error.code === 1) throw new Error('merge_preflight: candidate conflicts with origin/main; merge main and resolve before review or verification');
    throw new Error(`merge_preflight: cannot compute merge with origin/main: ${error.message}`);
  }
  demand(SHA.test(tree), 'merge preflight did not produce a tree', 'merge_preflight');
  const decision = await carryOverSourceReview(cwd, candidate, { base: main, tree }, runGit);
  demand(decision.ok, `clean merge cannot carry over source review: ${decision.reason}`, 'merge_preflight');
}
async function boundedJson(path, limit = 1024 * 1024) {
  const handle = await open(path, 'r');
  try {
    demand((await handle.stat()).size <= limit, 'JSON input exceeds size bound');
    const bytes = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    demand(bytesRead <= limit, 'JSON input exceeds size bound'); return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
async function saveState(path, state) {
  const bytes = `${JSON.stringify(state, null, 2)}\n`; demand(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, 'session exceeds 8 MiB; previous state preserved');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function runReviewCommand(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT'); const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(code ?? 1); });
  });
}
export async function verifyCandidateCommand({ cwd, session, command, args = [], resource, env = processEnvironment, snapshot = captureSessionCandidate, run = runReviewCommand }) {
  demand(env.AI_RESOURCE_GATE_ACTIVE !== '1' && !env.OPENLUP_HEAVY_ACTIVE, 'nested verification inside the resource broker is refused');
  const before = await snapshot(cwd, session.candidate.base, { env }); const decision = verdict(session, before, Date.now()); demand(decision.ok, decision.reason, decision.code);
  await validateEconomySession(cwd, session);
  await assertMergePreflight(cwd, before, { env });
  if (resource) {
    demand(/^[a-z][a-z0-9:-]{0,127}$/u.test(resource), 'resource profile is invalid');
    const broker = (env.PATH ?? '').split(delimiter).map(path => join(path, 'ai-resource-gate')).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
    demand(broker, 'ai-resource-gate is unavailable');
    // The broker matches lane keywords in the full key: a worktree name must
    // not introduce another keyword (even hexadecimal hashes can contain e2e).
    const worktree = createHash('sha256').update(resolve(cwd)).digest().readBigUInt64BE().toString(10);
    args = ['run', '--wait', `${resource}:wt${worktree}`, '--', command, ...args]; command = broker;
  }
  const code = await run(command, args, cwd, { ...env, OPENLUP_HEAVY_ACTIVE: cwd });
  await validateEconomySession(cwd, session);
  const after = await snapshot(cwd, before.base, { env }); const final = verdict(session, after, Date.now()); demand(final.ok, final.reason, final.code);
  return code;
}
export async function sessionMain(argv = process.argv.slice(2), { cwd = process.cwd(), env = processEnvironment } = {}) {
  const [verb, ...args] = argv; demand(['prepare', 'record', 'continue', 'renew', 'verify', 'status', 'receipt', 'verify-command'].includes(verb), 'use prepare [--new] <intent.json>, record <report.json>, continue "<note>", verify, status, receipt <PR>, or verify-command');
  const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  await mkdir(directory, { recursive: true });
  let lock;
  if (['prepare', 'record', 'continue', 'renew'].includes(verb)) {
    try { lock = await open(join(directory, '.session.lock'), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('invalid: session is busy; retry after the active transaction finishes'); throw error; }
  }
  try {
    let session; try { session = await boundedJson(path, 8 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (verb === 'prepare') {
      const fresh = args[0] === '--new'; if (fresh) args.shift();
      const spec = await boundedJson(args[0] ?? join(directory, 'intent.json'));
      const observed = { ...await captureSessionCandidate(cwd, undefined, { env }), intent: spec.intent, authorSessionId: spec.authorSessionId ?? env.CODEX_THREAD_ID };
      if (!fresh && session?.candidate && session.candidate.head !== observed.head) {
        try { await git(cwd, 'merge-base', '--is-ancestor', session.candidate.head, observed.head); }
        catch { throw new Error('invalid: rebased history; use prepare --new'); }
      }
      await assertMergePreflight(cwd, observed, { env });
      const now = Date.now();
      const rules = await captureReviewRules(cwd, observed);
      if (rules) observed.rules = rules;
      if (!fresh && session?.candidate && session.candidate.head !== observed.head) {
        const parents = await integrationParents(cwd, observed.head);
        const baseAncestor = await ancestor(git, cwd, session.candidate.base, observed.base) &&
          await ancestor(git, cwd, observed.base, 'origin/main');
        const integration = integrationReviewContext(session, observed, { parents, baseAncestor }, now);
        if (integration) {
          try {
            integration.mechanical = (await git(cwd, 'merge-tree', '--write-tree', session.candidate.head, observed.base)).trim() === observed.tree;
          } catch (error) {
            if (error.code !== 1) throw new Error(`invalid: cannot verify mechanical integration: ${error.message}`);
          }
          observed.integration = integration;
        }
      }
      if (!fresh && session?.candidate.head !== observed.head) {
        const coverage = await captureCoverageEdge(cwd, session, observed, now); if (coverage) observed.coverage = coverage;
      }
      const next = prepareCandidate(session, observed, now, fresh);
      await saveState(path, next);
      demand(next.cycle <= next.allowedCycles, 'record an owner continuation with continue "<note>"', 'needs_owner');
      console.log(JSON.stringify(next, null, 2)); return 0;
    }
    demand([2, 3].includes(session?.version), 'prepare a version-2 session before review');
    if (verb === 'status') { console.log(JSON.stringify(session, null, 2)); return 0; }
    if (verb === 'continue') { session = continueOwner(session, args[0], Date.now()); await saveState(path, session); return 0; }
    if (verb === 'verify-command') {
      const resource = args[0] === '--resource' ? args.splice(0, 2)[1] : undefined;
      demand(args.shift() === '--' && args[0], 'verify-command [--resource PROFILE] -- CMD ARGS...');
      return verifyCandidateCommand({ cwd, session, command: args[0], args: args.slice(1), resource, env });
    }
    const observed = await captureSessionCandidate(cwd, session.candidate.base, { env });
    demand(observed.clean, 'commit source changes before review', 'dirty');
    demand(['base', 'head', 'tree'].every(key => observed[key] === session.candidate[key]), 'candidate changed; prepare again', 'stale');
    if (verb === 'renew') {
      await validateEconomySession(cwd, session);
      session = renewCoverage(session, await captureRenewalProof(cwd, session), Date.now()); await saveState(path, session); return 0;
    }
    if (verb === 'record') { session = recordReport(session, await boundedJson(args[0]), Date.now()); await saveState(path, session); return 0; }
    await validateEconomySession(cwd, session);
    const decision = verdict(session, observed, Date.now()); demand(decision.ok, decision.reason, decision.code);
    if (verb === 'receipt') await assertMergePreflight(cwd, observed, { env });
    if (verb === 'receipt') console.log(`${session.version === 3 ? ECONOMY_RECEIPT_MARKER : RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receiptSummary(session, Number(args[0]), Date.now()))}\n\`\`\``);
    else console.log('reviewed');
    return 0;
  } finally { if (lock) { await lock.close(); await rm(join(directory, '.session.lock')); } }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) sessionMain().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
