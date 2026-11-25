import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackagesIncremental } from "./build-packages-incremental.mjs";
import { INVENTORY_PATH, inventoryEnvelope } from "./agent-review-derived.mjs";
import { SQL_REFERENCE, syncSqlReference } from "./agent-review-generators.mjs";
import { isUtcMigrationSlot, nextFreeMigrationSlot } from "./migration-slots.mjs";
import { parseStrictJson } from "./oss-strict-json.mts";
import { checkPlatformMigrationProjection } from "./packages/platform-migration-projection.ts";
import {
  REVIEWED_FORWARD_PATH,
  nativeStoreFunctionDefinitions,
  readReviewedForwardRegistry,
  sqlSha256,
  type NativeStoreSlot,
} from "./reviewed-platform-forward.ts";

const MANIFEST_PATH = "config/platform-migration-manifest.json";
const ALL_SLOT_PATTERN = /^(?:db\/platform|supabase)\/migrations\/(?:(?:q2|qa|qb)_)?(\d{14})_[A-Za-z0-9_-]+\.sql$/u;
const PLAIN_FORWARD_PATTERN = /^db\/platform\/migrations\/(\d{14})_[a-z][a-z0-9_]*\.sql$/u;
const ZERO_SLOT = "00000000000000";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

export interface MigrationSyncOptions {
  readonly root: string;
  readonly baseRef?: string;
  readonly files?: readonly string[];
  readonly nextSlot?: boolean;
  readonly noInventory?: boolean;
  readonly check?: boolean;
  readonly runInventoryRefresh?: (root: string) => void;
  readonly runIncrementalBuild?: (root: string) => void;
}

export interface MigrationSyncResult {
  readonly mode: "next-slot" | "check" | "sync";
  readonly baseRef: string;
  readonly nextSlot?: string;
  readonly files: readonly string[];
  readonly manifestUpdated: boolean;
  readonly forwardsUpdated: boolean;
  readonly inventoryRefreshed: boolean;
  readonly drift: readonly string[];
}

type ManifestUnit = { file: string; sha256: string };
type ManifestPlan = {
  baseline?: ManifestUnit;
  forward: ManifestUnit[];
  objectInventorySha256?: unknown;
};
type MutablePlatformManifest = ManifestPlan & {
  qualified?: ManifestPlan;
  qualifiedAdmin?: ManifestPlan;
};

type ForwardFunctionPin = { signature: string; beforeSha256: string | null; afterSha256: string };
type NativeStoreForwardEntry = { path: string; sha256: string; functions: ForwardFunctionPin[] };
type MutableReviewedForwards = {
  nativeStoreForwards?: NativeStoreForwardEntry[];
  nativeStoreForwardClass?: { sealed: boolean; slots: NativeStoreSlot[] };
  [key: string]: unknown;
};

function gitLines(root: string, args: readonly string[]): string[] {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

function resolveBaseCommit(root: string, baseRef: string): string {
  if (!baseRef || baseRef.startsWith("-")) {
    throw new Error("base git ref must not be empty or start with a hyphen");
  }
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error("unable to resolve base migration history from the configured git ref", { cause: error });
  }
}

function listLocalMigrationPaths(root: string): string[] {
  const results: string[] = [];
  for (const dir of ["db/platform/migrations", "supabase/migrations"]) {
    const fullDir = join(root, dir);
    if (!existsSync(fullDir)) continue;
    for (const entry of readdirSync(fullDir)) {
      if (entry.endsWith(".sql")) results.push(`${dir}/${entry}`);
    }
  }
  return results.sort();
}

function listBaseMigrationPaths(root: string, baseCommit: string): string[] {
  try {
    return gitLines(root, ["ls-tree", "-r", "--name-only", "-z", baseCommit, "--", "db/platform/migrations", "supabase/migrations"]).sort();
  } catch (error) {
    throw new Error("unable to read base migration history from the configured git ref", { cause: error });
  }
}

function maxSlotFromPaths(paths: readonly string[]): string {
  const slots = paths
    .map((path) => ALL_SLOT_PATTERN.exec(path)?.[1])
    .filter((slot): slot is string => typeof slot === "string" && slot !== ZERO_SLOT)
    .sort();
  return slots.at(-1) ?? ZERO_SLOT;
}

export function allocateNextMigrationSlot(root: string, baseRef = "origin/main"): string {
  const baseCommit = resolveBaseCommit(root, baseRef);
  const basePaths = listBaseMigrationPaths(root, baseCommit);
  const localPaths = listLocalMigrationPaths(root);
  const highest = maxSlotFromPaths([...basePaths, ...localPaths]);
  return nextFreeMigrationSlot(highest);
}

