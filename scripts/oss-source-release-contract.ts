import { createHash } from "node:crypto";
import { evaluatePlatformMigrationManifest, type PlatformMigrationManifest } from "./platform-migration-manifest.ts";
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve, sep } from "node:path";
import { PUBLICATION_CATALOG_PATH, PUBLIC_POLICY_REGISTRY_PATH, packageExecutionDigest, parsePublicPolicyRegistry, parsePublicPublicationCatalog, publicPublicationCatalogDigests } from "./oss-publication-policy.ts";
import { PUBLIC_EXECUTION_ENTRYPOINTS, isDirectExecutionEntrypoint } from "./oss-publication-contract.ts";
import { readPublicTypecheckCompatibility, type PublicTypecheckCompatibility } from "./oss-public-typecheck.ts";
import { authenticateGithubSourceRelease, parseSourceReleaseReceiptEnvelope, renderSourceReleaseAllowlist, type AuthenticatedSourceCandidate, type GithubFetch, type GithubSourceTransportInput, type PublicObjectInventoryEntry, type SourceReceiptEnvelope } from "./oss-consume-github-transport.ts";
import { documentationGit } from "./documentation-routing.ts";

export const SOURCE_RELEASE_CONTRACT_PATH = "config/openlup-source-release-contract.json";
export const SOURCE_RELEASE_EVIDENCE_CLASS = "local-fixture";
export const RESERVED_FIXTURE_COORDINATE = "https://openlup.invalid/source-release-fixture";
export const RESERVED_FIXTURE_SECURITY_ROUTE = "security@openlup.invalid";
export const CANONICAL_ACTIVATION_REPOSITORY = "https://github.com/openlup/openlup";
export const CANONICAL_ACTIVATION_SECURITY_ROUTE = "dev@openlup.com";
export const CANONICAL_ACTIVATION_TAG = "openlup-source-preview/1";
export const CANONICAL_ACTIVATION_TAG_MESSAGE = "OpenLup source preview 1.";
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
export const isValidPublicSecurityRoute = (value: unknown, allowFixture = false): value is string => typeof value === "string" && value === value.trim() && value.length <= 254 && EMAIL.test(value) && (!value.endsWith(".invalid") || (allowFixture && value === RESERVED_FIXTURE_SECURITY_ROUTE));
type JsonObject = Record<string, unknown>;
export type SourceReleaseContractInput = { inventoryDigest: string; classDigest: string; packageDigest: string; rootLockDigest: string; coreLockDigest: string; migrationManifestDigest: string; databaseTypesDigest: string; policyRegistryDigest: string; publicationCatalogDigest: string; compatibility?: PublicTypecheckCompatibility };
export type SourceReleaseIdentity =
  | { evidenceClass: "local-fixture"; coordinate?: undefined; securityRoute?: undefined; owner?: undefined }
  | { evidenceClass: "activation-candidate"; coordinate: string; securityRoute: string; owner: { name: string; email: string } };
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const validDigest = (value: unknown): value is string => typeof value === "string" && /^sha256-[a-f0-9]{64}$/u.test(value);
const digest = (contents: string | Buffer): string => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
function parse(source: string): JsonObject {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: unreadable JSON cannot be projected`); }
  if (!object(raw)) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: root must be an object`);
  return raw;
}

function activationRepository(identity: SourceReleaseIdentity) {
  if (identity.evidenceClass === SOURCE_RELEASE_EVIDENCE_CLASS) return { coordinate: RESERVED_FIXTURE_COORDINATE, securityRoute: RESERVED_FIXTURE_SECURITY_ROUTE };
  const validCoordinate = identity.coordinate === CANONICAL_ACTIVATION_REPOSITORY;
  const validRoute = identity.securityRoute === CANONICAL_ACTIVATION_SECURITY_ROUTE;
  const validOwner = identity.owner.name.trim() !== "" && !/(?:fixture|placeholder|todo|replace|example)/iu.test(identity.owner.name) && isValidPublicSecurityRoute(identity.owner.email) && !/(?:placeholder|example)/iu.test(identity.owner.email);
  if (!validCoordinate || identity.coordinate.includes(".invalid") || !validRoute || !validOwner) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: activation-candidate requires owner-supplied canonical GitHub identity and neutral non-.invalid security route`);
  return { coordinate: identity.coordinate, securityRoute: identity.securityRoute, owner: identity.owner };
}

export function createSourceReleaseContract(input: SourceReleaseContractInput, identity: SourceReleaseIdentity = { evidenceClass: SOURCE_RELEASE_EVIDENCE_CLASS }) {
  const { compatibility, ...digests } = input;
  for (const [name, value] of Object.entries(digests)) if (!validDigest(value)) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: ${name} must be a sha256 digest`);
  if (compatibility !== undefined) readPublicTypecheckCompatibility(JSON.stringify({ compatibility }));
  const fixture = identity.evidenceClass === SOURCE_RELEASE_EVIDENCE_CLASS;
  const contents = `${JSON.stringify({
    schemaVersion: 1,
    runtime: { node: "24.x", npm: "11.19.0" },
    inventory: { digest: input.inventoryDigest, classDigest: input.classDigest },
    packages: { manifestDigest: input.packageDigest, rootLockDigest: input.rootLockDigest, coreLockDigest: input.coreLockDigest },
    platformMigrationManifest: { path: "config/platform-migration-manifest.json", digest: input.migrationManifestDigest },
    databaseSchema: { path: "src/integrations/supabase/types.ts", binding: "unbound", replacement: "adopter-generated-required", digest: input.databaseTypesDigest },
    policy: { registryDigest: input.policyRegistryDigest, publicationCatalogDigest: input.publicationCatalogDigest },
    ...(compatibility === undefined ? {} : { compatibility }),
    repository: activationRepository(identity),
    release: { posture: "development-preview", stability: fixture ? "unstable" : "preview", evidenceClass: identity.evidenceClass },
  }, null, 2)}\n`;
  return { contents, digest: digest(contents) };
}

