import { createHash } from "node:crypto";
import { posix } from "node:path";

export const PUBLIC_POLICY_REGISTRY_PATH = "config/openlup-policy-registry.json";
export const PUBLICATION_CATALOG_PATH = "config/openlup-publication-catalog.json";
export const PUBLIC_REFERENCE_BUILD_COMMAND = "npm --workspace @openlup/core run build && npm run guard:client-secret-boundary && npm run guard:public-reference-site-routes && npm run build:public-reference:client && npm run build:public-reference:ssr && npm run build:public-reference:prerender";
export const PUBLIC_TEST_SCOPE = ["scripts/oss-consume-engine.test.ts", "scripts/oss-consume-github-transport.test.ts", "scripts/packages", "packages/core", "server/_lib", "server/adapters/managed", "server/adapters/postgres", "server/domains/accounting", "server/domains/channels", "server/domains/communications", "server/domains/fulfillment", "server/domains/payment", "server/domains/platform", "server/domains/support", "server/shared", "src/checkout/machine", "src/components/admin", "src/domains/customers", "src/domains/payment", "src/domains/platform", "src/domains/shipping", "src/domains/subscription", "src/lib/orderRef.test.ts", "src/public-reference"] as const;
export const PUBLIC_TEST_COMMAND = `node scripts/run-vitest.mjs run ${PUBLIC_TEST_SCOPE.join(" ")}`;
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
function parseObject(source: string, label: string): JsonObject { let parsed: unknown; try { parsed = JSON.parse(source); } catch { throw new Error(`${label}: unreadable JSON cannot be projected`); } if (!isObject(parsed)) throw new Error(`${label}: root must be an object`); return parsed; }
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
  publicCommand("oss:published-tree", "node --experimental-strip-types scripts/oss-published-tree-check.ts"),
  publicCommand("packages:check", "node --experimental-strip-types scripts/packages/packages-check.ts"),
  publicCommand("test", PUBLIC_TEST_COMMAND),
];
export const PUBLIC_PACKAGE_EXECUTION_SURFACES: PublicPackageExecutionSurface[] = [
  { path: "package.json", digest: packageExecutionDigest({ scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }) },
  { path: "packages/core/package.json", digest: "sha256-5bb893d11455be6a250527b04ffa92845c542b24316a5f4da6f6785d7c79a47f" },
  { path: "packages/ui/package.json", digest: "sha256-e57b14ab2c433bd03ae8e71aebf8c3b4eedafcc3177bf373230d45f84bccdb0b" },
];

export function parsePublicPolicyRegistry(source: string): PublicPolicyRegistry {
  const raw = parseObject(source, PUBLIC_POLICY_REGISTRY_PATH);
  if (raw.schemaVersion !== 1) throw new Error(`${PUBLIC_POLICY_REGISTRY_PATH}: unsupported schemaVersion`);
  const activePaths = publicRegistryPaths(raw.activePaths, `${PUBLIC_POLICY_REGISTRY_PATH}: activePaths`);
  if (activePaths.some((path) => path.startsWith("docs/plan/"))) throw new Error(`${PUBLIC_POLICY_REGISTRY_PATH}: private programme path leaked into public policy registry`);
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
  const raw = parseObject(source, PUBLICATION_CATALOG_PATH);
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
