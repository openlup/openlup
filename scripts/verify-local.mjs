// Full local contribution proof; hosted admission and installed stamps remain separate.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureSessionCandidate, git, sessionMain } from './agent-review-session.mjs';
import { verificationPlan } from './verification-plan.mjs';
export { verificationSteps } from './verification-plan.mjs';

// Observations only: no install, builds, review admission or provider access.
export async function observePrerequisites({ cwd = process.cwd(), env = processEnvironment, scope } = {}) {
  const observations = [];
  const file = async path => {
    try { return await readFile(join(cwd, path), 'utf8'); } catch { return undefined; }
  };
  const command = (name, argv) => {
    const result = spawnSync(name, argv, { cwd, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024 });
    return result.status === 0 ? { value: result.stdout.trim() } : {
      error: result.error?.code === 'ENOENT' ? 'not found on PATH' : result.signal ? `stopped by ${result.signal}` : `exit ${result.status ?? 'unavailable'}`,
    };
  };
  const version = (name, expected, observed, next, requiredBy) => observations.push({ name, requiredBy,
    status: observed.error ? 'blocked' : !expected ? 'unknown' : observed.value === expected ? 'ready' : 'blocked',
    expected: expected ?? 'unreadable pin', observed: observed.value ?? observed.error, next });
  const nodePin = (await file('.nvmrc'))?.trim();
  version('node', nodePin, { value: process.versions.node }, 'Select the Node version in .nvmrc, then rerun this plan.', ['all phases']);
  let manifest; let lock;
  try { manifest = JSON.parse(await file('package.json')); } catch { /* Report unknown, not a guessed pin. */ }
  try { lock = JSON.parse(await file('package-lock.json')); } catch { /* Installation owns the locked dependency set. */ }
  const npm = command('npm', ['--version']);
  version('npm', manifest?.packageManager, npm.value ? { value: `npm@${npm.value}` } : npm,
    'Select the packageManager version in package.json, then rerun this plan.', ['install']);
  const compiler = 'node_modules/typescript/bin/tsc';
  const compilerSource = await file(compiler);
  const compiled = compilerSource === undefined ? { error: `${compiler} is absent` } : command(process.execPath, [join(cwd, compiler), '--version']);
  version('compiler', lock?.packages?.['node_modules/typescript']?.version,
    compiled.value ? { value: compiled.value.replace(/^Version /u, '') } : compiled,
    'After selecting the pinned Node/npm, run npm ci --prefer-offline --no-audit --fund=false; the install phase also prepares dependencies.', ['lint', 'typecheck', 'build', 'tests']);
  version('gitleaks', '8.30.1', command('gitleaks', ['version']),
    'Provide gitleaks 8.30.1 on PATH before full local verification; hosted scanning remains required.', ['gitleaks']);
  let history;
  try { history = (await git(cwd, '--no-optional-locks', 'rev-parse', '--is-shallow-repository')).trim(); } catch { /* Do not infer complete scan history from a readable comparison base. */ }
  observations.push({ name: 'history', requiredBy: ['policy', 'dco', 'neutrality'],
    status: scope?.state === 'known' ? 'ready' : 'blocked',
    observed: scope?.state === 'known' ? 'comparison base and candidate scope available' : scope?.error ?? 'comparison scope unavailable',
    next: scope?.state === 'known' ? 'No comparison-history action required; secret-scan history is observed separately.' : 'Restore the required comparison history and origin/main (git fetch origin main), then rerun this plan.' });
  observations.push({ name: 'secret scan history', requiredBy: ['gitleaks'], status: history === 'false' ? 'ready' : 'unknown',
    observed: history === 'true' ? 'shallow checkout; complete local history is not available' : history === 'false' ? 'checkout is not shallow; the history scan has not run' : 'checkout depth is unreadable',
    next: history === 'false' ? 'Run the selected gitleaks phase; planning is not scan evidence.' : 'Restore omitted history with git fetch --unshallow when the checkout is shallow before claiming a complete-history scan. The selected command scans only available history; admission is unchanged.' });
  observations.push({ name: 'candidate', requiredBy: ['all phases'],
    status: scope?.candidate?.clean ? 'ready' : 'blocked', observed: scope?.candidate ? scope.candidate.clean ? 'clean committed candidate' : 'uncommitted or untracked changes' : 'candidate unavailable',
    next: 'Review and commit the intended candidate before full local verification; --plan remains available for a dirty tree.' });
  const overrides = ['OPENLUP_BUILD_OUT_DIR', 'OPENLUP_SSR_OUT_DIR', 'OPENLUP_REFERENCE_PROFILE', 'OPENLUP_VITEST_EXCLUDE_FILE'].filter(name => env[name] !== undefined);
  observations.push({ name: 'verification environment', requiredBy: ['all phases'], status: overrides.length ? 'blocked' : 'ready',
    observed: overrides.length ? `selected output/profile overrides: ${overrides.join(', ')}` : 'no selected output/profile overrides',
    next: overrides.length ? `Unset ${overrides.join(', ')} before full local verification.` : 'No action required.' });
  const docker = command('docker', ['info', '--format', '{{.ServerVersion}}']);
  observations.push({ name: 'docker', requiredBy: ['packages'], status: docker.value ? 'ready' : 'blocked',
    observed: docker.value ?? docker.error, next: 'Start an available Docker daemon for the selected disposable PostgreSQL package proofs; this plan starts no containers.' });
  const broker = hasBroker(env);
  observations.push({ name: 'resource broker', requiredBy: [], status: broker ? 'ready' : 'optional',
    observed: broker ? 'executable ai-resource-gate on PATH' : 'not available; local phases run directly', next: 'No action required; native review and any installed helper admission remain separate.' });
  return observations;
}

