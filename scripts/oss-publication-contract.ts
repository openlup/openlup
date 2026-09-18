import { createHash } from "node:crypto";
import { posix } from "node:path";

export const PROJECTED_PLATFORM_BASELINE_PATH = "supabase/migrations/00000000000000_platform_schema_baseline.sql";
export const EXPLICIT_PUBLIC_PROJECTION_PATHS = [
  ".github/pull_request_template.md", "AGENTS.md", "CODE_OF_CONDUCT.md", "Dockerfile", "SECURITY.md",
  "api/bff/[...path].ts",
  "config/canonical-order-money-legacy-exceptions.json", "config/environment-variables.json",
  "config/feature-flags.json", "config/gitleaks.toml", "config/platform-runtime.json", "config/platform-migration-manifest.json",
  "config/openlup-policy-registry.json", "config/openlup-publication-catalog.json",
  "config/openlup-source-release-contract.json", "config/public-reference-capability-manifest.json",
  "config/site-routes.json", "docker-compose.yml", "index.html",
  "package-lock.json", "package.json", "packages/core/package-lock.json", PROJECTED_PLATFORM_BASELINE_PATH,
  "src/integrations/supabase/types.ts",
  "vite.config.ts",
] as const;

export const PROJECTED_AGENTS_PATH = "AGENTS.md";

/** Every directly runnable file admitted by the bounded public command/container contract. */
export const PUBLIC_EXECUTION_ENTRYPOINTS = [
  "packages/core/scripts/api-contract.ts", "packages/core/scripts/core-package-consumer-smoke.ts",
  "packages/core/scripts/documentation-contract.ts", "packages/core/scripts/refuse-publish.ts",
  "packages/core/scripts/release-bundle.ts", "packages/core/scripts/release-check.ts",
  "packages/core/test/assertNoZeroCoverage.ts", "packages/core/vitest.config.ts",
  "packages/ui/smoke/neutrality.ts",
  "scripts/check-client-secret-boundary.ts", "scripts/dco-signoff-check.ts",
  "scripts/oss-consume-engine.test.ts", "scripts/oss-consume-github-transport.test.ts",
  "scripts/oss-published-tree-check.test.ts", "scripts/oss-published-tree-check.ts", "scripts/oss-reference-prerender.ts",
  "scripts/run-vitest.mjs", "scripts/site-routes.mjs", "server/runtime/public-reference/serve.ts",
  "src/lib/orderRef.test.ts",
  "vitest.config.ts",
] as const;
export const PUBLIC_WITHHELD_ABSENCE_PROBES = ["scripts/oss-published-tree-check.test.ts -> config/oss-core-readiness-blockers.json", "scripts/oss-published-tree-check.test.ts -> config/oss-split-rehearsal-baseline.json"] as const;
export const PUBLIC_PROJECTED_OPAQUE_DEPENDENCY_EDGES = { "packages/core/scripts/core-package-consumer-audit.ts": ["unresolved filesystem path: join(packageRoot, path)"] } as const;
export const PUBLIC_UNBOUND_DATABASE_TYPE_IMPORTERS = ["server/_lib/admin-domain/auth.ts", "server/adapters/dhl/cleanupAdapter.ts", "server/adapters/supabase/adminAuthVerifier.test.ts", "server/adapters/supabase/adminAuthVerifier.ts", "server/adapters/supabase/adminEmailSendsPort.ts", "server/adapters/supabase/adminTesterEmailSendsPort.ts", "server/adapters/supabase/communications/notificationRecipients.ts", "server/adapters/supabase/platform/adminPipelinePort.ts", "server/adapters/supabase/platform/adminPlatformPort.ts", "server/adapters/supabase/platform/adminSettingsPort.ts", "src/integrations/supabase/client.ts", "src/integrations/supabase/customerClient.ts"] as const;

export type ExplicitPublicProjectionPath = (typeof EXPLICIT_PUBLIC_PROJECTION_PATHS)[number];
export const EXPLICIT_PUBLIC_PROJECTION_SOURCE_OVERRIDES: Partial<Record<ExplicitPublicProjectionPath, string | null>> = {
  ".github/pull_request_template.md": ".github/public-reference-pull-request-template.md",
  "AGENTS.md": "docs/platform/AGENT_GUIDE.md",
  "CODE_OF_CONDUCT.md": null,
  "Dockerfile": "deploy/oci/public-reference.Dockerfile",
  "SECURITY.md": null,
  "config/public-reference-capability-manifest.json": null,
  "config/site-routes.json": "config/public-reference-site-routes.json",
  "docker-compose.yml": "deploy/oci/public-reference-compose.yml",
  "index.html": null,
  "src/integrations/supabase/types.ts": null,
  "vite.config.ts": "vite.public-reference.config.ts",
};
export const SOURCE_ONLY_PUBLIC_PROJECTION_PATHS = ["packages/core/scripts/core-package-consumer-audit.ts", "scripts/oss-public-coordinate-detector.ts", "src/test/setup.ts", "vite.public-reference.config.ts"] as const;
export const publicProjectionSource = (target: ExplicitPublicProjectionPath): string | null => Object.hasOwn(EXPLICIT_PUBLIC_PROJECTION_SOURCE_OVERRIDES, target) ? EXPLICIT_PUBLIC_PROJECTION_SOURCE_OVERRIDES[target]! : target;
export type ProjectionWrite = {
  path: string;
  contents: string;
};

