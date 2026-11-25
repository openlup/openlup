import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMain } from './agent-review-session.mjs';
import { explainVerification, hasBroker, runLogged, verificationSteps, verifyLocal } from './verify-local.mjs';

const npmPin = `npm@${execFileSync('npm', ['--version'], { env: { ...processEnvironment, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' }).trim()}`;

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(reviewed = true, nodePin = process.versions.node, uiViolation = false, extraFiles: string[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'verify-local-')); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(cwd, '.gitignore'), '.context/scratch/\n');
  await writeFile(join(cwd, '.nvmrc'), nodePin);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ packageManager: npmPin }));
  if (uiViolation) {
    await mkdir(join(cwd, 'packages/ui/smoke'), { recursive: true });
    await mkdir(join(cwd, 'packages/ui/src'));
    await copyFile(resolve('packages/ui/smoke/neutrality.ts'), join(cwd, 'packages/ui/smoke/neutrality.ts'));
  }
  await writeFile(join(cwd, 'source.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(cwd, 'source.txt'), 'candidate\n');
  if (uiViolation) await writeFile(join(cwd, 'packages/ui/src/example.ts'), 'export const example = "process' + '.env";\n');
  for (const file of extraFiles) {
    await mkdir(join(cwd, dirname(file)), { recursive: true });
    await writeFile(join(cwd, file), '-- sql\n');
  }
  git('add', '.'); git('commit', '-qm', 'candidate');
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
      verdict: 'PASS', findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }));
    await sessionMain(['record', report], { cwd, env });
    if (extraFiles.length > 0) {
      const secondReport = join(scratch, 'report-2.json');
      await writeFile(secondReport, JSON.stringify({ reviewer: 'second-reviewer', cold: true, tree: state.candidate.tree,
        verdict: 'PASS', findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }));
      await sessionMain(['record', secondReport], { cwd, env });
    }
  }
  const result = async () => {
    const name = (await readdir(scratch)).find(value => value.startsWith('verify-local-'))!;
    return JSON.parse(await readFile(join(scratch, name, 'result.json'), 'utf8'));
  };
  return { cwd, git, env, scratch, result, base };
}
const candidate = { base: 'a'.repeat(40), head: 'b'.repeat(40) };

