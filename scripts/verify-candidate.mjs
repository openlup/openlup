// Wrap each heavy local check with the same cheap/native preflight and one
// bounded worktree output lease, using an installed host broker for CPU/RAM.
// This does not replace any required check or stamp.
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { env as processEnvironment } from 'node:process';
import { captureSessionCandidate } from './agent-review-session.mjs';
import { checkMergePreview } from './merge-preview.mjs';

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
  const [broker, brokerArgs] = brokerCommand(process.execPath, [fileURLToPath(import.meta.url), ...(resource ? ['--resource', resource] : []), '--', command, ...args], directory, resource);
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = process.argv.slice(2);
  const resource = options[0] === '--resource' ? options.splice(0, 2)[1] : undefined;
  const [separator, command, ...args] = options;
  if (separator !== '--' || !command) { console.error('usage: node scripts/verify-candidate.mjs [--resource <existing-broker-resource>] -- <required-check-command> [args...]'); process.exitCode = 2; }
  else try { process.exitCode = await verifyCandidateCommand({ cwd: process.cwd(), command, args, resource }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
