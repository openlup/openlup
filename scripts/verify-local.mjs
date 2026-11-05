// Full local contribution proof; hosted admission and installed stamps remain separate.
import { spawn, execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureSessionCandidate, git, sessionMain } from './agent-review-session.mjs';
import { verificationPlan } from './verification-plan.mjs';
export { verificationSteps } from './verification-plan.mjs';

export async function explainVerification({ cwd = process.cwd(), env = processEnvironment, pgtap = false } = {}) {
  let candidate; let error;
  try {
    candidate = await captureSessionCandidate(cwd, undefined, {
      env, runGit: (root, ...args) => git(root, '--no-optional-locks', ...args),
    });
  } catch (failure) { error = failure.message; }
  return {
    kind: 'verification-plan', evidence: 'none; commands have not run',
    scope: candidate ? { state: 'known', candidate } : { state: 'unknown', error },
    ...verificationPlan(candidate ?? { base: '<comparison-base>', head: '<candidate-head>' }, '<run-directory>', '<package-artifacts>', pgtap),
  };
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
    const plan = verificationPlan(candidate, directory, packs, pgtap);
    result.pgtap = plan.pgtap;
    for (const step of plan.phases) {
      const current = await captureSessionCandidate(cwd, candidate.base, { env });
      if (!current.clean || current.head !== candidate.head || current.tree !== candidate.tree) throw new Error('candidate changed during local verification');
      const argv = [fileURLToPath(new URL('./agent-review-session.mjs', import.meta.url)), 'verify-command', ...(broker && step.resource ? ['--resource', step.resource] : []), '--', ...step.command];
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
  if (new Set(args).size !== args.length || args.some(arg => !['--pgtap', '--plan', '--json'].includes(arg)) || (args.includes('--json') && !args.includes('--plan'))) {
    console.error('usage: node scripts/verify-local.mjs [--pgtap] [--plan [--json]]'); process.exitCode = 1;
  } else if (args.includes('--plan')) {
    const plan = await explainVerification({ pgtap: args.includes('--pgtap') });
    if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Verification plan only; no commands executed. Scope: ${plan.scope.state}.`);
      if (plan.scope.error) console.log(plan.scope.error);
      console.log(plan.selection);
      for (const step of plan.phases) console.log(`${step.name}: ${step.reason}\n  owner=${step.owner}; context=${step.context}; resource=${step.resource ?? 'direct'}; requires=${step.requires.join(',') || 'none'}\n  argv=${JSON.stringify(step.command)}; env=${JSON.stringify(step.env)}`);
      console.log(`pgTAP: ${plan.pgtap}`);
      for (const item of plan.hostedOnly) console.log(`Hosted only (${item.context}): ${item.reason}`);
      for (const requirement of plan.executionPrerequisites) console.log(`Execution requires: ${requirement}`);
    }
    process.exitCode = plan.scope.state === 'known' ? 0 : 2;
  }
  else process.exitCode = await verifyLocal({ pgtap: args.includes('--pgtap') });
}