describe('full local verification command ownership', () => {
  it('shows targeted layered commands while retaining the default full command', async () => {
    const f = await fixture(false, process.versions.node, false, [
      'db/platform/migrations/20400101000000_example.sql',
      'scripts/platform-migration-manifest.test.ts',
    ]);
    const cli = resolve('scripts/verify-local.mjs');
    const plan = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, '--plan', '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    const layered = plan('--layered');
    expect(layered.status).toBe(0);
    const selected = JSON.parse(layered.stdout);
    expect(selected.mode).toBe('layered');
    expect(selected.phases.find((step: { name: string }) => step.name === 'tests').command)
      .toEqual(['env', '-u', 'OPENLUP_STACK_BASE', 'npm', 'test', '--', 'scripts/platform-migration-manifest.test.ts']);
    const full = JSON.parse(plan().stdout);
    expect(full.mode).toBe('full');
    expect(full.phases.find((step: { name: string }) => step.name === 'tests').command)
      .toEqual(['env', '-u', 'OPENLUP_STACK_BASE', 'npm', 'run', 'test:scoped']);
  });
  it('excludes non-root-Vitest files (packages/core/test/* and Playwright specs) from layered npm test', async () => {
    const f = await fixture(false, process.versions.node, false, [
      'packages/core/test/bundle.test.ts',
      'tests/preview/checkout/journey.spec.ts',
      'scripts/local.test.ts',
    ]);
    const cli = resolve('scripts/verify-local.mjs');
    const layered = spawnSync(process.execPath, [cli, '--layered', '--plan', '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    expect(layered.status).toBe(0);
    const selected = JSON.parse(layered.stdout);
    expect(selected.phases.find((step: { name: string }) => step.name === 'tests').command)
      .toEqual(['env', '-u', 'OPENLUP_STACK_BASE', 'npm', 'test', '--', 'scripts/local.test.ts']);
  });
  it('reports a clean layered skip when no Vitest file is affected', async () => {
    const f = await fixture();
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(message => { logs.push(String(message)); });
    const run = vi.fn(async () => ({ code: 0 }));
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, layered: true, run })).toBe(0);
    const result = await f.result(); directories.push(result.packs);
    expect(result.phases.find((phase: { name: string }) => phase.name === 'tests'))
      .toMatchObject({ skipped: true, code: 0 });
    expect(run).toHaveBeenCalledTimes(12);
    expect(logs.join('\n')).toContain('0 affected Vitest files (full suite runs in hosted CI)');
    log.mockRestore();
  });
  it('runs one installation and scoped suite, preserving package proof before tests and lint builds before typecheck', () => {
    const steps = verificationSteps(candidate, '/work/.context/scratch/run', '/tmp/packs', false);
    expect(steps.map(step => step.name)).toEqual(['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality',
      'install', 'lint', 'typecheck', 'build', 'subscription', 'packages', 'tests']);
    expect(steps.filter(step => step.command.includes('ci'))).toHaveLength(1);
    expect(steps.flatMap(step => step.command).join(' ')).not.toMatch(/--shard|pretest|test:required|public-ci-dependencies|public-ci-reuse/);
    expect(steps.find(step => step.name === 'policy')?.command).toEqual(['npm', 'run', 'oss:published-tree', '--', '--policy', '--docs-base', candidate.base]);
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
  it('does not turn a successful explain into native review evidence', async () => {
    const f = await fixture(false);
    const before = await readdir(f.scratch);
    const output = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs'), '--plan', '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout).phases).toHaveLength(13);
    expect(await readdir(f.scratch)).toEqual(before);
    const run = vi.fn(); expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(1);
    expect(run).not.toHaveBeenCalled(); expect((await f.result()).phases).toEqual([]);
  });
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
    expect(result.phases.find(phase => phase.name === 'subscription').env.OPENLUP_SSR_OUT_DIR).toMatch(new RegExp(`^${f.cwd}/\\.context/scratch/verify-local-`));
  });
  it('executes the real UI checker and stops before install or any heavy phase on a neutrality failure', async () => {
    const f = await fixture(true, process.versions.node, true);
    const run = vi.fn(async (_command, args) => {
      const command = args.slice(args.indexOf('--') + 1);
      if (!command.includes('packages/ui/smoke/neutrality.ts')) return { code: 0 };
      const child = spawnSync(command[0], command.slice(1), { cwd: f.cwd, env: f.env, encoding: 'utf8' });
      expect(child.stderr).toContain('env read');
      return { code: child.status ?? 1 };
    });
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(1);
    const result = await f.result(); directories.push(result.packs);
    expect(result.phases.map(phase => phase.name)).toEqual(['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality']);
    expect(run).toHaveBeenCalledTimes(6);
  });
  it('stops at the first failing command without retrying or claiming later proof', async () => {
    const f = await fixture(); const run = vi.fn(async () => ({ code: 124 }));
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(124);
    const result = await f.result(); directories.push(result.packs);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(run.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.phases).toHaveLength(run.mock.calls.length);
    expect(result.phases.every(phase => phase.resource === null)).toBe(true);
    expect(result.code).toBe(124);
  });
  it('retains a broken package build and stops before dependent diagnostics', async () => {
    const f = await fixture();
    const run = vi.fn(async (_command, args) => ({ code: args.includes('lint') ? 17 : 0 }));
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(17);
    const result = await f.result(); directories.push(result.packs);
    expect(result.phases.map(phase => phase.name)).toEqual(['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality', 'install', 'lint']);
    expect(result.phases.at(-1)).toMatchObject({ name: 'lint', code: 17 });
  });
  it('refuses identity drift between phases even if a command reports success', async () => {
    const f = await fixture(); const run = vi.fn(async () => { await writeFile(join(f.cwd, 'source.txt'), 'changed\n'); return { code: 0 }; });
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(1);
    const result = await f.result(); directories.push(result.packs);
    expect(result.phases.some(phase => phase.name === 'install')).toBe(false);
    expect(result.error).toContain('candidate changed');
  });
  it('runs independent read-only phases concurrently while strictly enforcing requires and heavy-phase serialization', async () => {
    const f = await fixture();
    const expectedOrder = ['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality', 'install', 'lint', 'typecheck', 'build', 'subscription', 'packages', 'tests'];
    const readOnly = new Set(['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality']);
    const delays: Record<string, number> = { policy: 40, inventory: 10, dco: 30, gitleaks: 5, neutrality: 20, 'ui-neutrality': 15 };
    const phaseNameFromLog = (logPath: string) => logPath.split('/').at(-1)!.replace(/\.log$/u, '');
    let activeReadOnly = 0; let maxReadOnly = 0;
    let activeHeavy = 0; let maxHeavy = 0;
    const finished = new Set<string>();
    const startedAfter = new Map<string, Set<string>>();
    const run = vi.fn(async (_command, _args, _cwd, _env, logPath) => {
      const name = phaseNameFromLog(logPath);
      startedAfter.set(name, new Set(finished));
      if (readOnly.has(name)) {
        activeReadOnly++; maxReadOnly = Math.max(maxReadOnly, activeReadOnly);
        await new Promise(resolveTimer => setTimeout(resolveTimer, delays[name] ?? 10));
        activeReadOnly--;
      } else {
        expect(activeReadOnly).toBe(0);
        activeHeavy++; maxHeavy = Math.max(maxHeavy, activeHeavy);
        await new Promise(resolveTimer => setTimeout(resolveTimer, 5));
        activeHeavy--;
      }
      finished.add(name);
      return { code: 0 };
    });
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run, concurrency: 4 })).toBe(0);
    const result = await f.result(); directories.push(result.packs);
    expect(maxReadOnly).toBeGreaterThan(1);
    expect(maxReadOnly).toBeLessThanOrEqual(4);
    expect(maxHeavy).toBe(1);
    expect(result.phases.map(phase => phase.name)).toEqual(expectedOrder);
    for (const step of verificationSteps({ base: f.base, head: f.git('rev-parse', 'HEAD'), changedPaths: ['source.txt'] }, '/run', '/packs')) {
      for (const req of step.requires) {
        expect(startedAfter.get(step.name)?.has(req), `${step.name} must start after ${req}`).toBe(true);
      }
    }
    for (const ro of readOnly) expect(startedAfter.get('install')?.has(ro)).toBe(true);
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
  it('retains interrupted subprocess failure rather than reporting proof', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-interrupt-')); directories.push(cwd);
    const result = await runLogged(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], cwd, processEnvironment, join(cwd, 'interrupted.log'));
    expect(result).toMatchObject({ code: 1, signal: 'SIGTERM' });
  });
  it('passes --docs-base in --plan for known and unknown scope', async () => {
    const f = await fixture(false);
    const known = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs'), '--plan', '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    expect(known.status).toBe(0);
    expect(JSON.parse(known.stdout).phases.find((phase: { name: string }) => phase.name === 'policy').command.slice(-2)).toEqual(['--docs-base', f.base]);
    f.git('update-ref', '-d', 'refs/remotes/origin/main');
    const unknown = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs'), '--plan', '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(JSON.parse(unknown.stdout).phases.find((phase: { name: string }) => phase.name === 'policy').command.slice(-2)).toEqual(['--docs-base', '<comparison-base>']);
  });
  it.each(['db/platform/migrations/20400101000000_example.sql', 'packages/platform/sql/subscriptions/example.sql'])('auto-enables pgtap when %s changes in candidate diff', async sqlPath => {
    const f = await fixture(true, process.versions.node, false, [sqlPath]);
    const planned = await explainVerification({ cwd: f.cwd, env: f.env });
    expect(planned.pgtap).toContain('auto-selected due to SQL changes');
    expect(planned.phases.map(phase => phase.name)).toContain('pgtap');
    const explicit = await explainVerification({ cwd: f.cwd, env: f.env, pgtap: true });
    expect(explicit.pgtap).toBe('selected');
    expect(explicit.phases.map(phase => phase.name)).toContain('pgtap');
    const calls: string[][] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = vi.fn(async (_command, args) => { calls.push(args); return { code: 0 }; });
    expect(await verifyLocal({ cwd: f.cwd, env: f.env, run })).toBe(0);
    const result = await f.result(); directories.push(result.packs);
    expect(calls).toHaveLength(14);
    expect(result.phases.map((phase: { name: string }) => phase.name)).toContain('pgtap');
    expect(result.pgtap).toContain('auto-selected due to SQL changes');
    expect(log.mock.calls.flat().join('\n')).toContain('auto-selected pgTAP due to SQL changes');
  });
  it('does not auto-enable pgtap for SQL outside db/ and packages/*/sql/', async () => {
    const f = await fixture(false, process.versions.node, false, ['supabase/tests/example_test.sql']);
    const planned = await explainVerification({ cwd: f.cwd, env: f.env });
    expect(planned.pgtap).toContain('not selected');
    expect(planned.phases.map(phase => phase.name)).not.toContain('pgtap');
  });
});
