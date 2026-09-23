import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { PUBLICATION_CATALOG_PATH, PUBLIC_POLICY_REGISTRY_PATH, packageExecutionDigest, parsePublicPolicyRegistry, parsePublicPublicationCatalog, publicPublicationCatalogDigests } from "./oss-publication-policy.ts";
import { PUBLIC_EXECUTION_ENTRYPOINTS, isDirectExecutionEntrypoint } from "./oss-publication-contract.ts";
import { readPublicTypecheckCompatibility, type PublicTypecheckCompatibility } from "./oss-public-typecheck.ts";
import { authenticateGithubSourceRelease, parseSourceReleaseReceiptEnvelope, renderSourceReleaseAllowlist, type AuthenticatedSourceCandidate, type GithubFetch, type GithubSourceTransportInput, type PublicObjectInventoryEntry, type SourceReceiptEnvelope } from "./oss-consume-github-transport.ts";

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

export type DescendantSourceReleaseInput = {
  root: string;
  previous: GithubSourceTransportInput;
  fetcher?: GithubFetch;
  releaseTag: string;
  tagMessage: string;
  releaseNote: string | Buffer;
  outputPath: string;
};
export type DescendantSourceReleaseResult = { receipt: Extract<SourceReceiptEnvelope, { schemaVersion: 5 }>; contents: string; digest: string; allowlist: string; allowlistDigest: string };

