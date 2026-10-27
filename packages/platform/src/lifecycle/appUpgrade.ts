import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Exact UTF-8 scaffold files; every unlisted path remains application-owned. */
export interface AppVersionSnapshot {
  version: string;
  schema: { min: number; max: number };
  files: Readonly<Record<string, string>>;
}

export interface AppUpgradeInput {
  /** Absolute canonical path (as returned by realpath) of an existing app directory. */
  root: string;
  from: AppVersionSnapshot;
  to: AppVersionSnapshot;
  /** Observed by the caller; planning and applying execute no database work. */
  schemaVersion: number;
}

export type AppUpgradeAction = "create" | "replace" | "remove" | "unchanged" | "preserved" | "already-applied";
export interface AppUpgradeConflict { path: string; reason: string }
export interface AppUpgradePlan {
  fromVersion: string;
  toVersion: string;
  schemaVersion: number;
  files: { path: string; action: AppUpgradeAction }[];
  conflicts: AppUpgradeConflict[];
}

export class AppUpgradeConflictError extends Error {
  constructor(public readonly conflicts: readonly AppUpgradeConflict[]) {
    super(`Application upgrade refused: ${conflicts.map(({ path, reason }) => `${path || "schema"}: ${reason}`).join("; ")}`);
    this.name = "AppUpgradeConflictError";
  }
}

/** Read-only comparison of explicit predecessor and candidate snapshots. */
export async function planAppUpgrade(input: AppUpgradeInput): Promise<AppUpgradePlan> {
  return (await inspectUpgrade(input)).plan;
}

/**
 * The caller must hold an exclusive maintenance window over the application tree.
 * This is not a lock against concurrent editors or hostile filesystem mutation.
 * All conflicts are checked before any writes. A later I/O failure can leave a
 * partial upgrade: rerun the same snapshots to recognize exact completed bytes.
 * Each replacement is atomic on a local filesystem; the complete upgrade is not.
 * An abrupt process termination can leave a uniquely named temporary file; it is
 * never treated as a managed app file or resumed operation.
 * No SQL, dependency install, version marker, deployment or user hook is executed.
 */
export async function applyAppUpgrade(input: AppUpgradeInput): Promise<{ plan: AppUpgradePlan; applied: string[] }> {
  const { root, plan, target } = await inspectUpgrade(input);
  if (plan.conflicts.length) throw new AppUpgradeConflictError(plan.conflicts);
  const applied: string[] = [];
  for (const file of plan.files) {
    const destination = join(root, file.path);
    if (file.action === "remove") {
      await fs.unlink(destination);
    } else if (file.action === "create" || file.action === "replace") {
      await fs.mkdir(dirname(destination), { recursive: true });
      const temporary = join(dirname(destination), `.openlup-${randomUUID()}.tmp`);
      // Rename replaces this directory entry rather than modifying a possible hardlink.
      const mode = file.action === "replace" ? (await fs.stat(destination)).mode & 0o777 : 0o600;
      let handle;
      try {
        handle = await fs.open(temporary, "wx", mode);
        if (file.action === "replace") await handle.chmod(mode);
        await handle.writeFile(target.get(file.path)!, "utf8");
        await handle.close();
        await fs.rename(temporary, destination);
      } finally {
        if (handle) {
          await handle.close();
          await fs.rm(temporary, { force: true });
        }
      }
    } else continue;
    applied.push(file.path);
  }
  return { plan, applied };
}

