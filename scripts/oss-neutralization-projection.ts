import { createHash } from "node:crypto";
import { carriesPrivateOperationalCoordinate, NEUTRALIZATION_RULESET_DIGEST, projectOperationalCoordinates } from "./oss-public-coordinate-detector.ts";
export { carriesPrivateOperationalCoordinate, NEUTRALIZATION_RULESET_DIGEST, projectOperationalCoordinates } from "./oss-public-coordinate-detector.ts";

export type NeutralizationWrite = { path: string; contents: string };
export type NeutralizationEntry = { path: string; class: "framework-namespace"; format: "text"; rule: "private-operational-coordinate-v1"; matches: number; sourceDigest: string; outputDigest: string };
export type NeutralizationProjection = { entries: NeutralizationEntry[]; writes: NeutralizationWrite[]; registryDigest: string; ruleSetDigest: string };
export type NeutralizationRegistry = { schemaVersion: 1; ruleSetDigest: string; reason: string; entries: NeutralizationEntry[] };
export type PublicCoordinateProfile = { repository: string; securityRoute: string };
/**
 * The path the registry occupied while it was carried by every branch.
 *
 * Nothing reads it any more: it is kept so the artifact writer can refuse to put the cache back,
 * which is the one destination `--registry-out` must never accept.
 */
export const NEUTRALIZATION_REGISTRY_PATH = "config/oss-operational-coordinate-projections.json";

const digest = (contents: string): string => `sha256-${createHash("sha256").update(contents).digest("hex")}`;

/**
 * The registry document, validated.
 *
 * It survives the registry leaving git because the artifact is still a published document: the
 * merge-group upload is read by people and by the published-tree fixture, and a document nothing
 * can parse is a document nothing can check.
 */
export function parseRegistry(raw: unknown): NeutralizationRegistry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("neutralizationProjection: missing exact registry");
  const value = raw as Partial<NeutralizationRegistry>;
  if (value.schemaVersion !== 1 || value.ruleSetDigest !== NEUTRALIZATION_RULESET_DIGEST || typeof value.reason !== "string" || value.reason.trim() === "" || !Array.isArray(value.entries)) throw new Error("neutralizationProjection: invalid schema, reason, or rule-set digest");
  const entries = value.entries as NeutralizationEntry[];
  const paths = entries.map((entry) => entry?.path);
  if (paths.some((path) => typeof path !== "string" || path === "") || new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error("neutralizationProjection: entry paths must be sorted and unique");
  for (const entry of entries) {
    if (entry.class !== "framework-namespace" || entry.format !== "text" || entry.rule !== "private-operational-coordinate-v1" || !Number.isInteger(entry.matches) || entry.matches < 1 || !/^sha256-[a-f0-9]{64}$/u.test(entry.sourceDigest) || !/^sha256-[a-f0-9]{64}$/u.test(entry.outputDigest)) throw new Error(`neutralizationProjection: invalid entry ${entry.path}`);
  }
  return value as NeutralizationRegistry;
}

/**
 * The neutralization of one tree, computed from that tree's sources alone.
 *
 * This replaced `projectRegisteredNeutralizations`, which took a tracked registry and asserted the
 * detector agreed with it. That assertion is why every branch had to carry the registry, and the
 * registry is what conflicted on 18 % of merges to `main`. What the assertion actually protected is
 * kept here rather than dropped: the output of the projection is re-tested, so a rule that leaves a
 * private operational coordinate standing still stops the export instead of publishing it.
 *
 * `registryDigest` is the digest of the computed entries, which is the same value the tracked
 * registry implied for the same tree - the export's `classificationDigests` therefore do not move.
 */
export function activateProjectedCoordinates(contents: string, profile?: PublicCoordinateProfile, path = ""): string {
  if (!profile) return contents;
  return contents
    .replaceAll("https://openlup.invalid/repository", profile.repository)
    .replaceAll("openlup.invalid/repository", profile.repository.replace(/^https:\/\//u, ""))
    .replaceAll("security@openlup.invalid", profile.securityRoute)
    .replaceAll("operator@example.invalid", path === "scripts/oss-publication-contract.ts" ? profile.securityRoute : "operator@example.invalid")
    .replaceAll("platform.openlup.invalid", "openlup.com")
    .replaceAll("op://openlup.invalid", profile.repository);
}

export function hasUnresolvedOperationalPlaceholder(contents: string, path: string): boolean {
  const unresolved = ["openlup.invalid/repository", "security@openlup.invalid", "platform.openlup.invalid", "op://openlup.invalid"];
  return unresolved.some((value) => contents.includes(value)) || (contents.includes("operator@example.invalid") && !["server/domains/partners/managedB2BInquirySubmit.ts", "server/domains/support/customerJourneySnapshot.test.ts"].includes(path));
}

export function computeNeutralizations(sources: ReadonlyMap<string, string>, profile?: PublicCoordinateProfile): NeutralizationProjection {
  const entries: NeutralizationEntry[] = [];
  const writes: NeutralizationWrite[] = [];
  for (const path of [...sources.keys()].sort()) {
    const source = sources.get(path)!;
    if (!carriesPrivateOperationalCoordinate(source, path)) continue;
    const projectedBase = projectOperationalCoordinates(source, path);
    const projected = { ...projectedBase, contents: activateProjectedCoordinates(projectedBase.contents, profile, path) };
    if (carriesPrivateOperationalCoordinate(projected.contents, path)) throw new Error(`neutralizationProjection: the projected output still carries a private operational coordinate at ${path}`);
    entries.push({ path, class: "framework-namespace", format: "text", rule: "private-operational-coordinate-v1", matches: projected.matches, sourceDigest: digest(source), outputDigest: digest(projected.contents) });
    writes.push({ path, contents: projected.contents });
  }
  return { entries, writes, registryDigest: digest(JSON.stringify(entries)), ruleSetDigest: NEUTRALIZATION_RULESET_DIGEST };
}
