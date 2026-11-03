import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateVerificationSteps, verificationPlan } from './verification-plan.mjs';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const candidate = { base: 'a'.repeat(40), head: 'b'.repeat(40) };
const plan = (pgtap = false) => verificationPlan(candidate, '/work/.context/scratch/run', '/tmp/packs', pgtap);
const expectedNames = ['policy', 'inventory', 'dco', 'gitleaks', 'neutrality', 'ui-neutrality', 'install', 'lint',
  'typecheck', 'build', 'subscription', 'packages', 'tests'];

describe('local obligation contract', () => {
  it.each([false, true])('preserves every existing command, env and resource, pgtap=%s', pgtap => {
    // Pinned to the pre-extraction contributor commands, independently of the new catalogue.
    const expected = [
      ['policy', ['npm', 'run', 'oss:published-tree', '--', '--policy'], {}, null],
      ['inventory', ['npm', 'run', 'oss:published-tree', '--', '--inventory'], {}, null],
      ['dco', ['npm', 'run', 'check:dco-signoff', '--', candidate.base, candidate.head], {}, null],
      ['gitleaks', ['gitleaks', 'git', '.', '--config', 'config/gitleaks.toml', '--redact', '--no-banner'], {}, null],
      ['neutrality', [process.execPath, 'scripts/public-ci-neutrality.mjs', '--base-commit', candidate.base], {}, null],
      ['ui-neutrality', [process.execPath, '--experimental-strip-types', 'packages/ui/smoke/neutrality.ts'], {}, null],
      ['install', ['npm', 'ci', '--prefer-offline', '--no-audit', '--fund=false'], {}, 'openlup:install'],
      ['lint', ['npm', 'run', 'lint'], {}, 'openlup:typecheck'],
      ['typecheck', ['npm', 'run', 'oss:published-tree', '--', '--typecheck'], {}, 'openlup:typecheck'],
      ['build', ['npm', 'run', 'build'], {}, 'openlup:build'],
      ['subscription', ['npm', 'run', 'build:public-reference'], { OPENLUP_REFERENCE_PROFILE: 'subscription',
        OPENLUP_BUILD_OUT_DIR: '/work/.context/scratch/run/client', OPENLUP_SSR_OUT_DIR: '/work/.context/scratch/run/ssr' }, 'openlup:build'],
      ['packages', [process.execPath, '--experimental-strip-types', 'scripts/packages/required-package-gates.ts', '--out', '/tmp/packs', '--expected-commit', candidate.head], {}, 'openlup:coverage'],
      ['tests', ['env', '-u', 'OPENLUP_STACK_BASE', 'npm', 'run', 'test:scoped'], {}, 'openlup:coverage'],
    ];
    if (pgtap) expected.push(['pgtap', [process.execPath, 'scripts/public-ci-pgtap.mjs'], {}, 'openlup:pgtap']);
    expect(plan(pgtap).phases.map(({ name, command, env, resource }) => [name, command, env, resource])).toEqual(expected);
  });
  it.each([
    ['docs', ['docs/platform/DEVELOPMENT_AND_RELEASE.md']], ['runtime', ['server/runtime/example.ts']],
    ['package', ['packages/core/src/index.ts']], ['SQL', ['supabase/migrations/new.sql']],
    ['control', ['.github/workflows/published-tree-ci.yml']], ['unknown', ['new/domain/input']],
    ['rename', ['src/old.ts', 'server/new.ts']], ['deletion', ['scripts/removed.mjs']],
  ])('does not narrow mandatory obligations for %s inputs', (_label, changedPaths) => {
    expect(verificationPlan({ ...candidate, changedPaths }, '/run', '/packs').phases.map(step => step.name)).toEqual(expectedNames);
  });
  it('refuses unknown, duplicate, missing and wrongly ordered obligations', () => {
    const steps = plan().phases;
    expect(() => validateVerificationSteps([...steps, { name: 'typo' }])).toThrow('unknown verification phase: typo');
    expect(() => validateVerificationSteps([...steps, steps[0]])).toThrow('duplicate verification phase: policy');
    expect(() => validateVerificationSteps(steps.filter(step => step.name !== 'install'))).toThrow('lint requires earlier phase: install');
    expect(() => validateVerificationSteps(steps.filter(step => step.name !== 'neutrality'))).toThrow('missing required verification phase: neutrality');
    expect(() => validateVerificationSteps([...steps].reverse())).toThrow('requires earlier phase');
    expect(() => validateVerificationSteps(plan(true).phases)).toThrow('pgtap requires explicit selection');
  });
  it('keeps an explicit owner and requirement for each of the six mechanical CI contexts and hosted-only boundaries', async () => {
    const workflow = await readFile(resolve('.github/workflows/published-tree-ci.yml'), 'utf8');
    const job = (name: string) => workflow.split(`\n  ${name}:\n`)[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ?? '';
    const phases = plan().phases;
    expect([...new Set(phases.map(step => step.context))].sort()).toEqual(['dco', 'gitleaks', 'install-proof', 'self-check', 'test', 'typecheck']);
    for (const context of ['dco', 'gitleaks', 'install-proof', 'self-check', 'test', 'typecheck']) expect(job(context)).not.toBe('');
    for (const name of ['policy', 'inventory', 'lint', 'typecheck', 'build', 'subscription']) {
      const phase = phases.find(step => step.name === name)!;
      expect(job(phase.context)).toContain(`run: ${phase.command.join(' ')}`);
      expect(phase.owner).not.toBe(''); expect(phase.reason).not.toBe('');
    }
    expect(job('self-check')).toContain('run: node --experimental-strip-types packages/ui/smoke/neutrality.ts');
    expect(job('self-check')).toContain('github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before');
    expect(job('self-check')).toContain('run: node scripts/public-ci-neutrality.mjs --base-commit "$NEUTRALITY_BASE_COMMIT"');
    expect(job('install-proof')).toContain('scripts/packages/required-package-gates.ts --out "$RUNNER_TEMP/package-gates" --expected-commit "$(git rev-parse HEAD)"');
    expect(job('test-full-shard')).toContain('npm test -- --shard=${{ matrix.shard }}/4');
    expect(job('test')).toContain('test "$SHARD_RESULT" = "success"');
    expect(plan().hostedOnly.map(item => item.context)).toEqual(['test', 'install-proof', 'native-review']);
  });
});

describe('read-only public explain CLI', () => {
  const cli = resolve('scripts/verify-local.mjs');
  const execute = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  async function gitFixture() {
    const cwd = await mkdtemp(join(tmpdir(), 'verification-plan-')); directories.push(cwd);
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
      expect(result.status).toBe(0); return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main'); await writeFile(join(cwd, 'source'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    await writeFile(join(cwd, 'source'), 'uncommitted'); await writeFile(join(cwd, 'new-file'), 'untracked');
    return { cwd, git };
  }
  it('explains an unreviewed dirty tree without npm, gitleaks, dependencies, scratch files or index writes', async () => {
    const f = await gitFixture();
    const before = await readFile(join(f.cwd, '.git/index'));
    const files = await readdir(f.cwd);
    const output = execute(f.cwd, '--plan', '--json');
    expect(output.status).toBe(0); const result = JSON.parse(output.stdout);
    expect(result.scope).toMatchObject({ state: 'known', candidate: { clean: false } });
    expect(result.evidence).toContain('commands have not run');
    expect(result.phases.map(step => step.name)).toEqual(expectedNames);
    expect(result).not.toHaveProperty('code'); expect(output.stdout).not.toContain('PASS');
    expect(await readdir(f.cwd)).toEqual(files); expect(await readFile(join(f.cwd, '.git/index'))).toEqual(before);
    const human = execute(f.cwd, '--plan', '--pgtap');
    expect(human.status).toBe(0); expect(human.stdout).toContain('pgTAP: selected');
    expect(human.stdout).toContain('Hosted only (native-review)'); expect(await readdir(f.cwd)).toEqual(files);
  });
  it('keeps all obligations and reports UNKNOWN scope when the Git base is unreadable', async () => {
    const f = await gitFixture(); f.git('update-ref', '-d', 'refs/remotes/origin/main');
    const output = execute(f.cwd, '--plan', '--json');
    expect(output.status).toBe(2); const result = JSON.parse(output.stdout);
    expect(result.scope.state).toBe('unknown'); expect(result.scope.error).not.toBe('');
    expect(result.phases.map(step => step.name)).toEqual(expectedNames);
    expect(result.phases.find(step => step.name === 'dco').command.slice(-2)).toEqual(['<comparison-base>', '<candidate-head>']);
    expect(await readdir(f.cwd)).toEqual(['.git', 'new-file', 'source']);
  });
  it.each([['--json'], ['--plan', '--plan'], ['--skip'], ['--plan', '--pgtap', '--pgtap']])('refuses invalid args %j before writing', async (...args) => {
    const cwd = await mkdtemp(join(tmpdir(), 'verification-plan-args-')); directories.push(cwd);
    expect(execute(cwd, ...args).status).toBe(1); expect(await readdir(cwd)).toEqual([]);
  });
});
