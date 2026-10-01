import { createHash } from "node:crypto";
import { evaluatePlatformMigrationManifest, type PlatformMigrationManifest } from "./platform-migration-manifest.ts";
import { execFileSync } from "node:child_process";
import { PUBLICATION_CATALOG_PATH, PUBLIC_POLICY_REGISTRY_PATH, packageExecutionDigest, parsePublicPolicyRegistry, parsePublicPublicationCatalog, publicPublicationCatalogDigests } from "./oss-publication-policy.ts";
import { PUBLIC_EXECUTION_ENTRYPOINTS, isDirectExecutionEntrypoint } from "./oss-publication-contract.ts";
import { readPublicTypecheckCompatibility, type PublicTypecheckCompatibility } from "./oss-public-typecheck.ts";
import { documentationGit } from "./documentation-routing.ts";
import { assertReviewedPlatformForward } from "./reviewed-platform-forward.ts";

export const SOURCE_RELEASE_CONTRACT_PATH = "config/openlup-source-release-contract.json";
export const SOURCE_RELEASE_EVIDENCE_CLASS = "local-fixture";
export const RESERVED_FIXTURE_COORDINATE = "https://openlup.invalid/source-release-fixture";
export const RESERVED_FIXTURE_SECURITY_ROUTE = "security@openlup.invalid";
export const CANONICAL_ACTIVATION_REPOSITORY = "https://github.com/openlup/openlup";
export const CANONICAL_ACTIVATION_SECURITY_ROUTE = "dev@openlup.com";
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
  if (Object.hasOwn(raw, "sourceSeed")) throw new Error(`${SOURCE_RELEASE_CONTRACT_PATH}: sourceSeed is a retired downstream field and is refused`);
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
 * Identity and `compatibility` come from the tree's current contract. The descendant release check
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

/** One regular file of a commit's Git tree. */
type GitInventoryEntry = { path: string; mode: "100644" | "100755"; gitBlobSha: string };
const commitSha = (value: string) => /^[0-9a-f]{40}$/u.test(value);
const GIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const gitBytes = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, maxBuffer: GIT_OUTPUT_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
function gitInventory(root: string, revision: string): GitInventoryEntry[] {
  const rows = gitBytes(root, ["ls-tree", "-r", "-z", "--full-tree", revision]).toString().split("\0").filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if (!match || match[3]!.startsWith("/") || match[3]!.includes("\\") || match[3]!.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("descendant release requires regular canonical Git paths");
    return { path: match[3]!, mode: match[1] as "100644" | "100755", gitBlobSha: match[2]! };
  });
  return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
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

