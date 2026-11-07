// Local Git and state adapters for native supervisor process evidence.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { env as processEnvironment } from 'node:process';
import { ECONOMY_RECEIPT_MARKER, digest, protectedCoveragePath, carryOver, fullReviewReports, demand, integrationReviewContext, prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER, verdict } from './agent-review-decide.mjs';
import { REGISTRY_PATHS, registryUnion } from './agent-review-registry.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
export async function git(cwd, ...args) {
  return (await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', '-c', 'merge.conflictStyle=merge', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...processEnvironment, PATH: '/usr/bin:/bin' } })).stdout;
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
// This literal anchors the one-time transition in trusted main's first-parent history.
const PORTABLE_REVIEW = 'openlup-portable-review-20261103';
const SESSION_PATH = 'scripts/agent-review-session.mjs';

// Review evidence binds to the candidate's own change: a clean merge onto a later base keeps it.
export async function carryOverSourceReview(cwd, candidate, group, runGit = git) {
  const baseAncestor = await ancestor(runGit, cwd, candidate.base, group.base);
  let predictedTree;
  if (baseAncestor && candidate.tree !== group.tree) {
    try { predictedTree = (await runGit(cwd, 'merge-tree', '--write-tree', `--merge-base=${candidate.base}`, group.base, candidate.head)).trim(); } catch { predictedTree = null; }
  }
  return carryOver({ reviewedTree: candidate.tree, groupTree: group.tree, baseAncestor, predictedTree });
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
export async function proveReviewIntegration(cwd, previous, current, portable = false) {
  const parents = await integrationParents(cwd, current.head);
  demand(parents.length === 2 && parents[0] === previous.head && parents[1] === current.base, 'integration parents differ');
  demand(await ancestor(git, cwd, previous.base, current.base), 'integration base ancestry differs');
  const own = (await captureCommittedReviewCandidate(cwd, previous.base, previous.head)).changedPaths;
  const moved = (await captureCommittedReviewCandidate(cwd, previous.base, current.base)).changedPaths;
  let prediction; let conflicts = [];
  try { prediction = (await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', previous.head, current.base)).split('\0')[0]; }
  catch (error) {
    if (error.code !== 1) throw error;
    const parts = error.stdout.split('\0'); prediction = parts.shift(); conflicts = parts.filter(Boolean);
    demand(conflicts.length > 0, 'integration conflict list missing');
  }
  demand(SHA.test(prediction), 'merge prediction missing'); const replacements = new Map();
  // Git's clean merge stands for every carrier it merged. A conflicting carrier
  // takes the deterministic union of its named arrays; if that union does not
  // apply (a change outside the arrays, an overlap or another mode), the carrier
  // is reviewed as part of the resolution.
  for (const path of conflicts.filter(path => REGISTRY_PATHS.includes(path))) {
    const blobs = [];
    for (const revision of [previous.base, previous.head, current.base]) {
      if ((await git(cwd, 'ls-tree', revision, '--', path)).trim().startsWith('100644 blob ')) blobs.push(await git(cwd, 'show', `${revision}:${path}`));
    }
    let union; try { union = blobs.length === 3 ? registryUnion(path, ...blobs) : undefined; } catch { union = undefined; }
    if (union !== undefined) replacements.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
  }
  // A union counts only when it is what was committed; any other carrier bytes are reviewed.
  for (const [path, blob] of replacements) {
    if ((await git(cwd, 'ls-tree', current.tree, '--', path)).trim() !== `100644 blob ${blob}\t${path}`) replacements.delete(path);
  }
  if (replacements.size) prediction = await replaceTreeBlobs(cwd, prediction, replacements);
  // A clean or registry-union merge needs no review. Every other difference from
  // that mechanical result, including edits outside the conflicts, is the
  // resolution and is reviewed as its delta. A conflict left unresolved refuses.
  const delta = await captureCommittedReviewCandidate(cwd, prediction, current.tree);
  demand(conflicts.every(path => replacements.has(path) || delta.changedPaths.includes(path)), 'integration commits a conflict without resolving it');
  const resolution = delta.changedPaths; const modeChanged = delta.modeChanged;
  const kind = resolution.length ? 'resolution' : conflicts.length ? 'registry-union' : 'git';
  return { kind: portable ? 'portable-' + kind : kind, tree: current.tree, own, moved, ...(resolution.length ? { resolution, prediction, modeChanged } : {}) };
}
export async function captureCoverageEdge(cwd, session, observed, now, historicalKind) {
  if (!session || !observed.rules ||
    digest(observed.intent) !== digest(session.history.findLast(event => event.type === 'prepare').intent) ||
    observed.authorSessionId !== session.history.findLast(event => event.type === 'prepare').authorSessionId) return undefined;
  const passed = verdict(session, session.candidate, now).ok;
  if (!passed && (session.candidate.base !== observed.base || !fullReviewReports(session))) return undefined;
  let proof; let kind; let from = session.candidate.head; let to = observed.head;
  if (session.candidate.base !== observed.base) {
    // An integration base must be on main; a repair keeps its existing (possibly stacked) base.
    if (!await ancestor(git, cwd, observed.base, 'origin/main')) return undefined;
    kind = 'integration';
    try {
      const entry = await git(cwd, 'ls-tree', observed.base, '--', SESSION_PATH);
      const source = entry ? await git(cwd, 'show', `${observed.base}:${SESSION_PATH}`) : '';
      const portable = source.includes(`const PORTABLE_REVIEW = '${PORTABLE_REVIEW}';`);
      // The landed base selects the proof. A receipt cannot opt into the old
      // selector after the rollout, even when historical fingerprints match.
      // A session from before the version-3 rules can inherit only through the portable proof.
      if ((historicalKind && historicalKind.startsWith('portable-') !== portable) || (!portable && session.candidate.rules?.version !== 3)) return undefined;
      proof = await proveReviewIntegration(cwd, session.candidate, observed, portable);
      if (proof.prediction) { from = proof.prediction; to = observed.tree; }
    } catch { return undefined; }
  } else {
    if (session.candidate.rules?.version !== 3) return undefined;
    const delta = await captureCommittedReviewCandidate(cwd, session.candidate.head, observed.head);
    const commits = (await git(cwd, 'rev-list', '--merges', `${session.candidate.head}..${observed.head}`)).trim();
    if (!await ancestor(git, cwd, session.candidate.head, observed.head) || commits || !delta.changedPaths.length) return undefined;
    proof = { paths: delta.changedPaths, modeChanged: delta.modeChanged }; kind = 'repair';
  }
  return { kind, previous: digest(session.history), from: { base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree },
    delta: digest(await git(cwd, 'diff', '--binary', '--no-renames', from, to)), proof };
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
        const version = prefix.some(item => item.type === 'rules' || item.candidate?.rules?.version === 3) ? 3 : 2;
        const before = { ...session, version, candidate: prior.candidate, history: prefix, preparedAt: prior.at };
        const edge = await captureCoverageEdge(cwd, before, { ...actual, rules, intent: event.intent, authorSessionId: event.authorSessionId }, event.at, event.candidate.coverage.proof?.kind);
        demand(edge && digest(edge) === digest(event.candidate.coverage), 'recorded coverage proof differs');
      }
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
  const decision = await carryOverSourceReview(cwd, candidate, { base: main, tree, trustedMain: main }, runGit);
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
  const [verb, ...args] = argv; demand(['prepare', 'record', 'verify', 'status', 'receipt', 'verify-command'].includes(verb), 'use prepare [--new] <intent.json>, record <report.json>, verify, status, receipt <PR>, or verify-command');
  const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  await mkdir(directory, { recursive: true });
  let lock;
  if (['prepare', 'record'].includes(verb)) {
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
      console.log(JSON.stringify(next, null, 2)); return 0;
    }
    demand([2, 3].includes(session?.version), 'prepare a version-2 session before review');
    if (verb === 'status') { console.log(JSON.stringify(session, null, 2)); return 0; }
    if (verb === 'verify-command') {
      const resource = args[0] === '--resource' ? args.splice(0, 2)[1] : undefined;
      demand(args.shift() === '--' && args[0], 'verify-command [--resource PROFILE] -- CMD ARGS...');
      return verifyCandidateCommand({ cwd, session, command: args[0], args: args.slice(1), resource, env });
    }
    const observed = await captureSessionCandidate(cwd, session.candidate.base, { env });
    demand(observed.clean, 'commit source changes before review', 'dirty');
    demand(['base', 'head', 'tree'].every(key => observed[key] === session.candidate[key]), 'candidate changed; prepare again', 'stale');
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