const receiptDigest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
// A single approved preview/4 -> preview/5 bridge. These are target Git bytes, not caller input.
const W1A_PREVIOUS = { receipt: "sha256:d072483b9e09ccbf4bfedca0a985b7b97dcb0ac00e2ed0953e9fda6e5a0d0461", commit: "f5d05bf0a0e0674b47d677c2392fac5deb6031be", tree: "3d6cb4ae320497b587016720e164faf884ede3cc" } as const;
const W1A_CONTRACT = "sha256:6bb9f686d5552cc4a316e6fcdde44a248a8355b02d9c10d1fa62a6544366d6cc";
const W1A_ADDED = [
  ["config/public-reference-subscription-imports.json", "100644", "public-output", "sha256:c25feac67732240e6d0ace774c7c2a3095e77414a74e87360d91fb193b530c3a"],
  ["config/public-reference-subscription-supabase.toml", "100644", "public-output", "sha256:1cf875e7bed1515cd25cc5bef39eb6674d068dbdd650679dc3b5ffefd1671dc1"],
  ["docs/platform/SUBSCRIPTION_REFERENCE.md", "100644", "platform-documentation", "sha256:d2ac745af716f6096042cf6f0c9b21d2281929c2f6d987ec57a21012ec404613"],
  ["docs/platform/plans/subscription-reference-w1.md", "100644", "platform-documentation", "sha256:8c9f1a2b647d6c48373d7943176af1283bfb5566a0799119d77ba5b8d35bafcf"],
  ["scripts/public-reference/grant-operator.mjs", "100644", "public-output", "sha256:bbeef7a11a5d1bc82cd139b76d8f7fc399d45aa19a9bf999fdfc8ef96e36176f"],
  ["scripts/public-reference/setup-subscription.mjs", "100755", "public-output", "sha256:5222d4233e41efb22e17656fdddd5c20c9091c5d38db8cb5ed23feeb271f1f56"],
  ["scripts/public-reference/subscription-prereqs.sql", "100644", "public-output", "sha256:4323c42c4d16c25ed2fe86a2273ac39af95dbeac6550a79f0e489878831b06b6"],
  ["scripts/public-reference/subscription-seed.sql", "100644", "public-output", "sha256:a8d353582ef6279bf4ac403405a18580f3fbb323b07aee8a1873a2f767f6487d"],
  ["scripts/public-reference/verify-subscription.mjs", "100644", "public-output", "sha256:1062586e74c7db0804d0f7c6d97bab1dcdd552b3239e97886a40dd16420b88e3"],
  ["server/runtime/public-reference/capturedCheckout.test.ts", "100644", "public-output", "sha256:a85501e9eacbc7e5c1563c031f4241e61ce8e5ecd5f2c1c302da8f9394cd55f7"],
  ["server/runtime/public-reference/capturedCheckout.ts", "100644", "public-output", "sha256:6f44ac8901f07e42241ed937cf36dfe28c0db74c44510aebdcd18d5c16dd2a91"],
  ["server/runtime/public-reference/subscriptionAccount.test.ts", "100644", "public-output", "sha256:375c95c6f6312cef9eff131ca4d37b1e27368a92a6e8b79c67a56316c1e06138"],
  ["server/runtime/public-reference/subscriptionAccount.ts", "100644", "public-output", "sha256:6451b50c09b030bc6e3ecb7e5b497ec8c2f66eb26567de2d791f6d6b61394a85"],
  ["server/runtime/public-reference/subscriptionOperator.test.ts", "100644", "public-output", "sha256:323aafe571eabfed6ea53610165d88e82a644e1acdd011ed177e49315f29763a"],
  ["server/runtime/public-reference/subscriptionOperator.ts", "100644", "public-output", "sha256:eaa87d713fdcd3aca9bcae00a6fd068770468de731607fd94d158e5a386cfe66"],
  ["server/runtime/public-reference/subscriptionProfile.test.ts", "100644", "public-output", "sha256:36aafd7699d494de1898ce7f26ed2681b363e35f787b002b3b5a968f93dbe77e"],
  ["server/runtime/public-reference/subscriptionProfile.ts", "100644", "public-output", "sha256:238e80d45fa94d799015af9c2b5bbdd2361e53bdcd5aa8f09aa48c825fd70c7b"],
  ["src/domains/customers/useAuthenticatedAccountLifecycle.test.tsx", "100644", "public-output", "sha256:f7c2dd3f6743c01210398a90ed4682e3269f23623d2f5c50c8ae9439d9177c26"],
  ["src/domains/customers/useAuthenticatedAccountLifecycle.ts", "100644", "public-output", "sha256:f58bcbbc2bd17ae03fdaf383c1a2fc840cecc098131d40b5773a218e97751dae"],
  ["src/public-reference/SubscriptionAccount.test.tsx", "100644", "public-output", "sha256:e3502313cb179f9bcf1d599469d02e59f3dd2a0a319c9cfabf45bd42977b7efe"],
  ["src/public-reference/SubscriptionAccount.tsx", "100644", "public-output", "sha256:d9fb82d1b0a6e8f5a76f305594d4eb8548e1fd1650022d88c9a134e8eb4997fa"],
  ["src/public-reference/subscription-main.test.tsx", "100644", "public-output", "sha256:50e6dd8e8235449a69339305cc27fdd494eb159f1e9a23d7d08f14b2d94257e7"],
  ["src/public-reference/subscription-main.tsx", "100644", "public-output", "sha256:3cdb1b2335b8838162ea1cf9af67f06ac8dc902cbbf3458a48b720c6e09deb06"],
  ["src/public-reference/subscription.css", "100644", "public-output", "sha256:da226793138435dffb6a7cec6e23a0c6c81353fc46a81f0d706455f200e8acfb"],
  ["src/public-reference/subscriptionApi.test.ts", "100644", "public-output", "sha256:d9a89de9dd0816ea04531e1d7094ac75aaef3c5759c618e6d079bef977750a5c"],
  ["src/public-reference/subscriptionApi.ts", "100644", "public-output", "sha256:a555bb8d7077a5404f0a7d7944e653fd61ff20d647ba2ff156e26afedee741b2"],
  ["src/public-reference/subscriptionMessages.test.tsx", "100644", "public-output", "sha256:f001e37f44f4290b82f0e8d45f67e4a31c49a365c6085aabd1cb54a43bf2a1d9"],
  ["src/public-reference/subscriptionMessages.ts", "100644", "public-output", "sha256:37f86c9ce8afe0789c1e5cdefd19bee4709e73084c335c371975658912a81278"],
] as const;
const W1A_PROJECTED = [
  [".github/pull_request_template.md", "sha256:b466b40c7ee2fabf4a9420e508254d443485824b67af9c103f6f2cba8f0195a9"],
  ["AGENTS.md", "sha256:9fac677959db8dfa55552e1685a8860557b9cbe6d15c29c7c0f13031122fae5f"],
  ["config/openlup-publication-catalog.json", "sha256:e1d4294a9971c9fe0d1496fee4f72d95c5582803b89700696bb77a4d6bba651b"],
  ["config/openlup-source-release-contract.json", W1A_CONTRACT],
  ["packages/core/release-gates.json", "sha256:ac1fdf6f472e406d74abd75b551ac3a3bc9096dc6aad69b6ab8e1f6fddf06845"],
  ["packages/core/scripts/core-package-consumer-audit.ts", "sha256:dfdc5ac50102ea14bc73771be785d6723f6c8269e83a93678076a8db26cd7a47"],
  ["scripts/oss-publication-contract.ts", "sha256:16e22b23820d1524b8f185b9bb698012eae88a724975176dcd4e529ecc7ee112"],
  ["server/runtime/public-reference/serve.ts", "sha256:f122db1ea1d811ac33757bc417ba0f9edb766792b0c7f96003d8ed2bd3e8417f"],
  ["vite.public-reference.config.ts", "sha256:cf84b3b57b6831601e1c0251027acbe285ffffff1a5660b86f98e95ac0e53ab4"],
] as const;
export const finiteW1aPinnedPaths = {
  added: W1A_ADDED.map(([path]) => path),
  projected: W1A_PROJECTED.map(([selector]) => selector),
} as const;
/** Pure fixed-pin check shared by the writer and its portable Git-object characterization. */
export function assertFiniteW1aBlobPins(
  added: ReadonlyArray<readonly [string, string, string, string]>,
  projected: ReadonlyArray<readonly [string, string]>,
  contractDigest: string,
): void {
  if (JSON.stringify(added) !== JSON.stringify(W1A_ADDED)) throw new Error("W1a added path, mode, class, or bytes differ from approved target");
  if (JSON.stringify(projected) !== JSON.stringify(W1A_PROJECTED)) throw new Error("W1a projected selector or bytes differ from approved target");
  if (contractDigest !== W1A_CONTRACT) throw new Error("W1a target source contract differs from approved bytes");
}
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
function assertPreviousPublicState(root: string, previous: AuthenticatedSourceCandidate, target: PublicObjectInventoryEntry[]): void {
  const receipt = parseSourceReleaseReceiptEnvelope(previous.sourceReceiptRaw);
  if (receipt.evidenceClass !== "activation-candidate" || previous.sourceReceiptDigest !== receiptDigest(previous.sourceReceiptRaw) || receipt.export.commit !== previous.targetCommit || receipt.export.tree !== previous.targetTree || JSON.stringify(receipt) !== JSON.stringify(previous.receipt)) throw new Error("authenticated previous receipt identity differs");
  const old = gitInventory(root, previous.targetCommit), oldPaths = inventoryPaths(root, old);
  const inventoryIdentity = (rows: PublicObjectInventoryEntry[]) => rows.map(({ path, mode, gitBlobSha }) => [path, mode, gitBlobSha]);
  if (JSON.stringify(inventoryIdentity(old)) !== JSON.stringify(inventoryIdentity(previous.targetInventory))) throw new Error("authenticated previous inventory differs from local Git objects");
  if (JSON.stringify(oldPaths) !== JSON.stringify(receipt.disclosure.paths)) throw new Error("authenticated previous path digests differ from local Git objects");
  if (JSON.stringify(old.map(({ path, mode }) => ({ path, mode }))) !== JSON.stringify(target.map(({ path, mode }) => ({ path, mode })))) throw new Error("descendant receipt refuses public inventory or mode changes");
  const oldByPath = new Map(oldPaths.map((entry) => [entry.path, entry.digest])), targetByPath = new Map(inventoryPaths(root, target).map((entry) => [entry.path, entry.digest]));
  const protectedPaths = oldPaths.map(({ path }) => path).filter((path) => path === SOURCE_RELEASE_CONTRACT_PATH || /(?:^|\/)package(?:-lock)?\.json$/u.test(path));
  for (const path of protectedPaths) if (oldByPath.get(path) !== targetByPath.get(path)) throw new Error(`descendant receipt refuses protected contract or package bytes: ${path}`);
  for (const entry of receipt.drift) {
    const before = oldByPath.get(entry.selector), after = targetByPath.get(entry.selector);
    if (entry.public.disposition === "absent") { if (before !== undefined || after !== undefined) throw new Error(`descendant receipt drift absence differs: ${entry.selector}`); }
    else if (before !== entry.public.digest || after !== entry.public.digest) throw new Error(`descendant receipt refuses projected byte changes: ${entry.selector}`);
  }
}