function validActivationRepository(repository: JsonObject): boolean {
  const owner = repository.owner;
  return repository.coordinate === CANONICAL_ACTIVATION_REPOSITORY && repository.securityRoute === CANONICAL_ACTIVATION_SECURITY_ROUTE && object(owner) && typeof owner.name === "string" && owner.name.trim() !== "" && !/(?:fixture|placeholder|todo|replace|example)/iu.test(owner.name) && isValidPublicSecurityRoute(owner.email) && !/(?:placeholder|example)/iu.test(owner.email);
}

export function validateSourceReleaseContract(source: string): void {
  const raw = parse(source);
  if (raw.schemaVersion !== 1 || "commit" in raw || "tree" in raw) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: must be schemaVersion 1 and non-circular`);
  const runtime = raw.runtime;
  const release = raw.release;
  const repository = raw.repository;
  if (!object(runtime) || runtime.node !== "24.x" || runtime.npm !== "11.19.0" || !object(release) || release.posture !== "development-preview" || !object(repository)) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: invalid release posture`);
  if (release.evidenceClass === SOURCE_RELEASE_EVIDENCE_CLASS) {
    if (release.stability !== "unstable" || repository.coordinate !== RESERVED_FIXTURE_COORDINATE || repository.securityRoute !== RESERVED_FIXTURE_SECURITY_ROUTE) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: pre-act identity must use the exact reserved .invalid coordinates`);
  } else if (release.evidenceClass === "activation-candidate") {
    if (release.stability !== "preview" || !validActivationRepository(repository)) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: activation-candidate requires canonical non-placeholder owner identity`);
  } else throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: unknown evidence class`);
  const inventory = raw.inventory as JsonObject | undefined;
  const packages = raw.packages as JsonObject | undefined;
  const migration = raw.platformMigrationManifest as JsonObject | undefined;
  const database = raw.databaseSchema as JsonObject | undefined;
  const policy = raw.policy as JsonObject | undefined;
  const required = [inventory?.digest, inventory?.classDigest, packages?.manifestDigest, packages?.rootLockDigest, packages?.coreLockDigest, migration?.digest, database?.digest, policy?.registryDigest, policy?.publicationCatalogDigest];
  if (required.some((value) => !validDigest(value))) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: missing bound digest`);
  if (database?.path !== "src/integrations/supabase/types.ts" || database.binding !== "unbound" || database.replacement !== "adopter-generated-required") throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: database schema seam must remain explicitly unbound`);
  if (raw.compatibility !== undefined) readPublicTypecheckCompatibility(source);
  const sourceSeed = raw.sourceSeed as JsonObject | undefined;
  if (sourceSeed !== undefined && (!object(sourceSeed) || !validDigest(sourceSeed.publicationCatalogInventoryDigest) || !validDigest(sourceSeed.publicationCatalogClassDigest))) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: invalid source publication-catalog seed digest`);
}

/**
 * The DOWNSTREAM adoption form of the contract.
 *
 * This repository no longer tracks a contract: it computes one and writes it into the tree it
 * publishes. A repository that ADOPTS that published tree does track one, and the two functions
 * below are the whole of what the upstream-adoption handler
 * (`scripts/oss-upstream-adoption-projections.ts`) needs to say that an adopter's tracked bytes are
 * the upstream materialization plus the adopter's own publication-catalog seed - nothing more.
 * They are deliberately not reachable from the export or from any gate this branch runs.
 */
export function trackedSourceReleaseContractContents(publicationCatalog: string, materialized: string): string {
  const expected = parse(materialized);
  validateSourceReleaseContract(materialized);
  const { repository, release, ...body } = expected;
  const seed = publicPublicationCatalogDigests(publicationCatalog);
  return `${JSON.stringify({ ...body, sourceSeed: { publicationCatalogInventoryDigest: seed.inventoryDigest, publicationCatalogClassDigest: seed.classDigest }, repository, release }, null, 2)}\n`;
}

export function assertTrackedSourceReleaseContract(raw: string, publicationCatalog: string, materialized: string): void {
  const tracked = parse(raw);
  validateSourceReleaseContract(raw);
  const sourceSeed = tracked.sourceSeed;
  const seed = publicPublicationCatalogDigests(publicationCatalog);
  if (!object(sourceSeed) || JSON.stringify(sourceSeed) !== JSON.stringify({ publicationCatalogInventoryDigest: seed.inventoryDigest, publicationCatalogClassDigest: seed.classDigest })) throw new Error("source-release contract sourceSeed is stale");
  const expected = trackedSourceReleaseContractContents(publicationCatalog, materialized);
  if (raw !== expected) throw new Error(`source-release tracked contract differs from the upstream materialized contract byte-for-byte. Fields that moved: ${sourceReleaseContractChangedFields(parse(raw), parse(expected)).join(", ") || "none nameable"}.`);
}