const SQL_TREE = /^(?:db\/.+|packages\/[^/]+\/sql\/.+)\.sql$/u;

function resolvePgtapSelection(candidate, pgtap) {
  const autoSelected = !pgtap && (candidate?.changedPaths ?? []).some(path => SQL_TREE.test(path));
  return {
    selected: pgtap || autoSelected,
    autoSelected,
    note: autoSelected ? 'selected (auto-selected due to SQL changes)' : undefined,
  };
}

export async function explainVerification({ cwd = process.cwd(), env = processEnvironment, pgtap = false, layered = false } = {}) {
  let candidate; let error;
  try {
    candidate = await captureSessionCandidate(cwd, undefined, {
      env, runGit: (root, ...args) => git(root, '--no-optional-locks', ...args),
    });
  } catch (failure) { error = failure.message; }
  const scope = candidate ? { state: 'known', candidate } : { state: 'unknown', error };
  const resolvedPgtap = resolvePgtapSelection(candidate, pgtap);
  const plan = verificationPlan(candidate ?? { base: '<comparison-base>', head: '<candidate-head>' }, '<run-directory>', '<package-artifacts>', resolvedPgtap.selected, { layered, rootDir: cwd });
  if (resolvedPgtap.note) plan.pgtap = resolvedPgtap.note;
  return {
    kind: 'verification-plan', evidence: 'none; verification commands have not run', scope,
    ...plan,
    prerequisites: await observePrerequisites({ cwd, env, scope }),
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
const DEFAULT_READ_ONLY_CONCURRENCY = 4;

async function assertCandidateUnchanged(cwd, candidate, env) {
  const current = await captureSessionCandidate(cwd, candidate.base, { env });
  if (!current.clean || current.head !== candidate.head || current.tree !== candidate.tree) {
    throw new Error('candidate changed during local verification');
  }
}

async function executePhase(step, { cwd, env, directory, broker, run }) {
  if (step.skipMessage) {
    const log = join(directory, `${step.name}.log`);
    await writeFile(log, `${step.skipMessage}\n`);
    console.log(`Local verification: ${step.name}; ${step.skipMessage}`);
    return { name: step.name, argv: [], env: step.env, resource: null, log, seconds: 0, code: 0, skipped: true };
  }
  const argv = [fileURLToPath(new URL('./agent-review-session.mjs', import.meta.url)), 'verify-command', ...(broker && step.resource ? ['--resource', step.resource] : []), '--', ...step.command];
  const started = Date.now(); const log = join(directory, `${step.name}.log`);
  console.log(`Local verification: ${step.name}; resource=${broker && step.resource ? step.resource : 'direct'}; log=${log}`);
  const phase = await run(process.execPath, argv, cwd, { ...env, ...step.env }, log);
  return { name: step.name, argv, env: step.env, resource: broker && step.resource ? step.resource : null, log, seconds: (Date.now() - started) / 1000, ...phase };
}

export async function verifyLocal({ cwd = process.cwd(), env = processEnvironment, pgtap = false, layered = false, run = runLogged, concurrency = DEFAULT_READ_ONLY_CONCURRENCY } = {}) {
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
    const resolvedPgtap = resolvePgtapSelection(candidate, pgtap);
    const plan = verificationPlan(candidate, directory, packs, resolvedPgtap.selected, { layered, rootDir: cwd });
    if (resolvedPgtap.note) {
      plan.pgtap = resolvedPgtap.note;
      console.log('Local verification: auto-selected pgTAP due to SQL changes');
    }
    result.pgtap = plan.pgtap;
    const limit = Math.max(1, Math.floor(concurrency));
    const stepContext = { cwd, env, directory, broker, run };
    const completed = new Set();
    let pending = [...plan.phases];
    while (pending.length > 0) {
      await assertCandidateUnchanged(cwd, candidate, env);
      const ready = pending.filter(step => step.requires.every(requirement => completed.has(requirement)));
      if (ready.length === 0) throw new Error('verification plan has unsatisfied dependencies');
      const readyReadOnly = ready.filter(step => step.resource === null);
      if (readyReadOnly.length > 0) {
        const waveRecorded = new Map();
        const waveErrors = new Map();
        let stopLaunching = false;
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(limit, readyReadOnly.length) }, async () => {
          while (!stopLaunching && cursor < readyReadOnly.length) {
            const step = readyReadOnly[cursor++];
            try {
              const recorded = await executePhase(step, stepContext);
              waveRecorded.set(step.name, recorded);
              if (recorded.code !== 0) stopLaunching = true;
            } catch (error) {
              waveErrors.set(step.name, error);
              stopLaunching = true;
            }
          }
        }));
        for (const step of readyReadOnly) {
          if (waveRecorded.has(step.name)) result.phases.push(waveRecorded.get(step.name));
        }
        for (const step of readyReadOnly) {
          if (waveErrors.has(step.name)) throw waveErrors.get(step.name);
        }
        const firstFailure = readyReadOnly.map(step => waveRecorded.get(step.name)).find(phase => phase && phase.code !== 0);
        if (firstFailure) { result.code = firstFailure.code; return result.code; }
        for (const step of readyReadOnly) completed.add(step.name);
        pending = pending.filter(step => !completed.has(step.name));
        continue;
      }
      const step = ready[0];
      const recorded = await executePhase(step, stepContext);
      result.phases.push(recorded);
      if (recorded.code !== 0) { result.code = recorded.code; return result.code; }
      completed.add(step.name);
      pending = pending.filter(item => item.name !== step.name);
    }
    await assertCandidateUnchanged(cwd, candidate, env);
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
  if (new Set(args).size !== args.length || args.some(arg => !['--layered', '--pgtap', '--plan', '--json'].includes(arg)) || (args.includes('--json') && !args.includes('--plan'))) {
    console.error('usage: node scripts/verify-local.mjs [--layered] [--pgtap] [--plan [--json]]'); process.exitCode = 2;
  } else if (args.includes('--plan')) {
    const plan = await explainVerification({ pgtap: args.includes('--pgtap'), layered: args.includes('--layered') });
    if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Verification plan only; no verification commands executed. Scope: ${plan.scope.state}.`);
      if (plan.scope.error) console.log(plan.scope.error);
      for (const item of plan.prerequisites) console.log(`Prerequisite ${item.name}: ${item.status}; observed=${item.observed}${item.expected ? `; expected=${item.expected}` : ''}\n  next=${item.next}`);
      console.log(plan.selection);
      for (const step of plan.phases) console.log(`${step.name}: ${step.reason}\n  owner=${step.owner}; context=${step.context}; resource=${step.resource ?? 'direct'}; requires=${step.requires.join(',') || 'none'}\n  argv=${JSON.stringify(step.command)}; env=${JSON.stringify(step.env)}`);
      console.log(`pgTAP: ${plan.pgtap}`);
      for (const item of plan.hostedOnly) console.log(`Hosted only (${item.context}): ${item.reason}`);
      for (const requirement of plan.executionPrerequisites) console.log(`Execution requires: ${requirement}`);
    }
    process.exitCode = plan.scope.state === 'known' ? 0 : 2;
  }
  else process.exitCode = await verifyLocal({ pgtap: args.includes('--pgtap'), layered: args.includes('--layered') });
}