/** Exactly the reviewed W1a preview/5 transition; every exception is fixed here. */
function assertFiniteW1aTarget(root: string, previous: AuthenticatedSourceCandidate, target: PublicObjectInventoryEntry[]): SourceReceiptEnvelope["drift"] {
  // Reuse the unchanged producer's complete prior Git/receipt/byte check against the prior tree.
  assertPreviousPublicState(root, previous, previous.targetInventory);
  const old = previous.targetInventory, oldByPath = new Map(old.map((row) => [row.path, row]));
  const targetByPath = new Map(target.map((row) => [row.path, row]));
  const read = (rows: Map<string, PublicObjectInventoryEntry>, path: string) => {
    const entry = rows.get(path); if (!entry) throw new Error(`W1a target is missing ${path}`);
    return gitBytes(root, ["cat-file", "blob", entry.gitBlobSha]);
  };
  for (const entry of old) if (targetByPath.get(entry.path)?.mode !== entry.mode) throw new Error(`W1a old path or mode changed: ${entry.path}`);
  const oldCatalog = parsePublicPublicationCatalog(read(oldByPath, PUBLICATION_CATALOG_PATH).toString());
  const targetCatalogRaw = read(targetByPath, PUBLICATION_CATALOG_PATH).toString();
  const targetCatalog = parsePublicPublicationCatalog(targetCatalogRaw), classes = new Map(targetCatalog.publicPaths.map(({ path, class: classification }) => [path, classification]));
  if (JSON.stringify(oldCatalog.publicPaths.map(({ path }) => path)) !== JSON.stringify(old.map(({ path }) => path)) ||
      JSON.stringify(targetCatalog.publicPaths.map(({ path }) => path)) !== JSON.stringify(target.map(({ path }) => path))) throw new Error("W1a catalogue inventory differs from Git");
  for (const row of oldCatalog.publicPaths) if (classes.get(row.path) !== row.class) throw new Error(`W1a old catalogue class changed: ${row.path}`);
  const additions = target.filter(({ path }) => !oldByPath.has(path)).map(({ path, mode }) => [path, mode, classes.get(path), receiptDigest(read(targetByPath, path))]);
  const allowedEntrypoints = new Set<string>(PUBLIC_EXECUTION_ENTRYPOINTS);
  for (const entry of target) if (oldByPath.get(entry.path)?.gitBlobSha !== entry.gitBlobSha &&
    isDirectExecutionEntrypoint(entry.path, read(targetByPath, entry.path).toString()) && !allowedEntrypoints.has(entry.path)) {
    throw new Error(`W1a unregistered direct execution entrypoint: ${entry.path}`);
  }
  const protectedPaths = old.map(({ path }) => path).filter((path) => /(?:^|\/)package(?:-lock)?\.json$/u.test(path));
  for (const path of [...protectedPaths, "config/platform-migration-manifest.json", "src/integrations/supabase/types.ts", PUBLIC_POLICY_REGISTRY_PATH]) {
    if (read(oldByPath, path).compare(read(targetByPath, path)) !== 0) throw new Error(`W1a protected bytes changed: ${path}`);
  }
  const policy = parsePublicPolicyRegistry(read(targetByPath, PUBLIC_POLICY_REGISTRY_PATH).toString());
  if (policy.activePaths.some((path) => !targetByPath.has(path))) throw new Error("W1a policy path is absent from target Git");
  for (const surface of targetCatalog.packageExecutionSurfaces) {
    const manifest = JSON.parse(read(targetByPath, surface.path).toString()) as { scripts?: Record<string, string>; bin?: string | Record<string, string> };
    if (surface.digest !== packageExecutionDigest(manifest)) throw new Error(`W1a package execution surface changed: ${surface.path}`);
  }
  const contractRaw = read(targetByPath, SOURCE_RELEASE_CONTRACT_PATH).toString();
  validateSourceReleaseContract(contractRaw);
  const priorContract = parse(previous.sourceContract.contents), contract = parse(contractRaw);
  const allowedFields = ["inventory.classDigest", "inventory.digest", "policy.publicationCatalogDigest"];
  if (JSON.stringify(sourceReleaseContractChangedFields(priorContract, contract).sort()) !== JSON.stringify(allowedFields)) throw new Error("W1a source contract fields exceed approved rebind");
  const catalogDigests = publicPublicationCatalogDigests(targetCatalogRaw), inventory = contract.inventory as JsonObject, binding = contract.policy as JsonObject;
  if (inventory.digest !== catalogDigests.inventoryDigest || inventory.classDigest !== catalogDigests.classDigest || binding.publicationCatalogDigest !== `sha256-${createHash("sha256").update(targetCatalogRaw).digest("hex")}`) throw new Error("W1a source contract catalogue binding differs from Git");
  const expected = new Map<string, string>(W1A_PROJECTED.map(([selector, digest]) => [selector, digest]));
  const priorDrift = previous.receipt.drift;
  const actualChanged = priorDrift.filter((entry) => entry.public.disposition === "projected" && read(oldByPath, entry.selector).compare(read(targetByPath, entry.selector)) !== 0).map(({ selector }) => selector);
  assertFiniteW1aBlobPins(additions as Array<[string, string, string, string]>, actualChanged.map((selector) => [selector, receiptDigest(read(targetByPath, selector))]), receiptDigest(contractRaw));
  const targetDrift = priorDrift.map((entry) => {
    const before = oldByPath.has(entry.selector) ? receiptDigest(read(oldByPath, entry.selector)) : undefined;
    const after = targetByPath.has(entry.selector) ? receiptDigest(read(targetByPath, entry.selector)) : undefined;
    if (entry.public.disposition === "absent") { if (before !== undefined || after !== undefined) throw new Error(`W1a absent drift selector appeared: ${entry.selector}`); return entry; }
    if (before !== entry.public.digest || after !== (expected.get(entry.selector) ?? entry.public.digest)) throw new Error(`W1a projected bytes differ: ${entry.selector}`);
    return expected.has(entry.selector) ? { ...entry, public: { disposition: "projected" as const, digest: after! } } : entry;
  });
  return targetDrift;
}