export function sourceReleaseContractChangedFields(before: unknown, after: unknown, prefix = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!object(before) || !object(after)) return [prefix || "$ref"];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => sourceReleaseContractChangedFields(before[key], after[key], prefix === "" ? key : `${prefix}.${key}`));
}

const MIGRATION_MANIFEST_PATH = "config/platform-migration-manifest.json";
const DATABASE_TYPES_PATH = "src/integrations/supabase/types.ts";
/** Returns one file's bytes from the tree being described, or `undefined` when the path is absent. */
export type SourceReleaseBlobReader = (path: string) => Buffer | string | undefined;

/**
 * Derives the source-release contract a tree describes. Every digest field comes from the tree's
 * own bytes: the inventory and class digests from the publication catalogue, the package digests
 * from `package.json` and the two lockfiles, and the remaining digests from the files they name.
 * Identity and `compatibility` come from the tree's current contract. The descendant producer
 * refuses a tree whose contract differs from this result; after a dependency or catalogue change,
 * write `contents` back to `config/openlup-source-release-contract.json`.
 */
export function deriveSourceReleaseContract(readBlob: SourceReleaseBlobReader): { contents: string; digest: string } {
  const read = (path: string) => { const bytes = readBlob(path); if (bytes === undefined) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: derivation input is absent: ${path}`); return bytes; };
  const current = read(SOURCE_RELEASE_CONTRACT_PATH).toString();
  validateSourceReleaseContract(current);
  const raw = parse(current), repository = raw.repository as JsonObject, release = raw.release as JsonObject, owner = repository.owner as JsonObject;
  const identity: SourceReleaseIdentity = release.evidenceClass === "activation-candidate"
    ? { evidenceClass: "activation-candidate", coordinate: repository.coordinate as string, securityRoute: repository.securityRoute as string, owner: { name: owner.name as string, email: owner.email as string } }
    : { evidenceClass: SOURCE_RELEASE_EVIDENCE_CLASS };
  const catalog = read(PUBLICATION_CATALOG_PATH), catalogDigests = publicPublicationCatalogDigests(catalog.toString());
  return createSourceReleaseContract({
    inventoryDigest: catalogDigests.inventoryDigest,
    classDigest: catalogDigests.classDigest,
    packageDigest: digest(read("package.json")),
    rootLockDigest: digest(read("package-lock.json")),
    coreLockDigest: digest(read("packages/core/package-lock.json")),
    migrationManifestDigest: digest(read(MIGRATION_MANIFEST_PATH)),
    databaseTypesDigest: digest(read(DATABASE_TYPES_PATH)),
    policyRegistryDigest: digest(read(PUBLIC_POLICY_REGISTRY_PATH)),
    publicationCatalogDigest: digest(catalog),
    ...(raw.compatibility === undefined ? {} : { compatibility: raw.compatibility as PublicTypecheckCompatibility }),
  }, identity);
}

export type DescendantSourceReleaseInput = {
  root: string;
  previous: GithubSourceTransportInput;
  fetcher?: GithubFetch;
  releaseTag: string;
  tagMessage: string;
  releaseNote: string | Buffer;
  outputPath: string;
  /** Previous projection selectors this release retires; canonical, sorted and unique. Unnamed rows are always carried forward. */
  retireProjectedSelectors?: readonly string[];
};
export type DescendantSourceReleaseResult = { receipt: Extract<SourceReceiptEnvelope, { schemaVersion: 5 }>; contents: string; digest: string; allowlist: string; allowlistDigest: string };
const receiptDigest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const commitSha = (value: string) => /^[0-9a-f]{40}$/u.test(value);
const gitRead = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const gitBytes = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, maxBuffer: GIT_OUTPUT_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
function gitInventory(root: string, revision: string): PublicObjectInventoryEntry[] {
  const rows = gitBytes(root, ["ls-tree", "-r", "-z", "--full-tree", revision]).toString().split("\0").filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if (!match || match[3]!.startsWith("/") || match[3]!.includes("\\") || match[3]!.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("descendant receipt requires regular canonical Git paths");
    return { path: match[3]!, mode: match[1] as "100644" | "100755", gitBlobSha: match[2]! };
  });
  return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function inventoryPaths(root: string, entries: PublicObjectInventoryEntry[]) { return entries.map((entry) => ({ path: entry.path, mode: entry.mode, digest: receiptDigest(gitBytes(root, ["cat-file", "blob", entry.gitBlobSha])) })); }
function safeReceiptOutput(root: string, path: string): string {
  if (!isAbsolute(path)) throw new Error("descendant receipt output must be an absolute external path");
  const source = realpathSync(root), target = resolve(path), prefixes = target.split(sep).slice(1).map((_, index, parts) => `${sep}${parts.slice(0, index + 1).join(sep)}`);
  for (const prefix of prefixes) { const state = lstatSync(prefix, { throwIfNoEntry: false }); if (!state) break; if (state.isSymbolicLink()) throw new Error("descendant receipt output refuses symlink traversal"); }
  const parent = realpathSync(dirname(target)); if (target === source || target.startsWith(`${source}${sep}`) || parent === source || parent.startsWith(`${source}${sep}`)) throw new Error("descendant receipt output must stay outside the checkout");
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error("descendant receipt output already exists"); return target;
}
const SCHEMA_BEARING_PATHS = new Set<string>([MIGRATION_MANIFEST_PATH, DATABASE_TYPES_PATH, PUBLIC_POLICY_REGISTRY_PATH]);
/** A path subject to the frozen-schema or append-only-forward release rules: it carries the platform database or policy schema. */
const isSchemaBearingSourceReleasePath = (path: string): boolean => SCHEMA_BEARING_PATHS.has(path) || path.startsWith("db/platform/migrations/") || path.startsWith("supabase/migrations/") || (path.startsWith("db/bootstrap/") && path.toLowerCase().endsWith(".sql"));
/** Contract fields a descendant keeps from the previous release; the validator separately fixes `runtime`. */
const PREVIOUS_RELEASE_CONTRACT_FIELDS = ["schemaVersion", "platformMigrationManifest.path", "databaseSchema", "policy.registryDigest", "repository", "release"] as const;
/** A deliberately bounded SQL admission check, not a general SQL interpreter.
 * Comments and literal values cannot hide syntax; procedural/dynamic SQL refuses.
 * Existing SQL is frozen, so only new forwards pass through this predicate.
 */
export function isExpandOnlyPlatformForward(sql: string): boolean {
  const tokens: string[] = [];
  for (let index = 0; index < sql.length;) {
    const rest = sql.slice(index);
    if (/^\s/u.test(rest)) { index++; continue; }
    if (rest.startsWith("--")) { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end; continue; }
    if (rest.startsWith("/*")) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) return false;
      continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]; let value = "", closed = false; index++;
      while (index < sql.length) {
        if (sql[index] === "\\") return false; // Refuse escape-string ambiguity.
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index++; closed = true; break;
        }
        value += sql[index++];
      }
      if (!closed) return false;
      tokens.push(quote === "'" ? "<literal>" : value.toUpperCase()); continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest)?.[0];
    if (word) { tokens.push(word.toUpperCase()); index += word.length; continue; }
    const number = /^[0-9]+(?:\.[0-9]+)?/u.exec(rest)?.[0];
    if (number) { tokens.push("<literal>"); index += number.length; continue; }
    if (!";.,()+-=[]".includes(rest[0]!)) return false;
    tokens.push(rest[0]!); index++;
  }
  const statements: string[][] = [[]];
  for (const token of tokens) { if (token === ";") statements.push([]); else statements.at(-1)!.push(token); }
  const nonempty = statements.filter((statement) => statement.length);
  return nonempty.length > 0 && nonempty.every((statement) => {
    if (statement.some((token) => ["DROP", "TRUNCATE", "RENAME", "OWNER", "SET", "APP", "DELETE", "UPDATE", "REPLACE", "SELECT", "EXECUTE", "CALL", "DETACH", "ATTACH", "INHERIT", "DISABLE", "ENABLE", "VALIDATE", "AUTHORIZATION"].includes(token))) return false;
    const text = statement.join(" ");
    if (text === "BEGIN" || text === "COMMIT") return true;
    if (/^INSERT INTO /u.test(text)) {
      const values = statement.indexOf("VALUES"), conflict = statement.indexOf("ON", values);
      if (values < 0 || conflict < 0 || !/ ON CONFLICT(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \)| ON CONSTRAINT [A-Z_][A-Z0-9_]*)? DO NOTHING$/u.test(text)) return false;
      // Seed values are literals only; no subquery, function or dynamic execution.
      return statement.slice(values + 1, conflict).every((token) => ["<literal>", "TRUE", "FALSE", "NULL", "(", ")", ",", "+", "-"].includes(token)) && statement.filter((token) => token === "DO").length === 1;
    }
    if (statement.includes("DO")) return false;
    if (/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TYPE|SEQUENCE|SCHEMA) /u.test(text)) return !statement.includes("ALTER") && statement.filter((token) => token === "CREATE").length === 1;
    if (/^ALTER TABLE /u.test(text)) {
      const add = statement.indexOf("ADD");
      if (add <= 2 || statement.slice(2, add).includes(",") || statement.filter((token) => token === "ALTER").length !== 1) return false;
      let depth = 0;
      for (let index = add; index < statement.length; index++) {
        if (statement[index] === "(") depth++;
        if (statement[index] === ")") depth--;
        if (depth < 0 || (depth === 0 && statement[index] === "," && statement[index + 1] !== "ADD")) return false;
      }
      return depth === 0;
    }
    return false;
  });
}

function assertPlatformSchemaForwards(old: PublicObjectInventoryEntry[], target: PublicObjectInventoryEntry[], readOld: SourceReleaseBlobReader, readTarget: SourceReleaseBlobReader): void {
  const oldByPath = new Map(old.map((entry) => [entry.path, entry]));
  const targetByPath = new Map(target.map((entry) => [entry.path, entry]));
  const added: string[] = [];
  for (const path of [...new Set([...oldByPath.keys(), ...targetByPath.keys()])].filter(isSchemaBearingSourceReleasePath).sort()) {
    const before = oldByPath.get(path), after = targetByPath.get(path);
    if (before?.mode === after?.mode && before?.gitBlobSha === after?.gitBlobSha) continue;
    if (path === MIGRATION_MANIFEST_PATH && before && after && before.mode === after.mode) continue;
    const rail = /^(db\/platform|supabase)\/migrations\/[0-9]{14}_[A-Za-z0-9_-]+\.sql$/u.test(path);
    if (before || !after || after.mode !== "100644" || !rail || path.endsWith("/00000000000000_platform_schema_baseline.sql") || path.endsWith("/00000000000000_platform_baseline.sql")) throw new Error(`descendant receipt refuses a schema-bearing edit, delete, mode change or unsupported addition: ${path}`);
    if (!isExpandOnlyPlatformForward(readTarget(path)!.toString())) throw new Error(`descendant receipt refuses a non-expand-only platform forward: ${path}`);
    added.push(path);
  }
  if (added.some((path) => path.startsWith("supabase/migrations/")) && !oldByPath.has("supabase/migrations/00000000000000_platform_schema_baseline.sql")) throw new Error("descendant managed forwards require the previous frozen managed baseline");
  for (const directory of ["db/platform/migrations/", "supabase/migrations/"]) {
    let version = old.filter(({ path }) => path.startsWith(directory)).map(({ path }) => /^([0-9]{14})_/u.exec(path.slice(directory.length))?.[1] ?? "").sort().at(-1) ?? "";
    for (const path of added.filter((path) => path.startsWith(directory))) {
      const next = path.slice(directory.length, directory.length + 14);
      if (next <= version) throw new Error(`descendant receipt refuses a non-increasing migration version: ${path}`);
      version = next;
    }
  }
  const before = parse(readOld(MIGRATION_MANIFEST_PATH)!.toString()), after = parse(readTarget(MIGRATION_MANIFEST_PATH)!.toString());
  const errors = evaluatePlatformMigrationManifest({ manifest: after, migrations: target.filter(({ path }) => path.startsWith("db/platform/migrations/")).map(({ path }) => ({ file: path, content: readTarget(path)!.toString() })) });
  if (errors.length) throw new Error(`descendant platform migration manifest refuses: ${errors.join("; ")}`);
  const previous = before as unknown as PlatformMigrationManifest, current = after as unknown as PlatformMigrationManifest;
  if (before.schemaVersion !== after.schemaVersion || JSON.stringify(before.baseline) !== JSON.stringify(after.baseline) || !Array.isArray(previous.forward) || JSON.stringify(current.forward.slice(0, previous.forward.length)) !== JSON.stringify(previous.forward) || current.forward.length < previous.forward.length) throw new Error("descendant platform migration manifest must extend the previous prefix");
  const appended = current.forward.slice(previous.forward.length).map(({ file }) => file).sort();
  if (JSON.stringify(appended) !== JSON.stringify(added.filter((path) => path.startsWith("db/platform/migrations/")))) throw new Error("descendant platform migration manifest must bind exactly the appended portable forwards");
  if (appended.length === 0 && JSON.stringify(before) !== JSON.stringify(after)) throw new Error("descendant platform migration manifest cannot change without appended portable forwards");
}
const canonicalSelector = (value: unknown): value is string => typeof value === "string" && value !== "" && !value.includes("\\") && posix.normalize(value) === value && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
function retiredProjectedSelectors(value: unknown, drift: SourceReceiptEnvelope["drift"]): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || !value.every(canonicalSelector)) throw new Error("retireProjectedSelectors must list canonical repository paths");
  if (value.some((selector, index) => index > 0 && value[index - 1]! >= selector)) throw new Error("retireProjectedSelectors must be sorted and unique");
  for (const selector of value) if (!drift.some((entry) => entry.selector === selector && entry.class === "projection")) throw new Error(`retireProjectedSelectors names no previous projection row: ${selector}`);
  return new Set(value);
}

/**
 * The standing descendant check. The target commit must describe itself: its catalogue lists its
 * Git inventory, its contract equals `deriveSourceReleaseContract` of its own bytes and keeps the
 * previous release's fixed fields, and its schema history is an immutable prefix with admitted expand-only forwards. Paths, packages,
 * the catalogue and projected content may otherwise change. Returns the receipt's disclosed paths
 * and its drift rows: every previous row except named retirements, projection rows refreshed from
 * the target tree and local-measurement rows unchanged.
 */
function describeDescendantSourceRelease(root: string, previous: AuthenticatedSourceCandidate, targetCommit: string, retireProjectedSelectors?: readonly string[]): { paths: SourceReceiptEnvelope["disclosure"]["paths"]; drift: SourceReceiptEnvelope["drift"] } {
  const receipt = parseSourceReleaseReceiptEnvelope(previous.sourceReceiptRaw);
  if (receipt.evidenceClass !== "activation-candidate" || previous.sourceReceiptDigest !== receiptDigest(previous.sourceReceiptRaw) || receipt.export.commit !== previous.targetCommit || receipt.export.tree !== previous.targetTree || JSON.stringify(receipt) !== JSON.stringify(previous.receipt) || receiptDigest(previous.sourceContract.contents) !== receipt.contract.digest) throw new Error("authenticated previous receipt identity differs");
  const old = gitInventory(root, previous.targetCommit), oldPaths = inventoryPaths(root, old);
  const inventoryIdentity = (rows: PublicObjectInventoryEntry[]) => rows.map(({ path, mode, gitBlobSha }) => [path, mode, gitBlobSha]);
  if (JSON.stringify(inventoryIdentity(old)) !== JSON.stringify(inventoryIdentity(previous.targetInventory))) throw new Error("authenticated previous inventory differs from local Git objects");
  if (JSON.stringify(oldPaths) !== JSON.stringify(receipt.disclosure.paths)) throw new Error("authenticated previous path digests differ from local Git objects");
  const oldDigests = new Map(oldPaths.map((entry) => [entry.path, entry.digest]));
  for (const entry of receipt.drift) if (entry.public.disposition === "absent" ? oldDigests.has(entry.selector) : oldDigests.get(entry.selector) !== entry.public.digest) throw new Error(`authenticated previous drift differs from local Git objects: ${entry.selector}`);
  const target = gitInventory(root, targetCommit), paths = inventoryPaths(root, target);
  const oldByPath = new Map(old.map((entry) => [entry.path, entry])), targetByPath = new Map(target.map((entry) => [entry.path, entry]));
  const targetDigests = new Map(paths.map((entry) => [entry.path, entry.digest]));
  const readTarget = (path: string) => { const entry = targetByPath.get(path); return entry ? gitBytes(root, ["cat-file", "blob", entry.gitBlobSha]) : undefined; };
  const requireTarget = (path: string) => { const bytes = readTarget(path); if (bytes === undefined) throw new Error(`descendant tree is missing ${path}`); return bytes; };
  const readOld = (path: string) => { const entry = oldByPath.get(path); return entry ? gitBytes(root, ["cat-file", "blob", entry.gitBlobSha]) : undefined; };
  assertPlatformSchemaForwards(old, target, readOld, readTarget);
  const catalog = parsePublicPublicationCatalog(requireTarget(PUBLICATION_CATALOG_PATH).toString());
  if (JSON.stringify(catalog.publicPaths.map(({ path }) => path)) !== JSON.stringify(target.map(({ path }) => path))) throw new Error("descendant publication catalogue differs from the Git inventory");
  const allowedEntrypoints = new Set<string>(PUBLIC_EXECUTION_ENTRYPOINTS);
  for (const entry of target) if (oldByPath.get(entry.path)?.gitBlobSha !== entry.gitBlobSha && !allowedEntrypoints.has(entry.path) && isDirectExecutionEntrypoint(entry.path, requireTarget(entry.path).toString())) throw new Error(`descendant receipt found an unregistered direct execution entrypoint: ${entry.path}`);
  const policy = parsePublicPolicyRegistry(requireTarget(PUBLIC_POLICY_REGISTRY_PATH).toString());
  for (const path of policy.activePaths) if (!targetByPath.has(path)) throw new Error(`descendant policy path is absent from the Git inventory: ${path}`);
  const manifests = target.map(({ path }) => path).filter((path) => path === "package.json" || path.endsWith("/package.json")).sort();
  if (JSON.stringify(manifests) !== JSON.stringify(catalog.packageExecutionSurfaces.map(({ path }) => path))) throw new Error(`descendant package manifests differ from the catalogued package execution surfaces: ${manifests.join(", ")}`);
  for (const surface of catalog.packageExecutionSurfaces) {
    const manifest = JSON.parse(requireTarget(surface.path).toString()) as { scripts?: Record<string, string>; bin?: string | Record<string, string> };
    if (surface.digest !== packageExecutionDigest(manifest)) throw new Error(`descendant package execution surface differs from the catalogue: ${surface.path}`);
  }
  const contractRaw = requireTarget(SOURCE_RELEASE_CONTRACT_PATH).toString();
  validateSourceReleaseContract(contractRaw);
  const derived = deriveSourceReleaseContract(readTarget);
  if (derived.contents !== contractRaw) throw new Error(`descendant source contract does not describe its tree; regenerate it with the snippet in CONTRIBUTING.md. Fields that differ: ${sourceReleaseContractChangedFields(parse(contractRaw), parse(derived.contents)).join(", ") || "formatting"}`);
  const fixed = sourceReleaseContractChangedFields(parse(previous.sourceContract.contents), parse(contractRaw)).filter((field) => PREVIOUS_RELEASE_CONTRACT_FIELDS.some((name) => field === name || field.startsWith(`${name}.`)));
  if (fixed.length > 0) throw new Error(`descendant source contract must keep the previous release's ${fixed.join(", ")}`);
  const retired = retiredProjectedSelectors(retireProjectedSelectors, receipt.drift);
  const foldedTargetPaths = new Set(target.map(({ path }) => path.toLowerCase()));
  const drift = receipt.drift.filter(({ selector }) => !retired.has(selector)).map((entry): SourceReceiptEnvelope["drift"][number] => {
    const after = targetDigests.get(entry.selector);
    // A case-insensitive checkout would place a case variant at the same local-measurement file.
    if (entry.class === "local-measurement") { if (foldedTargetPaths.has(entry.selector.toLowerCase())) throw new Error(`descendant receipt refuses a public path at a local-measurement selector: ${entry.selector}`); return entry; }
    return { ...entry, public: after === undefined ? { disposition: "absent", digest: null } : { disposition: "projected", digest: after } };
  });
  return { paths, drift };
}

/** A removal marker is a whole `//` comment line in a code file naming the first preview that must no longer carry
 * that file. Any comment line that starts with `openlup-remove-before:` must parse as one. */
const REMOVAL_MARKER = /^[ \t]*\/\/ openlup-remove-before: openlup-source-preview\/([1-9][0-9]*)[ \t]*$/u;
const REMOVAL_MARKER_START = /^[ \t]*\/\/[ \t]*openlup-remove-before:/u;
const REMOVAL_MARKER_TEXT = "openlup-remove-before";
const REMOVAL_SCAN_CODE_FILE = /\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/u;

/** The regular code-file blobs in `git ls-tree -r -z --full-tree` output, in listing order. */
export function removalScanBlobs(listing: string): Array<{ path: string; oid: string }> {
  return listing.split("\0").filter((row) => row !== "").flatMap((row) => {
    const entry = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\n]+)$/u.exec(row);
    if (!entry) throw new Error("removal marker scan output is malformed");
    return entry[2] === "blob" && (entry[1] === "100644" || entry[1] === "100755") && REMOVAL_SCAN_CODE_FILE.test(entry[4]!) ? [{ path: entry[4]!, oid: entry[3]! }] : [];
  });
}

