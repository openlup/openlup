import { createHash } from "node:crypto";
import { posix } from "node:path";

import { isChangelogFragmentArea, validateChangelogFragment } from "./packages/changelog-fragments.ts";
import { DuplicateJsonKeyError, parseStrictJson } from "./oss-strict-json.mts";

export const PUBLIC_POLICY_REGISTRY_PATH = "config/openlup-policy-registry.json";
export const PUBLICATION_CATALOG_PATH = "config/openlup-publication-catalog.json";
export const PUBLIC_REFERENCE_BUILD_COMMAND = "node scripts/build-packages-incremental.mjs && npm run guard:client-secret-boundary && npm run guard:public-reference-site-routes && npm run build:public-reference:client && npm run build:public-reference:ssr && npm run build:public-reference:prerender";
export const PUBLIC_TEST_SCOPE = ["api", "mcp", "scripts", "server", "src", "tests"] as const;
export const PUBLIC_TEST_COMMAND = "node scripts/run-vitest.mjs run";
export type ContractOwner = { id: string; owners: [string] };
export type PublicPolicyRegistry = { schemaVersion: 1; activePaths: string[]; contracts: ContractOwner[] };
export type PublicGuardViability = { id: string; status: "published"; path: string; command: string; publicInputs: string[]; publicDocs: string[]; publicCiEntrypoint: string; seededFalsifier: string } | { id: string; status: "withheld"; reason: string; withheldPaths: string[]; withheldCommands: string[] };
export type PublicPackageCommand = { name: string; command: string; publicDocs: string[]; publicCiEntrypoint: string; seededFalsifier: string };
export type PublicPackageExecutionSurface = { path: string; digest: string };
export type PublicCatalogPath = { path: string; class: string };
export type PublicPublicationCatalog = { schemaVersion: 1 | 2 | 3; publicPaths: PublicCatalogPath[]; packageCommands: PublicPackageCommand[]; packageExecutionSurfaces: PublicPackageExecutionSurface[]; guardViability: PublicGuardViability[] };
type JsonObject = Record<string, unknown>;
const digest = (contents: string): string => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
function parseObject(source: string, label: string, parse: (source: string) => unknown = JSON.parse): JsonObject {
  let parsed: unknown;
  try { parsed = parse(source); }
  catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw error;
    throw new Error(`${label}: unreadable JSON cannot be projected`);
  }
  if (!isObject(parsed)) throw new Error(`${label}: root must be an object`);
  return parsed;
}
export function publicRegistryPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new Error(`${label}: expected a string array`);
  const paths = value as string[];
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error(`${label}: paths must be unique and sorted`);
  for (const path of paths) if (path.startsWith("/") || path.includes("\\") || path === "." || path.startsWith("../") || posix.normalize(path) !== path) throw new Error(`${label}: invalid repository-relative path ${path}`);
  return paths;
}
export function publicRegistryOwners(value: unknown, label: string, active: Set<string>): ContractOwner[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  const contracts = value.map((row, index) => {
    if (!isObject(row) || typeof row.id !== "string" || !Array.isArray(row.owners) || row.owners.length !== 1 || typeof row.owners[0] !== "string") throw new Error(`${label}[${index}]: each contract needs exactly one registered owner`);
    if (!active.has(row.owners[0])) throw new Error(`${label}[${index}]: owner ${row.owners[0]} is not an active path`);
    return { id: row.id, owners: [row.owners[0]] as [string] };
  });
  const ids = contracts.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) throw new Error(`${label}: contract ids must be unique and sorted`);
  return contracts;
}
const PUBLIC_CI = ".github/workflows/published-tree-ci.yml";
const publicCommand = (name: string, command: string): PublicPackageCommand => ({ name, command, publicDocs: ["CONTRIBUTING.md", "README.md"], publicCiEntrypoint: PUBLIC_CI, seededFalsifier: "scripts/oss-published-tree-check.test.ts" });
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
export function packageExecutionDigest(value: { scripts?: Record<string, string>; bin?: string | Record<string, string> }): string { return digest(stableJson({ scripts: value.scripts ?? {}, bin: value.bin ?? {} })); }
export const PUBLIC_PACKAGE_COMMANDS: PublicPackageCommand[] = [
  publicCommand("build", "npm run build:public-reference"),
  publicCommand("build:public-reference", PUBLIC_REFERENCE_BUILD_COMMAND),
  publicCommand("build:public-reference:client", "OPENLUP_BUILD_TARGET=public-reference vite build --configLoader native"),
  publicCommand("build:public-reference:prerender", "node --experimental-strip-types scripts/oss-reference-prerender.ts"),
  publicCommand("build:public-reference:ssr", "OPENLUP_BUILD_TARGET=public-reference-ssr vite build --configLoader native"),
  publicCommand("check:dco-signoff", "node --experimental-strip-types scripts/dco-signoff-check.ts"),
  publicCommand("guard:client-secret-boundary", "node --experimental-strip-types scripts/check-client-secret-boundary.ts"),
  publicCommand("guard:public-reference-site-routes", "node scripts/site-routes.mjs --public-reference"),
  publicCommand("inventory:refresh", "node --import tsx scripts/installation-inventory-refresh.ts"),
  publicCommand("landing:merge", "node scripts/agent-review-landing.mjs"),
  publicCommand("migration:finalize", "node scripts/migration-finalize.mjs"),
  publicCommand("lint", "node scripts/ast-grep/check-filewide-ignore.mjs && ast-grep scan --error=no-suppress-all --error=unused-suppression && ast-grep test --skip-snapshot-tests && eslint ."),
  publicCommand("preflight", "node --experimental-strip-types scripts/preflight.ts"),
  publicCommand("prelint", "node scripts/build-packages-incremental.mjs"),
  publicCommand("oss:published-tree", "node --experimental-strip-types scripts/oss-published-tree-check.ts"),
  publicCommand("packages:check", "node --experimental-strip-types scripts/packages/packages-check.ts"),
  publicCommand("release:bump", "node --experimental-strip-types scripts/packages/release-bump.ts"),
  publicCommand("release:docs-pass", "node --experimental-strip-types scripts/packages/release-docs-pass.ts"),
  publicCommand("sql:admit", "node --experimental-strip-types scripts/sql-admit.ts"),
  publicCommand("pretest", "node scripts/build-packages-incremental.mjs"),
  publicCommand("test", PUBLIC_TEST_COMMAND),
  publicCommand("test:hosted", "node scripts/test-hosted.mjs"),
  publicCommand("test:scoped", "scope_file=$(mktemp) && trap 'rm -f \"$scope_file\"' EXIT && export OPENLUP_VITEST_EXCLUDE_FILE=\"$scope_file\" && node scripts/ci-test-scope.mjs && npm test"),
];
export const PUBLIC_PACKAGE_EXECUTION_SURFACES: PublicPackageExecutionSurface[] = [
  { path: "examples/neutral-store/package.json", digest: "sha256-f13fb832ebc96fc06a087c8932f84194d5f51cf3b629a6a731f5410504611d45" },
  { path: "package.json", digest: packageExecutionDigest({ scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }) },
  { path: "packages/core/package.json", digest: "sha256-4f6bcde0848f6c84669b06720154b12e47a3f73d75a1cfd7f54fd7802bc745ca" },
  { path: "packages/outbox/package.json", digest: "sha256-a360b29145594eb1e103130637c52225910ff5ea07a41d46d9db34bc43279dfa" },
  { path: "packages/platform/package.json", digest: "sha256-782411925db131f063378b285055974b019b58f518c7ca9602346012a00a17d4" },
  { path: "packages/ui/package.json", digest: "sha256-e57b14ab2c433bd03ae8e71aebf8c3b4eedafcc3177bf373230d45f84bccdb0b" },
];

