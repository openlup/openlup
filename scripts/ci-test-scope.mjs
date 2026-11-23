import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { pathToFileURL } from 'node:url';

// Inputs are plain prefixes: an entry ending in '/' covers that directory and
// everything below it (dot files included); any other entry is one exact file.
// Glob matching is deliberately avoided: its '*' and '**' skip dot segments.
// Broad shared triggers: every non-doc root file, every dot-prefixed segment
// anywhere (.github, .npmignore, .env...), the tooling/import closure and test
// setup. That includes both manifests, Vitest, run-vitest, this table and all
// workflows.
export const SHARED_INPUTS = ['scripts/', 'tests/setup/', 'src/test/',
  'src/checkout/machine/commerceRequestCache.ts'];

// Root-level documentation files that do not affect build/test configuration
// and therefore do not trigger the global root-file bailout. Unlisted doc and
// policy checks always run; bounded doc tests declare ROOT_DOC_FILES below.
export const ROOT_DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'GOVERNANCE.md',
  'CHANGELOG.md',
];
const ROOT_DOC_SET = new Set(ROOT_DOC_FILES);

// Only bounded fixtures belong here. Inputs are relative to the checkout;
// every row also has SHARED_INPUTS. Package rows conservatively include all
// packages (exports, builds, packs, manifests and package documentation).
// Session decision tables are unlisted and always run; they do not scan the
// repository. Source-preview, neutrality and published-tree tests remain unlisted
// for their repository-wide policy/inventory or removal-marker scans.
// Review each row against every actual repository read in its import closure;
// see CONTRIBUTING.md#extend-tooling-selection-conservatively.
// Keep scripts/packages/platform-agent-guide.test.ts unlisted: it always runs outbox/platform docs:check.
// Keep scripts/agent-review-derived.test.ts unlisted: it runs Docker-free derived landing checks and readDocumentationState over all tracked paths.
// Keep scripts/packages/generate-release-bom.test.ts unlisted: it scans every *.md file anywhere in the repository.
const NATIVE_STORE_CATALOG_SHARED_INPUTS = [
  'tests/postgres/nativeStoreForwardCatalog.shared.ts',
  'tests/helpers/issuedPlatformCatalog.ts',
  'tests/helpers/postgresContainer.ts',
  'config/ci-images.json',
  'config/reviewed-platform-forwards.json',
  'config/platform-migration-manifest.json',
  'db/platform/migrations/',
];
const PACKAGE_MANIFESTS = [
  'packages/core/package.json',
  'packages/outbox/package.json',
  'packages/platform/package.json',
  'packages/ui/package.json',
];
const PACKAGE_SRC_DIRS = [
  'packages/core/src/',
  'packages/outbox/src/',
  'packages/platform/src/',
  'packages/ui/src/',
];
export const TOOLING_INPUTS = {
  'scripts/agent-review-derived-inventory.test.ts': [
    'db/platform/migrations/',
    'packages/',
    'config/platform-migration-manifest.json',
    'config/reviewed-platform-forwards.json',
    'config/openlup-publication-catalog.json',
    'config/openlup-packages.json',
    'config/ci-images.json',
    'config/doc-routing.json',
    'docs/platform/SOURCE_MAP.md',
    'src/lib/coreDomains.ts',
    'tests/postgres/current-installation-inventory.json',
    'tests/helpers/postgresContainer.ts',
    'server/adapters/postgres/',
  ], // Real Docker landing:merge + installation-inventory-refresh.ts witness (builds core/outbox/platform, syncs SQL/source-map, refreshes 5 PG inventories).
  'scripts/agent-review-queue.test.ts': [], // Synthetic Git repositories and recorded transport.
  'scripts/agent-review-gate.test.ts': [], // Real-Git witnesses of the session CLI and hosted admission.
  'scripts/agent-review-registry.test.ts': ['config/openlup-publication-catalog.json', 'packages/platform/test/packageBoundary.test.ts'], // Closed-registry union and review-economy fixtures reading REGISTRY_PATHS.
  'scripts/public-ci-reuse.test.ts': [], // Recorded workflow/job responses.
  'scripts/documentation-cli.test.ts': ['examples/neutral-store/package.json', ...PACKAGE_MANIFESTS, 'packages/core/scripts/', ...ROOT_DOC_FILES], // Copies CLI closure, package execution surfaces and validates root docs.
  'scripts/pgtap-parity.test.ts': [], // Pure TAP/row-diff/sabotage/executable unit fixtures.
  'scripts/qualified-migration-admission.test.ts': ['config/reviewed-platform-forwards.json', 'db/platform/migrations/'], // Qualified installation admission pins and issued SQL preimages.
  'scripts/reviewed-batch-forward.test.ts': ['config/reviewed-platform-forwards.json', 'config/platform-migration-manifest.json', 'db/platform/migrations/', 'supabase/migrations/', 'packages/platform/sql/'], // Historical batch/M09-M12 forward pinning and co-located admission checks.
  'scripts/reviewed-native-store-forward.test.ts': ['config/reviewed-platform-forwards.json', 'config/platform-migration-manifest.json', 'db/platform/migrations/', 'docs/platform/DATA_AND_MIGRATIONS.md', 'tests/helpers/issuedPlatformCatalog.ts'], // Native-store forward classifier, issued prefix pins and control/guard-catalog doc checks.
  'scripts/sql-admit.test.ts': ['config/reviewed-platform-forwards.json'], // Synthetic Git fixtures reading the committed forward registry and scripts/ admission rules.
  'scripts/ast-grep/check-filewide-ignore.test.ts': [], // Fixture source; actual rules under scripts/.
  'scripts/ast-grep/rule-tests/portable-no-industry-contracts.test.ts': [], // Fixture source and rules.
  'scripts/packages/distribution-cli-proof.test.ts': ['packages/', 'examples/neutral-store/', 'config/openlup-packages.json', 'config/ci-images.json'], // Starter upgrade/extraction proof, CLI and candidate packs.
  'scripts/packages/distribution-cli-settings.test.ts': ['packages/', 'examples/neutral-store/', 'config/openlup-packages.json', 'config/ci-images.json'], // Starter settings discovery/upgrade/MCP proofs and packed platform binary.
  'scripts/packages/eslint-import-map.test.ts': [...PACKAGE_MANIFESTS, ...PACKAGE_SRC_DIRS, 'src/', 'server/'], // Config reads workspace exports and domain directories.
  'scripts/packages/guide-tutorial.test.ts': ['packages/core/docs/guide/start/tutorial.md'], // Reads packages/core/docs/guide/start/tutorial.md plus temp fixtures.
  'scripts/packages/outbox-consumer-proof.test.ts': ['packages/', 'server/runtime/outbox/', 'config/openlup-packages.json', 'config/ci-images.json'], // Actual config, image pins, packs, smoke scripts and reference wiring.
  'scripts/packages/package-manifest-policy.test.ts': ['packages/', 'config/openlup-packages.json'], // Actual config, core exports and root tsconfigs.
  'scripts/packages/package-release.test.ts': ['packages/core/scripts/'], // Release module mutations and synthetic Git fixtures.
  'scripts/packages/package-size-policy.test.ts': ['packages/', 'config/openlup-packages.json'], // Actual config, npm packs/browser entries and budgets.
  'scripts/packages/package-tarball-gate.test.ts': ['packages/'], // Tarball and attestation fixtures.
  'scripts/packages/packages-check.test.ts': ['packages/', 'config/openlup-packages.json'], // Actual manifest-only check plus cold fixture builds.
  'scripts/packages/pack-manifest-input.test.ts': [], // Pure synthetic pack/hash and isolation fixtures.
  'scripts/packages/platform-cold-consumer.test.ts': ['packages/'], // Actual wrapper, synthetic consumers and compiler.
  'scripts/packages/reference-delegation-consumer.test.ts': ['packages/'], // Packs core/platform tarballs and proves isolated delegation consumer.
  'scripts/packages/release-bump.test.ts': ['packages/'], // Reads packages/core/docs/guide/upgrade/v1-3-0.md plus synthetic manifests/locks/changelogs.
  'scripts/packages/release-docs-pass.test.ts': ['packages/core/scripts/'], // Synthetic Git fixtures, fixed release tags and core documentation-contract/consumer-audit helpers.
  'scripts/packages/release-gate.test.ts': ['packages/core/scripts/release-npm-checks.ts'], // Gate mutations, Git and recorded API fixtures.
  'scripts/packages/release-workflow-authenticity.test.ts': [], // Workflow controls under .github/ (already global bailout) and scripted fixtures.
  'scripts/packages/required-package-gates.test.ts': ['packages/core/package.json', 'packages/core/scripts/build-if-missing.ts'], // Cold build/API/consumer fixtures copying core build helper.
  'scripts/packages/set-release.test.ts': ['packages/core/scripts/'], // Set-module mutations and synthetic release fixtures.
  'tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts': ['tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts', ...NATIVE_STORE_CATALOG_SHARED_INPUTS], // Real PostgreSQL native-store catalog witness (with service_role).
  'tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts': ['tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts', ...NATIVE_STORE_CATALOG_SHARED_INPUTS], // Real PostgreSQL native-store catalog witness (without service_role).
  'tests/postgres/reviewedBatchForwards.test.ts': [
    'tests/postgres/reviewedBatchForwards.test.ts',
    'tests/postgres/reviewedBatchCatalog.ts',
    'tests/postgres/subscriptionNativeFixture.ts',
    'tests/postgres/managed-compat/',
    'tests/helpers/postgresContainer.ts',
    'tests/helpers/managedCompatPostgres.ts',
    'tests/helpers/fulfillmentNative.ts',
    'config/ci-images.json',
    'config/ci-postgres-packages.json',
    'config/reviewed-platform-forwards.json',
    'config/platform-migration-manifest.json',
    'db/platform/migrations/',
    'supabase/migrations/',
    'packages/',
    'server/adapters/postgres/migrationRunner.ts',
    'src/domains/commerce/offerAvailability.ts',
  ], // Real PostgreSQL native/managed batch catalog gate, compat harness and inventory/offer witnesses.
};