/** Splits `git cat-file --batch` output into the contents of `oids`, in order. */
export function splitRemovalScanBatch(batch: Buffer, oids: readonly string[]): Buffer[] {
  let offset = 0;
  const blobs = oids.map((oid) => {
    const headerEnd = batch.indexOf(0x0a, offset);
    const [name, type, size, extra] = headerEnd === -1 ? [] : batch.subarray(offset, headerEnd).toString("latin1").split(" ");
    const length = /^(?:0|[1-9][0-9]*)$/u.test(size ?? "") ? Number(size) : Number.NaN;
    if (name !== oid || type !== "blob" || extra !== undefined || !Number.isSafeInteger(length) || batch[headerEnd + 1 + length] !== 0x0a) throw new Error("removal marker scan output is malformed");
    offset = headerEnd + length + 2;
    return batch.subarray(headerEnd + 1, headerEnd + 1 + length);
  });
  if (offset !== batch.length) throw new Error("removal marker scan output is malformed");
  return blobs;
}

/** The lines of one blob that start like a removal marker. A NUL byte in the first 8000 bytes makes the blob binary. */
export function removalMarkerLines(bytes: Buffer): string[] {
  if (bytes.subarray(0, 8000).includes(0) || !bytes.includes(REMOVAL_MARKER_TEXT)) return [];
  return bytes.toString("utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u).filter((line) => REMOVAL_MARKER_START.test(line));
}

/** The sorted files that preview `number` must not carry. A marker line that does not parse is refused, not ignored. */
export function overdueRemovals(number: number, markers: ReadonlyArray<{ path: string; line: string }>): string[] {
  const overdue = new Set<string>();
  for (const { path, line } of markers) {
    const marker = REMOVAL_MARKER.exec(line);
    if (!marker || !Number.isSafeInteger(Number(marker[1]))) throw new Error(`${path}: malformed removal marker: ${line}`);
    if (Number(marker[1]) <= number) overdue.add(path);
  }
  return [...overdue].sort();
}

/** Refuses to cut preview `number` while a code file anywhere in the tree of `target` carries a removal marker naming
 * that preview or an earlier one. The workflow's prepare step and the receipt producer both run it. It lists the whole
 * tree and reads the blobs themselves, with no pathspec and no attribute lookup, through the checkout-bound Git runner
 * that ignores replacement objects, grafts and inherited Git environment; any git failure refuses. */
export function assertNoOverdueRemovals(number: number, target: string, cwd = process.cwd()): void {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`the removal marker check needs a positive integer preview number, not ${number}`);
  const git = (args: string[], input?: string) => documentationGit(cwd, args, input, 512 * 1024 * 1024);
  const files = removalScanBlobs(git(["ls-tree", "-r", "-z", "--full-tree", target]).toString("utf8"));
  const blobs = files.length === 0 ? [] : splitRemovalScanBatch(git(["cat-file", "--batch"], files.map(({ oid }) => `${oid}\n`).join("")), files.map(({ oid }) => oid));
  const markers = files.flatMap(({ path }, index) => removalMarkerLines(blobs[index]!).map((line) => ({ path, line })));
  const overdue = overdueRemovals(number, markers);
  if (overdue.length > 0) throw new Error(`openlup-source-preview/${number} refuses files marked for removal by it: ${overdue.join(", ")}`);
}

