import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const COVERAGE_ARTIFACT_SCHEMA_VERSION = 1;
export const COVERAGE_COORDINATE_FORMAT = "repo_relative_v1";
const DIGEST = /^[a-f0-9]{64}$/u;

export type CoverageProofBinding = { key: string; inputDigest: string; commandDigest: string };
export type CoverageSummary = Record<string, unknown> & { total: Record<string, unknown> };
export type CoverageSidecarRead =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; bytes: Buffer };

export function coverageArtifactWaitMs(value: unknown): number {
  const parsed = Number(value ?? 120_000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 120_000) : 120_000;
}

export function readCoverageStageBinding(bindingPath: string, proofPath: string, markerPath: string): Readonly<CoverageProofBinding> {
  if (!bindingPath || !proofPath || !markerPath) throw new Error("Coverage stage binding is incomplete.");
  const expectedProofPath = resolve(proofPath);
  if (!isAbsolute(proofPath) || resolve(markerPath) !== `${expectedProofPath}.singleflight`) {
    throw new Error("Coverage marker does not match the stage proof path.");
  }
  const value = JSON.parse(readFileSync(bindingPath, "utf8"));
  if (value?.schemaVersion !== 1 || value.stageName !== "vitest-coverage"
    || !DIGEST.test(value.key) || !DIGEST.test(value.inputDigest) || !DIGEST.test(value.commandDigest)
    || resolve(String(value.path ?? "")) !== expectedProofPath
    || basename(expectedProofPath) !== `${value.key}.json`
    || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)
    || value.payload.stageName !== value.stageName || value.payload.inputDigest !== value.inputDigest
    || value.payload.commandDigest !== value.commandDigest || hashBytes(Buffer.from(JSON.stringify(value.payload))) !== value.key) {
    throw new Error("Coverage stage binding does not match its proof payload.");
  }
  return Object.freeze({ key: value.key, inputDigest: value.inputDigest, commandDigest: value.commandDigest });
}

export function normalizeCoverageSummaryForPublication(sourcePath: string, producerRoot = process.cwd()): CoverageSummary {
  const root = realpathSync(resolve(producerRoot));
  const summary = parseSummary(readFileSync(sourcePath));
  const entries = new Map<string, unknown>();
  for (const [rawPath, coverage] of Object.entries(summary)) {
    if (rawPath === "total") continue;
    const key = repositoryKey(rawPath, root);
    if (entries.has(key)) throw new Error(`Coverage summary contains duplicate repository coordinate: ${key}`);
    entries.set(key, coverage);
  }
  return Object.fromEntries([["total", summary.total], ...[...entries].sort(([left], [right]) => left.localeCompare(right))]) as CoverageSummary;
}

export function coverageSidecarBytes(sourcePath: string, producerRoot: string, proof: CoverageProofBinding): Buffer {
  const summary = normalizeCoverageSummaryForPublication(sourcePath, producerRoot);
  const summaryBytes = canonicalSummaryBytes(summary);
  return Buffer.from(`${JSON.stringify({
    schemaVersion: COVERAGE_ARTIFACT_SCHEMA_VERSION,
    coordinateFormat: COVERAGE_COORDINATE_FORMAT,
    proof,
    summarySha256: hashBytes(summaryBytes),
    summary,
  }, null, 2)}\n`);
}

export function readValidatedCoverageSidecar(sidecarPath: string, consumerRoot: string, expectedProof: CoverageProofBinding): CoverageSidecarRead {
  if (!sidecarPath || !existsSync(sidecarPath)) return { status: "missing" };
  try {
    const envelope = JSON.parse(readFileSync(sidecarPath, "utf8"));
    if (envelope?.schemaVersion !== COVERAGE_ARTIFACT_SCHEMA_VERSION
      || envelope.coordinateFormat !== COVERAGE_COORDINATE_FORMAT
      || !sameProof(envelope.proof, expectedProof)) throw new Error("binding mismatch");
    const summaryBytes = canonicalSummaryBytes(envelope.summary);
    if (!DIGEST.test(envelope.summarySha256) || hashBytes(summaryBytes) !== envelope.summarySha256) {
      throw new Error("checksum mismatch");
    }
    validateSummaryForRoot(envelope.summary, consumerRoot);
    return { status: "valid", bytes: summaryBytes };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function validateCanonicalCoverageSummaryBytes(bytes: Buffer): CoverageSummary {
  const summary = parseSummary(bytes);
  for (const key of Object.keys(summary)) if (key !== "total") assertCanonicalKey(key);
  return summary;
}

export const hashCoverageBytes = hashBytes;

function canonicalSummaryBytes(summary: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(parseSummaryValue(summary), null, 2)}\n`);
}

function validateSummaryForRoot(summary: unknown, consumerRoot: string): void {
  const root = realpathSync(resolve(consumerRoot));
  for (const key of Object.keys(parseSummaryValue(summary))) {
    if (key === "total") continue;
    assertCanonicalKey(key);
    const target = resolve(root, ...key.split("/"));
    if (!existsSync(target) || !statSync(target).isFile() || containedRelative(root, realpathSync(target)) !== key) {
      throw new Error(`Coverage summary coordinate is unavailable in the consumer repository: ${key}`);
    }
  }
}

function repositoryKey(rawPath: string, root: string): string {
  if (!rawPath || rawPath.includes("\0")) throw new Error("Coverage summary contains an empty or invalid path.");
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, ...rawPath.split("/"));
  if (!isAbsolute(rawPath)) assertCanonicalKey(rawPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`Coverage summary path is outside the producer repository or missing: ${rawPath}`);
  }
  const key = containedRelative(root, realpathSync(absolute));
  if (!key || (!isAbsolute(rawPath) && key !== rawPath)) {
    throw new Error(`Coverage summary path escapes the producer repository: ${rawPath}`);
  }
  assertCanonicalKey(key);
  return key;
}

function containedRelative(root: string, target: string): string {
  const value = relative(root, target);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return "";
  return value.split(sep).join("/");
}

function parseSummary(bytes: Buffer): CoverageSummary {
  return parseSummaryValue(JSON.parse(bytes.toString("utf8")));
}

function parseSummaryValue(value: unknown): CoverageSummary {
  const summary = value as Record<string, unknown> | null;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || !summary.total || typeof summary.total !== "object" || Array.isArray(summary.total)) {
    throw new Error("Coverage summary must be an object with a total entry.");
  }
  return summary as CoverageSummary;
}

function assertCanonicalKey(key: string): void {
  if (!key || key.includes("\\") || isAbsolute(key) || key.startsWith("./")
    || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Coverage summary path is not a canonical repository-relative key: ${key}`);
  }
}

function sameProof(actual: CoverageProofBinding | null | undefined, expected: CoverageProofBinding): boolean {
  return actual?.key === expected.key && actual.inputDigest === expected.inputDigest
    && actual.commandDigest === expected.commandDigest;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
