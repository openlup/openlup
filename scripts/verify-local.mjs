// Full local contribution proof; hosted admission and installed stamps remain separate.
import { spawn, execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureSessionCandidate, git, sessionMain } from './agent-review-session.mjs';

const profiles = {
  policy: null, inventory: null, dco: null,
  gitleaks: null, install: 'openlup:install', lint: 'openlup:typecheck',
  typecheck: 'openlup:typecheck', build: 'openlup:build', subscription: 'openlup:build',
  packages: 'openlup:coverage', tests: 'openlup:coverage', neutrality: null,
  'ui-neutrality': null, pgtap: 'openlup:pgtap',
};
export function verificationSteps(candidate, build, packs, pgtap) {
  const npm = (...args) => ['npm', ...args];
  const node = (...args) => [process.execPath, ...args];
  const steps = [
    ['policy', npm('run', 'oss:published-tree', '--', '--policy')],
    ['inventory', npm('run', 'oss:published-tree', '--', '--inventory')],
    ['dco', npm('run', 'check:dco-signoff', '--', candidate.base, candidate.head)],
    ['gitleaks', ['gitleaks', 'git', '.', '--config', 'config/gitleaks.toml', '--redact', '--no-banner']],
    ['install', npm('ci', '--prefer-offline', '--no-audit', '--fund=false')],
    ['lint', npm('run', 'lint')],
    ['typecheck', npm('run', 'oss:published-tree', '--', '--typecheck')],
    ['build', npm('run', 'build')],
    ['subscription', npm('run', 'build:public-reference'), { OPENLUP_REFERENCE_PROFILE: 'subscription',
      OPENLUP_BUILD_OUT_DIR: join(build, 'client'), OPENLUP_SSR_OUT_DIR: join(build, 'ssr') }],
    ['packages', node('--experimental-strip-types', 'scripts/packages/required-package-gates.ts', '--out', packs, '--expected-commit', candidate.head)],
    // Keep the real stack pin in the native wrapper, outside isolated test Git fixtures.
    ['tests', ['env', '-u', 'OPENLUP_STACK_BASE', ...npm('run', 'test:scoped')]],
    ['neutrality', node('scripts/public-ci-neutrality.mjs', '--base-commit', candidate.base)],
    ['ui-neutrality', node('--experimental-strip-types', 'packages/ui/smoke/neutrality.ts')],
  ];
  if (pgtap) steps.push(['pgtap', node('scripts/public-ci-pgtap.mjs')]);
  return steps.map(([name, command, env = {}]) => {
    if (!Object.hasOwn(profiles, name)) throw new Error(`unknown verification phase: ${name}`);
    return { name, command, env, resource: profiles[name] };
  });
}
export function hasBroker(env) {
  return (env.PATH ?? '').split(delimiter).some(dir => {
    try { accessSync(join(dir, 'ai-resource-gate'), constants.X_OK); return true; } catch { return false; }
  });
}
export function runLogged(command, args, cwd, env, logPath) {
  return new Promise((resolveRun, reject) => {
    const log = openSync(logPath, 'wx');
    writeSync(log, `${JSON.stringify({ command, args })}\n`);
    // One descriptor preserves stdout/stderr ordering, including the root worker line.
    const child = spawn(command, args, { cwd, env, stdio: ['inherit', log, log] });
    const interrupt = () => child.kill('SIGINT'); const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', async (code, signal) => {
      cleanup(); closeSync(log);
      try {
        const output = await readFile(logPath, 'utf8');
        const worker = env.CI === 'true' ? undefined : /^Local verification Vitest workers=.+$/mu.exec(output)?.[0];
        resolveRun({ code: code ?? 1, signal, worker });
      } catch (error) { reject(error); }
    });
  });
}
export async function verifyLocal({ cwd = process.cwd(), env = processEnvironment, pgtap = false, run = runLogged } = {}) {
  env = { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}` };
  const scratch = join(cwd, '.context', 'scratch'); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'verify-local-'));
  const result = { started: new Date().toISOString(), hosted: 'Source/group dependency admission, native admission and installed stamps remain separate.', phases: [], code: 1 };
  try {
    const candidate = await captureSessionCandidate(cwd, undefined, { env });
    if (!candidate.clean) throw new Error('verification requires a clean committed candidate');
    await sessionMain(['verify'], { cwd, env });
    result.candidate = candidate; result.main = (await git(cwd, 'rev-parse', 'origin/main^{commit}')).trim();
    const pinned = (await readFile(join(cwd, '.nvmrc'), 'utf8')).trim();
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    if (process.versions.node !== pinned) throw new Error(`verification requires Node ${pinned}; running ${process.versions.node}`);
    const npmVersion = execFileSync('npm', ['--version'], { cwd, env, encoding: 'utf8' }).trim();
    if (`npm@${npmVersion}` !== manifest.packageManager) throw new Error(`verification requires ${manifest.packageManager}; running npm@${npmVersion}`);
    const leaks = execFileSync('gitleaks', ['version'], { cwd, env, encoding: 'utf8' }).trim();
    if (leaks !== '8.30.1') throw new Error(`verification requires gitleaks 8.30.1; running ${leaks}`);
    result.runtime = { node: process.versions.node, npm: npmVersion, gitleaks: leaks };
    for (const key of ['OPENLUP_BUILD_OUT_DIR', 'OPENLUP_SSR_OUT_DIR', 'OPENLUP_REFERENCE_PROFILE', 'OPENLUP_VITEST_EXCLUDE_FILE']) {
      if (env[key] !== undefined) throw new Error(`unset ${key} before full local verification`);
    }
    const packs = await mkdtemp(join(tmpdir(), 'openlup-verify-packs-')); result.packs = packs;
    const broker = hasBroker(env); result.broker = broker;
    const steps = verificationSteps(candidate, directory, packs, pgtap);
    result.pgtap = pgtap ? 'selected' : 'not selected; use --pgtap for database inputs or an explicit diagnostic request';
    for (const step of steps) {
      const current = await captureSessionCandidate(cwd, candidate.base, { env });
      if (!current.clean || current.head !== candidate.head || current.tree !== candidate.tree) throw new Error('candidate changed during local verification');
      const argv = ['scripts/agent-review-session.mjs', 'verify-command', ...(broker && step.resource ? ['--resource', step.resource] : []), '--', ...step.command];
      const started = Date.now(); const log = join(directory, `${step.name}.log`);
      console.log(`Local verification: ${step.name}; resource=${broker && step.resource ? step.resource : 'direct'}; log=${log}`);
      const phase = await run(process.execPath, argv, cwd, { ...env, ...step.env }, log);
      result.phases.push({ name: step.name, argv, env: step.env, resource: broker && step.resource ? step.resource : null, log, seconds: (Date.now() - started) / 1000, ...phase });
      if (phase.code !== 0) { result.code = phase.code; return result.code; }
    }
    const final = await captureSessionCandidate(cwd, candidate.base, { env });
    if (!final.clean || final.head !== candidate.head || final.tree !== candidate.tree) throw new Error('candidate changed during local verification');
    await sessionMain(['verify'], { cwd, env }); result.code = 0; return 0;
  } catch (error) { result.error = error.message; console.error(error.message); return 1; }
  finally {
    result.ended = new Date().toISOString();
    await writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Local verification ${result.code === 0 ? 'PASS' : 'FAILED'}: ${join(directory, 'result.json')}`);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== '--pgtap')) { console.error('usage: node scripts/verify-local.mjs [--pgtap]'); process.exitCode = 1; }
  else process.exitCode = await verifyLocal({ pgtap: args.includes('--pgtap') });
}