async function inspectUpgrade(input: AppUpgradeInput): Promise<{
  root: string; plan: AppUpgradePlan; target: Map<string, string>;
}> {
  const before = snapshotFiles(input.from), target = snapshotFiles(input.to);
  const paths = [...new Set([...before.keys(), ...target.keys()])].sort();
  const aliases = new Set<string>();
  for (const path of paths) {
    const alias = path.normalize("NFC").toLowerCase();
    if (aliases.has(alias)) throw new Error(`Application upgrade path alias: ${path}`);
    aliases.add(alias);
  }
  const directorySpellings = new Map<string, string>();
  for (const path of paths) {
    const components = path.split("/");
    while (components.length > 1) {
      components.pop();
      const directory = components.join("/"), alias = directory.normalize("NFC").toLowerCase();
      if (aliases.has(alias)) throw new Error(`Application upgrade file-parent collision: ${path}`);
      // Parents may not exist yet; both snapshots must still agree on their spelling.
      const spelling = directorySpellings.get(alias);
      if (spelling !== undefined && spelling !== directory) throw new Error(`Application upgrade path alias: ${path}`);
      directorySpellings.set(alias, directory);
    }
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 0) throw new Error("Application schema version must be a nonnegative safe integer");
  const plan: AppUpgradePlan = {
    fromVersion: input.from.version, toVersion: input.to.version,
    schemaVersion: input.schemaVersion, files: [], conflicts: [],
  };
  for (const snapshot of [input.from, input.to]) {
    if (input.schemaVersion < snapshot.schema.min || input.schemaVersion > snapshot.schema.max) {
      plan.conflicts.push({ path: "", reason: `schema ${input.schemaVersion} is outside ${snapshot.version} range ${snapshot.schema.min}..${snapshot.schema.max}` });
    }
  }
  const requestedRoot = resolve(input.root), rootStat = await fs.lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Application upgrade root must be an ordinary directory");
  const root = await fs.realpath(requestedRoot);
  if (input.root !== root) throw new Error("Application upgrade root must be an absolute canonical path");
  for (const path of paths) {
    const observed = await readFile(root, path);
    if (typeof observed === "string") {
      plan.conflicts.push({ path, reason: observed });
      continue;
    }
    const oldBytes = before.has(path) ? Buffer.from(before.get(path)!, "utf8") : null;
    const newBytes = target.has(path) ? Buffer.from(target.get(path)!, "utf8") : null;
    const equal = (bytes: Buffer | null) => observed === null ? bytes === null : bytes !== null && observed.equals(bytes);
    let action: AppUpgradeAction;
    if (oldBytes !== null && newBytes !== null && oldBytes.equals(newBytes)) {
      // An upstream-unchanged file carries no write authority over local customization.
      action = equal(oldBytes) ? "unchanged" : "preserved";
    } else if (equal(newBytes)) action = "already-applied";
    else if (equal(oldBytes)) action = newBytes === null ? "remove" : oldBytes === null ? "create" : "replace";
    else {
      plan.conflicts.push({ path, reason: "current bytes match neither predecessor nor candidate" });
      continue;
    }
    plan.files.push({ path, action });
  }
  return { root, plan, target };
}

function snapshotFiles(snapshot: AppVersionSnapshot): Map<string, string> {
  if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version.trim()) throw new Error("Application snapshot needs an explicit version");
  const range = snapshot.schema;
  if (!range || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) || range.min < 0 || range.max < range.min) throw new Error("Application snapshot needs an ordered nonnegative schema range");
  if (!snapshot.files || typeof snapshot.files !== "object" || Array.isArray(snapshot.files)) throw new Error("Application snapshot files must be a record");
  const result = new Map<string, string>();
  for (const [path, content] of Object.entries(snapshot.files)) {
    const segments = path.split("/");
    if (!path || Buffer.from(path, "utf8").toString("utf8") !== path || /[\\:]/u.test(path) || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || segments.some(segment => !segment || segment === "." || segment === ".." || /[. ]$/u.test(segment)) || segments.some(segment => [".git", "node_modules"].includes(segment.toLowerCase()))) {
      throw new Error(`Unsafe application upgrade path: ${path}`);
    }
    if (typeof content !== "string" || Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error(`Application upgrade content must be valid UTF-8: ${path}`);
    result.set(path, content);
  }
  return result;
}

/** A string is a structural refusal; null means an absent path. Never follow links. */
async function readFile(root: string, path: string): Promise<Buffer | null | string> {
  const segments = path.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const parent = current;
    current = join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // A filesystem alias is not ownership of the differently spelled entry.
    // Check only after lstat: ENOENT on a case-sensitive store stays absence.
    if (!(await fs.readdir(parent)).includes(segment)) return "managed path spelling differs from directory entry";
    if (stat.isSymbolicLink()) return "symlink in managed path";
    const last = index === segments.length - 1;
    if (last) return stat.isFile() ? fs.readFile(current) : "managed path is not a regular file";
    if (!stat.isDirectory()) return "managed parent is not a directory";
  }
  return null;
}
