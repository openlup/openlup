import { execFileSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { pathToFileURL } from 'node:url';

// Inputs are plain prefixes: an entry ending in '/' covers that directory and
// everything below it (dot files included); any other entry is one exact file.
// Glob matching is deliberately avoided: its '*' and '**' skip dot segments.
// Broad shared triggers: every non-doc root file, every dot-prefixed segment
// anywhere (.github, .npmignore, .env...), every non-allowlisted file under
// scripts/ (fail-closed: runners, Docker, builds, fixtures, package scripts,
// migration helpers, preflight, oss-* and unknown scripts all bail out), and
// test setup.
export const SHARED_INPUTS = ['tests/setup/', 'src/test/',
  'src/checkout/machine/commerceRequestCache.ts'];

// Explicit fail-closed allowlist for files under scripts/ that do NOT trigger
// the global bailout:
// - Tier A: scripts/**/*.test.* and scripts/**/*.spec.* (script test files).
// - Tier B: NON_BAILOUT_SCRIPTS below — leaf/CLI/guard scripts proven by the
//   AST exemption-safety guard in scripts/ci-test-scope.test.ts to have every
//   TOOLING_INPUTS consumer declare them explicitly.
// Any other path under scripts/ (including every new/unknown script) fails
// closed and runs the complete suite.
const SCRIPT_TEST_FILE = /^scripts\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/u;
export const NON_BAILOUT_SCRIPTS = [
  'scripts/ast-grep/',
  'scripts/public-ci-reuse.mjs',
  'scripts/merge-queue-check-arm.mjs',
  'scripts/ci-receipt-rerun.mjs',
  'scripts/agent-review-queue.mjs',
  'scripts/agent-review-queue-planner.mjs',
  'scripts/merge-queue-churn.mjs',
  'scripts/public-ci-dependencies.mjs',
  'scripts/public-ci-neutrality.mjs',
  'scripts/public-claims.mjs',
  'scripts/dco-signoff-check.ts',
  'scripts/affected-tests.mjs',
  'scripts/verification-plan.mjs',
  'scripts/verify-local.mjs',
  'scripts/test-hosted.mjs',
  'scripts/workflow-jobs.ts',
  'scripts/agent-ci-queued-diagnose.ts',
  'scripts/agent-context/evaluate.mjs',
];
const coversInput = (input, path) => (input.endsWith('/') ? path === input || path.startsWith(input) : path === input);
export function isGlobalBailoutScript(path) {
  if (!path.startsWith('scripts/')) return false;
  if (SCRIPT_TEST_FILE.test(path)) return false;
  return !NON_BAILOUT_SCRIPTS.some(entry => coversInput(entry, path));
}

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
// Keep scripts/preflight-integration.test.ts unlisted: it clones HEAD and runs full-repo preflight -- --fast (publication, neutrality, ast-grep, filewide-ignore and guide-check tree scans).
// Keep scripts/packages/generate-release-bom.test.ts unlisted: it scans every *.md file anywhere in the repository.
const NATIVE_STORE_CATALOG_SHARED_INPUTS = [
  'tests/postgres/nativeStoreForwardCatalog.shared.ts',
  'tests/helpers/issuedPlatformCatalog.ts',
  'tests/helpers/postgresContainer.ts',
  'config/ci-images.json',
  'config/reviewed-platform-forwards.json',
  'config/platform-migration-manifest.json',
  'db/platform/migrations/',
  'packages/core/src/platform-runtime/',
  'packages/platform/src/migrations/',
  'server/adapters/postgres/migrationRunner.ts',
  'server/adapters/postgres/qualifiedInstall.ts',
  'server/adapters/postgres/selectedCatalogProjection.ts',
];
const AGENT_REVIEW_QUEUE_SCRIPTS = [
  'scripts/agent-review-queue.mjs',
  'scripts/ci-receipt-rerun.mjs',
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
// Conservative base closure for PostgreSQL suites. Deliberately omits the broad
// `tests/postgres/` directory prefix so editing one PostgreSQL test retains only
// itself (and editing a helper under `tests/postgres/` retains only the suites
// whose AST closure depends on it). Every entry is audited by the TypeScript AST
// closure guard in scripts/ci-test-scope.test.ts.
const PG_BASE_INPUTS = [
  'config/ci-images.json',
  'config/platform-migration-manifest.json',
  'config/reviewed-platform-forwards.json',
  'db/platform/migrations/',
  'packages/',
  'server/',
  'tests/helpers/',
];
const PG_AXES = {
  '@api': ['api/'],
  '@catalogPacks': ['examples/catalog-packs/'],
  '@dataDoc': ['docs/platform/DATA_AND_MIGRATIONS.md'],
  '@examples': ['examples/'],
  '@identityTests': ['tests/identity/'],
  '@managedCompat': ['supabase/', 'config/ci-postgres-packages.json', 'tests/postgres/managed-compat/'],
  '@mcp': ['mcp/'],
  '@src': ['src/'],
  '@starter': ['examples/neutral-store/'],
};
const GOVERNED_DRAFT_SUITE_INPUTS = [
  '@starter',
  'tests/postgres/catalogAdmissionOwnerWrite.fixture.ts',
  'tests/postgres/catalogPublicationFixture.ts',
  'tests/postgres/subscriptionLifecycleClosureFixture.ts',
  'tests/postgres/subscriptionNativeFixture.ts',
];
const POSTGRES_SUITE_CLOSURES = {
  'tests/postgres/accountSupportComposition.test.ts': ['@src', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/accountSupportOperatorAuthority.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/accountSupportReads.test.ts': ['@src'],
  'tests/postgres/accountSupportSelfService.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/accountSupportUpgrade.test.ts': ['@managedCompat', 'tests/postgres/reviewedBatchCatalog.ts'],
  'tests/postgres/acquisitionAdmission.test.ts': ['@api', '@examples', '@mcp', '@src', 'tests/postgres/acquisitionAdmissionFixture.ts'],
  'tests/postgres/acquisitionEvidenceParity.test.ts': [],
  'tests/postgres/adminMembershipAuthority.test.ts': [],
  'tests/postgres/bundleEffectiveParity.test.ts': [],
  'tests/postgres/bundleNative.test.ts': [],
  'tests/postgres/catalogAdmission.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/catalogAdmissionIssueReader.test.ts': ['tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/catalogAdmissionPrelock.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/catalogAttributeProjection.test.ts': [],
  'tests/postgres/catalogBasePriceTransfer.test.ts': [],
  'tests/postgres/catalogBasePriceWriter.test.ts': ['tests/postgres/acquisitionAdmissionFixture.ts'],
  'tests/postgres/catalogDefinitionInstall.test.ts': ['@starter'],
  'tests/postgres/catalogDraftV2.test.ts': [],
  'tests/postgres/catalogLifecycle.test.ts': ['tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogOrderProtection.test.ts': ['@starter', 'tests/postgres/acquisitionAdmissionFixture.ts'],
  'tests/postgres/catalogPriceListBasis.test.ts': ['tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogPricePublicationV2.test.ts': ['tests/postgres/acquisitionAdmissionFixture.ts', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/fixtures/catalogPricePublicationV2/grants.sql'],
  'tests/postgres/catalogPricePublicationV2Pgtap.test.ts': ['@managedCompat', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/fixtures/catalogPricePublicationV2/grants.sql'],
  'tests/postgres/catalogPublication.test.ts': ['tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/omsHumanAdmission.fixture.ts'],
  'tests/postgres/catalogPublicationCanonical.test.ts': ['tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/catalogPublicationCommands.test.ts': ['tests/postgres/acquisitionAdmissionFixture.ts', 'tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogPublicationDiscovery.test.ts': ['tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogPublicationGovernedRoster.test.ts': ['tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogPublicationReadiness.test.ts': ['tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogPublicationTaxAssignments.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/catalogQuantities.test.ts': [],
  'tests/postgres/catalogRuntimeCheckout.test.ts': ['@src', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/m14QualifiedAdminComposition.proof.ts', 'tests/postgres/m14QualifiedComposition.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgrade.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgradeChild.ts'],
  'tests/postgres/catalogSelectedAdmissionRuntime.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/catalogStorefrontPage.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/catalogSubscriptionProfiles.test.ts': ['@starter'],
  'tests/postgres/catalogVariantAxes.test.ts': ['@starter'],
  'tests/postgres/catalogueReferencePacks.test.ts': ['@catalogPacks', '@starter', 'tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/channelConnectedRestore.test.ts': [],
  'tests/postgres/channelManagedRetainedInstallation.test.ts': ['@managedCompat'],
  'tests/postgres/channelMigrationInventory.test.ts': [],
  'tests/postgres/channelPurchase.conformance.test.ts': ['@managedCompat', '@src'],
  'tests/postgres/checkoutAttemptLedger.test.ts': ['@managedCompat'],
  'tests/postgres/checkoutInlineRecovery.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/checkoutOwnerRestoreStates.test.ts': ['tests/postgres/checkoutOwnerRestoreStates.fixture.ts'],
  'tests/postgres/checkoutOwnerRestoreStatesBootstrapAbsent.test.ts': ['tests/postgres/checkoutOwnerRestoreStates.fixture.ts'],
  'tests/postgres/checkoutOwnerRestoreStatesBootstrapDormant.test.ts': ['tests/postgres/checkoutOwnerRestoreStates.fixture.ts'],
  'tests/postgres/checkoutPaymentGuidance.test.ts': ['@src', '@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/checkoutRecoveryInspection.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/checkoutRecoveryInspectionUpgrade.test.ts': [],
  'tests/postgres/checkoutRecoveryLinkLifecycle.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/checkoutRecoveryPay.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/checkoutRecoveryRecreation.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/checkoutRecoveryReminderEpisodes.test.ts': [],
  'tests/postgres/checkoutRecoveryReminderSchedule.test.ts': ['@managedCompat', '@src', '@starter'],
  'tests/postgres/checkoutRecoveryTokenPort.test.ts': [],
  'tests/postgres/checkoutRecoveryWaves.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/commerceComposition.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/commerceDestinationsDonor.test.ts': ['@managedCompat'],
  'tests/postgres/commerceDestinationsNative.test.ts': ['@src', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/commerceManagedRail.test.ts': ['@managedCompat', '@src', 'tests/postgres/reviewedBatchCatalog.ts'],
  'tests/postgres/commerceMoneyLimitsV2.test.ts': [],
  'tests/postgres/commerceMoneyLimitsV2Pgtap.test.ts': ['@managedCompat', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/fixtures/commerceMoneyLimitsV2/replayed.sql'],
  'tests/postgres/commercePriceAuthorityRead.test.ts': [],
  'tests/postgres/commerceQuoteCatalogRead.test.ts': ['@starter', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/commerceQuoteCatalogFixture.ts'],
  'tests/postgres/commerceQuoteV2.test.ts': ['@src', 'packages/core/docs/guide/how-to/build/quote-prices.md', 'tests/postgres/commerceQuoteV2StorageFixture.ts', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/commerceQuoteV2CompositionWire.test.ts': ['tests/postgres/commerceQuoteV2StorageFixture.ts', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/commerceQuoteV2Storage.test.ts': ['tests/postgres/commerceQuoteV2StorageFixture.ts', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/commerceQuoteV2StoragePgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/commerceQuoteV2Storage/replayed.sql'],
  'tests/postgres/communicationEcommerceErasure.test.ts': ['@src', '@starter', 'tests/postgres/communicationEcommerceFixture.ts', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/communicationEcommerceEvents.test.ts': ['tests/postgres/communicationEcommerceFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/communicationEcommerceProvider.test.ts': ['@managedCompat', 'tests/postgres/communicationEcommerceFixture.ts'],
  'tests/postgres/communicationEcommerceTransfer.test.ts': ['tests/postgres/communicationEcommerceFixture.ts'],
  'tests/postgres/communicationsNative.test.ts': ['@api', '@managedCompat', '@src', 'config/canonical-order-money-legacy-exceptions.json', 'config/site-routes.json'],
  'tests/postgres/connectedManagedRetained.test.ts': ['@managedCompat'],
  'tests/postgres/connectedStoreCatalogDrafts.test.ts': ['@starter'],
  'tests/postgres/connectedStoreCatalogRevisions.test.ts': ['tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/connectedStorePaymentMethods.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/connectedStorePromotionClaims.test.ts': [],
  'tests/postgres/connectedStoreRestoreUpgrade.test.ts': ['tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/connectedStoreStarterRelations.test.ts': [],
  'tests/postgres/connectedStoreTransfer.test.ts': ['@src', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts', 'tests/postgres/m19NoticeFixture.ts'],
  'tests/postgres/contactClientRegistrar.test.ts': ['@src'],
  'tests/postgres/customerAccountConsents.test.ts': ['@dataDoc', 'tests/postgres/current-installation-inventory.json'],
  'tests/postgres/customerAccountMutations.test.ts': ['@src', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/customerBillingProfiles.test.ts': ['tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/customerCheckoutLinks.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/customerCommandKeyIsolation.test.ts': [],
  'tests/postgres/customerNewsletterWithdrawal.test.ts': ['@dataDoc'],
  'tests/postgres/customerPreferences.test.ts': ['tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/customerPreferences.fixture.ts'],
  'tests/postgres/customerSavedAddresses.test.ts': ['@src', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/customerPreferences.fixture.ts', 'tests/postgres/customerSavedAddresses.fixture.ts'],
  'tests/postgres/customer_browser_identity.test.ts': ['@src'],
  'tests/postgres/definerSearchPath.test.ts': ['tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/destinationV2Checkout.test.ts': ['tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/destinationV2OrderBinding.test.ts': ['tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/destinationV2ParcelFreeze.test.ts': ['tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/destinationV2Receipts.test.ts': ['tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/destinationV2SubscriptionEdit.test.ts': ['@src', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/disposableDockerReap.test.ts': [],
  'tests/postgres/dunningAttemptReplay.test.ts': ['@managedCompat'],
  'tests/postgres/dunningLifecycleActiveRepair.test.ts': [],
  'tests/postgres/expandOnlyExpressions.test.ts': [],
  'tests/postgres/feedbackMediaAuthority.test.ts': ['@managedCompat', '@src'],
  'tests/postgres/fulfillmentAlignmentComposition.test.ts': [],
  'tests/postgres/fulfillmentCommerceReads.test.ts': [],
  'tests/postgres/fulfillmentContactCorrectionPgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/fulfillmentContactCorrection.sql'],
  'tests/postgres/fulfillmentDeliveryAlignment.test.ts': ['@src'],
  'tests/postgres/fulfillmentDeliveryContactCorrection.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentDispatchPgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/fulfillmentDispatch/outcomes.sql'],
  'tests/postgres/fulfillmentHostSeamRefusals.test.ts': [],
  'tests/postgres/fulfillmentNativeConformance.test.ts': [],
  'tests/postgres/fulfillmentOperatorJourneys.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentParcelContacts.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentParcelStatusFence.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentPreparationBinding.test.ts': [],
  'tests/postgres/fulfillmentProviderIntake.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentRenewalAdmission.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentShipmentCommands.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/fulfillmentStockEvidenceReplay.test.ts': [],
  'tests/postgres/g10FulfillmentIdentity.test.ts': [],
  'tests/postgres/inventoryNative.test.ts': ['tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/inventoryRenewalProtectionPolicy.test.ts': ['@starter', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/invoicingBuyerCapture.test.ts': ['tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/invoicingCaptured.test.ts': [],
  'tests/postgres/invoicingContinuity.test.ts': ['@api', '@src', 'config/site-routes.json'],
  'tests/postgres/invoicingDelivery.test.ts': [],
  'tests/postgres/invoicingManagedCorrection.test.ts': ['@managedCompat', '@src'],
  'tests/postgres/invoicingNativeConformance.test.ts': ['@managedCompat', '@src'],
  'tests/postgres/invoicingStoreContract.test.ts': [],
  'tests/postgres/m05CatalogComposition.test.ts': ['@src'],
  'tests/postgres/m14InstallQualification.test.ts': [],
  'tests/postgres/m14ManagedCatchup.test.ts': ['@managedCompat', '@src', 'tests/postgres/m14ConnectedCatchup.ts', 'tests/postgres/m14ManagedCatchup.ts', 'tests/postgres/m14ManagedSourceFixture.ts'],
  'tests/postgres/m14MigrationSessionAdmission.test.ts': [],
  'tests/postgres/m14QualifiedAdminComposition.test.ts': ['tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/m14QualifiedAdminComposition.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgrade.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgradeChild.ts'],
  'tests/postgres/m14QualifiedBaseline.test.ts': [],
  'tests/postgres/m14QualifiedComposition.test.ts': ['@src', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/m14QualifiedComposition.fixture.ts', 'tests/postgres/m14QualifiedComposition.proof.ts'],
  'tests/postgres/m14QualifiedCompositionTarget.test.ts': ['@src', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/m14QualifiedComposition.fixture.ts', 'tests/postgres/m14QualifiedComposition.proof.ts'],
  'tests/postgres/m14QualifiedSession.test.ts': [],
  'tests/postgres/m14RecipeConformance.test.ts': ['@identityTests', '@managedCompat', '@src', 'config/canonical-order-money-legacy-exceptions.json', 'config/public-reference-communications-imports.json', 'config/public-reference-identity-imports.json', 'config/public-reference-subscription-imports.json', 'config/public-reference-subscription-supabase.toml', 'config/site-routes.json', 'tests/postgres/catalogRuntimeCheckout.proof.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/fixtures/m14ApplicationActor.ts', 'tests/postgres/fixtures/m14EffectActor.mjs', 'tests/postgres/fixtures/m14EffectProvider.mjs', 'tests/postgres/fixtures/m14SelfhostActor.ts', 'tests/postgres/m14ApplicationCohort.ts', 'tests/postgres/m14ConnectedCatchup.ts', 'tests/postgres/m14HostedStorage.mjs', 'tests/postgres/m14ManagedCatchup.ts', 'tests/postgres/m14ManagedSourceFixture.ts', 'tests/postgres/m14OlderSnapshotRecovery.ts', 'tests/postgres/m14QualifiedAdminComposition.proof.ts', 'tests/postgres/m14RdsRecipe.mjs', 'tests/postgres/m14RecipeJourneys.mjs', 'tests/postgres/m14ReleasedSchemaUpgrade.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgradeChild.ts', 'tests/postgres/m14SelfhostHost.ts', 'tests/postgres/m14SelfhostStorage.mjs', 'tests/postgres/oidcIdentity.conformance.ts', 'tests/postgres/oidcIssuerFixture.ts', 'tests/postgres/oidcReferenceRp.ts', 'tests/postgres/runM14EffectHandover.ts', 'tests/postgres/runM14RecipeConformance.mjs', 'tests/postgres/runOidcIdentityConformance.mjs'],
  'tests/postgres/m14ReleasedSchemaUpgrade.test.ts': ['tests/postgres/current-installation-inventory.json', 'tests/postgres/m14ReleasedSchemaUpgrade.proof.ts', 'tests/postgres/m14ReleasedSchemaUpgradeChild.ts'],
  'tests/postgres/m14RestrictedConnectedRestore.test.ts': ['tests/postgres/catalogAdmissionOwnerWrite.fixture.ts', 'tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/m14RestrictedConnectedRestore.fixture.ts'],
  'tests/postgres/m14RestrictedConnectedRestoreMatrix.test.ts': ['tests/postgres/current-installation-inventory.json', 'tests/postgres/m14RestrictedConnectedRestore.fixture.ts'],
  'tests/postgres/m17ChannelReference.test.ts': ['@managedCompat', '@src'],
  'tests/postgres/m19BundleWriteExport.test.ts': [],
  'tests/postgres/m19BundleWriteIdentity.test.ts': ['@src'],
  'tests/postgres/m19CheckoutShipping.test.ts': [],
  'tests/postgres/m19MigrationFacade.test.ts': [],
  'tests/postgres/m19NoticeIsolation.test.ts': ['@dataDoc', 'tests/postgres/m19NoticeFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/m19PaymentCancellation.test.ts': ['@dataDoc', 'tests/postgres/m19PaymentSimulatorChild.ts'],
  'tests/postgres/m19StorePromotion.test.ts': [],
  'tests/postgres/m19StorePromotionIdentity.test.ts': ['@src'],
  'tests/postgres/managedStorageTransfer.test.ts': ['@managedCompat', 'tests/postgres/managedStorageTransfer.proof.ts'],
  'tests/postgres/marketDirectoryPreservation.test.ts': ['@managedCompat', '@src'],
  'tests/postgres/migrationFinalization.test.ts': ['@managedCompat'],
  'tests/postgres/migrationLedgerAttributeVersion.test.ts': [],
  'tests/postgres/nativeAccountReads.test.ts': ['@src', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/nativeCheckoutPersistence.test.ts': [],
  'tests/postgres/nativeRenewalDueFairness.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/neutralStarterE4.test.ts': ['@starter'],
  'tests/postgres/neutralStoreCataloguePacks.test.ts': ['@starter'],
  'tests/postgres/neutralStorePaidMail.test.ts': ['@starter'],
  'tests/postgres/neutralStoreQuote.test.ts': ['@starter'],
  'tests/postgres/neutralStoreRecovery.test.ts': ['@starter'],
  'tests/postgres/neutralStoreRenewal.test.ts': ['@starter', 'tests/postgres/subscriptionPublicRenewal.worker.mjs', 'tests/postgres/subscriptionPublicRenewalFixture.ts'],
  'tests/postgres/neutralStoreRenewalPolicy.test.ts': ['@starter', 'tests/postgres/subscriptionPublicRenewal.worker.mjs', 'tests/postgres/subscriptionPublicRenewalFixture.ts'],
  'tests/postgres/neutralStoreUuid.test.ts': ['@starter'],
  'tests/postgres/newPurchaseStockManaged.test.ts': ['@managedCompat'],
  'tests/postgres/newPurchaseStockNative.test.ts': [],
  'tests/postgres/nodeHostRuntimeDrain.test.ts': [],
  'tests/postgres/offerPolicyReadinessInputs.test.ts': [],
  'tests/postgres/offerPolicyReadinessTransfer.test.ts': [],
  'tests/postgres/omsControlPlaneNative.test.ts': [],
  'tests/postgres/omsHumanAdmission.test.ts': ['tests/postgres/omsHumanAdmission.fixture.ts', 'tests/postgres/omsHumanAdmission.host.mjs'],
  'tests/postgres/omsQueueLadder.test.ts': ['@managedCompat'],
  'tests/postgres/operatorCheckoutPaymentLink.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/operatorIdentityUpgrade.test.ts': ['@managedCompat', '@src', 'tests/postgres/identityPrivacy.conformance.ts'],
  'tests/postgres/operatorInvitationCatalogue.test.ts': ['tests/postgres/operatorInvitationCatalogue.ts'],
  'tests/postgres/operatorInvitationLifecycle.test.ts': ['tests/postgres/operatorInvitationCatalogue.ts'],
  'tests/postgres/operatorOrderCommands.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/partnerAcquisition.test.ts': [],
  'tests/postgres/paymentMethodRefsPgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/paymentMethods/', 'tests/postgres/m19NoticeFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentMethodRuntime.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentProviderProfiles.test.ts': ['@starter', 'tests/postgres/fixtures/', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentProviderStore.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentProviderStorePgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/paymentProvider/', 'tests/postgres/fixtures/paymentProvider/setup.sql'],
  'tests/postgres/paymentProviderTransfer.test.ts': [],
  'tests/postgres/paymentReconciliationAttributionGap.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentReconciliationPgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/', 'tests/postgres/fixtures/paymentProvider/setup.sql', 'tests/postgres/fixtures/paymentReconciliation/setup.sql'],
  'tests/postgres/paymentReconciliationStore.test.ts': ['@starter', 'tests/postgres/fixtures/', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentReconciliationTransfer.test.ts': ['tests/postgres/fixtures/', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/paymentsNativeConformance.test.ts': [],
  'tests/postgres/pgTemplateBroker.test.ts': [],
  'tests/postgres/platformBffMovedRoutes.test.ts': [],
  'tests/postgres/platformManifestSuffix.test.ts': [],
  'tests/postgres/policyCloseDigest.test.ts': ['@src', 'tests/postgres/catalogPublicationFixture.ts'],
  'tests/postgres/portabilityRows.test.ts': [],
  'tests/postgres/postgresContainer.test.ts': ['@managedCompat'],
  'tests/postgres/postgresContainerCleanup.test.ts': [],
  'tests/postgres/privacyErasureReplay.test.ts': ['@managedCompat', '@src', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/fixtures/privacyErasureReconciliations.sql'],
  'tests/postgres/privacyReplayFence.test.ts': ['@managedCompat', '@src', 'tests/postgres/customerAccountMutations.fixture.ts'],
  'tests/postgres/privacyRequiredContributors.test.ts': ['@managedCompat', '@src', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/fixtures/privacyRequiredContributors.sql'],
  'tests/postgres/privacyRequiredContributorsMounted.test.ts': ['@identityTests', '@managedCompat', '@src', 'config/canonical-order-money-legacy-exceptions.json', 'config/public-reference-communications-imports.json', 'config/public-reference-identity-imports.json', 'config/public-reference-subscription-imports.json', 'config/public-reference-subscription-supabase.toml', 'config/site-routes.json', 'tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/fixtures/privacyReplayRecorded.json'],
  'tests/postgres/promotionsNative.test.ts': [],
  'tests/postgres/purchaseReservationDonor.test.ts': ['@managedCompat'],
  'tests/postgres/purchaseReservationNative.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/qualifiedRuntimeLockCompletion.test.ts': ['tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/retainedClientSubscriptionImport.test.ts': [],
  'tests/postgres/returnRequestCommands.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/reviewedPortableCreation.test.ts': ['@managedCompat'],
  'tests/postgres/riskControl.conformance.test.ts': ['@managedCompat'],
  'tests/postgres/settingsOwnerWindow.test.ts': [],
  'tests/postgres/settingsWave1Policies.test.ts': [],
  'tests/postgres/settingsWave2Policies.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/settingsWave3aPolicies.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/shippingNative.test.ts': ['@src'],
  'tests/postgres/starterGraduationCadence.test.ts': ['@managedCompat'],
  'tests/postgres/storeJourneyAcceptance.test.ts': [],
  'tests/postgres/storeJourneyChallengeTransfer.test.ts': [],
  'tests/postgres/storeJourneyConsentChoices.test.ts': [],
  'tests/postgres/storeJourneyDestinations.test.ts': [],
  'tests/postgres/storeJourneyGuestCheckout.test.ts': ['@starter'],
  'tests/postgres/storeJourneyNotices.test.ts': ['tests/postgres/m19NoticeFixture.ts'],
  'tests/postgres/storeJourneyRenewal.test.ts': [],
  'tests/postgres/storeJourneyTransfer.test.ts': [],
  'tests/postgres/stripePortableRail.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionActivationEditWindow.test.ts': ['tests/postgres/subscriptionActivationFixture.ts', 'tests/postgres/subscriptionPublicRenewal.worker.mjs', 'tests/postgres/subscriptionPublicRenewalFixture.ts', 'tests/postgres/subscriptionRegistrationFixture.ts'],
  'tests/postgres/subscriptionActivationPermissions.test.ts': ['tests/postgres/subscriptionActivationFixture.ts', 'tests/postgres/subscriptionRegistrationFixture.ts'],
  'tests/postgres/subscriptionAutoResumeDeliveredHistory.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionComposition.test.ts': ['@src', 'tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionContinuityBaseline.test.ts': [],
  'tests/postgres/subscriptionExactEditor.test.ts': [],
  'tests/postgres/subscriptionExactInstallation.test.ts': ['tests/postgres/current-installation-inventory.json', 'tests/postgres/nativeStoreForwardCatalog.shared.ts'],
  'tests/postgres/subscriptionLifecycleClosure.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionLifecycleContractWitnesses.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionManagedStock.test.ts': ['@managedCompat'],
  'tests/postgres/subscriptionMethodHealthCompatibility.test.ts': [],
  'tests/postgres/subscriptionNoticeDelivery.test.ts': ['tests/postgres/m19NoticeFixture.ts'],
  'tests/postgres/subscriptionNoticeProducers.test.ts': ['tests/postgres/m19NoticeFixture.ts'],
  'tests/postgres/subscriptionPackageEditor.test.ts': [],
  'tests/postgres/subscriptionPauseDuration.test.ts': ['@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionPublicRenewal.test.ts': ['@src', 'tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionPublicRenewal.worker.mjs', 'tests/postgres/subscriptionPublicRenewalFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionPurchaseRenewal.test.ts': ['tests/postgres/subscriptionRegistrationFixture.ts'],
  'tests/postgres/subscriptionPurchaseTemplate.test.ts': ['tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionPublicRenewal.worker.mjs', 'tests/postgres/subscriptionPublicRenewalFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionPurchaseTemplateLegacy.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionRecoveryTruth.test.ts': ['tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionRegistrationActivationLockOrder.test.ts': ['tests/postgres/subscriptionActivationFixture.ts', 'tests/postgres/subscriptionRegistrationFixture.ts'],
  'tests/postgres/subscriptionRenewalGate.test.ts': ['tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionRenewalLifecycle.test.ts': ['@src', '@starter', 'tests/postgres/subscriptionAlignmentRollbackCases.ts', 'tests/postgres/subscriptionCommandLifecycleCases.ts', 'tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionRenewalAdapterCases.ts', 'tests/postgres/subscriptionRetryLifecycleCases.ts', 'tests/postgres/subscriptionStockAccountingCases.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionRetainedMethodCompatibility.test.ts': ['@managedCompat'],
  'tests/postgres/subscriptionRetainedRenewal.test.ts': ['tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionPublicRenewal.worker.mjs', 'tests/postgres/subscriptionPublicRenewalFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionRetryResume.test.ts': ['@src', '@starter', 'tests/postgres/subscriptionLifecycleClosureFixture.ts', 'tests/postgres/subscriptionNativeFixture.ts'],
  'tests/postgres/subscriptionSavedAddressSelection.test.ts': ['tests/postgres/customerAccountMutations.fixture.ts', 'tests/postgres/customerPreferences.fixture.ts', 'tests/postgres/customerSavedAddresses.fixture.ts'],
  'tests/postgres/subscriptionSizedEditor.test.ts': [],
  'tests/postgres/subscriptionSizedInstallation.test.ts': ['tests/postgres/catalogPublicationFixture.ts', 'tests/postgres/current-installation-inventory.json', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/subscriptionStockWaitBusy.test.ts': ['tests/postgres/subscriptionNativeFixture.ts', 'tests/postgres/subscriptionStockWaitCases.ts'],
  'tests/postgres/subscriptionStockWaitReads.test.ts': [],
  'tests/postgres/subscriptionWinback.test.ts': [],
  'tests/postgres/taxCalculationsV2.test.ts': ['@src', 'tests/postgres/destinationDocumentFixture.ts', 'tests/postgres/destinationReceiptFixture.ts'],
  'tests/postgres/taxCalculationsV2Pgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/taxCalculationsV2/replayed.sql'],
  'tests/postgres/taxCoveragePgtap.test.ts': ['@managedCompat', 'tests/postgres/fixtures/taxCoverage/revisions.sql', 'tests/postgres/fixtures/taxCoverage/settings.ts'],
  'tests/postgres/taxCoverageRevisions.test.ts': ['tests/postgres/fixtures/taxCoverage/corpus.ts', 'tests/postgres/fixtures/taxCoverage/settings.ts'],
};
// These registrations land before the suites. Check each suite's own file.
const GOVERNED_DRAFT_SUITE_PATHS = [
  'tests/postgres/catalogAdmissionOwnerWrite.test.ts',
  'tests/postgres/catalogAdmissionRuntimeCommit.test.ts',
];
const postgresSuiteInputs = (testPath, extras = []) => [
  ...PG_BASE_INPUTS,
  testPath,
  ...extras.flatMap(entry => PG_AXES[entry] ?? [entry]),
];
const safeFileProbe = isFile => testPath => {
  try {
    return isFile(testPath);
  } catch {
    return false;
  }
};
export function governedDraftSuiteInputs(isFile) {
  return Object.fromEntries(GOVERNED_DRAFT_SUITE_PATHS
    .filter(safeFileProbe(isFile))
    .map(testPath => [testPath, postgresSuiteInputs(testPath, GOVERNED_DRAFT_SUITE_INPUTS)]));
}
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
  'scripts/agent-review-queue.test.ts': [...AGENT_REVIEW_QUEUE_SCRIPTS, 'scripts/agent-review-queue-planner.mjs', 'scripts/merge-queue-check-arm.mjs', 'scripts/dco-signoff-check.ts', 'scripts/merge-queue-churn.mjs'], // Synthetic Git repositories and recorded transport.
  'scripts/agent-review-gate.test.ts': [...AGENT_REVIEW_QUEUE_SCRIPTS], // Real-Git witnesses of the session CLI and hosted admission.
  'scripts/agent-review-registry.test.ts': ['config/openlup-publication-catalog.json', 'packages/platform/test/packageBoundary.test.ts', ...AGENT_REVIEW_QUEUE_SCRIPTS], // Closed-registry union and review-economy fixtures reading REGISTRY_PATHS.
  'scripts/public-ci-reuse.test.ts': ['scripts/public-ci-reuse.mjs'], // Recorded workflow/job responses.
  'scripts/documentation-cli.test.ts': ['examples/neutral-store/package.json', ...PACKAGE_MANIFESTS, 'packages/core/scripts/', ...ROOT_DOC_FILES], // Copies CLI closure, package execution surfaces and validates root docs.
  'scripts/pgtap-parity.test.ts': [], // Pure TAP/row-diff/sabotage/executable unit fixtures.
  'scripts/qualified-migration-admission.test.ts': ['config/reviewed-platform-forwards.json', 'db/platform/migrations/', ...AGENT_REVIEW_QUEUE_SCRIPTS], // Qualified installation admission pins and issued SQL preimages.
  'scripts/reviewed-batch-forward.test.ts': ['config/reviewed-platform-forwards.json', 'config/platform-migration-manifest.json', 'db/platform/migrations/', 'supabase/migrations/', 'packages/platform/sql/', ...AGENT_REVIEW_QUEUE_SCRIPTS, 'scripts/source-preview-release.test.ts'], // Historical batch/M09-M12 forward pinning and co-located admission checks.
  'scripts/reviewed-native-store-forward.test.ts': ['config/reviewed-platform-forwards.json', 'config/platform-migration-manifest.json', 'db/platform/migrations/', 'docs/platform/DATA_AND_MIGRATIONS.md', 'tests/helpers/issuedPlatformCatalog.ts', ...AGENT_REVIEW_QUEUE_SCRIPTS], // Native-store forward classifier, issued prefix pins and control/guard-catalog doc checks.
  'scripts/sql-admit.test.ts': ['config/reviewed-platform-forwards.json', ...AGENT_REVIEW_QUEUE_SCRIPTS], // Synthetic Git fixtures reading the committed forward registry and scripts/ admission rules.
  'scripts/ast-grep/check-filewide-ignore.test.ts': ['scripts/ast-grep/'], // Fixture source; actual rules under scripts/ast-grep/.
  'scripts/ast-grep/rule-tests/portable-no-industry-contracts.test.ts': ['scripts/ast-grep/'], // Fixture source and rules.
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
    'tests/helpers/pgTemplateBroker.ts',
    'tests/helpers/managedCompatPostgres.ts',
    'tests/helpers/fulfillmentNative.ts',
    'config/ci-images.json',
    'config/ci-postgres-packages.json',
    'config/reviewed-platform-forwards.json',
    'config/platform-migration-manifest.json',
    'db/platform/migrations/',
    'supabase/',
    'packages/',
    'server/adapters/postgres/migrationRunner.ts',
    'server/adapters/postgres/qualifiedInstall.ts',
    'server/adapters/postgres/selectedCatalogProjection.ts',
    'src/domains/commerce/offerAvailability.ts',
  ], // Real PostgreSQL native/managed batch catalog gate, compat harness and inventory/offer witnesses.
  ...Object.fromEntries(
    Object.entries(POSTGRES_SUITE_CLOSURES).map(([testPath, extras]) => [testPath, postgresSuiteInputs(testPath, extras)]),
  ),
  ...governedDraftSuiteInputs(testPath =>
    statSync(new URL(`../${testPath}`, import.meta.url), { throwIfNoEntry: false })?.isFile() ?? false),
};

const WORKFLOW_PGTAP_INPUTS = [
  'supabase/migrations/',
  'supabase/tests/',
  'tests/postgres/managed-compat/',
  'config/ci-postgres-packages.json',
  'config/ci-images.json',
];
const WORKFLOW_REFERENCE_BUILD_INPUTS = [
  'src/',
  'server/',
  'api/',
  'packages/',
  'public/',
  'config/',
];
const WORKFLOW_PACKAGE_GATES_INPUTS = [
  'packages/',
  'examples/neutral-store/',
  'db/platform/migrations/',
  'server/',
  'docs/platform/communications-conformance.mjs',
  'config/openlup-packages.json',
  'config/ci-images.json',
  'config/platform-migration-manifest.json',
  'config/reviewed-platform-forwards.json',
  'config/environment-variables.json',
  'config/documentation-guide-allowlist.json',
  'tests/helpers/postgresContainer.ts',
  'AGENTS.md',
];
const WORKFLOW_INSTALL_BROWSER_INPUTS = [
  'packages/',
  'examples/neutral-store/',
  'config/openlup-packages.json',
  'config/ci-images.json',
  'tests/helpers/postgresContainer.ts',
  'tests/postgres/m14ReleasedSchemaUpgrade.proof.ts',
  'tests/postgres/m14ReleasedSchemaUpgradeChild.ts',
];
export const ALL_WORKFLOW_SCOPES_TRUE = Object.freeze({
  run_pgtap: true,
  run_reference_build: true,
  run_package_gates: true,
  run_install_browser: true,
  run_install_pack: true,
});

const hasInvalidPath = changedPaths => !Array.isArray(changedPaths) || changedPaths.some(path => typeof path !== 'string'
  || !path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'));
const hasGlobalBailout = changedPaths => changedPaths.some(path => (!path.includes('/') && !ROOT_DOC_SET.has(path))
  || path.split('/').some(segment => segment.startsWith('.'))
  || isGlobalBailoutScript(path)
  || SHARED_INPUTS.some(input => coversInput(input, path)));

export function excludedToolingTests(changedPaths) {
  if (hasInvalidPath(changedPaths) || hasGlobalBailout(changedPaths)) return [];
  const touched = inputs => changedPaths.some(path => inputs.some(input => coversInput(input, path)));
  return Object.entries(TOOLING_INPUTS)
    .filter(([test, inputs]) => !touched([test, ...inputs]))
    .map(([test]) => test).sort();
}

export function workflowScopeFromPaths(changedPaths, { hasDeletion = false } = {}) {
  if (hasInvalidPath(changedPaths) || changedPaths.length === 0 || hasGlobalBailout(changedPaths)) {
    return { ...ALL_WORKFLOW_SCOPES_TRUE };
  }
  const touched = inputs => changedPaths.some(path => inputs.some(input => coversInput(input, path)));
  const run_pgtap = touched(WORKFLOW_PGTAP_INPUTS);
  const run_reference_build = touched(WORKFLOW_REFERENCE_BUILD_INPUTS);
  // Deleting or renaming any tracked file (reported as D under --no-renames) can
  // break repository-link existence checks in packages/core docs:check.
  const run_package_gates = hasDeletion || touched(WORKFLOW_PACKAGE_GATES_INPUTS);
  const run_install_browser = touched(WORKFLOW_INSTALL_BROWSER_INPUTS);
  const run_install_pack = run_package_gates || run_install_browser;
  return { run_pgtap, run_reference_build, run_package_gates, run_install_browser, run_install_pack };
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

function resolveEventMergeBase({ eventName, event, cwd = process.cwd(), git = args => runGit(cwd, args) }) {
  const base = eventName === 'pull_request' ? event?.pull_request?.base?.sha
    : eventName === 'merge_group' ? event?.merge_group?.base_sha : undefined;
  if (!/^[a-f0-9]{40}$/u.test(base ?? '')) return null;
  const fork = git(['merge-base', 'HEAD', base]).trim();
  if (!/^[a-f0-9]{40}$/u.test(fork)) return null;
  return { fork, git };
}

function readEventDiffPaths(options) {
  try {
    const resolved = resolveEventMergeBase(options);
    if (!resolved) return null;
    const diff = resolved.git(['diff', '--no-renames', '--name-only', '-z', resolved.fork, 'HEAD', '--']);
    if (diff && !diff.endsWith('\0')) return null;
    return diff.split('\0').filter(Boolean);
  } catch {
    return null; // Missing history, malformed metadata and Git errors fail closed.
  }
}

function readEventDiffWithStatus(options) {
  try {
    const resolved = resolveEventMergeBase(options);
    if (!resolved) return null;
    const diff = resolved.git(['diff', '--no-renames', '--name-status', '-z', resolved.fork, 'HEAD', '--']);
    if (!diff) return { paths: [], hasDeletion: false };
    if (!diff.endsWith('\0')) return null;
    const tokens = diff.slice(0, -1).split('\0');
    if (tokens.length % 2 !== 0) return null;
    const paths = [];
    let hasDeletion = false;
    for (let index = 0; index < tokens.length; index += 2) {
      const status = tokens[index];
      const path = tokens[index + 1];
      if (!/^[AMDT]$/u.test(status) || !path) return null;
      if (status === 'D') hasDeletion = true;
      paths.push(path);
    }
    return { paths, hasDeletion };
  } catch {
    return null; // Missing history, malformed metadata and Git errors fail closed.
  }
}

// HEAD is the checked-out candidate, including GitHub's PR merge commit. Diff
// against its merge-base with the event's exact base, never a moving branch.
// --no-renames reports both old and new names, so moving an input triggers it.
export function scopeFromEvent(options) {
  const paths = readEventDiffPaths(options ?? {});
  return paths ? excludedToolingTests(paths) : [];
}

export function workflowScopeFromEvent(options) {
  const diff = readEventDiffWithStatus(options ?? {});
  return diff ? workflowScopeFromPaths(diff.paths, { hasDeletion: diff.hasDeletion }) : { ...ALL_WORKFLOW_SCOPES_TRUE };
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

export function writeWorkflowScope({ output, eventName, eventPath, cwd } = {}) {
  let scope = { ...ALL_WORKFLOW_SCOPES_TRUE };
  try {
    if (eventName && eventPath) {
      scope = workflowScopeFromEvent({ eventName, event: JSON.parse(readFileSync(eventPath, 'utf8')), cwd });
    }
  } catch { /* Fail closed to running every workflow lane on any read/selection error. */ }
  const lines = [
    `run_pgtap=${scope.run_pgtap}`,
    `run_reference_build=${scope.run_reference_build}`,
    `run_package_gates=${scope.run_package_gates}`,
    `run_install_browser=${scope.run_install_browser}`,
    `run_install_pack=${scope.run_install_pack}`,
  ].join('\n');
  if (output) appendFileSync(output, `${lines}\n`);
  console.log(`Workflow scope (${eventName ?? 'unknown'}): ${lines.replaceAll('\n', ', ')}`);
  return scope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--workflow-outputs') {
    writeWorkflowScope({
      output: processEnvironment.GITHUB_OUTPUT,
      eventName: processEnvironment.GITHUB_EVENT_NAME,
      eventPath: processEnvironment.GITHUB_EVENT_PATH,
    });
  } else {
    const valid = args.length === 0 || (args.length === 2 && args[0] === '--base' && args[1] && !args[1].startsWith('-'));
    if (!valid) {
      if (processEnvironment.OPENLUP_VITEST_EXCLUDE_FILE) {
        writeFileSync(processEnvironment.OPENLUP_VITEST_EXCLUDE_FILE, '');
      }
      throw new Error('Usage: node scripts/ci-test-scope.mjs [--base <ref> | --workflow-outputs]');
    }
    writeTestScope({ output: processEnvironment.OPENLUP_VITEST_EXCLUDE_FILE, base: args[1],
      eventName: processEnvironment.GITHUB_EVENT_NAME, eventPath: processEnvironment.GITHUB_EVENT_PATH });
  }
}