export type ExportTotalityInput = {
  trackedPaths: string[];
  copiedSourcePaths?: string[];
  projectedSourcePaths?: string[];
  flattenedSourcePaths?: string[];
  withheldPaths: string[];
  outputPaths?: string[];
  classificationDigests?: string[];
  // Compatibility fields remain only while the exporter switches to source/output inventories.
  projectedPaths?: string[];
  publishedPaths?: string[];
  withholdSelectors?: string[];
};

type JsonObject = Record<string, unknown>;

const sha256 = (contents: string): string =>
  `sha256-${createHash("sha256").update(contents).digest("hex")}`;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sortedPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${label}: expected a string array`);
  }
  const paths = value as string[];
  if (new Set(paths).size !== paths.length) throw new Error(`${label}: paths must be unique`);
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error(`${label}: paths must be sorted`);
  }
  for (const path of paths) {
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path === "." ||
      path.startsWith("../") ||
      posix.normalize(path) !== path
    ) {
      throw new Error(`${label}: invalid repository-relative path ${path}`);
    }
  }
  return paths;
}

export function isDirectExecutionEntrypoint(path: string, contents: string): boolean {
  if (contents.startsWith("#!")) return true;
  if (!/\.(?:[cm]?[jt]sx?|ba?sh)$/u.test(path)) return false;
  return /\bprocess\.argv\b|\brequire\.main\s*===\s*module\b|\bimport\.meta\.url\s*===\s*pathToFileURL\(/u.test(contents);
}

export function projectPublicAgentGuide(source: string): ProjectionWrite {
  const replacements = [["(README.md)", "(docs/platform/README.md)"], ["(ARCHITECTURE_AND_EXTENSIONS.md)", "(docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)"], ["(DATA_AND_MIGRATIONS.md)", "(docs/platform/DATA_AND_MIGRATIONS.md)"], ["(RUNTIME_AND_SELF_HOSTING.md)", "(docs/platform/RUNTIME_AND_SELF_HOSTING.md)"], ["(CANONICAL_CONTRACTS.md)", "(docs/platform/CANONICAL_CONTRACTS.md)"], ["(../../CONTRIBUTING.md)", "(CONTRIBUTING.md)"], ["(../../SECURITY.md)", "(SECURITY.md)"]] as const;
  if (replacements.some(([sourceLink]) => !source.includes(sourceLink))) throw new Error("public AGENTS.md projection source is missing a canonical link");
  return { path: PROJECTED_AGENTS_PATH, contents: replacements.reduce((contents, [from, to]) => contents.replaceAll(from, to), source) };
}

export function projectPublicTestSetup(source: string): ProjectionWrite { const privateI18n = '\n  const { default: testI18n, loadAllTestNamespaces } = await import("@/i18n/config");\n  await loadAllTestNamespaces(testI18n);\n'; if (source.split(privateI18n).length !== 2) throw new Error("src/test/setup.ts: private i18n bootstrap anchor drifted"); return { path: "src/test/setup.ts", contents: source.replace(privateI18n, "") }; }

export function projectPublicCorePackageConsumerAudit(source: string, securityRoute: string): ProjectionWrite {
  const anchor = 'const approvedPublicSecurityContact = "dev@openlup.com";';
  if (source.split(anchor).length !== 2 || securityRoute.trim() !== securityRoute || securityRoute === "" || /[\r\n]/u.test(securityRoute)) throw new Error("packages/core consumer audit security-contact projection drifted");
  return { path: "packages/core/scripts/core-package-consumer-audit.ts", contents: source.replace(anchor, `const approvedPublicSecurityContact = ${JSON.stringify(securityRoute)};`) };
}

export function assertExplicitPublicProjectionWrites(writes: Iterable<ProjectionWrite>, additionalPaths: Iterable<string> = []): void {
  const received = [...writes];
  const paths = received.map((write) => write.path);
  const expected = new Set<string>([...EXPLICIT_PUBLIC_PROJECTION_PATHS, ...additionalPaths]);
  const duplicate = paths.filter((path, index) => paths.indexOf(path) !== index);
  const unknown = paths.filter((path) => !expected.has(path));
  const missing = [...expected].filter((path) => !paths.includes(path)).sort();

  if (duplicate.length > 0) {
    throw new Error(`public projection writes duplicate output(s): ${[...new Set(duplicate)].join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new Error(`public projection writes unregistered output(s): ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`public projection writes missed registered output(s): ${missing.join(", ")}`);
  }
  if (received.some((write) => write.contents.length === 0)) {
    throw new Error("public projection writes an empty registered output");
  }
}

/** The source classes, in the fixed order `classDigest` writes them. */
export const SOURCE_CLASSES = ["copiedSourcePaths", "projectedSourcePaths", "flattenedSourcePaths", "withheldSourcePaths"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/**
 * Process surfaces whose MEMBERSHIP is repository churn rather than a publication decision.
 *
 * Each of the three is written BY the delivery process rather than describing what the process
 * ships: a wave plan is required of every change, an intent settles an owner decision before work
 * starts, and an archived incident is the durable record of one that already happened. Adding any
 * of them is bookkeeping, and an
 * enumerated class list therefore moves this digest for a reason that says nothing about what a
 * published tree would contain. The selector stands for its whole subtree instead: the digest pins
 * the selector AND the class it maps to, so retiring the selector or reclassifying the subtree still
 * moves the value, while adding one more member does not.
 *
 * Totality is unaffected - `assertExportTotality` still gives every tracked path exactly one class,
 * and only the way one already-decided class is written down changes. What the digest can no longer
 * see - one member escaping into another class - is asserted below instead, which is stricter than a
 * value no reader compares path by path.
 */
export const PINNED_CLASS_SELECTORS: readonly { selector: string; sourceClass: SourceClass }[] = [
  { selector: ".agents/", sourceClass: "withheldSourcePaths" },
  { selector: "docs/archive/", sourceClass: "withheldSourcePaths" },
  { selector: "docs/plan/", sourceClass: "withheldSourcePaths" },
];

/**
 * Collapse each pinned selector's subtree to the selector itself, after proving the subtree really
 * carries the class the pin declares. An escape throws here rather than shifting an opaque digest.
 */
export function foldPinnedClassSelectors(classes: Record<SourceClass, string[]>): Record<SourceClass, string[]> {
  const folded = Object.fromEntries(SOURCE_CLASSES.map((name) => [name, classes[name]])) as Record<SourceClass, string[]>;
  for (const { selector, sourceClass } of PINNED_CLASS_SELECTORS) {
    const escaped = SOURCE_CLASSES.filter((name) => name !== sourceClass).flatMap((name) => folded[name].filter((path) => path.startsWith(selector)));
    if (escaped.length > 0) throw new Error(`export totality: pinned selector ${selector} is classified ${sourceClass}, but ${escaped.sort().join(", ")} is not`);
    folded[sourceClass] = folded[sourceClass].filter((path) => !path.startsWith(selector));
  }
  return folded;
}

export function assertExportTotality(input: ExportTotalityInput) {
  const tracked = sortedPaths(input.trackedPaths, "export totality trackedPaths");
  const withheld = sortedPaths(input.withheldPaths, "export totality withheldPaths");
  const projected = sortedPaths(input.projectedSourcePaths ?? input.projectedPaths ?? [], "export totality projectedSourcePaths");
  const flattened = sortedPaths(input.flattenedSourcePaths ?? [], "export totality flattenedSourcePaths");
  const output = sortedPaths(input.outputPaths ?? input.publishedPaths ?? [], "export totality outputPaths");
  const trackedSet = new Set(tracked);
  const copied = sortedPaths(input.copiedSourcePaths ?? tracked.filter((path) => ![...withheld, ...projected, ...flattened].includes(path)), "export totality copiedSourcePaths");
  const classes = [copied, projected, flattened, withheld];
  const classified = new Map<string, number>();
  for (const paths of classes) for (const path of paths) {
    if (!trackedSet.has(path)) throw new Error(`export totality: unregistered source classification ${path}`);
    classified.set(path, (classified.get(path) ?? 0) + 1);
  }
  const invalid = tracked.filter((path) => classified.get(path) !== 1);
  if (invalid.length > 0) throw new Error(`export totality: source must have exactly one class: ${invalid.join(", ")}`);
  if (input.outputPaths !== undefined) {
    const missing = EXPLICIT_PUBLIC_PROJECTION_PATHS.filter((path) => !output.includes(path));
    if (missing.length > 0) throw new Error(`export totality: output inventory misses explicit projection(s): ${missing.join(", ")}`);
  }
  return { copiedSourcePaths: copied, projectedSourcePaths: projected, flattenedSourcePaths: flattened, withheldSourcePaths: withheld, outputPaths: output };
}

export function exportTotalityDigests(input: ExportTotalityInput) {
  const classes = assertExportTotality(input);
  const selectors = sortedPaths(input.withholdSelectors ?? [], "export totality withholdSelectors");
  const classificationDigests = [...(input.classificationDigests ?? [])].sort();
  if (new Set(classificationDigests).size !== classificationDigests.length || classificationDigests.some((value) => !/^sha256-[a-f0-9]{64}$/u.test(value))) throw new Error("export totality classificationDigests must be unique sha256 digests");
  const folded = foldPinnedClassSelectors(classes);
  return {
    inventoryDigest: sha256(JSON.stringify(classes.outputPaths)),
    classDigest: sha256(JSON.stringify({
      selectors,
      pinnedClassSelectors: PINNED_CLASS_SELECTORS.map(({ selector, sourceClass }) => `${sourceClass}:${selector}`).sort(),
      classificationDigests,
      copiedSourcePaths: folded.copiedSourcePaths,
      projectedSourcePaths: folded.projectedSourcePaths,
      flattenedSourcePaths: folded.flattenedSourcePaths,
      withheldSourcePaths: folded.withheldSourcePaths,
    })),
  };
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
