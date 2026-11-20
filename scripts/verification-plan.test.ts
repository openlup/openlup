import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
      ['policy', ['npm', 'run', 'oss:published-tree', '--', '--policy', '--docs-base', candidate.base], {}, null],
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
    for (const name of ['inventory', 'lint', 'typecheck', 'build', 'subscription']) {
      const phase = phases.find(step => step.name === name)!;
      const worker = phase.context === 'install-proof' ? 'install-packages' : phase.context;
      expect(job(worker)).toContain(`run: ${phase.command.join(' ')}`);
      expect(phase.owner).not.toBe(''); expect(phase.reason).not.toBe('');
    }
    const policy = phases.find(step => step.name === 'policy')!;
    expect(job('self-check')).toContain('run: npm run oss:published-tree -- --policy');
    expect(policy.owner).not.toBe(''); expect(policy.reason).not.toBe('');
    expect(job('self-check')).toContain('run: node --experimental-strip-types packages/ui/smoke/neutrality.ts');
    expect(job('self-check')).toContain('github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before');
    expect(job('self-check')).toContain('run: node scripts/public-ci-neutrality.mjs --base-commit "$NEUTRALITY_BASE_COMMIT"');
    expect(job('install-packages')).toContain('scripts/packages/required-package-gates.ts --out "$RUNNER_TEMP/package-gates" --expected-commit "$(git rev-parse HEAD)"');
    expect(job('install-proof')).toContain('needs: [install-packages, install-browser]');
    expect(job('test-full-shard')).toContain('npm test -- --shard=${{ matrix.shard }}/8');
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
    expect(result.prerequisites.find(item => item.name === 'compiler')).toMatchObject({ status: 'blocked', observed: 'node_modules/typescript/bin/tsc is absent' });
    expect(result.prerequisites.find(item => item.name === 'npm')).toMatchObject({ status: 'blocked', observed: 'not found on PATH' });
    expect(result.prerequisites.find(item => item.name === 'resource broker')).toMatchObject({ status: 'optional', requiredBy: [] });
    expect(result).not.toHaveProperty('code'); expect(output.stdout).not.toContain('PASS');
    expect(await readdir(f.cwd)).toEqual(files); expect(await readFile(join(f.cwd, '.git/index'))).toEqual(before);
    const human = execute(f.cwd, '--plan', '--pgtap');
    expect(human.status).toBe(0); expect(human.stdout).toContain('pgTAP: selected');
    expect(human.stdout).toContain('Hosted only (native-review)'); expect(await readdir(f.cwd)).toEqual(files);
    expect(human.stdout).toContain('Prerequisite compiler: blocked');
    expect(human.stdout).toContain('npm ci --prefer-offline --no-audit --fund=false');
  });
  it('observes selected versions without builds, installation, review or scratch writes, and reports wrong versions', async () => {
    const f = await gitFixture();
    const bin = join(f.cwd, '.git', 'observation-bin'); await mkdir(bin);
    for (const [name, value] of [['npm', '11.19.0'], ['gitleaks', '8.30.1'], ['docker', '27.0.0']]) {
      await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${value}'\n`); await chmod(join(bin, name), 0o700);
    }
    await writeFile(join(f.cwd, '.nvmrc'), process.versions.node);
    await writeFile(join(f.cwd, 'package.json'), JSON.stringify({ packageManager: 'npm@11.19.0' }));
    await writeFile(join(f.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/typescript': { version: '6.0.3' } } }));
    await mkdir(join(f.cwd, 'node_modules', 'typescript', 'bin'), { recursive: true });
    await writeFile(join(f.cwd, 'node_modules', 'typescript', 'bin', 'tsc'), 'console.log("Version 6.0.3")');
    const before = await readdir(f.cwd); const index = await readFile(join(f.cwd, '.git/index'));
    const observe = () => spawnSync(process.execPath, [cli, '--plan', '--json'], { cwd: f.cwd, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    const observed = observe(); expect(observed.status).toBe(0);
    const prerequisites = JSON.parse(observed.stdout).prerequisites;
    for (const name of ['node', 'npm', 'compiler', 'gitleaks', 'docker', 'history']) expect(prerequisites.find(item => item.name === name)?.status).toBe('ready');
    expect(prerequisites.find(item => item.name === 'candidate')?.status).toBe('blocked');
    expect(await readdir(f.cwd)).toEqual(before); expect(await readFile(join(f.cwd, '.git/index'))).toEqual(index);
    await writeFile(join(f.cwd, '.nvmrc'), '0.0.0');
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "0.0.0\\n"\n');
    await writeFile(join(f.cwd, 'node_modules', 'typescript', 'bin', 'tsc'), 'console.log("Version 0.0.0")');
    const wrong = JSON.parse(observe().stdout).prerequisites;
    for (const name of ['node', 'npm', 'compiler']) expect(wrong.find(item => item.name === name)?.status).toBe('blocked');
    expect(await readdir(f.cwd)).toEqual(before); expect(await readFile(join(f.cwd, '.git/index'))).toEqual(index);
  });
  it('distinguishes a known comparison base from incomplete secret-scan history without changing admission', async () => {
    const f = await gitFixture();
    await writeFile(join(f.cwd, '.git', 'shallow'), `${f.git('rev-parse', 'HEAD')}\n`);
    const before = await readFile(join(f.cwd, '.git/index'));
    const output = execute(f.cwd, '--plan', '--json');
    expect(output.status).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result.scope.state).toBe('known');
    expect(result.prerequisites.find(item => item.name === 'history')).toMatchObject({ status: 'ready', observed: 'comparison base and candidate scope available' });
    expect(result.prerequisites.find(item => item.name === 'secret scan history')).toMatchObject({ status: 'unknown', observed: 'shallow checkout; complete local history is not available' });
    expect(result.phases.map(step => step.name)).toEqual(expectedNames);
    expect(await readFile(join(f.cwd, '.git/index'))).toEqual(before);
  });
  it('schedules a broad diagnostic only after early preflight accepts the committed candidate', async () => {
    const f = await gitFixture();
    const base = f.git('rev-parse', 'HEAD');
    const planner = resolve('scripts/verification-plan.mjs');
    const probe = `import { pathToFileURL } from 'node:url';
      import { env } from 'node:process';
      const { preflightBeforeReview } = await import(pathToFileURL(env.OPENLUP_TEST_PLANNER));
      try { console.log(await preflightBeforeReview()); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const schedule = (stackBase?: string) => spawnSync('/bin/sh', [
      '-c', '"$1" --input-type=module -e "$2" && printf "broker-started\\n"',
      'schedule', process.execPath, probe,
    ], {
      cwd: f.cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', OPENLUP_TEST_PLANNER: planner, OPENLUP_STACK_BASE: stackBase },
    });
    expect(schedule().stderr).toContain('requires a clean committed candidate');
    await writeFile(join(f.cwd, 'source'), 'candidate\n');
    f.git('add', '.'); f.git('commit', '-qm', 'candidate');
    const head = f.git('rev-parse', 'HEAD');
    const accepted = schedule();
    expect(accepted.status).toBe(0);
    expect(accepted.stdout.trim().split('\n')).toEqual([
      `Pre-review ${head} on ${base} against ${base}: merge prediction accepted.`, 'broker-started',
    ]);
    const pending = schedule(head);
    expect(pending.status).toBe(0);
    expect(pending.stdout).toContain('queue still awaits the exact stack predecessor');
    f.git('checkout', '-q', '--detach', base);
    await writeFile(join(f.cwd, 'source'), 'main change\n');
    f.git('add', 'source'); f.git('commit', '-qm', 'main change');
    f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    f.git('checkout', '-q', '--detach', head);
    const index = await readFile(join(f.cwd, '.git/index'));
    const refused = schedule();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('candidate conflicts with origin/main');
    expect(refused.stdout).not.toContain('broker-started');
    expect(await readdir(f.cwd)).toEqual(['.git', 'new-file', 'source']);
    expect(await readFile(join(f.cwd, '.git/index'))).toEqual(index);
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
