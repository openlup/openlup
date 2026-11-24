import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { env as processEnvironment } from 'node:process';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excludedToolingTests, resolveGitExecutable, ROOT_DOC_FILES, scopeFromEvent, scopeFromLocal, TOOLING_INPUTS, writeTestScope } from './ci-test-scope.mjs';

const base = 'a'.repeat(40);
const all = Object.keys(TOOLING_INPUTS).sort();
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(tmpdir(), 'ci-test-scope-')); directories.push(path); return path; }

describe('conservative tooling scope', () => {
  it('excludes only declared fixtures on a product change, retaining tree scanners and lint inputs', () => {
    const excluded = excludedToolingTests(['src/pages/account/example.tsx']);
    expect(excluded).toEqual(all.filter(test => !test.endsWith('eslint-import-map.test.ts')));
    for (const file of ['agent-review-session', 'source-preview-release', 'public-ci-neutrality', 'oss-published-tree-check']) {
      expect(excluded).not.toContain(`scripts/${file}.test.ts`);
    }
    expect(excludedToolingTests(['server/runtime/outbox/candidateAdmission.ts']))
      .toEqual(Object.entries(TOOLING_INPUTS)
        .filter(([, inputs]) => !inputs.some(input => input === 'server/' || input === 'server/runtime/outbox/'))
        .map(([test]) => test).sort());
    expect(excludedToolingTests(['packages/core/src/index.ts']))
      .toEqual(Object.entries(TOOLING_INPUTS)
        .filter(([, inputs]) => !inputs.includes('packages/') && !inputs.includes('packages/core/src/'))
        .map(([test]) => test).sort());
  });
  it.each(['package.json', 'package-lock.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.app.json',
    'LICENSE', 'UNKNOWN.md', 'scripts/run-vitest.mjs',
    'scripts/ci-test-scope.mjs', 'scripts/ci-test-scope.test.ts', '.github/workflows/any.yml',
    '.github/actions/example/action.yml',
    'eslint.config.js', '.nvmrc', 'scripts/packages/new-helper.ts', 'tests/setup/scrub-git-env.ts',
    'src/test/setup.ts', 'src/checkout/machine/commerceRequestCache.ts',
    // Dot segments anywhere and hidden root folders: glob '*'/'**' would skip them.
    '.husky/pre-commit', 'scripts/.x', 'tests/setup/.env', 'src/test/.x', 'packages/core/.gitignore',
    'packages/platform/src/.npmignore', 'packages/core/.github/workflows/ci.yml'])(
    'runs everything for shared input %s', path => { expect(excludedToolingTests([path])).toEqual([]); },
  );
  it('excludes bounded tooling tests for docs and unrelated config changes', () => {
    expect(excludedToolingTests(['docs/platform/README.md'])).toEqual(all);
    expect(excludedToolingTests(['config/doc-routing.json'])).toEqual(all.filter(test =>
      test !== 'scripts/agent-review-derived-inventory.test.ts'));
    expect(excludedToolingTests(['config/openlup-packages.json'])).toEqual(all.filter(test =>
      !['agent-review-derived-inventory', 'distribution-cli-proof', 'distribution-cli-settings', 'outbox-consumer-proof', 'package-manifest-policy', 'package-size-policy', 'packages-check'].some(name => test.endsWith(`${name}.test.ts`))));
  });
  it.each(ROOT_DOC_FILES)(
    'does not disable all exclusions for root doc %s while retaining doc and policy checks',
    doc => {
      const excluded = excludedToolingTests([doc]);
      expect(excluded).toEqual(all.filter(test => test !== 'scripts/documentation-cli.test.ts'));
      expect(excluded).not.toContain('scripts/documentation-cli.test.ts');
      for (const unlisted of ['scripts/oss-published-tree-check.test.ts', 'scripts/dco-signoff-check.test.ts',
        'scripts/check-publishable-gap-enumeration.test.ts', 'scripts/public-ci-neutrality.test.ts',
        'scripts/packages/platform-agent-guide.test.ts', 'scripts/agent-review-derived.test.ts',
        'scripts/preflight-integration.test.ts', 'scripts/packages/generate-release-bom.test.ts']) {
        expect(excluded).not.toContain(unlisted);
      }
      expect(excluded).toContain('scripts/packages/outbox-consumer-proof.test.ts');
      expect(excluded).toContain('scripts/packages/distribution-cli-proof.test.ts');
    },
  );
  it('retains the Outbox, distribution and PostgreSQL witnesses for image-pin-only changes', () => {
    const excluded = excludedToolingTests(['config/ci-images.json']);
    for (const test of [
      'scripts/packages/outbox-consumer-proof.test.ts',
      'scripts/packages/distribution-cli-proof.test.ts',
      'scripts/packages/distribution-cli-settings.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts',
      'tests/postgres/reviewedBatchForwards.test.ts',
    ]) {
      expect(excluded).not.toContain(test);
    }
  });
  it('retains distribution-cli-proof, distribution-cli-settings, guide-tutorial and pgtap-parity for their actual dependency closures', () => {
    expect(excludedToolingTests(['examples/neutral-store/extract.mjs']))
      .toEqual(all.filter(test => ![
        'scripts/packages/distribution-cli-proof.test.ts',
        'scripts/packages/distribution-cli-settings.test.ts',
        'tests/postgres/neutralStarterE4.test.ts',
        'tests/postgres/neutralStoreQuote.test.ts',
        'tests/postgres/neutralStoreRecovery.test.ts',
        'tests/postgres/neutralStoreUuid.test.ts',
      ].includes(test)));
    expect(excludedToolingTests(['examples/neutral-store/owned/catalogue.ts']))
      .not.toContain('scripts/packages/distribution-cli-proof.test.ts');
    expect(excludedToolingTests(['examples/neutral-store/owned/settings-host.ts']))
      .not.toContain('scripts/packages/distribution-cli-settings.test.ts');
    expect(excludedToolingTests(['packages/platform/src/lifecycle/openlup.mjs']))
      .not.toContain('scripts/packages/distribution-cli-proof.test.ts');
    expect(excludedToolingTests(['packages/core/docs/guide/start/tutorial.md']))
      .not.toContain('scripts/packages/guide-tutorial.test.ts');
    expect(excludedToolingTests(['packages/core/src/index.ts']))
      .toContain('scripts/pgtap-parity.test.ts');
    expect(excludedToolingTests(['scripts/pgtap-parity.mjs'])).toEqual([]);
  });
  it('excludes bounded migration-pinning, registry, delegation, release-docs and postgres catalog suites on unrelated changes while keeping repo-wide scanners', () => {
    const excluded = excludedToolingTests(['src/pages/Home.tsx']);
    for (const bounded of [
      'scripts/agent-review-registry.test.ts',
      'scripts/qualified-migration-admission.test.ts',
      'scripts/reviewed-batch-forward.test.ts',
      'scripts/reviewed-native-store-forward.test.ts',
      'scripts/sql-admit.test.ts',
      'scripts/packages/distribution-cli-settings.test.ts',
      'scripts/packages/reference-delegation-consumer.test.ts',
      'scripts/packages/release-docs-pass.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts',
      'tests/postgres/reviewedBatchForwards.test.ts',
    ]) {
      expect(excluded).toContain(bounded);
    }
    expect(excluded).not.toContain('scripts/agent-review-derived.test.ts');
    expect(excluded).not.toContain('scripts/preflight.test.ts');
    expect(excluded).not.toContain('scripts/preflight-integration.test.ts');
    expect(excluded).not.toContain('scripts/packages/generate-release-bom.test.ts');
  });
  it('retains migration-pinning, registry, package and postgres catalog suites when their declared inputs change', () => {
    const portableMigration = excludedToolingTests(['db/platform/migrations/20261121000000_example.sql']);
    for (const test of [
      'scripts/qualified-migration-admission.test.ts',
      'scripts/reviewed-batch-forward.test.ts',
      'scripts/reviewed-native-store-forward.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts',
      'tests/postgres/reviewedBatchForwards.test.ts',
    ]) {
      expect(portableMigration).not.toContain(test);
    }
    expect(portableMigration).toContain('scripts/sql-admit.test.ts');

    const managedMigration = excludedToolingTests(['supabase/migrations/20261121000000_example.sql']);
    expect(managedMigration).not.toContain('scripts/reviewed-batch-forward.test.ts');
    expect(managedMigration).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');
    expect(managedMigration).toContain('tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts');

    const forwardRegistry = excludedToolingTests(['config/reviewed-platform-forwards.json']);
    for (const test of [
      'scripts/sql-admit.test.ts',
      'scripts/qualified-migration-admission.test.ts',
      'scripts/reviewed-batch-forward.test.ts',
      'scripts/reviewed-native-store-forward.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts',
      'tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts',
      'tests/postgres/reviewedBatchForwards.test.ts',
    ]) {
      expect(forwardRegistry).not.toContain(test);
    }

    const pgHarness = excludedToolingTests(['tests/helpers/postgresContainer.ts']);
    expect(pgHarness).not.toContain('tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts');
    expect(pgHarness).not.toContain('tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts');
    expect(pgHarness).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');

    const dataDoc = excludedToolingTests(['docs/platform/DATA_AND_MIGRATIONS.md']);
    expect(dataDoc).not.toContain('scripts/reviewed-native-store-forward.test.ts');
    expect(dataDoc).toContain('tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts');
    expect(dataDoc).toContain('tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts');

    expect(excludedToolingTests(['config/openlup-publication-catalog.json'])).not.toContain('scripts/agent-review-registry.test.ts');
    expect(excludedToolingTests(['packages/platform/test/packageBoundary.test.ts'])).not.toContain('scripts/agent-review-registry.test.ts');

    const pkgChange = excludedToolingTests(['packages/core/src/index.ts']);
    expect(pkgChange).not.toContain('scripts/packages/distribution-cli-settings.test.ts');
    expect(pkgChange).not.toContain('scripts/packages/reference-delegation-consumer.test.ts');
    expect(pkgChange).not.toContain('scripts/packages/eslint-import-map.test.ts');
    expect(pkgChange).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');
    expect(pkgChange).toContain('scripts/packages/release-docs-pass.test.ts');
    expect(excludedToolingTests(['packages/core/scripts/documentation-contract.ts']))
      .not.toContain('scripts/packages/release-docs-pass.test.ts');

    // Narrowed package-SQL / SQL-reference falsifier: retains all 11 live-pack/SQL/manifest tests
    // plus the split Docker inventory witness, while skipping the 10 narrowed synthetic/unrelated tests.
    const narrowedSynthetic = [
      'scripts/documentation-cli.test.ts',
      'scripts/packages/eslint-import-map.test.ts',
      'scripts/packages/guide-tutorial.test.ts',
      'scripts/packages/pack-manifest-input.test.ts',
      'scripts/packages/package-release.test.ts',
      'scripts/packages/release-docs-pass.test.ts',
      'scripts/packages/release-gate.test.ts',
      'scripts/packages/release-workflow-authenticity.test.ts',
      'scripts/packages/required-package-gates.test.ts',
      'scripts/packages/set-release.test.ts',
    ];
    const retainedOnPackageSql = [
      'scripts/agent-review-derived-inventory.test.ts',
      'scripts/reviewed-batch-forward.test.ts',
      'scripts/packages/distribution-cli-proof.test.ts',
      'scripts/packages/distribution-cli-settings.test.ts',
      'scripts/packages/outbox-consumer-proof.test.ts',
      'scripts/packages/package-manifest-policy.test.ts',
      'scripts/packages/package-size-policy.test.ts',
      'scripts/packages/package-tarball-gate.test.ts',
      'scripts/packages/packages-check.test.ts',
      'scripts/packages/platform-cold-consumer.test.ts',
      'scripts/packages/reference-delegation-consumer.test.ts',
      'scripts/packages/release-bump.test.ts',
      'tests/postgres/reviewedBatchForwards.test.ts',
    ];
    for (const sqlPath of ['packages/platform/sql/20990101000000_example.sql', 'packages/core/docs/guide/reference/sql.md']) {
      const excluded = excludedToolingTests([sqlPath]);
      for (const test of narrowedSynthetic) expect(excluded, `${sqlPath} excludes ${test}`).toContain(test);
      for (const test of retainedOnPackageSql) {
        if (sqlPath.endsWith('sql.md') && test === 'scripts/reviewed-batch-forward.test.ts') continue;
        expect(excluded, `${sqlPath} retains ${test}`).not.toContain(test);
      }
    }
    expect(excludedToolingTests(['src/pages/Home.tsx'])).toContain('scripts/agent-review-derived-inventory.test.ts');
    for (const inventoryInput of [
      'db/platform/migrations/20990101000000_example.sql',
      'packages/core/scripts/documentation-sql-inventory.ts',
      'packages/outbox/sql/20990101000000_example.sql',
      'packages/platform/src/portability/index.ts',
      'docs/platform/SOURCE_MAP.md',
      'src/lib/coreDomains.ts',
    ]) {
      expect(excludedToolingTests([inventoryInput]), inventoryInput)
        .not.toContain('scripts/agent-review-derived-inventory.test.ts');
    }

    expect(excludedToolingTests(['server/adapters/postgres/migrationRunner.ts'])).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');
    expect(excludedToolingTests(['src/domains/commerce/offerAvailability.ts'])).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');
    expect(excludedToolingTests(['tests/postgres/managed-compat/supabase.sql'])).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');
    expect(excludedToolingTests(['config/ci-postgres-packages.json'])).not.toContain('tests/postgres/reviewedBatchForwards.test.ts');
  });
  it('excludes pure PostgreSQL suites on src/mcp/unrelated-doc edits and retains them on backend/migration/starter/doc triggers', () => {
    const purePgSuites = [
      'tests/postgres/catalogPublication.test.ts',
      'tests/postgres/connectedStoreCatalogRevisions.test.ts',
      'tests/postgres/connectedStorePromotionClaims.test.ts',
      'tests/postgres/connectedStoreStarterRelations.test.ts',
      'tests/postgres/customerAccountConsents.test.ts',
      'tests/postgres/customerAccountMutations.test.ts',
      'tests/postgres/customerBillingProfiles.test.ts',
      'tests/postgres/customerCheckoutLinks.test.ts',
      'tests/postgres/customerNewsletterWithdrawal.test.ts',
      'tests/postgres/customerSavedAddresses.test.ts',
      'tests/postgres/fulfillmentOperatorJourneys.test.ts',
      'tests/postgres/fulfillmentProviderIntake.test.ts',
      'tests/postgres/m14QualifiedAdminComposition.test.ts',
      'tests/postgres/m14QualifiedComposition.test.ts',
      'tests/postgres/m14RestrictedConnectedRestore.test.ts',
      'tests/postgres/subscriptionNoticeProducers.test.ts',
      'tests/postgres/subscriptionRetainedRenewal.test.ts',
    ];
    const starterPgSuites = [
      'tests/postgres/neutralStarterE4.test.ts',
      'tests/postgres/neutralStoreQuote.test.ts',
      'tests/postgres/neutralStoreRecovery.test.ts',
      'tests/postgres/neutralStoreUuid.test.ts',
    ];
    for (const unrelated of ['src/pages/Home.tsx', 'mcp/server.ts', 'docs/platform/README.md']) {
      const excluded = excludedToolingTests([unrelated]);
      for (const suite of [...purePgSuites, ...starterPgSuites]) expect(excluded).toContain(suite);
      expect(excluded).not.toContain('tests/postgres/connectedStoreTransfer.test.ts');
      expect(excluded).not.toContain('tests/postgres/subscriptionPublicRenewal.test.ts');
      expect(excluded).not.toContain('tests/postgres/policyCloseDigest.test.ts');
    }
    for (const trigger of [
      'db/platform/migrations/20261124000000_example.sql',
      'config/ci-images.json',
      'config/platform-migration-manifest.json',
      'config/reviewed-platform-forwards.json',
      'packages/platform/src/index.ts',
      'server/adapters/postgres/connectedStoreRestore.ts',
      'tests/helpers/pgTemplateBroker.ts',
      'tests/postgres/storeJourney.ts',
    ]) {
      const excluded = excludedToolingTests([trigger]);
      for (const suite of [...purePgSuites, ...starterPgSuites]) expect(excluded).not.toContain(suite);
    }
    const starterTrigger = excludedToolingTests(['examples/neutral-store/host/server.ts']);
    for (const suite of starterPgSuites) expect(starterTrigger).not.toContain(suite);
    for (const suite of purePgSuites) expect(starterTrigger).toContain(suite);

    const dataDocTrigger = excludedToolingTests(['docs/platform/DATA_AND_MIGRATIONS.md']);
    expect(dataDocTrigger).not.toContain('tests/postgres/customerNewsletterWithdrawal.test.ts');
    expect(dataDocTrigger).not.toContain('tests/postgres/customerAccountConsents.test.ts');
    expect(dataDocTrigger).toContain('tests/postgres/catalogPublication.test.ts');
  });
  it.each(Object.entries(TOOLING_INPUTS).flatMap(([test, inputs]) => inputs.map(input => [test, input] as const)))(
    'runs %s when its declared input %s changes', (test, input) => {
      expect(excludedToolingTests([input.endsWith('/') ? `${input}scope-witness.ts` : input])).not.toContain(test);
    },
  );
  it.each(['push', 'workflow_dispatch', 'unknown', undefined])('runs everything for event %s', eventName => {
    expect(scopeFromEvent({ eventName, event: { pull_request: { base: { sha: base } } }, git: () => { throw new Error('must not run'); } })).toEqual([]);
  });
  it('runs everything for git failure, missing or malformed base and malformed output', () => {
    const event = { pull_request: { base: { sha: base } } };
    expect(scopeFromEvent({ eventName: 'pull_request', event, git: () => { throw new Error('missing history'); } })).toEqual([]);
    for (const value of [undefined, '', '--help', 'main']) {
      expect(scopeFromEvent({ eventName: 'pull_request', event: { pull_request: { base: { sha: value } } } })).toEqual([]);
    }
    expect(scopeFromEvent({ eventName: 'pull_request', event, git: () => 'invalid' })).toEqual([]);
    expect(scopeFromEvent({ eventName: 'pull_request', event, git: args => args[0] === 'merge-base' ? base : 'src/a.ts' })).toEqual([]);
  });
  it('uses the event merge-base, includes deletions and both rename paths, and produces identical shard input', () => {
    const cwd = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q'); writeFileSync(join(cwd, 'source.ts'), 'before'); git('add', '.'); git('commit', '-qm', 'base');
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'source.ts'), 'base moves ahead'); git('add', '.'); git('commit', '-qm', 'base ahead');
    const ahead = git('rev-parse', 'HEAD'); git('checkout', '-q', '--detach', before);
    // Product-only candidate. Base-only root changes must not trigger everything.
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/product.ts'), 'product'); git('add', '.'); git('commit', '-qm', 'product');
    const pr = { eventName: 'pull_request', event: { pull_request: { base: { sha: ahead } } }, cwd };
    const selected = scopeFromEvent(pr);
    expect(selected).toEqual(excludedToolingTests(['src/product.ts']));
    expect(selected.length).toBeGreaterThan(0);
    for (let shard = 1; shard <= 8; shard++) expect(scopeFromEvent(pr)).toEqual(selected);
    expect(scopeFromEvent({ eventName: 'merge_group', event: { merge_group: { base_sha: ahead } }, cwd })).toEqual(selected);
    git('mv', 'source.ts', 'src/moved.ts'); git('commit', '-qm', 'rename root trigger');
    expect(scopeFromEvent(pr)).toEqual([]);
    git('reset', '--hard', 'HEAD~1'); git('rm', 'source.ts'); git('commit', '-qm', 'delete root trigger');
    expect(scopeFromEvent(pr)).toEqual([]);
  });
  it('clears stale exclusions on unreadable or unknown events and actual git failure', () => {
    const cwd = scratch(), output = join(cwd, 'exclude.txt'), eventPath = join(cwd, 'event.json');
    for (const eventName of ['pull_request', 'workflow_dispatch']) {
      writeFileSync(output, 'stale.test.ts\n');
      writeTestScope({ output, eventName, eventPath, cwd }); expect(readFileSync(output, 'utf8')).toBe('');
      writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
      writeFileSync(output, 'stale.test.ts\n');
      writeTestScope({ output, eventName, eventPath, cwd }); expect(readFileSync(output, 'utf8')).toBe('');
      rmSync(eventPath);
    }
  });
});