export function parsePublicPolicyRegistry(source: string): PublicPolicyRegistry {
  const raw = parseObject(source, PUBLIC_POLICY_REGISTRY_PATH);
  if (raw.schemaVersion !== 1) throw new Error(`${PUBLIC_POLICY_REGISTRY_PATH}: unsupported schemaVersion`);
  const activePaths = publicRegistryPaths(raw.activePaths, `${PUBLIC_POLICY_REGISTRY_PATH}: activePaths`);
  return { schemaVersion: 1, activePaths, contracts: publicRegistryOwners(raw.contracts, `${PUBLIC_POLICY_REGISTRY_PATH}: contracts`, new Set(activePaths)) };
}
function parsePackageCommands(value: unknown): PublicPackageCommand[] {
  if (!Array.isArray(value)) throw new Error(`${PUBLICATION_CATALOG_PATH}: packageCommands must be an array`);
  const commands = value.map((row, index): PublicPackageCommand => {
    if (!isObject(row) || typeof row.name !== "string" || typeof row.command !== "string" || typeof row.publicCiEntrypoint !== "string" || typeof row.seededFalsifier !== "string") throw new Error(`${PUBLICATION_CATALOG_PATH}: packageCommands[${index}] is incomplete`);
    return { name: row.name, command: row.command, publicDocs: publicRegistryPaths(row.publicDocs, `${PUBLICATION_CATALOG_PATH}: ${row.name}.publicDocs`), publicCiEntrypoint: row.publicCiEntrypoint, seededFalsifier: row.seededFalsifier };
  });
  if (JSON.stringify(commands) !== JSON.stringify(PUBLIC_PACKAGE_COMMANDS)) throw new Error(`${PUBLICATION_CATALOG_PATH}: package command catalogue drifted from the closed public inventory`);
  return commands;
}
export function parsePublicPublicationCatalog(source: string): PublicPublicationCatalog {
  const raw = parseObject(source, PUBLICATION_CATALOG_PATH, (contents) => parseStrictJson(contents, PUBLICATION_CATALOG_PATH));
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) || !Array.isArray(raw.publicPaths) || !Array.isArray(raw.guardViability)) throw new Error(`${PUBLICATION_CATALOG_PATH}: unsupported schema or missing public inventory`);
  if ("dispositions" in raw || "privateReadiness" in raw || "downstreamReceipt" in raw) throw new Error(`${PUBLICATION_CATALOG_PATH}: private publication state must not leak into the public catalogue`);
  const publicPaths = raw.publicPaths.map((row, index) => { if (!isObject(row) || typeof row.path !== "string" || typeof row.class !== "string" || row.class === "") throw new Error(`${PUBLICATION_CATALOG_PATH}: publicPaths[${index}] needs path/class`); return { path: row.path, class: row.class }; });
  const orderedPaths = publicRegistryPaths(publicPaths.map(({ path }) => path), `${PUBLICATION_CATALOG_PATH}: publicPaths`);
  const guardViability = raw.guardViability.map((row, index): PublicGuardViability => {
    if (!isObject(row) || typeof row.id !== "string" || (row.status !== "published" && row.status !== "withheld")) throw new Error(`${PUBLICATION_CATALOG_PATH}: guardViability[${index}] needs id/status`);
    if (row.status === "withheld") {
      if (typeof row.reason !== "string" || row.reason.trim() === "") throw new Error(`${PUBLICATION_CATALOG_PATH}: withheld guard ${row.id} needs a reason`);
      if (["path", "command", "publicInputs", "publicDocs", "publicCiEntrypoint", "seededFalsifier"].some((key) => key in row)) throw new Error(`${PUBLICATION_CATALOG_PATH}: withheld guard ${row.id} must not masquerade as a published guard`);
      return { id: row.id, status: "withheld", reason: row.reason, withheldPaths: publicRegistryPaths(row.withheldPaths, `${PUBLICATION_CATALOG_PATH}: ${row.id}.withheldPaths`), withheldCommands: publicRegistryPaths(row.withheldCommands, `${PUBLICATION_CATALOG_PATH}: ${row.id}.withheldCommands`) };
    }
    if (typeof row.path !== "string" || typeof row.command !== "string" || typeof row.publicCiEntrypoint !== "string" || typeof row.seededFalsifier !== "string") throw new Error(`${PUBLICATION_CATALOG_PATH}: published guard ${row.id} needs path/command/CI/falsifier`);
    return { id: row.id, status: "published", path: row.path, command: row.command, publicInputs: publicRegistryPaths(row.publicInputs, `${PUBLICATION_CATALOG_PATH}: ${row.id}.publicInputs`), publicDocs: publicRegistryPaths(row.publicDocs, `${PUBLICATION_CATALOG_PATH}: ${row.id}.publicDocs`), publicCiEntrypoint: row.publicCiEntrypoint, seededFalsifier: row.seededFalsifier };
  });
  const ids = guardViability.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) throw new Error(`${PUBLICATION_CATALOG_PATH}: guard ids must be unique and sorted`);
  const packageCommands = raw.schemaVersion === 1 ? [] : parsePackageCommands(raw.packageCommands);
  const packageExecutionSurfaces = raw.schemaVersion !== 3 ? [] : (() => {
    if (!Array.isArray(raw.packageExecutionSurfaces)) throw new Error(`${PUBLICATION_CATALOG_PATH}: packageExecutionSurfaces must be an array`);
    const surfaces = raw.packageExecutionSurfaces.map((row, index): PublicPackageExecutionSurface => { if (!isObject(row) || typeof row.path !== "string" || typeof row.digest !== "string" || !/^sha256-[a-f0-9]{64}$/u.test(row.digest)) throw new Error(`${PUBLICATION_CATALOG_PATH}: packageExecutionSurfaces[${index}] is malformed`); return { path: row.path, digest: row.digest }; });
    publicRegistryPaths(surfaces.map(({ path }) => path), `${PUBLICATION_CATALOG_PATH}: packageExecutionSurfaces`);
    if (JSON.stringify(surfaces) !== JSON.stringify(PUBLIC_PACKAGE_EXECUTION_SURFACES)) throw new Error(`${PUBLICATION_CATALOG_PATH}: package execution surfaces drifted from the closed public inventory`);
    return surfaces;
  })();
  return { schemaVersion: raw.schemaVersion, publicPaths: orderedPaths.map((path) => publicPaths.find((row) => row.path === path)!), packageCommands, packageExecutionSurfaces, guardViability };
}
export function createPublicPublicationCatalog(publicPaths: PublicCatalogPath[], guardViability: PublicGuardViability[]) { const contents = `${JSON.stringify({ schemaVersion: 3, publicPaths, packageCommands: PUBLIC_PACKAGE_COMMANDS, packageExecutionSurfaces: PUBLIC_PACKAGE_EXECUTION_SURFACES, guardViability }, null, 2)}\n`; parsePublicPublicationCatalog(contents); return { contents, digest: digest(contents) }; }
export function publicPublicationCatalogDigests(source: string) { const catalog = parsePublicPublicationCatalog(source); return { inventoryDigest: digest(JSON.stringify(catalog.publicPaths.map(({ path }) => path))), classDigest: digest(JSON.stringify(catalog.publicPaths)) }; }

