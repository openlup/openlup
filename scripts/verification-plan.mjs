// One local obligation catalogue. Package discovery and tooling scope keep their owners.
import { join } from 'node:path';
import { env as processEnvironment } from 'node:process';

const npm = (...args) => ['npm', ...args];
const node = (...args) => [process.execPath, ...args];
const definitions = {
  policy: {
    command: () => npm('run', 'oss:published-tree', '--', '--policy'), resource: null, requires: [],
    owner: 'scripts/oss-published-tree-check.ts', context: 'self-check',
    reason: 'Publication policy, documentation ownership and generated navigation.',
  },
  inventory: {
    command: () => npm('run', 'oss:published-tree', '--', '--inventory'), resource: null, requires: [],
    owner: 'scripts/oss-published-tree-check.ts', context: 'self-check',
    reason: 'Complete public tree and executable inventory.',
  },
  dco: {
    command: ({ candidate }) => npm('run', 'check:dco-signoff', '--', candidate.base, candidate.head), resource: null, requires: [],
    owner: 'scripts/dco-signoff-check.ts', context: 'dco',
    reason: 'Human sign-off on the exact comparison range.',
  },
  gitleaks: {
    command: () => ['gitleaks', 'git', '.', '--config', 'config/gitleaks.toml', '--redact', '--no-banner'], resource: null, requires: [],
    owner: 'config/gitleaks.toml', context: 'gitleaks',
    reason: 'Secret scanning of Git history with the pinned scanner.',
  },
  neutrality: {
    command: ({ candidate }) => node('scripts/public-ci-neutrality.mjs', '--base-commit', candidate.base), resource: null, requires: [],
    owner: 'scripts/public-ci-neutrality.mjs', context: 'self-check',
    reason: 'Tree-wide shrink-only neutrality against the exact comparison base; Node and Git only.',
  },
  'ui-neutrality': {
    command: () => node('--experimental-strip-types', 'packages/ui/smoke/neutrality.ts'), resource: null, requires: [],
    owner: 'packages/ui/smoke/neutrality.ts', context: 'self-check',
    reason: 'Portable UI source boundary; Node only, before dependency installation.',
  },
  install: {
    command: () => npm('ci', '--prefer-offline', '--no-audit', '--fund=false'), resource: 'openlup:install', requires: [],
    owner: 'package-lock.json', context: 'install-proof',
    reason: 'One locked dependency installation for the serial local run.',
  },
  lint: {
    command: () => npm('run', 'lint'), resource: 'openlup:typecheck', requires: ['install'],
    owner: 'package.json', context: 'typecheck',
    reason: 'Package prerequisite builds, structural rules and lint.',
  },
  typecheck: {
    command: () => npm('run', 'oss:published-tree', '--', '--typecheck'), resource: 'openlup:typecheck', requires: ['lint'],
    owner: 'scripts/oss-public-typecheck.ts', context: 'typecheck',
    reason: 'Preview type diagnostics using declarations built by prelint.',
  },
  build: {
    command: () => npm('run', 'build'), resource: 'openlup:build', requires: ['install'],
    owner: 'package.json', context: 'install-proof',
    reason: 'Default reference client, SSR and prerender build.',
  },
  subscription: {
    command: () => npm('run', 'build:public-reference'), resource: 'openlup:build', requires: ['build'],
    env: ({ build }) => ({ OPENLUP_REFERENCE_PROFILE: 'subscription', OPENLUP_BUILD_OUT_DIR: join(build, 'client'), OPENLUP_SSR_OUT_DIR: join(build, 'ssr') }),
    owner: 'package.json', context: 'install-proof',
    reason: 'Subscription reference build in isolated task-local output directories.',
  },
  packages: {
    command: ({ candidate, packs }) => node('--experimental-strip-types', 'scripts/packages/required-package-gates.ts', '--out', packs, '--expected-commit', candidate.head),
    resource: 'openlup:coverage', requires: ['build', 'subscription'],
    owner: 'scripts/packages/required-package-gates.ts', context: 'install-proof',
    reason: 'Owner discovers every publishable package and runs its cold artifact, API and required consumer gates; SQL proof needs Docker.',
  },
  tests: {
    // The native wrapper keeps the real stack pin; isolated test Git fixtures do not.
    command: () => ['env', '-u', 'OPENLUP_STACK_BASE', ...npm('run', 'test:scoped')], resource: 'openlup:coverage', requires: ['packages'],
    owner: 'scripts/ci-test-scope.mjs', context: 'test',
    reason: 'Complete required root selection; the existing owner alone selects bounded tooling exclusions. Serial after package output mutations.',
  },
  pgtap: {
    command: () => node('scripts/public-ci-pgtap.mjs'), resource: 'openlup:pgtap', requires: [],
    owner: 'scripts/public-ci-pgtap.mjs', context: 'pgtap',
    reason: 'Raw Docker diagnostic: select --pgtap for database inputs or an explicit diagnostic request.',
  },
};