function readGitBlob(root: string, ref: string, path: string): Buffer {
  return execFileSync("git", ["-C", root, "show", `${ref}:${path}`], {
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function assertBaseMigrationsUnchanged(root: string, baseCommit: string, basePaths: readonly string[]): void {
  for (const path of basePaths) {
    if (!path.startsWith("db/platform/migrations/")) continue;
    const full = join(root, path);
    if (!existsSync(full)) throw new Error("existing base migration file was deleted from the working tree");
    const disk = readFileSync(full);
    const committed = readGitBlob(root, baseCommit, path);
    if (!disk.equals(committed)) throw new Error("existing base migration bytes are immutable and must not be edited");
  }
}

function upsertForwardUnit(forward: ManifestUnit[], file: string, sha256: string, baseFiles: ReadonlySet<string>): void {
  const existingIndex = forward.findIndex((unit) => unit.file === file);
  if (existingIndex >= 0) {
    if (baseFiles.has(file) && forward[existingIndex]!.sha256 !== sha256) {
      throw new Error("existing base migration checksum must not be modified");
    }
    forward[existingIndex] = { file, sha256 };
    return;
  }
  // Preserve the issued base prefix order verbatim (including qualified q2_/qa_/qb_
  // entries interleaved by timestamp) and only sort non-base suffix entries.
  let prefixEnd = 0;
  for (let index = 0; index < forward.length; index += 1) {
    if (baseFiles.has(forward[index]!.file)) prefixEnd = index + 1;
  }
  const prefix = forward.slice(0, prefixEnd);
  const suffix = [...forward.slice(prefixEnd), { file, sha256 }].sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  );
  forward.splice(0, forward.length, ...prefix, ...suffix);
}

function applyInventoryDigestsToManifest(root: string, manifest: MutablePlatformManifest): void {
  const inventorySource = readFileSync(join(root, INVENTORY_PATH), "utf8");
  const envelope = inventoryEnvelope(inventorySource) as { value?: { current?: { profiles?: Record<string, { objectInventorySha256?: unknown } | undefined> } } };
  const profiles = envelope.value?.current?.profiles;
  if (!profiles || typeof profiles !== "object") {
    throw new Error("measured installation inventory is missing current profile digests");
  }
  const requireHash = (name: string): string => {
    const value = profiles[name]?.objectInventorySha256;
    if (typeof value !== "string" || !HEX_SHA256.test(value)) {
      throw new Error("measured installation inventory contains an invalid SHA-256 digest");
    }
    return value;
  };
  manifest.objectInventorySha256 = requireHash("legacy");
  if (manifest.qualified) {
    manifest.qualified.objectInventorySha256 = {
      bootstrapMigrator: { withRestore: requireHash("bootstrap") },
      separateMigrator: { withRestore: requireHash("separate") },
    };
  }
  if (manifest.qualifiedAdmin) {
    manifest.qualifiedAdmin.objectInventorySha256 = {
      installerManaged: requireHash("admin-managed"),
      operatorProvisioned: requireHash("admin-operator"),
    };
  }
}

function computePrecedingFunctionDigests(
  root: string,
  manifest: MutablePlatformManifest,
  targetPath: string,
  signatures: readonly string[],
): Map<string, string> {
  if (!signatures.length) return new Map();
  const sources: string[] = [];
  if (manifest.baseline?.file) sources.push(manifest.baseline.file);
  for (const unit of manifest.forward) {
    if (unit.file === targetPath) break;
    sources.push(unit.file);
  }
  const latest = new Map<string, string>();
  for (const sourcePath of sources) {
    const defs = nativeStoreFunctionDefinitions(readFileSync(join(root, sourcePath)), signatures, true);
    for (const [signature, digest] of defs) latest.set(signature, digest);
  }
  return latest;
}

function syncReviewedForwardsForTargets(
  root: string,
  manifest: MutablePlatformManifest,
  forwards: MutableReviewedForwards,
  targetDigests: ReadonlyMap<string, { bytes: Buffer; sha256: string }>,
): boolean {
  const slots = forwards.nativeStoreForwardClass?.slots;
  if (!Array.isArray(slots)) return false;
  let touched = false;
  const nativeForwards = Array.isArray(forwards.nativeStoreForwards) ? forwards.nativeStoreForwards : [];
  for (const [targetPath, { bytes, sha256 }] of targetDigests) {
    const slot = slots.find((candidate) => candidate.path === targetPath);
    if (!slot) continue;
    touched = true;
    const replacedSignatures = slot.replacedFunctions.map((fn) => fn.signature);
    const createdSignatures = slot.createdFunctions.map((fn) => fn.signature);
    const allSignatures = [...replacedSignatures, ...createdSignatures];
    const preceding = computePrecedingFunctionDigests(root, manifest, targetPath, replacedSignatures);
    const current = allSignatures.length ? nativeStoreFunctionDefinitions(bytes, allSignatures, false) : new Map<string, string>();

    const functions: ForwardFunctionPin[] = [];
    for (const fn of slot.replacedFunctions) {
      const beforeSha256 = preceding.get(fn.signature);
      if (!beforeSha256) throw new Error("declared replacedFunction signature was not found in preceding migration history");
      const afterSha256 = current.get(fn.signature);
      if (!afterSha256) throw new Error("declared replacedFunction signature was not found in the target migration file");
      fn.beforeSha256 = beforeSha256;
      functions.push({ signature: fn.signature, beforeSha256, afterSha256 });
    }
    for (const fn of slot.createdFunctions) {
      const afterSha256 = current.get(fn.signature);
      if (!afterSha256) throw new Error("declared createdFunction signature was not found in the target migration file");
      functions.push({ signature: fn.signature, beforeSha256: null, afterSha256 });
    }

    const entry: NativeStoreForwardEntry = { path: targetPath, sha256, functions };
    const existingIndex = nativeForwards.findIndex((item) => item.path === targetPath);
    if (existingIndex >= 0) nativeForwards[existingIndex] = entry;
    else nativeForwards.push(entry);
  }
  if (touched) {
    const slotOrder = new Map(slots.map((slot, index) => [slot.path, index]));
    nativeForwards.sort((left, right) => {
      const leftOrder = slotOrder.get(left.path) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = slotOrder.get(right.path) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    });
    forwards.nativeStoreForwards = nativeForwards;
  }
  return touched;
}

function defaultInventoryRefresh(root: string): void {
  execFileSync(process.execPath, ["--import", "tsx", join(root, "scripts/installation-inventory-refresh.ts")], {
    cwd: root,
    stdio: "inherit",
    timeout: 900_000,
  });
}

function defaultIncrementalBuild(root: string): void {
  buildPackagesIncremental({ rootDir: root, stdio: "inherit" });
}

export function runMigrationSync(options: MigrationSyncOptions): MigrationSyncResult {
  const root = resolve(options.root);
  const baseRef = options.baseRef ?? "origin/main";
  if (options.nextSlot) {
    return {
      mode: "next-slot",
      baseRef,
      nextSlot: allocateNextMigrationSlot(root, baseRef),
      files: [],
      manifestUpdated: false,
      forwardsUpdated: false,
      inventoryRefreshed: false,
      drift: [],
    };
  }

  const baseCommit = resolveBaseCommit(root, baseRef);
  const basePaths = listBaseMigrationPaths(root, baseCommit);
  const baseSet = new Set(basePaths);
  const maxBaseSlot = maxSlotFromPaths(basePaths);
  assertBaseMigrationsUnchanged(root, baseCommit, basePaths);

  let targets: string[];
  if (options.files && options.files.length > 0) {
    targets = [...new Set(options.files)].sort();
    for (const file of targets) {
      if (!PLAIN_FORWARD_PATTERN.test(file)) {
        throw new Error("explicit migration path must match a plain forward under db/platform/migrations");
      }
      if (baseSet.has(file)) {
        throw new Error("explicit migration path already exists in base history and cannot be resynced");
      }
    }
  } else {
    targets = listLocalMigrationPaths(root)
      .filter((path) => PLAIN_FORWARD_PATTERN.test(path) && !baseSet.has(path))
      .sort();
  }

  const targetDigests = new Map<string, { bytes: Buffer; sha256: string }>();
  let previousSlot = maxBaseSlot;
  for (const file of targets) {
    const full = join(root, file);
    if (!existsSync(full)) throw new Error("target migration file does not exist on disk");
    const stat = lstatSync(full);
    if (!stat.isFile() || (stat.mode & 0o111) !== 0) {
      throw new Error("target migration file must be a regular non-executable file");
    }
    const slot = PLAIN_FORWARD_PATTERN.exec(file)![1]!;
    if (!isUtcMigrationSlot(slot)) {
      throw new Error("migration slot must be a valid 14-digit UTC timestamp; run with --next-slot to allocate a valid slot");
    }
    if (slot <= previousSlot) {
      throw new Error("migration slot must be strictly later than the base migration history; run with --next-slot to allocate a valid slot");
    }
    previousSlot = slot;
    const bytes = readFileSync(full);
    targetDigests.set(file, { bytes, sha256: sqlSha256(bytes) });
  }

  const manifestFull = join(root, MANIFEST_PATH);
  const originalManifestText = readFileSync(manifestFull, "utf8");
  const manifest = parseStrictJson(originalManifestText, MANIFEST_PATH) as MutablePlatformManifest;
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin].filter((value): value is ManifestPlan => Boolean(value))) {
    for (const [file, { sha256 }] of targetDigests) upsertForwardUnit(plan.forward, file, sha256, baseSet);
  }
  const nextManifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestUpdated = nextManifestText !== originalManifestText;

  const forwardsFull = join(root, REVIEWED_FORWARD_PATH);
  let originalForwardsText = "";
  let nextForwardsText = "";
  let forwardsUpdated = false;
  if (existsSync(forwardsFull)) {
    originalForwardsText = readFileSync(forwardsFull, "utf8");
    const forwards = parseStrictJson(originalForwardsText, REVIEWED_FORWARD_PATH) as MutableReviewedForwards;
    const synced = syncReviewedForwardsForTargets(root, manifest, forwards, targetDigests);
    if (synced) {
      nextForwardsText = `${JSON.stringify(forwards, null, 2)}\n`;
      readReviewedForwardRegistry(Buffer.from(nextForwardsText, "utf8"));
      forwardsUpdated = nextForwardsText !== originalForwardsText;
    } else {
      nextForwardsText = originalForwardsText;
    }
  }

  if (options.check) {
    const drift: string[] = [];
    if (manifestUpdated) drift.push(`${MANIFEST_PATH}: checksum or forward entries out of sync`);
    if (forwardsUpdated) drift.push(`${REVIEWED_FORWARD_PATH}: reviewed forward digests out of sync`);
    drift.push(...checkPlatformMigrationProjection(root, false));
    if (existsSync(join(root, SQL_REFERENCE))) {
      const currentRef = readFileSync(join(root, SQL_REFERENCE), "utf8");
      const expectedRef = syncSqlReference(root);
      if (currentRef !== expectedRef) drift.push(`${SQL_REFERENCE}: generated SQL reference out of sync`);
    }
    return {
      mode: "check",
      baseRef,
      files: targets,
      manifestUpdated,
      forwardsUpdated,
      inventoryRefreshed: false,
      drift,
    };
  }

  if (manifestUpdated) writeFileSync(manifestFull, nextManifestText);
  if (forwardsUpdated) writeFileSync(forwardsFull, nextForwardsText);

  const initialProjectionErrors = checkPlatformMigrationProjection(root, true);
  if (initialProjectionErrors.length) throw new Error(initialProjectionErrors.join("; "));

  let inventoryRefreshed = false;
  if (!options.noInventory && targets.length > 0) {
    (options.runIncrementalBuild ?? defaultIncrementalBuild)(root);
    (options.runInventoryRefresh ?? defaultInventoryRefresh)(root);
    applyInventoryDigestsToManifest(root, manifest);
    writeFileSync(manifestFull, `${JSON.stringify(manifest, null, 2)}\n`);
    const postInventoryErrors = checkPlatformMigrationProjection(root, true);
    if (postInventoryErrors.length) throw new Error(postInventoryErrors.join("; "));
    inventoryRefreshed = true;
  }

  if (existsSync(join(root, SQL_REFERENCE))) {
    writeFileSync(join(root, SQL_REFERENCE), syncSqlReference(root));
  }

  return {
    mode: "sync",
    baseRef,
    files: targets,
    manifestUpdated: manifestUpdated || inventoryRefreshed,
    forwardsUpdated,
    inventoryRefreshed,
    drift: [],
  };
}

export function parseMigrationSyncArgs(argv: readonly string[]): Omit<MigrationSyncOptions, "root"> {
  const files: string[] = [];
  let baseRef: string | undefined;
  let nextSlot = false;
  let noInventory = false;
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--next-slot") {
      nextSlot = true;
    } else if (arg === "--no-inventory") {
      noInventory = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--file") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("missing path value for --file option");
      files.push(value);
    } else if (arg === "--base") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("missing git ref value for --base option");
      baseRef = value;
    } else {
      throw new Error("unknown option; supported options are --next-slot, --file, --base, --no-inventory, and --check");
    }
  }
  if (nextSlot && (check || noInventory || files.length > 0)) {
    throw new Error("--next-slot cannot be combined with --check, --no-inventory, or --file");
  }
  return { baseRef, files, nextSlot, noInventory, check };
}

function main(argv: readonly string[]): number {
  const parsed = parseMigrationSyncArgs(argv);
  const result = runMigrationSync({ root: process.cwd(), ...parsed });
  if (result.mode === "next-slot") {
    console.log(result.nextSlot);
    return 0;
  }
  console.log(JSON.stringify(result, null, 2));
  return result.drift.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
