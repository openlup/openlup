import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
assert(existsSync(resolve(root, '.starter-origin.json')), 'independent extracted starter required');
assert.equal(realpathSync(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).stdout.trim()), realpathSync(root));
const paths = ['owned/store.config.ts', 'owned/fragments.ts', 'client/style.css'];
const originals = new Map(paths.map(path => [path, readFileSync(path, 'utf8')]));
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until<T>(fn: () => Promise<T | false> | T | false, message: string, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${message}`);
}
async function reservePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  return { server, port: (server.address() as { port: number }).port };
}
async function freePort() { const { server, port } = await reservePort(); await new Promise<void>(done => server.close(() => done())); return port; }
function launch(args: string[]) {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'dev.mjs', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { output += data; });
  return { child, output: () => output };
}
async function request(port: number, path: string) {
  try { const response = await fetch(`http://127.0.0.1:${port}${path}`); return response.ok ? await response.text() : false; } catch { return false; }
}
function processRows(environment?: NodeJS.ProcessEnv): number[][] {
  const result = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, `ps inventory failed: ${result.error?.message ?? result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert(lines.length > 0 && lines.every(line => /^\s*\d+\s+\d+\s*$/.test(line)), 'valid nonempty process inventory required');
  return lines.map(line => line.trim().split(/\s+/).map(Number));
}
function descendants(pid: number): number[] {
  const rows = processRows();
  const found = new Set([pid]);
  let size = 0;
  while (size !== found.size) { size = found.size; for (const [child, parent] of rows) if (found.has(parent!)) found.add(child!); }
  found.delete(pid);
  return [...found].sort((a, b) => a - b);
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
const observedGroups = new Map<ChildProcess, { group: number; pids: number[] }>();
function observe(child: ChildProcess, environment?: NodeJS.ProcessEnv) {
  const rows = processRows(environment);
  const group = rows.find(([, parent]) => parent === child.pid)?.[0];
  const pids = descendants(child.pid!);
  if (group) observedGroups.set(child, { group, pids });
  return pids;
}
async function stop(child: ChildProcess, signal: NodeJS.Signals, observationEnvironment?: NodeJS.ProcessEnv) {
  let observed: number[] = [];
  let observationError: unknown;
  try { observed = observe(child, observationEnvironment); } catch (error) { observationError = error; }
  // The directly spawned launcher is owned even if process observation fails.
  child.kill(signal);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'launcher exit');
  if (observationError) throw observationError;
  await until(() => observed.every(pid => !alive(pid)), 'watch descendants exit');
  observedGroups.delete(child);
}
async function cleanup(child: ChildProcess) {
  let launcherError: unknown;
  if (child.exitCode === null && child.signalCode === null) {
    try { await stop(child, 'SIGTERM'); } catch {
      child.kill('SIGTERM');
      try { await until(() => child.exitCode !== null || child.signalCode !== null, 'launcher cleanup'); }
      catch (error) { launcherError = error; }
    }
  }
  const owned = observedGroups.get(child);
  if (owned && owned.pids.some(alive)) {
    try { process.kill(-owned.group, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await until(() => owned.pids.every(pid => !alive(pid)), 'owned watch group cleanup');
  }
  if (launcherError) throw launcherError;
}
async function assets(port: number) {
  const html = await request(port, '/');
  if (!html) return false;
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]!);
  const contents = await Promise.all(paths.map(path => request(port, path)));
  return contents.length && contents.every(Boolean) ? contents.join('\n') : false;
}

test('cleanup signals owned launcher when process observation fails', { timeout: 30000 }, async () => {
  processRows();
  const port = await freePort();
  const run = launch(['--port', String(port)]);
  try {
    await until(async () => !!(await request(port, '/api/config')), 'fault-injection host');
    const faultPids = descendants(run.child.pid!);
    assert(faultPids.length >= 2, 'fault-injection descendants must be observable');
    await assert.rejects(stop(run.child, 'SIGTERM', { PATH: '/nonexistent-starter-proof-path' }), /ps inventory failed/);
    await until(() => faultPids.every(pid => !alive(pid)), 'fault-injection descendants exit');
  } finally {
    await cleanup(run.child);
  }
});

test('local edit loop uses current successful output and cleans up its processes', { timeout: 120000 }, async () => {
  assert(existsSync(resolve(root, 'dist/index.html')), 'pre-existing build required');
  processRows(); // Refuse before spawning if process observation is unavailable.
  const running = new Set<ChildProcess>();
  const outputs = new Map<ChildProcess, () => string>();
  const start = (args: string[]) => { const run = launch(args); running.add(run.child); outputs.set(run.child, run.output); return run; };
  const end = async (child: ChildProcess, signal: NodeJS.Signals) => { await stop(child, signal); running.delete(child); };
  try {
    for (const args of [['--listen', '0.0.0.0'], ['--port'], ['extra'], ['--port', '1234', '--port', '1235']]) {
      const run = start(args);
      await until(() => run.child.exitCode !== null, 'invalid argument refusal');
      assert.notEqual(run.child.exitCode, 0);
      assert.equal(descendants(run.child.pid!).length, 0);
      running.delete(run.child);
    }
    const port = await freePort();
    const fragment = originals.get(paths[1]!)!;
    writeFileSync(paths[1]!, fragment + '\nthis is invalid syntax !!!\n');
    const run = start(['--configuration', 'supplements', '--port', String(port)]);
    await until(() => /error/i.test(run.output()), 'initial build error');
    await delay(1000);
    assert.equal(await request(port, '/api/config'), false, 'stale dist must not start host');
    assert(!run.output().includes('Neutral store local candidate:'), 'host must not start before a successful build');
    writeFileSync(paths[1]!, fragment);
    await until(async () => (await request(port, '/api/config')) || false, 'recovery from initial build');
    const config = originals.get(paths[0]!)!;
    writeFileSync(paths[0]!, config.replace("name: 'Aster Goods'", "name: 'Loop Brand Witness'"));
    await until(async () => String(await request(port, '/api/config')).includes('Loop Brand Witness'), 'configuration restart');
    const observed = observe(run.child);
    assert(observed.length >= 2, 'watch wrapper and host must be observable');
    writeFileSync(paths[1]!, fragment.replace("class: 'product-card'", "class: 'product-card loop-fragment-witness'"));
    writeFileSync(paths[2]!, originals.get(paths[2]!)! + '\n/* loop-css-witness */\n.loop-css-witness { color: rgb(1, 2, 3); }\n');
    await until(async () => { const value = await assets(port); return !!value && value.includes('loop-fragment-witness') && value.includes('loop-css-witness'); }, 'rebuilt referenced assets');
    await delay(1500);
    assert.deepEqual(descendants(run.child.pid!), observed, 'client rebuild must not restart host');
    writeFileSync(paths[0]!, config.replace("name: 'Aster Goods'", "name: ''"));
    await until(() => run.output().includes('starter_configuration_invalid'), 'runtime validation error');
    await until(async () => !(await request(port, '/api/config')), 'invalid runtime not ready');
    writeFileSync(paths[0]!, config);
    await until(async () => String(await request(port, '/api/config')).includes('Aster Goods'), 'runtime recovery');
    await end(run.child, 'SIGINT');
    const rebound = createServer();
    await new Promise<void>((done, reject) => rebound.once('error', reject).listen(port, '127.0.0.1', done));
    await new Promise<void>(done => rebound.close(() => done()));
    const second = start(['--configuration', 'coffee', '--port', String(port)]);
    await until(async () => String(await request(port, '/api/config')).includes('Pebble Coffee'), 'second configuration');
    assert(observe(second.child).length >= 2, 'second host descendants must be observable');
    await end(second.child, 'SIGTERM');
    const occupant = await reservePort();
    try {
      const blocked = start(['--port', String(occupant.port)]);
      await until(() => blocked.output().includes('EADDRINUSE'), 'port conflict');
      assert(!blocked.output().includes('Neutral store local candidate:'), 'port conflict must not choose another listener');
      assert(observe(blocked.child).length >= 1, 'blocked watch wrapper must be observable');
      await end(blocked.child, 'SIGTERM');
      assert(occupant.server.listening, 'owned launcher must not terminate port occupant');
    } finally { await new Promise<void>(done => occupant.server.close(() => done())); }
    writeFileSync(paths[1]!, fragment + '\nthis is invalid syntax !!!\n');
    const partial = start(['--port', String(port)]);
    await until(() => /error/i.test(partial.output()), 'partial startup error');
    await end(partial.child, 'SIGTERM');
  } catch (error) {
    for (const child of running) console.error(`launcher ${child.pid} output:\n${outputs.get(child)?.()}`);
    throw error;
  } finally {
    for (const [path, value] of originals) writeFileSync(path, value);
    for (const child of running) await cleanup(child);
  }
});