export function validateVerificationSteps(steps, pgtap = false) {
  const seen = new Set();
  for (const step of steps) {
    if (!Object.hasOwn(definitions, step.name)) throw new Error(`unknown verification phase: ${step.name}`);
    if (seen.has(step.name)) throw new Error(`duplicate verification phase: ${step.name}`);
    for (const prerequisite of definitions[step.name].requires) {
      if (!seen.has(prerequisite)) throw new Error(`${step.name} requires earlier phase: ${prerequisite}`);
    }
    seen.add(step.name);
  }
  for (const name of Object.keys(definitions)) {
    if (name !== 'pgtap' || pgtap) {
      if (!seen.has(name)) throw new Error(`missing required verification phase: ${name}`);
    } else if (seen.has(name)) throw new Error('pgtap requires explicit selection');
  }
}

export function verificationSteps(candidate, build, packs, pgtap = false) {
  const inputs = { candidate, build, packs };
  const steps = Object.entries(definitions).filter(([name]) => name !== 'pgtap' || pgtap)
    .map(([name, { command, env, ...definition }]) => ({ name, ...definition,
      requires: [...definition.requires], command: command(inputs), env: env ? env(inputs) : {} }));
  validateVerificationSteps(steps, pgtap);
  return steps;
}

export function verificationPlan(candidate, build, packs, pgtap = false) {
  return {
    phases: verificationSteps(candidate, build, packs, pgtap),
    selection: 'All thirteen mandatory local phases; no path-based narrowing or result reuse.',
    pgtap: pgtap ? 'selected' : 'not selected; use --pgtap for database inputs or an explicit diagnostic request',
    hostedOnly: [
      { context: 'test', reason: 'Four independent hosted shards and their complete success aggregation; local selection does not prove hosted execution.' },
      { context: 'install-proof', reason: 'Event-bound dependency comparison and hosted installation environment.' },
      { context: 'native-review', reason: 'Live source/group receipt admission; local review is an execution prerequisite.' },
    ],
    executionPrerequisites: [
      'A clean committed candidate and current native review; planning neither checks nor satisfies review.',
      'The pinned Node, npm and gitleaks versions; Git history and the selected check runtimes.',
      'An installed maintainer helper retains its separate verification stamp requirements.',
    ],
  };
}

export async function preflightBeforeReview({ cwd = process.cwd(), env = processEnvironment } = {}) {
  const { assertMergePreflight, captureSessionCandidate, git } = await import('./agent-review-session.mjs');
  const runGit = (root, ...args) => git(root, '--no-optional-locks', ...args);
  const main = (await runGit(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
  const candidate = await captureSessionCandidate(cwd, undefined, { env, runGit });
  if (!candidate.clean) throw new Error('early preflight requires a clean committed candidate');
  await assertMergePreflight(cwd, candidate, { env, runGit });

  let result = 'merge prediction accepted';
  if (env.OPENLUP_STACK_BASE === candidate.base) {
    try { await runGit(cwd, 'merge-base', '--is-ancestor', candidate.base, main); }
    catch (error) {
      if (error.code !== 1) throw error;
      result = 'local work allowed; queue still awaits the exact stack predecessor';
    }
  }
  if ((await runGit(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim() !== main) {
    throw new Error('origin/main moved during early preflight; run it again');
  }
  return `Pre-review ${candidate.head} on ${candidate.base} against ${main}: ${result}.`;
}
