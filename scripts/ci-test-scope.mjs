import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { env as processEnvironment } from 'node:process';
import { pathToFileURL } from 'node:url';

// Inputs are plain prefixes: an entry ending in '/' covers that directory and
// everything below it (dot files included); any other entry is one exact file.
// Glob matching is deliberately avoided: its '*' and '**' skip dot segments.
// Broad shared triggers: every root file, every dot-prefixed segment anywhere
// (.github, .npmignore, .env...), the tooling/import closure and test setup.
// That includes both manifests, Vitest, run-vitest, this table and all workflows.
export const SHARED_INPUTS = ['scripts/', 'tests/setup/', 'src/test/',
  'src/checkout/machine/commerceRequestCache.ts'];

// Only bounded fixtures belong here. Inputs are relative to the checkout;
// every row also has SHARED_INPUTS. Package rows conservatively include all
// packages (exports, builds, packs, manifests and package documentation).
// Session decision tables are unlisted and always run; they do not scan the
// repository. Source-preview, neutrality and published-tree tests remain unlisted
// for their repository-wide policy/inventory or removal-marker scans.
// Review each row against every actual repository read in its import closure;
// see CONTRIBUTING.md#extend-tooling-selection-conservatively.
export const TOOLING_INPUTS = {
  'scripts/agent-review-queue.test.ts': [], // Synthetic Git repositories and recorded transport.
  'scripts/agent-review-gate.test.ts': [], // Real-Git witnesses of the session CLI and hosted admission.
  'scripts/public-ci-reuse.test.ts': [], // Recorded workflow/job responses.
  'scripts/documentation-impact.test.ts': [], // Synthetic ownership/Git fixtures.
  'scripts/documentation-bundle.test.ts': [], // Synthetic bundle and source fixtures.
  'scripts/documentation-cli.test.ts': ['packages/'], // Copies CLI closure and package manifests.
  'scripts/ast-grep/check-filewide-ignore.test.ts': [], // Fixture source; actual rules under scripts/.
  'scripts/ast-grep/rule-tests/portable-no-industry-contracts.test.ts': [], // Fixture source and rules.
  'scripts/packages/eslint-import-map.test.ts': ['packages/', 'src/', 'server/'], // Config reads workspace exports and domain directories.
  'scripts/packages/outbox-consumer-proof.test.ts': ['packages/', 'server/runtime/outbox/', 'config/openlup-packages.json', 'config/ci-images.json'], // Actual config, image pins, packs, smoke scripts and reference wiring.
  'scripts/packages/package-manifest-policy.test.ts': ['packages/', 'config/openlup-packages.json'], // Actual config, core exports and root tsconfigs.
  'scripts/packages/package-release.test.ts': ['packages/'], // Release module mutations and Git fixtures.
  'scripts/packages/package-size-policy.test.ts': ['packages/', 'config/openlup-packages.json'], // Actual config, npm packs/browser entries and budgets.
  'scripts/packages/package-tarball-gate.test.ts': ['packages/'], // Tarball and attestation fixtures.
  'scripts/packages/packages-check.test.ts': ['packages/', 'config/openlup-packages.json'], // Actual manifest-only check plus cold fixture builds.
  'scripts/packages/pack-manifest-input.test.ts': ['packages/'], // Pack/hash and isolation fixtures.
  'scripts/packages/platform-cold-consumer.test.ts': ['packages/'], // Actual wrapper, synthetic consumers and compiler.
  'scripts/packages/release-bump.test.ts': ['packages/'], // Synthetic manifests/locks/changelogs.
  'scripts/packages/release-gate.test.ts': ['packages/'], // Gate mutations, Git and recorded API fixtures.
  'scripts/packages/release-workflow-authenticity.test.ts': ['packages/'], // Actual workflow controls and scripted fixtures.
  'scripts/packages/required-package-gates.test.ts': ['packages/'], // Cold build/API/consumer fixtures.
  'scripts/packages/set-release.test.ts': ['packages/'], // Set-module mutations and release fixtures.
};

