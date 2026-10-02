/** Every directly runnable file admitted by the bounded public command/container contract. */
export const PUBLIC_EXECUTION_ENTRYPOINTS = [
  "packages/core/scripts/api-contract.ts", "packages/core/scripts/core-package-consumer-smoke.ts",
  "packages/core/scripts/documentation-contract.ts", "packages/core/scripts/refuse-publish.ts",
  "packages/core/scripts/release-bundle.ts", "packages/core/scripts/release-check.ts",
  "packages/core/test/assertNoZeroCoverage.ts", "packages/core/vitest.config.ts",
  "packages/core/scripts/neutrality-tree-counts.ts", "packages/ui/smoke/neutrality.ts",
  "scripts/agent-review-session.mjs", "scripts/agent-review-session.test.ts",
  "scripts/agent-review-queue.mjs", "scripts/agent-review-queue.test.ts",
  "scripts/agent-review-controller.mjs", "scripts/agent-review-controller.test.ts",
  "scripts/agent-review-gate.mjs", "scripts/agent-review-gate.test.ts", "scripts/agent-review-hook.mjs",
  "scripts/agent-review-hosted.mjs", "scripts/agent-review-hosted.test.ts",
  "scripts/ast-grep/check-filewide-ignore.mjs",
  "scripts/check-client-secret-boundary.ts", "scripts/dco-signoff-check.ts",
  "scripts/oss-published-tree-check.test.ts", "scripts/oss-published-tree-check.ts", "scripts/oss-reference-prerender.ts",
  "scripts/packages/package-release.ts", "scripts/packages/packages-check.ts", "scripts/packages/release-bump.ts",
  "scripts/public-reference/grant-operator.mjs", "scripts/public-reference/setup-subscription.mjs",
  "scripts/public-reference/verify-subscription.mjs",
  "scripts/public-ci-neutrality.mjs", "scripts/public-ci-pgtap.mjs",
  "scripts/run-vitest.mjs", "scripts/site-routes.mjs", "scripts/source-preview-release.test.ts", "scripts/source-preview-release.ts",
  "server/runtime/communications/newsletterProviderRegistry.test.ts", "server/runtime/payment/paymentAdapterRegistry.test.ts",
  "server/runtime/public-reference/serve.ts",
  "src/lib/coreDomains.test.ts", "src/lib/orderRef.test.ts", "src/lib/paymentControlPlaneBoundary.test.ts",
  "src/pages/account/v2/sections/PaymentCardSetup.test.tsx",
  "vitest.config.ts",
] as const;

export function isDirectExecutionEntrypoint(path: string, contents: string): boolean {
  if (contents.startsWith("#!")) return true;
  if (!/\.(?:[cm]?[jt]sx?|ba?sh)$/u.test(path)) return false;
  return /\bprocess\.argv\b|\brequire\.main\s*===\s*module\b|\bimport\.meta\.url\s*===\s*pathToFileURL\(/u.test(contents);
}

export {
  RESERVED_FIXTURE_COORDINATE,
  RESERVED_FIXTURE_SECURITY_ROUTE,
  SOURCE_RELEASE_CONTRACT_PATH,
  SOURCE_RELEASE_EVIDENCE_CLASS,
  createSourceReleaseContract,
  isValidPublicSecurityRoute,
  validateSourceReleaseContract,
} from "./oss-source-release-contract.ts";
export type {
  SourceReleaseContractInput,
  SourceReleaseIdentity,
} from "./oss-source-release-contract.ts";

export {
  createPublicPublicationCatalog,
  packageExecutionDigest,
  publicPublicationCatalogDigests,
  PUBLIC_PACKAGE_COMMANDS,
  PUBLIC_PACKAGE_EXECUTION_SURFACES,
  PUBLICATION_CATALOG_PATH,
  PUBLIC_POLICY_REGISTRY_PATH,
  PUBLIC_TEST_COMMAND,
  PUBLIC_TEST_SCOPE,
  parsePublicPolicyRegistry,
  parsePublicPublicationCatalog,
} from "./oss-publication-policy.ts";
export type {
  ContractOwner,
  PublicCatalogPath,
  PublicGuardViability,
  PublicPackageCommand,
  PublicPackageExecutionSurface,
  PublicPolicyRegistry,
  PublicPublicationCatalog,
} from "./oss-publication-policy.ts";
