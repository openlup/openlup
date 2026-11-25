import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { env as processEnvironment } from 'node:process';
import { delimiter, extname, join, posix, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_WORKFLOW_SCOPES_TRUE, excludedToolingTests, governedDraftSuiteInputs, isGlobalBailoutScript, NON_BAILOUT_SCRIPTS, resolveGitExecutable, ROOT_DOC_FILES, scopeFromEvent, scopeFromLocal, SHARED_INPUTS, TOOLING_INPUTS, workflowScopeFromEvent, workflowScopeFromPaths, writeTestScope, writeWorkflowScope } from './ci-test-scope.mjs';

const base = 'a'.repeat(40);
const all = Object.keys(TOOLING_INPUTS).sort();
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(tmpdir(), 'ci-test-scope-')); directories.push(path); return path; }

describe('conservative tooling scope', () => {
  it('excludes only declared fixtures on a product change, retaining tree scanners, src-axis PG suites, and lint inputs', () => {
    const excluded = excludedToolingTests(['src/pages/account/example.tsx']);
    expect(excluded).toEqual(Object.entries(TOOLING_INPUTS)
      .filter(([, inputs]) => !inputs.includes('src/'))
      .map(([test]) => test).sort());
    expect(excluded).not.toContain('scripts/packages/eslint-import-map.test.ts');
    for (const file of ['agent-review-session', 'source-preview-release', 'public-ci-neutrality', 'oss-published-tree-check']) {
      expect(excluded).not.toContain(`scripts/${file}.test.ts`);
    }
    const serverExcluded = excludedToolingTests(['server/runtime/outbox/candidateAdmission.ts']);
    expect(serverExcluded).not.toContain('scripts/packages/outbox-consumer-proof.test.ts');
    expect(serverExcluded).not.toContain('scripts/packages/eslint-import-map.test.ts');
    expect(serverExcluded).toEqual(Object.entries(TOOLING_INPUTS)
      .filter(([, inputs]) => !inputs.some(input => input === 'server/' || input === 'server/runtime/outbox/'))
      .map(([test]) => test).sort());
    expect(excludedToolingTests(['packages/core/src/index.ts']))
      .toEqual(Object.entries(TOOLING_INPUTS)
        .filter(([, inputs]) => !inputs.includes('packages/') && !inputs.includes('packages/core/src/'))
        .map(([test]) => test).sort());
  });
  it.each(['package.json', 'package-lock.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.app.json',
    'LICENSE', 'UNKNOWN.md', 'scripts/run-vitest.mjs', 'scripts/ci-vitest-shard.mjs',
    'scripts/ci-test-scope.mjs', 'scripts/disposable-docker.mjs', 'scripts/build-packages-incremental.mjs',
    'scripts/fixtures/example.json', 'scripts/brand-new-unknown.mjs', 'scripts/ast-grep/.hidden',
    '.github/workflows/any.yml',
    '.github/actions/example/action.yml',
    'eslint.config.js', '.nvmrc', 'scripts/packages/new-helper.ts', 'tests/setup/scrub-git-env.ts',
    'src/test/setup.ts', 'src/checkout/machine/commerceRequestCache.ts',
    // Dot segments anywhere and hidden root folders: glob '*'/'**' would skip them.
    '.husky/pre-commit', 'scripts/.x', 'tests/setup/.env', 'src/test/.x', 'packages/core/.gitignore',
    'packages/platform/src/.npmignore', 'packages/core/.github/workflows/ci.yml'])(
    'runs everything for shared input %s', path => { expect(excludedToolingTests([path])).toEqual([]); },
  );
  it('avoids global bailout for script tests (Tier A) and allowlisted NON_BAILOUT_SCRIPTS (Tier B) while retaining self and owning tests', () => {
    // Tier A: unlisted script test excludes all bounded tooling and PG suites.
    const unlistedScriptTest = excludedToolingTests(['scripts/ci-test-scope.test.ts']);
    expect(unlistedScriptTest).toEqual(all);
    expect(unlistedScriptTest).not.toContain('scripts/ci-test-scope.test.ts');

    // Tier A: listed empty-input script test retains itself via self-retention!
    const emptyInputListed = excludedToolingTests(['scripts/pgtap-parity.test.ts']);
    expect(emptyInputListed).not.toContain('scripts/pgtap-parity.test.ts');
    expect(emptyInputListed).toEqual(all.filter(test => test !== 'scripts/pgtap-parity.test.ts'));

    // Tier A: listed script test with inputs retains itself and excludes unrelated PG suites.
    const listedScriptTest = excludedToolingTests(['scripts/public-ci-reuse.test.ts']);
    expect(listedScriptTest).not.toContain('scripts/public-ci-reuse.test.ts');
    expect(listedScriptTest).toContain('tests/postgres/catalogPublication.test.ts');

    // Tier B: allowlisted leaf/guard scripts retain their owning TOOLING_INPUTS tests and skip unrelated PG suites.
    const reuseScript = excludedToolingTests(['scripts/public-ci-reuse.mjs']);
    expect(reuseScript).not.toContain('scripts/public-ci-reuse.test.ts');
    expect(reuseScript).toContain('tests/postgres/catalogPublication.test.ts');

    const queueScript = excludedToolingTests(['scripts/agent-review-queue.mjs']);
    expect(queueScript).not.toContain('scripts/agent-review-queue.test.ts');
    expect(queueScript).not.toContain('scripts/agent-review-gate.test.ts');
    expect(queueScript).toContain('tests/postgres/catalogPublication.test.ts');

    const astGrepRule = excludedToolingTests(['scripts/ast-grep/rules/domain-no-environment-reads.yml']);
    expect(astGrepRule).not.toContain('scripts/ast-grep/check-filewide-ignore.test.ts');
    expect(astGrepRule).not.toContain('scripts/ast-grep/rule-tests/portable-no-industry-contracts.test.ts');
    expect(astGrepRule).toContain('tests/postgres/catalogPublication.test.ts');

    const affectedScript = excludedToolingTests(['scripts/affected-tests.mjs']);
    expect(affectedScript).toEqual(all);
    expect(affectedScript).not.toContain('scripts/affected-tests.test.ts');
  });
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
      .toEqual(Object.entries(TOOLING_INPUTS)
        .filter(([, inputs]) => !inputs.includes('examples/neutral-store/') && !inputs.includes('examples/'))
        .map(([test]) => test).sort());
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
  const ownerWriteSuite = 'tests/postgres/catalogAdmissionOwnerWrite.test.ts';
  const runtimeCommitSuite = 'tests/postgres/catalogAdmissionRuntimeCommit.test.ts';
  const unrelatedChange = ['docs/platform/README.md'];
  const ownerWriteFixture = 'tests/postgres/catalogAdmissionOwnerWrite.fixture.ts';
  const publicationFixture = 'tests/postgres/catalogPublicationFixture.ts';

  it.each([
    { present: [ownerWriteSuite] },
    { present: [runtimeCommitSuite] },
    { present: [ownerWriteSuite, runtimeCommitSuite] },
    { present: [] },
  ])('registers exactly the governed draft suites present: $present', ({ present }) => {
    const inputs = governedDraftSuiteInputs(testPath => present.includes(testPath));
    expect(Object.keys(inputs).sort()).toEqual([...present].sort());
    expect(excludedToolingTests(unrelatedChange, inputs)).toEqual([...present].sort());
    for (const input of [
      ownerWriteFixture,
      publicationFixture,
      'tests/postgres/subscriptionLifecycleClosureFixture.ts',
      'tests/postgres/subscriptionNativeFixture.ts',
      'examples/neutral-store/host/server.ts',
    ]) {
      expect(excludedToolingTests([input], inputs), input).toEqual([]);
    }
  });

  it.each(['EACCES', 'ELOOP'])('keeps the unlisted-test default (always runs) when a suite probe throws %s', code => {
    const inputs = governedDraftSuiteInputs(testPath => {
      if (testPath === ownerWriteSuite) throw Object.assign(new Error('suite probe failed'), { code });
      return testPath === runtimeCommitSuite;
    });
    expect(Object.keys(inputs)).toEqual([runtimeCommitSuite]);
    expect(excludedToolingTests(unrelatedChange, inputs)).toEqual([runtimeCommitSuite]);
  });

  it.each([ownerWriteFixture, publicationFixture])('retains restricted restore when only %s changes', fixture => {
    const restoreSuite = 'tests/postgres/m14RestrictedConnectedRestore.test.ts';
    expect(excludedToolingTests(unrelatedChange)).toContain(restoreSuite);
    expect(excludedToolingTests([fixture])).not.toContain(restoreSuite);
  });
  it('scopes all tests/postgres suites per-file and per-axis without broad tests/postgres/ prefixes', () => {
    const purePgSuites = [
      'tests/postgres/catalogPublication.test.ts',
      'tests/postgres/connectedStoreCatalogRevisions.test.ts',
      'tests/postgres/connectedStorePromotionClaims.test.ts',
      'tests/postgres/connectedStoreStarterRelations.test.ts',
      'tests/postgres/customerAccountConsents.test.ts',
      'tests/postgres/customerBillingProfiles.test.ts',
      'tests/postgres/customerNewsletterWithdrawal.test.ts',
      'tests/postgres/m14QualifiedAdminComposition.test.ts',
      'tests/postgres/m14RestrictedConnectedRestore.test.ts',
      'tests/postgres/m14RestrictedConnectedRestoreMatrix.test.ts',
      'tests/postgres/subscriptionNoticeProducers.test.ts',
      'tests/postgres/subscriptionRetainedRenewal.test.ts',
    ];
    const starterPgSuites = [
      'tests/postgres/customerCheckoutLinks.test.ts',
      'tests/postgres/fulfillmentOperatorJourneys.test.ts',
      'tests/postgres/fulfillmentProviderIntake.test.ts',
      'tests/postgres/neutralStarterE4.test.ts',
      'tests/postgres/neutralStoreQuote.test.ts',
      'tests/postgres/neutralStoreRecovery.test.ts',
      'tests/postgres/neutralStoreUuid.test.ts',
    ];
    const srcPgSuites = [
      'tests/postgres/accountSupportComposition.test.ts',
      'tests/postgres/acquisitionAdmission.test.ts',
      'tests/postgres/connectedStoreTransfer.test.ts',
      'tests/postgres/customerAccountMutations.test.ts',
      'tests/postgres/customerSavedAddresses.test.ts',
      'tests/postgres/subscriptionPublicRenewal.test.ts',
    ];
    const scopedPgSuites = all.filter(test => test.startsWith('tests/postgres/'));
    expect(scopedPgSuites.length).toBeGreaterThanOrEqual(261);

    // Unrelated docs exclude every scoped PostgreSQL suite.
    const docsExcluded = excludedToolingTests(['docs/platform/README.md']);
    for (const suite of scopedPgSuites) expect(docsExcluded).toContain(suite);

    // Frontend src/ excludes pure-server and starter suites while retaining src-axis suites.
    const srcExcluded = excludedToolingTests(['src/pages/Home.tsx']);
    for (const suite of [...purePgSuites, ...starterPgSuites]) expect(srcExcluded).toContain(suite);
    for (const suite of srcPgSuites) expect(srcExcluded).not.toContain(suite);

    // API-only edits retain api-axis suites and exclude pure/starter PG suites.
    const apiExcluded = excludedToolingTests(['api/bff/example.ts']);
    for (const suite of ['tests/postgres/acquisitionAdmission.test.ts', 'tests/postgres/communicationsNative.test.ts', 'tests/postgres/invoicingContinuity.test.ts']) {
      expect(apiExcluded).not.toContain(suite);
    }
    for (const suite of [...purePgSuites, ...starterPgSuites]) expect(apiExcluded).toContain(suite);

    // MCP-only edits retain acquisitionAdmission (which scans mcp/) and exclude pure/starter PG suites.
    const mcpExcluded = excludedToolingTests(['mcp/server.ts']);
    expect(mcpExcluded).not.toContain('tests/postgres/acquisitionAdmission.test.ts');
    for (const suite of [...purePgSuites, ...starterPgSuites]) expect(mcpExcluded).toContain(suite);

    // Editing a single PG test file retains ONLY that test and excludes other PG suites.
    const singlePgEdit = excludedToolingTests(['tests/postgres/catalogPublication.test.ts']);
    expect(singlePgEdit).not.toContain('tests/postgres/catalogPublication.test.ts');
    expect(singlePgEdit).toContain('tests/postgres/customerBillingProfiles.test.ts');
    expect(singlePgEdit).toContain('tests/postgres/neutralStoreQuote.test.ts');

    // Editing a shared PG helper retains only suites that depend on that helper.
    const helperEdit = excludedToolingTests(['tests/postgres/catalogPublicationFixture.ts']);
    expect(helperEdit).not.toContain('tests/postgres/catalogPublication.test.ts');
    expect(helperEdit).toContain('tests/postgres/customerBillingProfiles.test.ts');

    // Backend/migration/package/helper triggers retain all base PG suites.
    for (const trigger of [
      'db/platform/migrations/20261124000000_example.sql',
      'config/ci-images.json',
      'config/platform-migration-manifest.json',
      'config/reviewed-platform-forwards.json',
      'packages/platform/src/index.ts',
      'server/adapters/postgres/connectedStoreRestore.ts',
      'tests/helpers/pgTemplateBroker.ts',
    ]) {
      const excluded = excludedToolingTests([trigger]);
      for (const suite of [...purePgSuites, ...starterPgSuites]) expect(excluded, trigger).not.toContain(suite);
    }

    const starterTrigger = excludedToolingTests(['examples/neutral-store/host/server.ts']);
    for (const suite of starterPgSuites) expect(starterTrigger).not.toContain(suite);
    for (const suite of purePgSuites) expect(starterTrigger).toContain(suite);

    const dataDocTrigger = excludedToolingTests(['docs/platform/DATA_AND_MIGRATIONS.md']);
    for (const suite of [
      'tests/postgres/customerAccountConsents.test.ts',
      'tests/postgres/customerNewsletterWithdrawal.test.ts',
      'tests/postgres/m19NoticeIsolation.test.ts',
      'tests/postgres/m19PaymentCancellation.test.ts',
    ]) {
      expect(dataDocTrigger).not.toContain(suite);
    }
    expect(dataDocTrigger).toContain('tests/postgres/catalogPublication.test.ts');
  });
  it('runs every declared test when any of its declared inputs changes', () => {
    for (const [test, inputs] of Object.entries(TOOLING_INPUTS)) {
      for (const input of inputs) {
        expect(excludedToolingTests([input.endsWith('/') ? `${input}scope-witness.ts` : input]), `${test} <- ${input}`).not.toContain(test);
      }
    }
  });
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

describe('PostgreSQL AST closure soundness', () => {
  const BARE_ROOT_DIRS = new Set(['src', 'api', 'mcp', 'examples', 'supabase', 'docs']);
  const KNOWN_PREFIXES = ['src/', 'api/', 'mcp/', 'examples/', 'supabase/', 'docs/', 'config/', 'tests/', 'db/', 'packages/', 'server/', 'scripts/'];
  const VITEST_MOCK_METHODS = new Set(['mock', 'doMock', 'importActual', 'importMock']);
  const covers = (input: string, target: string) => (input.endsWith('/') ? target === input || target.startsWith(input) : target === input);

  function createAstClosureScanner(rootDir: string) {
    const pkgExports = new Map<string, { dir: string; exports: Record<string, unknown> }>();
    const pkgImports = new Map<string, Record<string, unknown>>();
    const rootPkgPath = resolve(rootDir, 'package.json');
    if (existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as { imports?: Record<string, unknown> };
      if (rootPkg.imports) pkgImports.set('', rootPkg.imports);
    }
    const packagesDir = resolve(rootDir, 'packages');
    if (existsSync(packagesDir)) {
      for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = resolve(packagesDir, entry.name, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: string; exports?: Record<string, unknown>; imports?: Record<string, unknown>;
        };
        if (manifest.name) pkgExports.set(manifest.name, { dir: `packages/${entry.name}`, exports: manifest.exports ?? {} });
        if (manifest.imports) pkgImports.set(`packages/${entry.name}`, manifest.imports);
      }
    }

    const fileCache = new Map<string, boolean>();
    const dirCache = new Map<string, boolean>();
    const isFile = (rel: string): boolean => {
      const cached = fileCache.get(rel);
      if (cached !== undefined) return cached;
      let ok = false;
      try { ok = statSync(resolve(rootDir, rel)).isFile(); } catch { ok = false; }
      fileCache.set(rel, ok);
      return ok;
    };
    const isDir = (rel: string): boolean => {
      const cached = dirCache.get(rel);
      if (cached !== undefined) return cached;
      let ok = false;
      try { ok = statSync(resolve(rootDir, rel)).isDirectory(); } catch { ok = false; }
      dirCache.set(rel, ok);
      return ok;
    };

    const resolveCandidate = (candidate: string): string | null => {
      const normalized = posix.normalize(candidate);
      if (!normalized || normalized.startsWith('..') || normalized.startsWith('/')) return null;
      const ext = extname(normalized);
      const tries: string[] = [];
      if (ext === '.js') { const s = normalized.slice(0, -3); tries.push(normalized, `${s}.ts`, `${s}.tsx`, `${s}.mts`, `${s}.mjs`); }
      else if (ext === '.jsx') { const s = normalized.slice(0, -4); tries.push(normalized, `${s}.tsx`, `${s}.ts`, `${s}.js`); }
      else if (ext === '.mjs') { const s = normalized.slice(0, -4); tries.push(normalized, `${s}.mts`, `${s}.ts`); }
      else if (ext === '.cjs') { const s = normalized.slice(0, -4); tries.push(normalized, `${s}.cts`, `${s}.ts`); }
      else if (ext) { tries.push(normalized); }
      else { tries.push(`${normalized}.ts`, `${normalized}.tsx`, `${normalized}.js`, `${normalized}.mjs`, `${normalized}.cjs`, `${normalized}/index.ts`, `${normalized}/index.tsx`, `${normalized}/index.js`, `${normalized}/index.mjs`); }
      return tries.find(isFile) ?? null;
    };

    const pickTarget = (value: unknown): string | null => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) { for (const item of value) { const picked = pickTarget(item); if (picked) return picked; } return null; }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of ['core-source', 'import', 'default', 'module', 'node', 'types']) {
          if (key in record) { const picked = pickTarget(record[key]); if (picked) return picked; }
        }
        for (const nested of Object.values(record)) { const picked = pickTarget(nested); if (picked) return picked; }
      }
      return null;
    };

    const resolveSpecifier = (spec: string, fromFile: string): string | null => {
      if (!spec || spec.startsWith('node:')) return null;
      if (spec.startsWith('./') || spec.startsWith('../')) return resolveCandidate(posix.join(posix.dirname(fromFile), spec));
      if (spec.startsWith('@/')) return resolveCandidate(`src/${spec.slice(2)}`);
      if (spec.startsWith('#')) {
        const pkgMatch = /^(packages\/[^/]+)\//u.exec(fromFile);
        const dirs = pkgMatch ? [pkgMatch[1], ''] : [''];
        for (const dir of dirs) {
          const map = pkgImports.get(dir);
          if (!map) continue;
          let target = pickTarget(map[spec]);
          if (!target) {
            for (const [pattern, importValue] of Object.entries(map)) {
              if (!pattern.includes('*')) continue;
              const [prefix, suffix] = pattern.split('*');
              if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
                const raw = pickTarget(importValue);
                if (raw) { target = raw.replaceAll('*', () => spec.slice(prefix.length, spec.length - suffix.length)); break; }
              }
            }
          }
          if (target) {
            const clean = target.replace(/^\.\//u, '');
            const srcTarget = clean.startsWith('dist/') ? `src/${clean.slice(5)}` : clean;
            const resolved = resolveCandidate(dir ? posix.join(dir, srcTarget) : srcTarget)
              ?? resolveCandidate(dir ? posix.join(dir, clean) : clean);
            if (resolved) return resolved;
          }
        }
        return null;
      }
      if (spec.startsWith('@openlup/')) {
        for (const [name, info] of pkgExports.entries()) {
          if (spec !== name && !spec.startsWith(`${name}/`)) continue;
          const subpath = spec === name ? '.' : `./${spec.slice(name.length + 1)}`;
          let target = pickTarget(info.exports[subpath]);
          if (!target) {
            for (const [pattern, exportValue] of Object.entries(info.exports)) {
              if (!pattern.includes('*')) continue;
              const [prefix, suffix] = pattern.split('*');
              if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
                const raw = pickTarget(exportValue);
                if (raw) { target = raw.replaceAll('*', () => subpath.slice(prefix.length, subpath.length - suffix.length)); break; }
              }
            }
          }
          if (target) {
            const clean = target.replace(/^\.\//u, '');
            const srcTarget = clean.startsWith('dist/') ? `src/${clean.slice(5)}` : clean;
            return resolveCandidate(posix.join(info.dir, srcTarget)) ?? resolveCandidate(posix.join(info.dir, clean));
          }
        }
      }
      return null;
    };

    const parseCache = new Map<string, { imports: string[]; pathLiterals: string[] }>();
    const analyzeFile = (rel: string) => {
      const cached = parseCache.get(rel);
      if (cached) return cached;
      const source = readFileSync(resolve(rootDir, rel), 'utf8');
      const sourceFile = ts.createSourceFile(
        rel,
        source,
        ts.ScriptTarget.Latest,
        false,
        rel.endsWith('.tsx') || rel.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const imports = new Set<string>();
      const pathLiterals = new Set<string>();
      const checkBareDirs = rel.startsWith('tests/postgres/') || rel.startsWith('tests/helpers/');

      const addRepoPath = (raw: string, allowDirPrefix = false) => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.includes('\n') || trimmed.length > 200) return;
        if (checkBareDirs && BARE_ROOT_DIRS.has(trimmed)) {
          pathLiterals.add(`${trimmed}/`);
          return;
        }
        if (/^(?:\.\.?\/)+/u.test(trimmed) && !/^(?:\.\.?\/)*\.\.?$/u.test(trimmed)) {
          const selfDir = posix.dirname(rel);
          const joined = posix.normalize(posix.join(selfDir, trimmed));
          if (!joined.startsWith('..') && !joined.startsWith('/') && joined !== '.' && joined !== 'tests' && joined !== selfDir) {
            const stripped = joined.replace(/\/$/u, '');
            if (isFile(stripped)) pathLiterals.add(stripped);
            else if (stripped !== selfDir && isDir(stripped)) pathLiterals.add(`${stripped}/`);
            else if (allowDirPrefix) {
              const dirPart = posix.dirname(joined);
              if (!dirPart.startsWith('..') && dirPart !== '.' && dirPart !== 'tests' && dirPart !== selfDir && isDir(dirPart)) pathLiterals.add(`${dirPart}/`);
            }
          }
        }
        const clean = trimmed.replace(/^\.\//u, '');
        if (KNOWN_PREFIXES.some(prefix => clean.startsWith(prefix))) {
          const stripped = clean.replace(/\/$/u, '');
          if (isFile(stripped)) pathLiterals.add(stripped);
          else if (isDir(stripped)) pathLiterals.add(`${stripped}/`);
          else if (allowDirPrefix) {
            const dirPart = posix.dirname(clean);
            if (KNOWN_PREFIXES.some(prefix => `${dirPart}/`.startsWith(prefix)) && isDir(dirPart)) pathLiterals.add(`${dirPart}/`);
          }
        }
      };

      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
        else if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
            imports.add(node.arguments[0].text);
          } else if (ts.isIdentifier(node.expression) && node.expression.text === 'tsImport' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
            imports.add(node.arguments[0].text);
          } else if (
            ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === 'vi'
            && VITEST_MOCK_METHODS.has(node.expression.name.text)
            && node.arguments[0]
            && ts.isStringLiteralLike(node.arguments[0])
          ) {
            imports.add(node.arguments[0].text);
          }
          const fnName = ts.isIdentifier(node.expression) ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
          if (fnName === 'join' || fnName === 'resolve') {
            const segs: string[] = [];
            for (const arg of node.arguments) {
              if (ts.isStringLiteralLike(arg)) segs.push(arg.text);
              else if (segs.length > 0) break;
            }
            if (segs.length > 0) {
              addRepoPath(posix.normalize(segs.join('/')), true);
              const selfDir = posix.dirname(rel);
              const fromSelf = posix.normalize(posix.join(selfDir, ...segs)).replace(/\/+$/u, '');
              if (fromSelf && !fromSelf.startsWith('..') && !fromSelf.startsWith('/') && fromSelf !== '.' && fromSelf !== 'tests' && fromSelf !== selfDir) {
                if (isFile(fromSelf)) pathLiterals.add(fromSelf);
                else if (isDir(fromSelf)) pathLiterals.add(`${fromSelf}/`);
              }
            }
          }
        }
        if (ts.isStringLiteralLike(node)) addRepoPath(node.text, false);
        else if (ts.isTemplateHead(node)) addRepoPath(node.text, true);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      const resolvedImports = new Set<string>();
      for (const spec of imports) {
        const resolved = resolveSpecifier(spec, rel);
        if (resolved) resolvedImports.add(resolved);
      }
      const entry = { imports: [...resolvedImports], pathLiterals: [...pathLiterals] };
      parseCache.set(rel, entry);
      return entry;
    };

    const collectClosure = (entryTest: string, { stopAtPackages = true, followScripts = false } = {}): string[] => {
      const visited = new Set<string>([entryTest]);
      const queue = [entryTest];
      const deps = new Set<string>([entryTest]);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (!/\.(?:ts|tsx|js|mjs|mts|cjs)$/u.test(cur)) continue;
        const { imports, pathLiterals } = analyzeFile(cur);
        for (const target of imports) {
          deps.add(target);
          if (isFile(target) && !visited.has(target) && /\.(?:ts|tsx|js|mjs|mts|cjs)$/u.test(target)
            && !(stopAtPackages && target.startsWith('packages/'))
            && (followScripts || !target.startsWith('scripts/'))) {
            visited.add(target);
            queue.push(target);
          }
        }
        if (cur.startsWith('packages/')) continue;
        if (cur.startsWith('scripts/') && cur !== entryTest) continue;
        for (const lit of pathLiterals) {
          deps.add(lit);
          const followLit = lit.startsWith('tests/helpers/') || lit.startsWith('tests/postgres/');
          if (followLit && isFile(lit) && !visited.has(lit) && /\.(?:ts|tsx|js|mjs|mts|cjs)$/u.test(lit)) {
            visited.add(lit);
            queue.push(lit);
          }
        }
      }
      return [...deps].sort();
    };

    return { collectClosure };
  }

  it('proves every scoped tests/postgres suite covers its full TypeScript AST import and filesystem closure without broad tests/postgres/ prefixes', () => {
    const rootDir = process.cwd();
    const { collectClosure } = createAstClosureScanner(rootDir);
    const rootDocSet = new Set(ROOT_DOC_FILES);
    const isGlobalBailout = (dep: string) => {
      if (!dep.endsWith('/') && !dep.includes('/') && !rootDocSet.has(dep)) return true;
      if (dep.split('/').some(seg => seg.startsWith('.'))) return true;
      if (isGlobalBailoutScript(dep)) return true;
      return SHARED_INPUTS.some(shared => covers(shared, dep));
    };

    const pgEntries = Object.entries(TOOLING_INPUTS).filter(([test]) => test.startsWith('tests/postgres/'));
    expect(pgEntries.length).toBeGreaterThanOrEqual(261);

    const violations: string[] = [];
    for (const [testPath, declaredInputs] of pgEntries) {
      if (!existsSync(resolve(rootDir, testPath))) {
        violations.push(`${testPath}: listed in TOOLING_INPUTS but missing on disk`);
        continue;
      }
      if (declaredInputs.some(input => input.includes('//'))) {
        violations.push(`${testPath}: contains unnormalized '//' path entry`);
      }
      if (declaredInputs.includes('tests/postgres/')) {
        violations.push(`${testPath}: must not use broad 'tests/postgres/' prefix`);
      }
      if (!declaredInputs.some(input => covers(input, testPath))) {
        violations.push(`${testPath}: does not cover its own file path`);
      }
      const closureDeps = collectClosure(testPath, { stopAtPackages: declaredInputs.includes('packages/') });
      for (const dep of closureDeps) {
        if (dep.includes('//')) {
          violations.push(`${testPath}: AST closure emitted unnormalized '//' path ${dep}`);
        }
        if (isGlobalBailout(dep)) continue;
        if (!declaredInputs.some(input => covers(input, dep))) {
          violations.push(`${testPath}: missing declared input covering ${dep}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('seeded falsifier: detects odd-quote regex doc reads, bare root directory scans, TemplateHead SQL reads, same-dir ./ URL/tsImport/resolve paths, and narrowed package barrel re-exports', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'tests/postgres/sub'), { recursive: true });
    mkdirSync(join(dir, 'docs/platform'), { recursive: true });
    mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    mkdirSync(join(dir, 'packages/demo/src'), { recursive: true });
    writeFileSync(join(dir, 'packages/demo/package.json'), JSON.stringify({
      name: '@openlup/demo',
      exports: { '.': { import: './dist/index.js' } },
    }));
    writeFileSync(join(dir, 'packages/demo/src/index.ts'), 'export { impl } from "./impl.js";\n');
    writeFileSync(join(dir, 'packages/demo/src/impl.ts'), 'export const impl = 1;\n');
    writeFileSync(join(dir, 'docs/platform/DATA_AND_MIGRATIONS.md'), '# doc\n');
    writeFileSync(join(dir, 'tests/postgres/hiddenHelper.ts'), 'export const h = 1;\n');
    writeFileSync(join(dir, 'tests/postgres/sameDirHelper.ts'), 'export const s = 2;\n');
    writeFileSync(join(dir, 'tests/postgres/sameDirFixture.sql'), 'SELECT 1;\n');
    writeFileSync(join(dir, 'tests/postgres/sub/data.sql'), 'SELECT 2;\n');
    writeFileSync(join(dir, 'tests/postgres/falsifier.test.ts'), [
      'import { h } from "./hiddenHelper.js";',
      'import { impl } from "@openlup/demo";',
      'const oddQuote = /lower\\(btrim\\(client\\.email(?:, E\'[^\']*\')?\\)\\)/u;',
      'const doc = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8");',
      'const roots = ["src", "api"];',
      'const sql = readFileSync(`supabase/migrations/${h}.sql`, "utf8");',
      'const fixture = new URL("./sameDirFixture.sql", import.meta.url);',
      'const mod = await tsImport("./sameDirHelper.ts", import.meta.url);',
      'const sub = resolve(__dirname, "sub", "data.sql");',
      'const subDir = resolve(__dirname, "sub/");',
      'const joined = ["a", "b"].join("/");',
    ].join('\n'));
    const { collectClosure } = createAstClosureScanner(dir);
    const deps = collectClosure('tests/postgres/falsifier.test.ts', { stopAtPackages: false });
    expect(deps).toContain('tests/postgres/hiddenHelper.ts');
    expect(deps).toContain('tests/postgres/sameDirHelper.ts');
    expect(deps).toContain('tests/postgres/sameDirFixture.sql');
    expect(deps).toContain('tests/postgres/sub/data.sql');
    expect(deps).toContain('tests/postgres/sub/');
    expect(deps.some(dep => dep.includes('//'))).toBe(false);
    expect(deps).not.toContain('tests/postgres/');
    expect(deps).toContain('packages/demo/src/index.ts');
    expect(deps).toContain('packages/demo/src/impl.ts');
    expect(deps).toContain('docs/platform/DATA_AND_MIGRATIONS.md');
    expect(deps).toContain('src/');
    expect(deps).toContain('api/');
    expect(deps).toContain('supabase/migrations/');
  });

  it('proves every exempted scripts/ path is safe and declared by every TOOLING_INPUTS consumer across full transitive closures', () => {
    const rootDir = process.cwd();
    const { collectClosure } = createAstClosureScanner(rootDir);
    const forbiddenAllowlistPrefixes = [
      'scripts/run-vitest',
      'scripts/ci-vitest-shard',
      'scripts/ci-test-scope',
      'scripts/build-packages-incremental',
      'scripts/disposable-docker',
      'scripts/fixtures/',
      'scripts/packages/',
      'scripts/preflight',
      'scripts/oss-',
    ];
    for (const entry of NON_BAILOUT_SCRIPTS) {
      expect(entry.startsWith('scripts/'), entry).toBe(true);
      expect(entry.includes('//'), entry).toBe(false);
      expect(existsSync(resolve(rootDir, entry.replace(/\/$/u, ''))), entry).toBe(true);
      for (const forbidden of forbiddenAllowlistPrefixes) {
        expect(entry.startsWith(forbidden), `${entry} must not exempt ${forbidden}`).toBe(false);
      }
    }

    const violations: string[] = [];
    for (const [testPath, declaredInputs] of Object.entries(TOOLING_INPUTS)) {
      const effectiveInputs = [testPath, ...declaredInputs];
      const closureDeps = collectClosure(testPath, { stopAtPackages: true, followScripts: true });
      for (const dep of closureDeps) {
        if (!dep.startsWith('scripts/') || isGlobalBailoutScript(dep)) continue;
        if (!effectiveInputs.some(input => covers(input, dep))) {
          violations.push(`${testPath}: transitive dependency on exempted script ${dep} is not covered by TOOLING_INPUTS`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('seeded falsifier: catches transitive dependency from a bailout script to an exempted script', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/public-ci-reuse.mjs'), 'export const reuse = true;\n');
    writeFileSync(join(dir, 'scripts/helper-bailout.mjs'), 'export { reuse } from "./public-ci-reuse.mjs";\n');
    writeFileSync(join(dir, 'scripts/consumer.test.ts'), 'import { reuse } from "./helper-bailout.mjs";\nexport const x = reuse;\n');
    const { collectClosure } = createAstClosureScanner(dir);
    const deps = collectClosure('scripts/consumer.test.ts', { stopAtPackages: true, followScripts: true });
    expect(deps).toContain('scripts/helper-bailout.mjs');
    expect(deps).toContain('scripts/public-ci-reuse.mjs');
    expect(isGlobalBailoutScript('scripts/public-ci-reuse.mjs')).toBe(false);
  });
});

describe('workflow scope gate (--workflow-outputs)', () => {
  const allFalse = {
    run_pgtap: false,
    run_reference_build: false,
    run_package_gates: false,
    run_install_browser: false,
    run_install_pack: false,
  };

  it('skips all gated lanes on unrelated docs, mcp, isolated PG tests, and allowlisted scripts', () => {
    for (const path of [
      'docs/platform/README.md',
      'CONTRIBUTING.md',
      'mcp/server.ts',
      'tests/postgres/catalogPublication.test.ts',
      'scripts/ci-vitest-shard.test.ts',
      'scripts/public-ci-reuse.mjs',
      'scripts/ast-grep/rules/bff-database-through-ports.yml',
    ]) {
      expect(workflowScopeFromPaths([path]), path).toEqual(allFalse);
    }
  });

  it('triggers exact workflow lanes per dependency axis', () => {
    for (const path of [
      'supabase/migrations/20990101000000_example.sql',
      'supabase/tests/example.sql',
      'tests/postgres/managed-compat/supabase.sql',
    ]) {
      expect(workflowScopeFromPaths([path]), path).toEqual({ ...allFalse, run_pgtap: true });
    }
    expect(workflowScopeFromPaths(['config/ci-postgres-packages.json'])).toEqual({
      ...allFalse,
      run_pgtap: true,
      run_reference_build: true,
    });
    expect(workflowScopeFromPaths(['config/ci-images.json'])).toEqual(ALL_WORKFLOW_SCOPES_TRUE);

    for (const path of ['src/pages/Home.tsx', 'api/bff/example.ts', 'public/favicon.ico', 'config/site-routes.json']) {
      expect(workflowScopeFromPaths([path]), path).toEqual({ ...allFalse, run_reference_build: true });
    }

    expect(workflowScopeFromPaths(['server/domains/commerce/example.ts'])).toEqual({
      ...allFalse,
      run_reference_build: true,
      run_package_gates: true,
      run_install_pack: true,
    });
    for (const path of [
      'db/platform/migrations/20990101000000_example.sql',
      'docs/platform/communications-conformance.mjs',
      'AGENTS.md',
    ]) {
      expect(workflowScopeFromPaths([path]), path).toEqual({
        ...allFalse,
        run_package_gates: true,
        run_install_pack: true,
      });
    }
    for (const path of ['config/documentation-guide-allowlist.json', 'config/platform-migration-manifest.json']) {
      expect(workflowScopeFromPaths([path]), path).toEqual({
        ...allFalse,
        run_reference_build: true,
        run_package_gates: true,
        run_install_pack: true,
      });
    }

    expect(workflowScopeFromPaths(['packages/core/src/index.ts'])).toEqual({
      run_pgtap: false,
      run_reference_build: true,
      run_package_gates: true,
      run_install_browser: true,
      run_install_pack: true,
    });
    for (const path of ['examples/neutral-store/host/server.ts', 'tests/helpers/postgresContainer.ts']) {
      expect(workflowScopeFromPaths([path]), path).toEqual({
        run_pgtap: false,
        run_reference_build: false,
        run_package_gates: true,
        run_install_browser: true,
        run_install_pack: true,
      });
    }
    for (const path of ['tests/postgres/m14ReleasedSchemaUpgrade.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgradeChild.ts']) {
      expect(workflowScopeFromPaths([path]), path).toEqual({
        ...allFalse,
        run_install_browser: true,
        run_install_pack: true,
      });
    }
  });

  it('fails closed to ALL_WORKFLOW_SCOPES_TRUE on empty, malformed, root non-doc, dot-segment, shared, and bailout script paths', () => {
    expect(workflowScopeFromPaths([])).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    expect(workflowScopeFromPaths(null as unknown as string[])).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    for (const path of [
      '',
      '/etc/passwd',
      '../escape.ts',
      'src\\windows.ts',
      'package.json',
      'package-lock.json',
      'vite.config.ts',
      'index.html',
      '.github/workflows/published-tree-ci.yml',
      'src/.env',
      'tests/setup/vitest.setup.ts',
      'scripts/public-ci-pgtap.mjs',
      'scripts/starter-browser-ci.mjs',
      'scripts/packages/required-package-gates.ts',
      'scripts/ci-test-scope.mjs',
      'scripts/new-unknown-helper.mjs',
    ]) {
      expect(workflowScopeFromPaths([path]), path).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    }
  });

  it('fails closed on push/unknown events, invalid SHAs, and Git errors while scoping pull_request and merge_group', () => {
    for (const eventName of ['push', 'workflow_dispatch', 'unknown', undefined]) {
      expect(workflowScopeFromEvent({
        eventName,
        event: { pull_request: { base: { sha: base } } },
        git: () => { throw new Error('must not run'); },
      }), String(eventName)).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    }
    expect(workflowScopeFromEvent({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: 'not-a-sha' } } },
    })).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    expect(workflowScopeFromEvent({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: base } } },
      git: () => { throw new Error('missing history'); },
    })).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    expect(workflowScopeFromEvent({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: base } } },
      git: args => args[0] === 'merge-base' ? base : 'M\0docs/platform/README.md',
    })).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    expect(workflowScopeFromEvent({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: base } } },
      git: args => args[0] === 'merge-base' ? base : 'M\0',
    })).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    expect(workflowScopeFromEvent({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: base } } },
      git: args => args[0] === 'merge-base' ? base : 'R100\0docs/a.md\0docs/b.md\0',
    })).toEqual(ALL_WORKFLOW_SCOPES_TRUE);
    expect(workflowScopeFromEvent({
      eventName: 'merge_group',
      event: { merge_group: { base_sha: base } },
      git: args => args[0] === 'merge-base' ? base : 'M\0docs/platform/README.md\0',
    })).toEqual(allFalse);
    expect(workflowScopeFromEvent({
      eventName: 'merge_group',
      event: { merge_group: { base_sha: base } },
      git: args => args[0] === 'merge-base' ? base : 'D\0docs/platform/DATA_AND_MIGRATIONS.md\0',
    })).toEqual({
      ...allFalse,
      run_package_gates: true,
      run_install_pack: true,
    });
    expect(workflowScopeFromPaths(['docs/platform/README.md'], { hasDeletion: true })).toEqual({
      ...allFalse,
      run_package_gates: true,
      run_install_pack: true,
    });
  });

  it('writes GITHUB_OUTPUT lines via --workflow-outputs CLI, runs package gates on file deletions/renames, and fails closed on unreadable event metadata', () => {
    const cwd = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    mkdirSync(join(cwd, 'docs/platform'), { recursive: true });
    writeFileSync(join(cwd, 'docs/platform/README.md'), 'before\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'docs/platform/README.md'), 'after\n');
    git('add', '.'); git('commit', '-qm', 'docs edit');

    const eventPath = join(cwd, 'event.json');
    const outputPath = join(cwd, 'github-output.txt');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: baseSha } } }));
    writeFileSync(outputPath, 'existing=1\n');
    execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/ci-test-scope.mjs'), '--workflow-outputs'], {
      cwd,
      env: { ...processEnvironment, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      encoding: 'utf8',
    });
    expect(readFileSync(outputPath, 'utf8')).toBe([
      'existing=1',
      'run_pgtap=false',
      'run_reference_build=false',
      'run_package_gates=false',
      'run_install_browser=false',
      'run_install_pack=false',
      '',
    ].join('\n'));

    // Renaming or deleting any tracked file triggers run_package_gates and run_install_pack.
    const editHead = git('rev-parse', 'HEAD');
    git('mv', 'docs/platform/README.md', 'docs/platform/MOVED.md');
    git('commit', '-qm', 'rename doc');
    const renameEventPath = join(cwd, 'rename-event.json');
    const renameOutputPath = join(cwd, 'rename-output.txt');
    writeFileSync(renameEventPath, JSON.stringify({ pull_request: { base: { sha: editHead } } }));
    execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/ci-test-scope.mjs'), '--workflow-outputs'], {
      cwd,
      env: { ...processEnvironment, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: renameEventPath, GITHUB_OUTPUT: renameOutputPath },
      encoding: 'utf8',
    });
    expect(readFileSync(renameOutputPath, 'utf8')).toBe([
      'run_pgtap=false',
      'run_reference_build=false',
      'run_package_gates=true',
      'run_install_browser=false',
      'run_install_pack=true',
      '',
    ].join('\n'));

    const fallbackOutput = join(cwd, 'fallback-output.txt');
    writeWorkflowScope({ output: fallbackOutput, eventName: 'pull_request', eventPath: join(cwd, 'missing.json'), cwd });
    expect(readFileSync(fallbackOutput, 'utf8')).toBe([
      'run_pgtap=true',
      'run_reference_build=true',
      'run_package_gates=true',
      'run_install_browser=true',
      'run_install_pack=true',
      '',
    ].join('\n'));

    expect(() => execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/ci-test-scope.mjs'), '--workflow-outputs', 'extra'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })).toThrow();
  });
});
