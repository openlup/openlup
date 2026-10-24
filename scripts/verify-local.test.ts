import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMain } from './agent-review-session.mjs';
import { hasBroker, runLogged, verificationSteps, verifyLocal } from './verify-local.mjs';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(reviewed = true, nodePin = process.versions.node) {
  const cwd = await mkdtemp(join(tmpdir(), 'verify-local-')); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n');
  await writeFile(join(cwd, '.nvmrc'), nodePin);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'npm@11.19.0' }));
  await writeFile(join(cwd, 'source.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(cwd, 'source.txt'), 'candidate\n'); git('add', '.'); git('commit', '-qm', 'candidate');
  const scratch = join(cwd, '.context', 'scratch'); await mkdir(scratch, { recursive: true });
  const env = { PATH: `${scratch}:${dirname(process.execPath)}:/usr/bin:/bin`, CODEX_THREAD_ID: 'author' };
  await writeFile(join(scratch, 'gitleaks'), '#!/bin/sh\nprintf "8.30.1\\n"\n'); await chmod(join(scratch, 'gitleaks'), 0o700);
  if (reviewed) {
    const intent = join(scratch, 'intent.json');
    await writeFile(intent, JSON.stringify({ intent: { risk: 'routine', criteria: 'preserve source' } }));
    await sessionMain(['prepare', intent], { cwd, env });
    const state = JSON.parse(await readFile(join(scratch, 'agent-review', 'session.json'), 'utf8'));
    const report = join(scratch, 'report.json');
    await writeFile(report, JSON.stringify({ reviewer: 'cold-reviewer', cold: true, tree: state.candidate.tree,
      verdict: 'PASS', findings: [], closes: [] }));
    await sessionMain(['record', report], { cwd, env });
  }
  const result = async () => {
    const name = (await readdir(scratch)).find(value => value.startsWith('verify-local-'))!;
    return JSON.parse(await readFile(join(scratch, name, 'result.json'), 'utf8'));
  };
  return { cwd, git, env, scratch, result, base };
}
const candidate = { base: 'a'.repeat(40), head: 'b'.repeat(40) };

describe('full local verification command ownership', () => {
  it('runs one installation and scoped suite, preserving package proof before tests and lint builds before typecheck', () => {
    const steps = verificationSteps(candidate, '/work/.context/scratch/run', '/tmp/packs', false);
    expect(steps.map(step => step.name)).toEqual(['policy', 'inventory', 'dco', 'gitleaks', 'install', 'lint',
      'typecheck', 'build', 'subscription', 'packages', 'tests', 'neutrality', 'ui-neutrality']);
    expect(steps.filter(step => step.command.includes('ci'))).toHaveLength(1);
    expect(steps.flatMap(step => step.command).join(' ')).not.toMatch(/--shard|pretest|test:required|public-ci-dependencies|public-ci-reuse/);
    expect(steps.find(step => step.name === 'tests')?.command).toEqual(['env', '-u', 'OPENLUP_STACK_BASE', 'npm', 'run', 'test:scoped']);
    expect(steps.find(step => step.name === 'dco')?.command.slice(-2)).toEqual([candidate.base, candidate.head]);
    expect(steps.find(step => step.name === 'neutrality')?.command.slice(-2)).toEqual(['--base-commit', candidate.base]);
  });
  it('assigns actual heavy profiles, uses a checkout-local SSR directory, and opts into the complete existing pgTAP runner', () => {
    const steps = verificationSteps(candidate, '/work/.context/scratch/run', '/tmp/packs', true);
    expect(Object.fromEntries(steps.map(step => [step.name, step.resource]))).toMatchObject({
      lint: 'openlup:typecheck', typecheck: 'openlup:typecheck', build: 'openlup:build',
      subscription: 'openlup:build', packages: 'openlup:coverage', tests: 'openlup:coverage', pgtap: 'openlup:pgtap',
    });
    expect(steps.find(step => step.name === 'subscription')?.env).toEqual({ OPENLUP_REFERENCE_PROFILE: 'subscription',
      OPENLUP_BUILD_OUT_DIR: '/work/.context/scratch/run/client', OPENLUP_SSR_OUT_DIR: '/work/.context/scratch/run/ssr' });
    expect(steps.find(step => step.name === 'packages')?.command).toContain('/tmp/packs');
    expect(steps.at(-1)?.command.slice(1)).toEqual(['scripts/public-ci-pgtap.mjs']);
    expect(steps.filter(step => ['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality'].includes(step.name)).every(step => step.resource === null)).toBe(true);
  });
  it('detects an executable broker rather than merely a file with that name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-broker-')); directories.push(cwd);
    expect(hasBroker({ PATH: cwd })).toBe(false);
    const path = join(cwd, 'ai-resource-gate'); await writeFile(path, '#!/bin/sh\n');
    await chmod(path, 0o600); expect(hasBroker({ PATH: cwd })).toBe(false);
    await chmod(path, 0o700); expect(hasBroker({ PATH: cwd })).toBe(true);
  });
});