describe('local scope', () => {
  function fixture() {
    const cwd = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    for (const directory of ['docs', 'src', 'packages/core']) mkdirSync(join(cwd, directory), { recursive: true });
    writeFileSync(join(cwd, 'docs/guide.md'), 'base');
    writeFileSync(join(cwd, 'packages/core/input.ts'), 'base');
    git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return { cwd, git };
  }
  it('defaults to origin/main, includes committed changes from the merge-base, and writes the exclusion file', () => {
    const { cwd, git } = fixture(), output = join(scratch(), 'exclude.txt');
    expect(scopeFromLocal({ cwd })).toEqual(all);
    writeFileSync(join(cwd, 'src/product.ts'), 'product'); git('add', '.'); git('commit', '-qm', 'product');
    expect(scopeFromLocal({ cwd })).toEqual(excludedToolingTests(['src/product.ts']));
    expect(writeTestScope({ cwd, output })).toEqual(excludedToolingTests(['src/product.ts']));
    expect(readFileSync(output, 'utf8')).toBe(`${excludedToolingTests(['src/product.ts']).join('\n')}\n`);
    // Explicit --base selects local mode even in a GitHub environment.
    expect(writeTestScope({ cwd, output, base: 'HEAD', eventName: 'push' })).toEqual(all);
  });
  it('includes unstaged, staged, cancelled working-file edits, deletion and rename paths', () => {
    const { cwd, git } = fixture();
    writeFileSync(join(cwd, 'packages/core/input.ts'), 'dirty');
    const expected = excludedToolingTests(['packages/core/input.ts']);
    expect(scopeFromLocal({ cwd })).toEqual(expected);
    git('add', '.'); expect(scopeFromLocal({ cwd })).toEqual(expected);
    writeFileSync(join(cwd, 'packages/core/input.ts'), 'base');
    expect(scopeFromLocal({ cwd })).toEqual(expected);
    git('reset', '--hard', 'HEAD'); git('mv', 'packages/core/input.ts', 'docs/moved.md');
    expect(scopeFromLocal({ cwd })).toEqual(expected);
    git('reset', '--hard', 'HEAD'); rmSync(join(cwd, 'packages/core/input.ts'));
    expect(scopeFromLocal({ cwd })).toEqual(expected);
  });
  it('includes untracked inputs and refuses to scope on every Git error or malformed output', () => {
    const { cwd } = fixture();
    writeFileSync(join(cwd, 'packages/core/new.ts'), 'untracked');
    expect(scopeFromLocal({ cwd })).toEqual(excludedToolingTests(['packages/core/new.ts']));
    expect(scopeFromLocal({ cwd, base: 'missing-ref' })).toEqual([]);
    for (let fail = 0; fail < 5; fail++) {
      let call = 0;
      expect(scopeFromLocal({ git: () => { if (call++ === fail) throw new Error('git failed'); return call === 1 ? base : ''; } })).toEqual([]);
    }
    expect(scopeFromLocal({ git: () => 'malformed' })).toEqual([]);
    expect(scopeFromLocal({ git: args => args[0] === 'merge-base' ? base : 'src/missing-nul.ts' })).toEqual([]);
    const output = join(scratch(), 'exclude.txt'); writeFileSync(output, 'stale.test.ts');
    expect(writeTestScope({ cwd, output, base: 'missing-ref' })).toEqual([]);
    expect(readFileSync(output, 'utf8')).toBe('');
  });
  it('accepts --base through the CLI and uses local defaults without GitHub event env', () => {
    const { cwd } = fixture(), output = join(scratch(), 'exclude.txt');
    const env = { ...processEnvironment, OPENLUP_VITEST_EXCLUDE_FILE: output };
    delete env.GITHUB_EVENT_NAME; delete env.GITHUB_EVENT_PATH;
    const script = join(process.cwd(), 'scripts/ci-test-scope.mjs');
    for (const args of [[], ['--base', 'HEAD']]) {
      execFileSync(process.execPath, [script, ...args], { cwd, env });
      expect(readFileSync(output, 'utf8')).toBe(`${all.join('\n')}\n`);
    }
  });
});