function assertPlatformSchemaForwards(root: string, previousCommit: string, targetCommit: string, old: GitInventoryEntry[], target: GitInventoryEntry[], readOld: SourceReleaseBlobReader, readTarget: SourceReleaseBlobReader): void {
  const oldByPath = new Map(old.map((entry) => [entry.path, entry]));
  const targetByPath = new Map(target.map((entry) => [entry.path, entry]));
  const added: string[] = [];
  for (const path of [...new Set([...oldByPath.keys(), ...targetByPath.keys()])].filter(isSchemaBearingSourceReleasePath).sort()) {
    const before = oldByPath.get(path), after = targetByPath.get(path);
    if (before?.mode === after?.mode && before?.gitBlobSha === after?.gitBlobSha) continue;
    if (path === MIGRATION_MANIFEST_PATH && before && after && before.mode === after.mode) continue;
    const rail = /^(db\/platform|supabase)\/migrations\/[0-9]{14}_[A-Za-z0-9_-]+\.sql$/u.test(path);
    if (before || !after || after.mode !== "100644" || !rail || path.endsWith("/00000000000000_platform_schema_baseline.sql") || path.endsWith("/00000000000000_platform_baseline.sql")) throw new Error(`descendant release refuses a schema-bearing edit, delete, mode change or unsupported addition: ${path}`);
    const contents = readTarget(path)!;
    const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    if (!isExpandOnlyPlatformForward(bytes.toString("utf8"))) assertReviewedPlatformForward(root, previousCommit, targetCommit, path, bytes, true);
    added.push(path);
  }
  if (added.some((path) => path.startsWith("supabase/migrations/")) && !oldByPath.has("supabase/migrations/00000000000000_platform_schema_baseline.sql")) throw new Error("descendant managed forwards require the previous frozen managed baseline");
  for (const directory of ["db/platform/migrations/", "supabase/migrations/"]) {
    let version = old.filter(({ path }) => path.startsWith(directory)).map(({ path }) => /^([0-9]{14})_/u.exec(path.slice(directory.length))?.[1] ?? "").sort().at(-1) ?? "";
    for (const path of added.filter((path) => path.startsWith(directory))) {
      const next = path.slice(directory.length, directory.length + 14);
      if (next <= version) throw new Error(`descendant release refuses a non-increasing migration version: ${path}`);
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

/**
 * The standing descendant check, run before a preview is tagged. The target commit must describe
 * itself: its catalogue lists its Git inventory, its contract equals `deriveSourceReleaseContract`
 * of its own bytes and keeps the previous release's fixed fields, and its schema history is an
 * immutable prefix of the previous release's, with admitted expand-only forwards. Paths, packages,
 * the catalogue and other content may otherwise change. Both commits are read as Git objects, never
 * from the working tree, so the check describes exactly what the tag will name.
 */
export function assertDescendantSourceRelease(root: string, previousCommit: string, targetCommit: string): void {
  if (!commitSha(previousCommit) || !commitSha(targetCommit)) throw new Error("descendant release check requires full commit SHAs");
  if (previousCommit === targetCommit) throw new Error("descendant release target must advance the previous release");
  const old = gitInventory(root, previousCommit), target = gitInventory(root, targetCommit);
  const oldByPath = new Map(old.map((entry) => [entry.path, entry])), targetByPath = new Map(target.map((entry) => [entry.path, entry]));
  const blob = (entry: GitInventoryEntry | undefined) => entry ? gitBytes(root, ["cat-file", "blob", entry.gitBlobSha]) : undefined;
  const readTarget = (path: string) => blob(targetByPath.get(path)), readOld = (path: string) => blob(oldByPath.get(path));
  const requireTarget = (path: string) => { const bytes = readTarget(path); if (bytes === undefined) throw new Error(`descendant tree is missing ${path}`); return bytes; };
  assertPlatformSchemaForwards(root, previousCommit, targetCommit, old, target, readOld, readTarget);
  const catalog = parsePublicPublicationCatalog(requireTarget(PUBLICATION_CATALOG_PATH).toString());
  if (JSON.stringify(catalog.publicPaths.map(({ path }) => path)) !== JSON.stringify(target.map(({ path }) => path))) throw new Error("descendant publication catalogue differs from the Git inventory");
  const allowedEntrypoints = new Set<string>(PUBLIC_EXECUTION_ENTRYPOINTS);
  for (const entry of target) if (oldByPath.get(entry.path)?.gitBlobSha !== entry.gitBlobSha && !allowedEntrypoints.has(entry.path) && isDirectExecutionEntrypoint(entry.path, requireTarget(entry.path).toString())) throw new Error(`descendant release found an unregistered direct execution entrypoint: ${entry.path}`);
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
  const previousContract = readOld(SOURCE_RELEASE_CONTRACT_PATH);
  if (previousContract === undefined) throw new Error(`previous release is missing ${SOURCE_RELEASE_CONTRACT_PATH}`);
  const fixed = sourceReleaseContractChangedFields(parse(previousContract.toString()), parse(contractRaw)).filter((field) => PREVIOUS_RELEASE_CONTRACT_FIELDS.some((name) => field === name || field.startsWith(`${name}.`)));
  if (fixed.length > 0) throw new Error(`descendant source contract must keep the previous release's ${fixed.join(", ")}`);
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
 * that preview or an earlier one. The release workflow's prepare step runs it. It lists the whole
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