/** The reader guide: Markdown pages under `packages/core/docs/guide/`, admitted by pattern like fragments. */
export const isGuidePageArea = (path: string): boolean => /^packages\/core\/docs\/guide(?:\/|$)/u.test(path);
export const isGuidePage = (path: string): boolean => /^packages\/core\/docs\/guide\/(?:[a-z0-9][a-z0-9-]*\/)*[A-Za-z0-9][A-Za-z0-9_-]*\.md$/u.test(path);
// The copied catalogue sample is documentation material, not an execution entrypoint.
export const isCatalogueSkeleton = (path: string): boolean => /^packages\/core\/docs\/guide\/how-to\/extend\/catalogue-pack-skeleton\/(?:catalogue\.json|(?:catalogue|pack|fixtures)\.ts)$/u.test(path);
/** Regular readable Markdown or the closed copied sample; executable modes remain refused. */
export function validateGuidePage(path: string, bytes: string | Buffer, mode: string): string {
  if ((!isGuidePage(path) && !isCatalogueSkeleton(path)) || mode !== "100644") throw new Error(`${path}: guide pages must be docs/guide/**/*.md with lowercase directories, regular and non-executable`);
  let contents: string;
  try { contents = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`${path}: guide page is not UTF-8`); }
  if (!contents.trim() || Buffer.from(contents).some((byte) => (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f)) throw new Error(`${path}: empty or malformed guide page`);
  if (/^[\t ]*(?:<{7}|={7}|>{7}|\|{7})/mu.test(contents)) throw new Error(`${path}: guide page refuses conflict markers`);
  return contents;
}