export function excludedToolingTests(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.some(path => typeof path !== 'string'
    || !path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) return [];
  const covers = (input, path) => input.endsWith('/') ? path.startsWith(input) : path === input;
  const touched = inputs => changedPaths.some(path => inputs.some(input => covers(input, path)));
  if (changedPaths.some(path => (!path.includes('/') && !ROOT_DOC_SET.has(path))
    || path.split('/').some(segment => segment.startsWith('.')))
    || touched(SHARED_INPUTS)) return [];
  return Object.entries(TOOLING_INPUTS)
    .filter(([, inputs]) => !touched(inputs))
    .map(([test]) => test).sort();
}

const isExecutableFile = candidate => {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

// Prefer the fixed system Git binary with a locked PATH so a writable PATH
// entry cannot substitute a fake git on standard runners; fall back to PATH
// resolution on setups (e.g. Homebrew/Nix) where /usr/bin/git is absent.
export function resolveGitExecutable({
  preferred = '/usr/bin/git',
  pathValue = processEnvironment.PATH ?? '',
  isExecutable = isExecutableFile,
} = {}) {
  if (preferred && isExecutable(preferred)) return { binary: preferred, path: '/usr/bin:/bin' };
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'git');
    if (isExecutable(candidate)) return { binary: candidate, path: pathValue };
  }
  return { binary: 'git', path: pathValue };
}

const runGit = (cwd, args) => {
  const { binary, path } = resolveGitExecutable();
  return execFileSync(binary, args, { cwd, encoding: 'utf8',
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...processEnvironment, PATH: path } });
};

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
