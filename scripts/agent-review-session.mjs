// Local Git and state adapters for native supervisor process evidence.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { env as processEnvironment } from 'node:process';
import { continueOwner, demand, prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER, verdict } from './agent-review-decide.mjs';

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
  const before = await snapshot(cwd, session.candidate.base); const decision = verdict(session, before, Date.now()); demand(decision.ok, decision.reason, decision.code);
  if (resource) {
    demand(/^[a-z][a-z0-9:-]{0,127}$/u.test(resource), 'resource profile is invalid');
    const broker = (env.PATH ?? '').split(delimiter).map(path => join(path, 'ai-resource-gate')).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
    demand(broker, 'ai-resource-gate is unavailable'); args = ['run', '--wait', `${resource}:${basename(cwd)}`, '--', command, ...args]; command = broker;
  }
  const code = await run(command, args, cwd, { ...env, OPENLUP_HEAVY_ACTIVE: cwd });
  const after = await snapshot(cwd, before.base); const final = verdict(session, after, Date.now()); demand(final.ok, final.reason, final.code);
  return code;
}
export async function sessionMain(argv = process.argv.slice(2), { cwd = process.cwd(), env = processEnvironment } = {}) {
  const [verb, ...args] = argv; demand(['prepare', 'record', 'continue', 'verify', 'status', 'receipt', 'verify-command'].includes(verb), 'use prepare [--new] <intent.json>, record <report.json>, continue "<note>", verify, status, receipt <PR>, or verify-command');
  const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  await mkdir(directory, { recursive: true });
  let lock;
  if (['prepare', 'record', 'continue'].includes(verb)) {
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
      const next = prepareCandidate(session, observed, Date.now(), fresh);
      await saveState(path, next);
      demand(next.cycle <= next.allowedCycles, 'record an owner continuation with continue "<note>"', 'needs_owner');
      console.log(JSON.stringify(next, null, 2)); return 0;
    }
    demand(session?.version === 2, 'prepare a version-2 session before review');
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
    if (verb === 'record') { session = recordReport(session, await boundedJson(args[0]), Date.now()); await saveState(path, session); return 0; }
    const decision = verdict(session, observed, Date.now()); demand(decision.ok, decision.reason, decision.code);
    if (verb === 'receipt') console.log(`${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receiptSummary(session, Number(args[0]), Date.now()))}\n\`\`\``);
    else console.log('reviewed');
    return 0;
  } finally { if (lock) { await lock.close(); await rm(join(directory, '.session.lock')); } }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) sessionMain().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