export function excludedToolingTests(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.some(path => typeof path !== 'string'
    || !path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) return [];
  const covers = (input, path) => input.endsWith('/') ? path.startsWith(input) : path === input;
  const touched = inputs => changedPaths.some(path => inputs.some(input => covers(input, path)));
  if (changedPaths.some(path => !path.includes('/') || path.split('/').some(segment => segment.startsWith('.')))
    || touched(SHARED_INPUTS)) return [];
  return Object.entries(TOOLING_INPUTS)
    .filter(([, inputs]) => !touched(inputs))
    .map(([test]) => test).sort();
}

// A fixed Git binary and search path: a writable PATH entry cannot substitute
// a fake git that reports no changed inputs.
const runGit = (cwd, args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...processEnvironment, PATH: '/usr/bin:/bin' } });

// HEAD is the checked-out candidate, including GitHub's PR merge commit. Diff
// against its merge-base with the event's exact base, never a moving branch.
// --no-renames reports both old and new names, so moving an input triggers it.
export function scopeFromEvent({ eventName, event, cwd = process.cwd(), git = args =>
  runGit(cwd, args) }) {
  try {
    const base = eventName === 'pull_request' ? event?.pull_request?.base?.sha
      : eventName === 'merge_group' ? event?.merge_group?.base_sha : undefined;
    if (!/^[a-f0-9]{40}$/u.test(base ?? '')) return [];
    const fork = git(['merge-base', 'HEAD', base]).trim();
    if (!/^[a-f0-9]{40}$/u.test(fork)) return [];
    const diff = git(['diff', '--no-renames', '--name-only', '-z', fork, 'HEAD', '--']);
    if (diff && !diff.endsWith('\0')) return [];
    return excludedToolingTests(diff.split('\0').filter(Boolean));
  } catch {
    return []; // Missing history, malformed metadata and Git errors run everything.
  }
}

// Include staged and unstaged paths separately: an index change can be undone
// in the working file while still being part of the contributor's pending work.
export function scopeFromLocal({ base = 'origin/main', cwd = process.cwd(), git = args =>
  runGit(cwd, args) } = {}) {
  try {
    const fork = git(['merge-base', 'HEAD', base]).trim();
    if (!/^[a-f0-9]{40}$/u.test(fork)) return [];
    const outputs = [
      git(['diff', '--no-renames', '--name-only', '-z', fork, 'HEAD', '--']),
      git(['diff', '--no-renames', '--name-only', '-z', '--cached', '--']),
      git(['diff', '--no-renames', '--name-only', '-z', '--']),
      git(['ls-files', '--others', '--exclude-standard', '-z']),
    ];
    if (outputs.some(diff => diff && !diff.endsWith('\0'))) return [];
    return excludedToolingTests(outputs.flatMap(diff => diff.split('\0').filter(Boolean)));
  } catch {
    return []; // A partial diff is never enough evidence to exclude a test.
  }
}

export function writeTestScope({ output, eventName, eventPath, base, cwd } = {}) {
  // Clear a previous selection first. An unreadable event must not reuse it.
  writeFileSync(output, '');
  let excluded = [];
  try {
    excluded = base !== undefined || (!eventName && !eventPath)
      ? scopeFromLocal({ base, cwd })
      : scopeFromEvent({ eventName, event: JSON.parse(readFileSync(eventPath, 'utf8')), cwd });
  } catch { /* No exclusions on any event-read/selection error. */ }
  writeFileSync(output, excluded.length ? `${excluded.join('\n')}\n` : '');
  console.log(`Test scope: ${excluded.length} bounded tooling files excluded (${base ?? eventName ?? 'origin/main'}).`);
  return excluded;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || (args.length === 2 && args[0] === '--base' && args[1] && !args[1].startsWith('-'));
  if (!valid) {
    writeFileSync(processEnvironment.OPENLUP_VITEST_EXCLUDE_FILE, '');
    throw new Error('Usage: node scripts/ci-test-scope.mjs [--base <ref>]');
  }
  writeTestScope({ output: processEnvironment.OPENLUP_VITEST_EXCLUDE_FILE, base: args[1],
    eventName: processEnvironment.GITHUB_EVENT_NAME, eventPath: processEnvironment.GITHUB_EVENT_PATH });
}