/** Writes one schema-5 receipt from an authenticated prior release and actual clean Git objects. */
export async function writeDescendantSourceReleaseReceipt(input: DescendantSourceReleaseInput): Promise<DescendantSourceReleaseResult> {
  const root = realpathSync(input.root), beforeHead = gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]), beforeStatus = gitRead(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!commitSha(beforeHead) || beforeStatus !== "") throw new Error("descendant receipt requires an exact clean public HEAD");
  const previous = await authenticateGithubSourceRelease(input.previous, input.fetcher); if (gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== beforeHead || gitRead(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== beforeStatus) throw new Error("descendant receipt refused a moving public HEAD during authentication");
  const previousNumber = /^openlup-source-preview\/([1-9][0-9]*)$/u.exec(previous.release.tag), next = /^openlup-source-preview\/([1-9][0-9]*)$/u.exec(input.releaseTag), previousOrdinal = Number(previousNumber?.[1]), nextOrdinal = Number(next?.[1]);
  if (!previousNumber || !next || !Number.isSafeInteger(previousOrdinal) || !Number.isSafeInteger(nextOrdinal) || nextOrdinal !== previousOrdinal + 1 || input.tagMessage !== `OpenLup source preview ${next[1]}.`) throw new Error("descendant receipt requires the exactly next preview tag and message");
  assertNoOverdueRemovals(nextOrdinal, beforeHead, root);
  try { execFileSync("git", ["merge-base", "--is-ancestor", previous.targetCommit, beforeHead], { cwd: root, stdio: "ignore" }); } catch { throw new Error("descendant receipt target does not descend from the authenticated previous release"); }
  if (beforeHead === previous.targetCommit) throw new Error("descendant receipt target must advance the previous release");
  const tagRaw = gitBytes(root, ["for-each-ref", `--format=%(objecttype)%00%(*objectname)%00%(refname:strip=2)%00%(contents)%00`, `refs/tags/${input.releaseTag}`]).toString();
  const tag = tagRaw.endsWith("\0\n") ? tagRaw.slice(0, -2).split("\0") : [];
  if (tag.length !== 4 || tag[0] !== "tag" || tag[1] !== beforeHead || tag[2] !== input.releaseTag || tag[3] !== `${input.tagMessage}\n`) throw new Error("descendant receipt requires the exact annotated tag at HEAD");
  const targetTree = gitRead(root, ["rev-parse", "HEAD^{tree}"]), parents = gitRead(root, ["show", "-s", "--format=%P", "HEAD"]).split(" ").filter(Boolean);
  if (!commitSha(targetTree) || parents.length === 0 || parents.some((parent) => !commitSha(parent)) || new Set(parents).size !== parents.length) throw new Error("descendant receipt Git commit identity is invalid");
  const { paths, drift: targetDrift } = describeDescendantSourceRelease(root, previous, beforeHead, input.retireProjectedSelectors);
  const contract = paths.find(({ path }) => path === SOURCE_RELEASE_CONTRACT_PATH); if (!contract) throw new Error("descendant receipt source contract is absent");
  const contractRaw = gitBytes(root, ["show", `${beforeHead}:${SOURCE_RELEASE_CONTRACT_PATH}`]).toString(); validateSourceReleaseContract(contractRaw); if (receiptDigest(contractRaw) !== contract.digest) throw new Error("descendant receipt source contract differs");
  const contractValue = parse(contractRaw), repository = contractValue.repository as JsonObject, release = contractValue.release as JsonObject; if (release.evidenceClass !== "activation-candidate" || JSON.stringify({ repository: repository.coordinate, securityRoute: repository.securityRoute, evidenceClass: release.evidenceClass, owner: repository.owner }) !== JSON.stringify(previous.receipt.identity)) throw new Error("descendant receipt source contract identity differs");
  const note = Buffer.isBuffer(input.releaseNote) ? input.releaseNote : Buffer.from(input.releaseNote); const noteText = new TextDecoder("utf-8", { fatal: true }).decode(note); if (note.length === 0 || noteText.trim() === "" || Buffer.from(noteText).compare(note) !== 0) throw new Error("descendant receipt release note must be non-empty canonical UTF-8 bytes");
  const base = { schemaVersion: 5 as const, evidenceClass: "activation-candidate" as const, identity: previous.receipt.identity as Extract<SourceReceiptEnvelope, { schemaVersion: 5 }>["identity"], contract: { path: SOURCE_RELEASE_CONTRACT_PATH as typeof SOURCE_RELEASE_CONTRACT_PATH, digest: contract.digest }, export: { commit: beforeHead, tree: targetTree, parents }, disclosure: { paths, releaseNote: { digest: receiptDigest(note) }, tag: { name: input.releaseTag, message: input.tagMessage } }, drift: targetDrift };
  const provisional = { ...base, disclosure: { allowlist: { schemaVersion: 1 as const, digest: receiptDigest("") }, ...base.disclosure } } as Extract<SourceReceiptEnvelope, { schemaVersion: 5 }>;
  const allowlist = renderSourceReleaseAllowlist(provisional), allowlistDigest = receiptDigest(allowlist), receipt = { ...base, disclosure: { allowlist: { schemaVersion: 1 as const, digest: allowlistDigest }, ...base.disclosure } }, contents = `${JSON.stringify(receipt, null, 2)}\n`;
  const parsedReceipt = parseSourceReleaseReceiptEnvelope(contents); if (gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== beforeHead || gitRead(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== beforeStatus) throw new Error("descendant receipt refused a moving public HEAD");
  const destination = safeReceiptOutput(root, input.outputPath); let descriptor: number | undefined;
  try {
    descriptor = openSync(destination, "wx+"); writeFileSync(descriptor, contents); fsyncSync(descriptor);
    const state = fstatSync(descriptor), bytes = Buffer.alloc(state.size); if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || bytes.toString() !== contents || JSON.stringify(parseSourceReleaseReceiptEnvelope(bytes)) !== JSON.stringify(parsedReceipt)) throw new Error("descendant receipt readback differs");
    if (gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== beforeHead || gitRead(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== beforeStatus) throw new Error("descendant receipt refused a moving public HEAD");
    closeSync(descriptor); descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) { const owned = fstatSync(descriptor); closeSync(descriptor); descriptor = undefined; const current = lstatSync(destination, { throwIfNoEntry: false }); if (current && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(destination); }
    throw error;
  }
  return { receipt, contents, digest: receiptDigest(contents), allowlist, allowlistDigest };
}
