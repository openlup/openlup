import { createHash } from "node:crypto";
import { posix } from "node:path";

export const CONSUMER_RECEIPT_PATH = "config/oss-consumed-upstream.json";
export const SOURCE_AUTHORITY_EXCEPTIONS_PATH = "config/oss-source-authority-exceptions.json";
export const ACTIVATION_JOURNAL_PATH = "config/oss-consume-activation-journal.json";
export const CONSUMER_CONTROL_PATHS = [CONSUMER_RECEIPT_PATH, "config/oss-upstream-adoptions.json", SOURCE_AUTHORITY_EXCEPTIONS_PATH, ACTIVATION_JOURNAL_PATH] as const;
export const DIGEST = /^sha256:[0-9a-f]{64}$/u;
export const SHA = /^[0-9a-f]{40}$/u;

type JsonObject = Record<string, unknown>;
export type Digest = `sha256:${string}`;
export type PathClass = "consumable" | "local-measurement" | "projected";
export type ClassEntry = { selector: string; reason: string };
export type InventoryBase = { algorithm: "sha256-path-nul-blob-v1"; pathCount: number; digest: Digest };
export type ReviewLimits = { paths: number; hunks: number; patchBytes: number };
export type ConsumeMetrics = ReviewLimits;
export type LastConsume = {
  repository: string; releaseTag: string; releaseImmutable: true; assetName: string; assetId: number; assetDigest: Digest;
  previousPublicSha: string | null; targetPublicSha: string; targetTree: string; publicContractDigest: Digest; sourceReceiptDigest: Digest;
  downstreamBase: InventoryBase; changePathDigest: Digest; patchDigest: Digest; metrics: ConsumeMetrics; changeSetDigest: Digest; executionPlanDigest: Digest;
};
export type ConsumerReceipt = {
  schemaVersion: 2; state: "pre-split" | "active"; waveMarker: string;
  source: { repository: string | null; protectedRef: string | null; rulesetIds: number[]; releaseTagPrefix: "openlup-source-preview/"; assetName: "openlup-source-receipt.json" };
  reviewPolicy: { metricVersion: "git-diff-v1"; measurementSha: string; windowSize: number; limits: ReviewLimits };
  pinMarkers: string[]; classes: { localMeasurement: ClassEntry[]; projected: ClassEntry[] }; lastConsume: LastConsume | null;
};
export type EmergencyPath = { path: string; preimageDigest: Digest; localDigest: Digest; acceptedTargetDigest?: Digest };
export type SourceAuthorityException = {
  id: string; incidentId: string; owner: string; openedAt: string; expiresAt: string; paths: EmergencyPath[];
  coordination?: { upstreamReference: string; recordedAt: string };
};
export type SourceAuthorityExceptions = { schemaVersion: 1; exceptions: SourceAuthorityException[] };
export type ActivationJournalEntry = { candidateDigest: Digest; receiptPreimageDigest: Digest; refusalCode: string; evidenceDigest: Digest; recordedAt: string };
export type ActivationJournal = { schemaVersion: 1; entries: ActivationJournalEntry[] };
export type OwnerPageViolation = { code: "source-authority-owner-page-required"; owner: string; incidentId: string; paths: string[]; expiresAt: string; evidenceDigest: Digest };