/** Hand-authored package SQL files that are not projected from `config/platform-migration-manifest.json`. */
export const HAND_AUTHORED_PACKAGE_SQL_PATHS = new Set([
  "packages/platform/sql/20260809150001_job_run_ledger_v3.sql",
]);
/** Platform SQL migrations and their projected package mirrors, admitted by manifest-pinned pattern. */
export const isManifestPinnedSqlArea = (path: string): boolean =>
  (/^db\/platform\/migrations\/.+\.sql$/u.test(path) || /^packages\/platform\/sql\/.+\.sql$/u.test(path))
  && !HAND_AUTHORED_PACKAGE_SQL_PATHS.has(path);

const PLATFORM_MIGRATION_MANIFEST_PATH = "config/platform-migration-manifest.json";
const CANONICAL_PLATFORM_MIGRATION_PATH = /^db\/platform\/migrations\/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

/** Regular non-executable UTF-8 SQL without NUL/control characters, bound to its manifest SHA-256 pin. */
export function validateManifestPinnedSql(path: string, bytes: string | Buffer, mode: string, expectedSha256: string): string {
  if (mode !== "100644") throw new Error(`${path}: platform SQL migration must be regular and non-executable`);
  const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  let contents: string;
  try { contents = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${path}: platform SQL migration is not UTF-8`); }
  if (!contents.trim() || raw.some((byte) => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) {
    throw new Error(`${path}: empty or control-character platform SQL migration is refused`);
  }
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== expectedSha256) throw new Error(`${path}: platform SQL migration SHA-256 mismatch against ${PLATFORM_MIGRATION_MANIFEST_PATH}`);
  return contents;
}

function readManifestPinnedSqlDigests(read: (path: string) => string | Buffer | undefined): Map<string, string> {
  const raw = read(PLATFORM_MIGRATION_MANIFEST_PATH);
  if (raw === undefined) throw new Error(`${PLATFORM_MIGRATION_MANIFEST_PATH}: platform migration manifest is absent`);
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const manifest = parseObject(text, PLATFORM_MIGRATION_MANIFEST_PATH, (contents) => parseStrictJson(contents, PLATFORM_MIGRATION_MANIFEST_PATH));
  const pinned = new Map<string, string>();
  const register = (path: string, sha256: string) => {
    const existing = pinned.get(path);
    if (existing !== undefined && existing !== sha256) {
      throw new Error(`${PLATFORM_MIGRATION_MANIFEST_PATH}: conflicting sha256 pin for ${path}`);
    }
    pinned.set(path, sha256);
  };
  const registerUnit = (unit: unknown, label: string) => {
    if (!isObject(unit) || typeof unit.file !== "string" || !CANONICAL_PLATFORM_MIGRATION_PATH.test(unit.file)
      || typeof unit.sha256 !== "string" || !HEX_SHA256.test(unit.sha256)) {
      throw new Error(`${PLATFORM_MIGRATION_MANIFEST_PATH}: ${label} must pin a canonical db/platform/migrations/*.sql path and sha256`);
    }
    register(unit.file, unit.sha256);
    register(`packages/platform/sql/${unit.file.slice("db/platform/migrations/".length)}`, unit.sha256);
  };
  const plans: [string, unknown][] = [
    ["root", manifest],
    ...(manifest.qualified !== undefined ? [["qualified", manifest.qualified] as [string, unknown]] : []),
    ...(manifest.qualifiedAdmin !== undefined ? [["qualifiedAdmin", manifest.qualifiedAdmin] as [string, unknown]] : []),
  ];
  for (const [name, plan] of plans) {
    if (!isObject(plan)) throw new Error(`${PLATFORM_MIGRATION_MANIFEST_PATH}: ${name} plan must be an object`);
    if (plan.baseline !== undefined) registerUnit(plan.baseline, `${name}.baseline`);
    if (plan.forward !== undefined) {
      if (!Array.isArray(plan.forward)) throw new Error(`${PLATFORM_MIGRATION_MANIFEST_PATH}: ${name}.forward must be an array`);
      for (const [index, unit] of plan.forward.entries()) registerUnit(unit, `${name}.forward[${index}]`);
    }
  }
  return pinned;
}

/** Exact authored rows, plus the three content-validated pattern admissions: changelog fragments, guide pages, and manifest-pinned platform SQL migrations. */
export function effectivePublicCatalogPaths(source: string, entries: readonly { path: string; mode: string }[], read: (path: string) => string | Buffer | undefined): PublicCatalogPath[] {
  const rows = parsePublicPublicationCatalog(source).publicPaths;
  const fragments = entries.filter(({ path }) => isChangelogFragmentArea(path));
  for (const { path, mode } of fragments) {
    const bytes = read(path);
    if (bytes === undefined) throw new Error(`${path}: fragment is absent`);
    validateChangelogFragment(path, bytes, mode);
    if (rows.some((row) => row.path === path)) throw new Error(`${path}: fragments use pattern admission, not per-file catalog rows`);
  }
  const guide = entries.filter(({ path }) => isGuidePageArea(path));
  for (const { path, mode } of guide) {
    const bytes = read(path);
    if (bytes === undefined) throw new Error(`${path}: guide page is absent`);
    validateGuidePage(path, bytes, mode);
  }
  for (const row of rows) if (isGuidePageArea(row.path)) throw new Error(`${row.path}: guide pages use pattern admission, not per-file catalog rows`);
  for (const row of rows) if (isManifestPinnedSqlArea(row.path)) throw new Error(`${row.path}: platform migrations use manifest-pinned pattern admission, not per-file catalog rows`);
  const migrations = entries.filter(({ path }) => isManifestPinnedSqlArea(path));
  if (migrations.length > 0) {
    const pinned = readManifestPinnedSqlDigests(read);
    for (const { path, mode } of migrations) {
      const expected = pinned.get(path);
      if (expected === undefined) throw new Error(`${path}: unmanifested platform SQL migration is refused by manifest-pinned pattern admission`);
      const bytes = read(path);
      if (bytes === undefined) throw new Error(`${path}: platform SQL migration is absent`);
      validateManifestPinnedSql(path, bytes, mode, expected);
    }
  }
  return [...rows, ...[...fragments, ...guide, ...migrations].map(({ path }) => ({ path, class: "public-output" }))].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