describe('real Git and subprocess refusals', () => {
  it.each(['missing review', 'dirty', 'changed commit'])('refuses %s before launching a gate', async scenario => {
    const f = await fixture(scenario !== 'missing review');
    if (scenario === 'dirty') await writeFile(join(f.cwd, 'source.txt'), 'dirty\n');
    if (scenario === 'changed commit') { await writeFile(join(f.cwd, 'source.txt'), 'new\n'); f.git('add', '.'); f.git('commit', '-qm', 'unreviewed'); }
    const output = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs')], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    expect(output.status).toBe(1);
    const result = await f.result(); expect(result.phases).toEqual([]);
    expect(result.error).toMatch(/prepare|clean|candidate changed/);
  });
  it('refuses a runtime pin mismatch before commands', async () => {
    const f = await fixture(true, '0.0.0');
    const run = vi.fn(); expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(1);
    expect(run).not.toHaveBeenCalled(); expect((await f.result()).error).toMatch(/requires Node 0\.0\.0/);
  });
  it.each([false, true])('serializes the whole command set with broker present=%s and records hosted limits', async broker => {
    const f = await fixture();
    if (broker) { const path = join(f.scratch, 'ai-resource-gate'); await writeFile(path, '#!/bin/sh\n'); await chmod(path, 0o700); }
    const calls: string[][] = [];
    const run = vi.fn(async (_command, args, _cwd, env) => {
      calls.push(args); expect(env.OPENLUP_HEAVY_ACTIVE).toBeUndefined();
      const cheap = args.some(arg => ['--policy', '--inventory', 'check:dco-signoff', 'gitleaks', 'scripts/public-ci-neutrality.mjs', 'packages/ui/smoke/neutrality.ts'].includes(arg));
      expect(args.includes('--resource')).toBe(broker && !cheap);
      expect(env.CODEX_THREAD_ID).toBe('author'); return { code: 0 };
    });
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(0);
    const result = await f.result(); directories.push(result.packs);
    expect(calls).toHaveLength(13); expect(result.phases).toHaveLength(13);
    expect(result.broker).toBe(broker); expect(result.hosted).toContain('remain separate');
    expect(result.phases[8].env.OPENLUP_SSR_OUT_DIR).toMatch(new RegExp(`^${f.cwd}/\\.context/scratch/verify-local-`));
  });
  it('stops at the first failing command without retrying or claiming later proof', async () => {
    const f = await fixture(); const run = vi.fn(async () => ({ code: 124 }));
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(124);
    const result = await f.result(); directories.push(result.packs);
    expect(run).toHaveBeenCalledTimes(1); expect(result.phases).toHaveLength(1); expect(result.code).toBe(124);
  });
  it('refuses identity drift between phases even if a command reports success', async () => {
    const f = await fixture(); const run = vi.fn(async () => { await writeFile(join(f.cwd, 'source.txt'), 'changed\n'); return { code: 0 }; });
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(1);
    const result = await f.result(); directories.push(result.packs);
    expect(run).toHaveBeenCalledTimes(1); expect(result.error).toContain('candidate changed');
  });
  it.each(['1', '40%'])('retains the first actual worker observation %s and subprocess failure', async workers => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-log-')); directories.push(cwd);
    const log = join(cwd, 'command.log');
    const source = `process.stderr.write("Local verification Vitest workers="); process.stderr.write(${JSON.stringify(`${workers}\n`)}); console.log("Local verification Vitest workers=4"); process.exitCode=7`;
    const result = await runLogged(process.execPath, ['-e', source], cwd, { ...processEnvironment, CI: 'false' }, log);
    expect(result).toMatchObject({ code: 7, worker: `Local verification Vitest workers=${workers}` });
    expect(await readFile(log, 'utf8')).toContain('Local verification Vitest workers=4');
  });
  it('retains CI child output without attributing a nested fixture worker line to the root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-ci-log-')); directories.push(cwd);
    const log = join(cwd, 'command.log');
    const result = await runLogged(process.execPath, ['-e', 'console.log("Local verification Vitest workers=4")'],
      cwd, { ...processEnvironment, CI: 'true' }, log);
    expect(result).toMatchObject({ code: 0, worker: undefined });
    expect(await readFile(log, 'utf8')).toContain('Local verification Vitest workers=4');
  });
});