describe('git executable resolution', () => {
  it('prefers the fixed /usr/bin/git binary with a locked PATH when executable', () => {
    const dir = scratch(), preferred = join(dir, 'git');
    writeFileSync(preferred, '#!/bin/sh\n');
    chmodSync(preferred, 0o755);
    expect(resolveGitExecutable({ preferred, pathValue: '/opt/homebrew/bin:/usr/local/bin' }))
      .toEqual({ binary: preferred, path: '/usr/bin:/bin' });
  });

  it('falls back to an executable git file from PATH when /usr/bin/git is unavailable', () => {
    const dir = scratch();
    const dirWithSubdir = join(dir, 'dir-entry'), nonExecDir = join(dir, 'non-exec'), validDir = join(dir, 'valid');
    mkdirSync(join(dirWithSubdir, 'git'), { recursive: true });
    mkdirSync(nonExecDir, { recursive: true });
    writeFileSync(join(nonExecDir, 'git'), '#!/bin/sh\n');
    chmodSync(join(nonExecDir, 'git'), 0o644);
    mkdirSync(validDir, { recursive: true });
    writeFileSync(join(validDir, 'git'), '#!/bin/sh\n');
    chmodSync(join(validDir, 'git'), 0o755);
    const pathValue = [dirWithSubdir, nonExecDir, validDir].join(delimiter);
    expect(resolveGitExecutable({ preferred: join(dir, 'missing-git'), pathValue }))
      .toEqual({ binary: join(validDir, 'git'), path: pathValue });
  });

  it('falls back to bare git when neither preferred nor PATH contains an executable git', () => {
    const empty = scratch();
    expect(resolveGitExecutable({ preferred: join(empty, 'missing-git'), pathValue: empty }))
      .toEqual({ binary: 'git', path: empty });
  });
});