/** Writes one schema-5 receipt from an authenticated prior release and actual clean Git objects. */
export async function writeDescendantSourceReleaseReceipt(input: DescendantSourceReleaseInput): Promise<DescendantSourceReleaseResult> {
  const root = realpathSync(input.root), beforeHead = gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]), beforeStatus = gitRead(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!commitSha(beforeHead) || beforeStatus !== "") throw new Error("descendant receipt requires an exact clean public HEAD");
  const previous = await authenticateGithubSourceRelease(input.previous, input.fetcher); if (gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== beforeHead || gitRead(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== beforeStatus) throw new Error("descendant receipt refused a moving public HEAD during authentication");
  const previousNumber = /^openlup-source-preview\/([1-9][0-9]*)$/u.exec(previous.release.tag), next = /^openlup-source-preview\/([1-9][0-9]*)$/u.exec(input.releaseTag), previousOrdinal = Number(previousNumber?.[1]), nextOrdinal = Number(next?.[1]);
  if (!previousNumber || !next || !Number.isSafeInteger(previousOrdinal) || !Number.isSafeInteger(nextOrdinal) || nextOrdinal !== previousOrdinal + 1 || input.tagMessage !== `OpenLup source preview ${next[1]}.`) throw new Error("descendant receipt requires the exactly next preview tag and message");
  try { execFileSync("git", ["merge-base", "--is-ancestor", previous.targetCommit, beforeHead], { cwd: root, stdio: "ignore" }); } catch { throw new Error("descendant receipt target does not descend from the authenticated previous release"); }
  if (beforeHead === previous.targetCommit) throw new Error("descendant receipt target must advance the previous release");
  const tagRaw = gitBytes(root, ["for-each-ref", `--format=%(objecttype)%00%(*objectname)%00%(refname:strip=2)%00%(contents)%00`, `refs/tags/${input.releaseTag}`]).toString();
  const tag = tagRaw.endsWith("\0\n") ? tagRaw.slice(0, -2).split("\0") : [];
  if (tag.length !== 4 || tag[0] !== "tag" || tag[1] !== beforeHead || tag[2] !== input.releaseTag || tag[3] !== `${input.tagMessage}\n`) throw new Error("descendant receipt requires the exact annotated tag at HEAD");
  const targetTree = gitRead(root, ["rev-parse", "HEAD^{tree}"]), parents = gitRead(root, ["show", "-s", "--format=%P", "HEAD"]).split(" ").filter(Boolean);
  if (!commitSha(targetTree) || parents.length === 0 || parents.some((parent) => !commitSha(parent)) || new Set(parents).size !== parents.length) throw new Error("descendant receipt Git commit identity is invalid");
  const finiteW1a = previous.sourceReceiptDigest === W1A_PREVIOUS.receipt && previous.targetCommit === W1A_PREVIOUS.commit && previous.targetTree === W1A_PREVIOUS.tree && input.releaseTag === "openlup-source-preview/5";
  const target = gitInventory(root, beforeHead); const targetDrift = finiteW1a ? assertFiniteW1aTarget(root, previous, target) : (assertPreviousPublicState(root, previous, target), previous.receipt.drift); const paths = inventoryPaths(root, target);
  const contract = paths.find(({ path }) => path === SOURCE_RELEASE_CONTRACT_PATH); if (!contract) throw new Error("descendant receipt source contract is absent");
  const contractRaw = gitBytes(root, ["show", `${beforeHead}:${SOURCE_RELEASE_CONTRACT_PATH}`]).toString(); validateSourceReleaseContract(contractRaw); if (receiptDigest(contractRaw) !== contract.digest || (!finiteW1a && contract.digest !== previous.receipt.contract.digest)) throw new Error("descendant receipt source contract differs");
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