const object = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
};
const exact = (value: JsonObject, label: string, keys: readonly string[]) => {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key)).sort();
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${label} misses field(s): ${missing.join(", ")}`);
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) throw new Error(`${label} must be a canonical non-empty string`);
  return value;
};
const integer = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return value as number;
};
const digest = (value: unknown, label: string): Digest => {
  const result = text(value, label);
  if (!DIGEST.test(result)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return result as Digest;
};
const sha = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (!SHA.test(result)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return result;
};
const repository = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result) || result.endsWith(".git") || result.includes(".invalid")) throw new Error(`${label} must be a canonical non-placeholder GitHub repository URL`);
  return result;
};
const protectedRef = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (result.startsWith("/") || result.endsWith("/") || result.includes("..") || result.includes("@{") || result.endsWith(".lock") || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result)) throw new Error(`${label} must be a canonical branch name`);
  return result;
};
export const canonicalPath = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (result.startsWith("/") || result.endsWith("/") || result.includes("\\") || result.split("/").includes("..") || result.split("/").includes("") || posix.normalize(result) !== result) throw new Error(`${label} must be a canonical repository-relative path`);
  return result;
};
const timestamp = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) || new Date(result).toISOString() !== result) throw new Error(`${label} must be a canonical UTC timestamp`);
  return result;
};
const sortedUnique = (values: string[], label: string) => {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) throw new Error(`${label} must be sorted and unique`);
};
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value as JsonObject).sort(([left], [right]) => compare(left, right)).map(([key, item]) => [key, canonicalValue(item)])) : value;
export const sha256 = (value: string | Buffer): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
export const canonicalDigest = (value: unknown): Digest => sha256(JSON.stringify(canonicalValue(value)));

// `ordered` is only ever false for the superseded v1 receipt below: sorting was introduced
// with v2 as merge hygiene, so it is not a property of bytes written before v2 existed.
function entries(value: unknown, label: string, ordered = true): ClassEntry[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((row, index) => { const item = object(row, `${label}[${index}]`); exact(item, `${label}[${index}]`, ["selector", "reason"]); return { selector: canonicalPath(item.selector, `${label}[${index}].selector`), reason: text(item.reason, `${label}[${index}].reason`) }; });
  if (ordered) sortedUnique(result.map(({ selector }) => selector), label);
  return result;
}
function limits(value: unknown, label: string): ReviewLimits {
  const item = object(value, label); exact(item, label, ["paths", "hunks", "patchBytes"]);
  return { paths: integer(item.paths, `${label}.paths`, 1), hunks: integer(item.hunks, `${label}.hunks`, 1), patchBytes: integer(item.patchBytes, `${label}.patchBytes`, 1) };
}
function metrics(value: unknown, label: string): ConsumeMetrics {
  const item = object(value, label); exact(item, label, ["paths", "hunks", "patchBytes"]);
  return { paths: integer(item.paths, `${label}.paths`), hunks: integer(item.hunks, `${label}.hunks`), patchBytes: integer(item.patchBytes, `${label}.patchBytes`) };
}
function inventory(value: unknown, label: string): InventoryBase {
  const item = object(value, label); exact(item, label, ["algorithm", "pathCount", "digest"]);
  if (item.algorithm !== "sha256-path-nul-blob-v1") throw new Error(`${label}.algorithm is unsupported`);
  return { algorithm: item.algorithm, pathCount: integer(item.pathCount, `${label}.pathCount`), digest: digest(item.digest, `${label}.digest`) };
}
function lastConsume(value: unknown): LastConsume {
  const item = object(value, "consumer receipt.lastConsume");
  const keys = ["repository", "releaseTag", "releaseImmutable", "assetName", "assetId", "assetDigest", "previousPublicSha", "targetPublicSha", "targetTree", "publicContractDigest", "sourceReceiptDigest", "downstreamBase", "changePathDigest", "patchDigest", "metrics", "changeSetDigest", "executionPlanDigest"];
  exact(item, "consumer receipt.lastConsume", keys);
  if (item.releaseImmutable !== true) throw new Error("consumer receipt.lastConsume.releaseImmutable must be true");
  const previous = item.previousPublicSha === null ? null : sha(item.previousPublicSha, "consumer receipt.lastConsume.previousPublicSha");
  const result: LastConsume = {
    repository: repository(item.repository, "consumer receipt.lastConsume.repository"), releaseTag: text(item.releaseTag, "consumer receipt.lastConsume.releaseTag"), releaseImmutable: true,
    assetName: text(item.assetName, "consumer receipt.lastConsume.assetName"), assetId: integer(item.assetId, "consumer receipt.lastConsume.assetId", 1), assetDigest: digest(item.assetDigest, "consumer receipt.lastConsume.assetDigest"),
    previousPublicSha: previous, targetPublicSha: sha(item.targetPublicSha, "consumer receipt.lastConsume.targetPublicSha"), targetTree: sha(item.targetTree, "consumer receipt.lastConsume.targetTree"),
    publicContractDigest: digest(item.publicContractDigest, "consumer receipt.lastConsume.publicContractDigest"), sourceReceiptDigest: digest(item.sourceReceiptDigest, "consumer receipt.lastConsume.sourceReceiptDigest"),
    downstreamBase: inventory(item.downstreamBase, "consumer receipt.lastConsume.downstreamBase"), changePathDigest: digest(item.changePathDigest, "consumer receipt.lastConsume.changePathDigest"),
    patchDigest: digest(item.patchDigest, "consumer receipt.lastConsume.patchDigest"), metrics: metrics(item.metrics, "consumer receipt.lastConsume.metrics"),
    changeSetDigest: digest(item.changeSetDigest, "consumer receipt.lastConsume.changeSetDigest"), executionPlanDigest: digest(item.executionPlanDigest, "consumer receipt.lastConsume.executionPlanDigest"),
  };
  if (!/^openlup-source-preview\/[1-9][0-9]*$/u.test(result.releaseTag)) throw new Error("consumer receipt.lastConsume.releaseTag is invalid");
  if (result.assetName !== "openlup-source-receipt.json") throw new Error("consumer receipt.lastConsume.assetName is invalid");
  return result;
}
export function parseConsumerReceipt(raw: string): ConsumerReceipt {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`${CONSUMER_RECEIPT_PATH} is not valid JSON`); }
  const item = object(parsed, "consumer receipt"); exact(item, "consumer receipt", ["schemaVersion", "state", "waveMarker", "source", "reviewPolicy", "pinMarkers", "classes", "lastConsume"]);
  if (item.schemaVersion !== 2 || (item.state !== "pre-split" && item.state !== "active")) throw new Error("consumer receipt schema/state is invalid");
  const source = object(item.source, "consumer receipt.source"); exact(source, "consumer receipt.source", ["repository", "protectedRef", "rulesetIds", "releaseTagPrefix", "assetName"]);
  const sourceRepository = source.repository === null ? null : repository(source.repository, "consumer receipt.source.repository");
  const sourceProtectedRef = source.protectedRef === null ? null : protectedRef(source.protectedRef, "consumer receipt.source.protectedRef");
  if (!Array.isArray(source.rulesetIds)) throw new Error("consumer receipt.source.rulesetIds must be an array");
  const rulesetIds = source.rulesetIds.map((value, index) => integer(value, `consumer receipt.source.rulesetIds[${index}]`, 1));
  if (new Set(rulesetIds).size !== rulesetIds.length || rulesetIds.some((value, index) => index > 0 && rulesetIds[index - 1]! >= value)) throw new Error("consumer receipt.source.rulesetIds must be sorted and unique");
  if (source.releaseTagPrefix !== "openlup-source-preview/" || source.assetName !== "openlup-source-receipt.json") throw new Error("consumer receipt source naming is invalid");
  const policy = object(item.reviewPolicy, "consumer receipt.reviewPolicy"); exact(policy, "consumer receipt.reviewPolicy", ["metricVersion", "measurementSha", "windowSize", "limits"]);
  if (policy.metricVersion !== "git-diff-v1") throw new Error("consumer receipt review metric is unsupported");
  if (!Array.isArray(item.pinMarkers) || item.pinMarkers.some((value) => typeof value !== "string" || value === "")) throw new Error("consumer receipt.pinMarkers must be strings");
  const pinMarkers = item.pinMarkers as string[]; sortedUnique(pinMarkers, "consumer receipt.pinMarkers");
  const classes = object(item.classes, "consumer receipt.classes"); exact(classes, "consumer receipt.classes", ["localMeasurement", "projected"]);
  const result: ConsumerReceipt = { schemaVersion: 2, state: item.state, waveMarker: text(item.waveMarker, "consumer receipt.waveMarker"), source: { repository: sourceRepository, protectedRef: sourceProtectedRef, rulesetIds, releaseTagPrefix: source.releaseTagPrefix, assetName: source.assetName }, reviewPolicy: { metricVersion: policy.metricVersion, measurementSha: sha(policy.measurementSha, "consumer receipt.reviewPolicy.measurementSha"), windowSize: integer(policy.windowSize, "consumer receipt.reviewPolicy.windowSize", 1), limits: limits(policy.limits, "consumer receipt.reviewPolicy.limits") }, pinMarkers, classes: { localMeasurement: entries(classes.localMeasurement, "consumer receipt.classes.localMeasurement"), projected: entries(classes.projected, "consumer receipt.classes.projected") }, lastConsume: item.lastConsume === null ? null : lastConsume(item.lastConsume) };
  const preSplitValid = result.lastConsume === null && result.source.repository === null && result.source.protectedRef === null && result.source.rulesetIds.length === 0;
  const activeValid = result.lastConsume !== null && result.source.repository === result.lastConsume.repository && result.source.protectedRef !== null && result.source.rulesetIds.length > 0;
  if (result.state === "pre-split" ? !preSplitValid : !activeValid) throw new Error("consumer receipt state/source/lastConsume combination is invalid");
  return result;
}

/**
 * The one superseded receipt shape git history actually contains: `schemaVersion: 1`, always
 * `pre-split`, carrying its own documentation inline under `$`-prefixed keys. It is parsed
 * here, beside the v2 parser and out of the same validators, so that a reader of history
 * reuses this file's strictness instead of re-implementing a looser copy of it.
 * `parseConsumerReceipt` above is untouched: nothing here relaxes the shape a commit may
 * WRITE, only the shape history is allowed to have already written.
 *
 * A v1 receipt carries no `source`, no `reviewPolicy` and no `lastConsume`, so only the
 * fields with a faithful pre-image are translated - `upstream.remote` becomes
 * `source.repository`, and "nothing consumed yet" becomes `lastConsume: null`. A v1 receipt
 * that disagrees with either is refused rather than flattened, and `reviewPolicy` is absent
 * from the returned type on purpose: inventing one would put a fabricated value somewhere a
 * later reader could believe it.
 *
 * Every field is validated as strictly as v2 validates it, with ONE deliberate exception:
 * v2's sorted-and-unique rule on `pinMarkers` and on the class selectors is merge hygiene
 * that arrived WITH v2, and no v1 receipt in this repository's history satisfies it.
 * Requiring it here would be the same retroactive enforcement this shape exists to undo.
 */
export type PreSplitV1ConsumerReceipt = {
  schemaVersion: 1; state: "pre-split"; waveMarker: string; pinMarkers: string[];
  classes: { localMeasurement: ClassEntry[]; projected: ClassEntry[] }; source: { repository: null }; lastConsume: null;
};
const V1_RECEIPT_KEYS = ["$baseNote", "$note", "$pinMarkersNote", "$waveMarkerNote", "classes", "consumedAtDownstreamSha", "pinMarkers", "schemaVersion", "state", "upstream", "waveMarker"];
const V1_RECEIPT_CLASS_KEYS = ["$derivedNote", "$note", "localMeasurement", "projected"];
export function parsePreSplitV1ConsumerReceipt(raw: string): PreSplitV1ConsumerReceipt {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`${CONSUMER_RECEIPT_PATH} is not valid JSON`); }
  const item = object(parsed, "v1 consumer receipt"); exact(item, "v1 consumer receipt", V1_RECEIPT_KEYS);
  if (item.schemaVersion !== 1 || item.state !== "pre-split") throw new Error("v1 consumer receipt schema/state is invalid");
  const upstream = object(item.upstream, "v1 consumer receipt.upstream"); exact(upstream, "v1 consumer receipt.upstream", ["remote", "ref", "sha"]);
  if (upstream.remote !== null || upstream.ref !== null || upstream.sha !== null || item.consumedAtDownstreamSha !== null) throw new Error("v1 consumer receipt records a consume this reader cannot translate");
  if (!Array.isArray(item.pinMarkers) || item.pinMarkers.length === 0 || item.pinMarkers.some((value) => typeof value !== "string" || value === "")) throw new Error("v1 consumer receipt.pinMarkers must be a non-empty list of strings");
  const classes = object(item.classes, "v1 consumer receipt.classes"); exact(classes, "v1 consumer receipt.classes", V1_RECEIPT_CLASS_KEYS);
  return { schemaVersion: 1, state: "pre-split", waveMarker: text(item.waveMarker, "v1 consumer receipt.waveMarker"), pinMarkers: item.pinMarkers as string[], classes: { localMeasurement: entries(classes.localMeasurement, "v1 consumer receipt.classes.localMeasurement", false), projected: entries(classes.projected, "v1 consumer receipt.classes.projected", false) }, source: { repository: null }, lastConsume: null };
}

function emergencyPath(value: unknown, label: string): EmergencyPath {
  const item = object(value, label); const keys = Object.hasOwn(item, "acceptedTargetDigest") ? ["path", "preimageDigest", "localDigest", "acceptedTargetDigest"] : ["path", "preimageDigest", "localDigest"]; exact(item, label, keys);
  return { path: canonicalPath(item.path, `${label}.path`), preimageDigest: digest(item.preimageDigest, `${label}.preimageDigest`), localDigest: digest(item.localDigest, `${label}.localDigest`), ...(Object.hasOwn(item, "acceptedTargetDigest") ? { acceptedTargetDigest: digest(item.acceptedTargetDigest, `${label}.acceptedTargetDigest`) } : {}) };
}
export function parseSourceAuthorityExceptions(raw: string): SourceAuthorityExceptions {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`${SOURCE_AUTHORITY_EXCEPTIONS_PATH} is not valid JSON`); }
  const root = object(parsed, "source authority exceptions"); exact(root, "source authority exceptions", ["schemaVersion", "exceptions"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.exceptions)) throw new Error("source authority exceptions schema is invalid");
  const exceptions = root.exceptions.map((row, index): SourceAuthorityException => {
    const label = `source authority exceptions[${index}]`, item = object(row, label); const keys = Object.hasOwn(item, "coordination") ? ["id", "incidentId", "owner", "openedAt", "expiresAt", "paths", "coordination"] : ["id", "incidentId", "owner", "openedAt", "expiresAt", "paths"]; exact(item, label, keys);
    const openedAt = timestamp(item.openedAt, `${label}.openedAt`), expiresAt = timestamp(item.expiresAt, `${label}.expiresAt`);
    if (Date.parse(expiresAt) <= Date.parse(openedAt) || Date.parse(expiresAt) - Date.parse(openedAt) > 86_400_000) throw new Error(`${label} expiry must be after opening and no more than 24 hours later`);
    if (!Array.isArray(item.paths) || item.paths.length === 0) throw new Error(`${label}.paths must be non-empty`);
    const paths = item.paths.map((entry, pathIndex) => emergencyPath(entry, `${label}.paths[${pathIndex}]`)); sortedUnique(paths.map(({ path }) => path), `${label}.paths`);
    let coordination: SourceAuthorityException["coordination"];
    if (Object.hasOwn(item, "coordination")) { const value = object(item.coordination, `${label}.coordination`); exact(value, `${label}.coordination`, ["upstreamReference", "recordedAt"]); coordination = { upstreamReference: text(value.upstreamReference, `${label}.coordination.upstreamReference`), recordedAt: timestamp(value.recordedAt, `${label}.coordination.recordedAt`) }; if (Date.parse(coordination.recordedAt) < Date.parse(openedAt) || Date.parse(coordination.recordedAt) > Date.parse(expiresAt)) throw new Error(`${label}.coordination.recordedAt must fall within the exception window`); }
    return { id: text(item.id, `${label}.id`), incidentId: text(item.incidentId, `${label}.incidentId`), owner: text(item.owner, `${label}.owner`), openedAt, expiresAt, paths, ...(coordination ? { coordination } : {}) };
  });
  sortedUnique(exceptions.map(({ id }) => id), "source authority exception ids");
  const claimed = new Set<string>(); for (const entry of exceptions) for (const subject of entry.paths) { if (claimed.has(subject.path)) throw new Error(`source authority exception path is claimed twice: ${subject.path}`); claimed.add(subject.path); }
  return { schemaVersion: 1, exceptions };
}
export function parseActivationJournal(raw: string): ActivationJournal {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`${ACTIVATION_JOURNAL_PATH} is not valid JSON`); }
  const root = object(parsed, "activation journal"); exact(root, "activation journal", ["schemaVersion", "entries"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.entries)) throw new Error("activation journal schema is invalid");
  const entries = root.entries.map((row, index): ActivationJournalEntry => { const label = `activation journal.entries[${index}]`, item = object(row, label); exact(item, label, ["candidateDigest", "receiptPreimageDigest", "refusalCode", "evidenceDigest", "recordedAt"]); return { candidateDigest: digest(item.candidateDigest, `${label}.candidateDigest`), receiptPreimageDigest: digest(item.receiptPreimageDigest, `${label}.receiptPreimageDigest`), refusalCode: text(item.refusalCode, `${label}.refusalCode`), evidenceDigest: digest(item.evidenceDigest, `${label}.evidenceDigest`), recordedAt: timestamp(item.recordedAt, `${label}.recordedAt`) }; });
  if (new Set(entries.map(activationJournalEntryKey)).size !== entries.length) throw new Error("activation journal evidence tuples must be unique");
  return { schemaVersion: 1, entries };
}
export const activationJournalEntryKey = ({ candidateDigest, receiptPreimageDigest, refusalCode, evidenceDigest }: Omit<ActivationJournalEntry, "recordedAt"> | ActivationJournalEntry): Digest => canonicalDigest({ candidateDigest, receiptPreimageDigest, refusalCode, evidenceDigest });
export const validateJournalAppend = (before: ActivationJournal, after: ActivationJournal): string[] => before.entries.length > after.entries.length || before.entries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(after.entries[index])) ? ["activation journal is not append-only"] : [];
export const inventoryBase = (rows: Array<{ path: string; blobDigest: Digest }>): InventoryBase => {
  const sorted = [...rows].sort((left, right) => compare(left.path, right.path)); sortedUnique(sorted.map(({ path }) => path), "downstream inventory paths");
  return { algorithm: "sha256-path-nul-blob-v1", pathCount: sorted.length, digest: sha256(sorted.map(({ path, blobDigest }) => `${path}\0${blobDigest}\n`).join("")) };
};
export const receiptAuthorityState = (receipt: Pick<ConsumerReceipt, "state" | "lastConsume">): string => receipt.state === "pre-split" ? "pre-split" : `active|${receipt.lastConsume!.targetPublicSha}|${receipt.lastConsume!.downstreamBase.digest}`;
export function ownerPageViolations(registry: SourceAuthorityExceptions, now: Date, scope?: ReadonlySet<string>): OwnerPageViolation[] {
  return registry.exceptions.flatMap((entry) => {
    const coordinated = entry.coordination && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/u.test(entry.coordination.upstreamReference);
    if (coordinated && Date.parse(entry.expiresAt) > now.getTime()) return [];
    const paths = entry.paths.map(({ path }) => path).filter((path) => !scope || scope.has(path));
    return paths.length === 0 ? [] : [{ code: "source-authority-owner-page-required" as const, owner: entry.owner, incidentId: entry.incidentId, paths, expiresAt: entry.expiresAt, evidenceDigest: canonicalDigest({ id: entry.id, incidentId: entry.incidentId, owner: entry.owner, paths: entry.paths, expiresAt: entry.expiresAt, coordination: entry.coordination ?? null, overlap: paths }) }];
  });
}
