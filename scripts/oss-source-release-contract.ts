import { createHash } from "node:crypto";
import { publicPublicationCatalogDigests } from "./oss-publication-policy.ts";
import { readPublicTypecheckCompatibility, type PublicTypecheckCompatibility } from "./oss-public-typecheck.ts";

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
const digest = (contents: string): string => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
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
