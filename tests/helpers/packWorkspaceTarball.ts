import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { env as processEnvironment } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 50;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface PackWorkspaceTarballOptions {
  /** Pass `--offline` to `npm pack`. */
  offline?: boolean;
  /** Subprocess timeout in milliseconds (defaults to 120_000). */
  timeoutMs?: number;
  /** Optional environment override for `npm pack`. */
  env?: NodeJS.ProcessEnv;
  /** Internal test hook: custom pack runner used in unit tests. */
  runPack?: (args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv | undefined) => Promise<string>;
  /** Internal test hook: custom sync pack runner used in unit tests. */
  runPackSync?: (args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv | undefined) => string;
}

function safeRunToken(runId: string | undefined): string | null {
  if (!runId) return null;
  const trimmed = runId.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]+$/u.test(trimmed)) return null;
  return trimmed;
}

export function runTarballCacheDir(runId = processEnvironment.OPENLUP_DISPOSABLE_RUN): string | null {
  const token = safeRunToken(runId);
  return token ? join(tmpdir(), `openlup-tarball-cache-${token}`) : null;
}

export function removeRunTarballCache(runId = processEnvironment.OPENLUP_DISPOSABLE_RUN): void {
  const cacheDir = runTarballCacheDir(runId);
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
}

function isCacheableWorkspacePackage(packageRealPath: string): boolean {
  const repoRoot = realpathSync(process.cwd());
  if (!packageRealPath.startsWith(repoRoot + sep)) return false;
  const firstSegment = relative(repoRoot, packageRealPath).split(sep)[0];
  return firstSegment === "packages" || firstSegment === "node_modules";
}

function cacheEntryDir(packageRealPath: string, offline: boolean): string | null {
  const cacheRoot = runTarballCacheDir();
  if (!cacheRoot || !isCacheableWorkspacePackage(packageRealPath)) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify({ dir: packageRealPath, offline }))
    .digest("hex");
  return join(cacheRoot, digest);
}

function buildPackArgs(destinationDir: string, offline: boolean): string[] {
  return [
    "pack",
    ...(offline ? ["--offline"] : []),
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destinationDir,
  ];
}

function parsePackedFilename(stdout: string, packageDir: string): string {
  const parsed = JSON.parse(stdout) as Array<{ filename?: unknown }>;
  const filename = parsed?.[0]?.filename;
  if (typeof filename !== "string" || !filename || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`npm pack returned an invalid filename for ${packageDir}`);
  }
  return filename;
}

function readReadyFilename(readyPath: string): string | null {
  if (!existsSync(readyPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(readyPath, "utf8")) as { filename?: unknown };
    return typeof parsed.filename === "string" && parsed.filename ? parsed.filename : null;
  } catch {
    return null;
  }
}

function copyCachedTarball(entryDir: string, filename: string, destinationDir: string): string {
  mkdirSync(destinationDir, { recursive: true });
  const destinationPath = join(destinationDir, filename);
  copyFileSync(join(entryDir, filename), destinationPath);
  return destinationPath;
}

function tryAcquireLock(lockDir: string): boolean {
  try {
    mkdirSync(lockDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function publishStagedTarball(entryDir: string, stageDir: string, filename: string, readyPath: string): void {
  const finalTarball = join(entryDir, filename);
  renameSync(join(stageDir, filename), finalTarball);
  const stagedReady = join(stageDir, "ready.json");
  writeFileSync(stagedReady, JSON.stringify({ filename }), "utf8");
  renameSync(stagedReady, readyPath);
}

async function defaultRunPack(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  const { stdout } = await execFileAsync("npm", [...args], {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function defaultRunPackSync(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv | undefined,
): string {
  return execFileSync("npm", [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/**
 * Pack a package directory into `destinationDir`, reusing a run-scoped tarball cache
 * across Vitest workers when packing immutable workspace `packages/*` or `node_modules/*` directories.
 * Each caller still receives its own `.tgz` copy inside `destinationDir`.
 */
export async function packWorkspaceTarball(
  directory: string,
  destinationDir: string,
  options: PackWorkspaceTarballOptions = {},
): Promise<string> {
  const packageDir = realpathSync(resolve(directory));
  const resolvedDest = resolve(destinationDir);
  const offline = Boolean(options.offline);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runPack = options.runPack ?? defaultRunPack;
  const entryDir = cacheEntryDir(packageDir, offline);

  if (!entryDir) {
    mkdirSync(resolvedDest, { recursive: true });
    const stdout = await runPack(buildPackArgs(resolvedDest, offline), packageDir, timeoutMs, options.env);
    return join(resolvedDest, parsePackedFilename(stdout, packageDir));
  }

  mkdirSync(entryDir, { recursive: true });
  const readyPath = join(entryDir, "ready.json");
  const lockDir = join(entryDir, ".lock");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const cached = readReadyFilename(readyPath);
    if (cached && existsSync(join(entryDir, cached))) {
      return copyCachedTarball(entryDir, cached, resolvedDest);
    }
    if (tryAcquireLock(lockDir)) {
      const stageDir = join(entryDir, `.stage-${process.pid}-${randomUUID()}`);
      try {
        const rechecked = readReadyFilename(readyPath);
        if (rechecked && existsSync(join(entryDir, rechecked))) {
          return copyCachedTarball(entryDir, rechecked, resolvedDest);
        }
        mkdirSync(stageDir, { recursive: true });
        const stdout = await runPack(buildPackArgs(stageDir, offline), packageDir, timeoutMs, options.env);
        const filename = parsePackedFilename(stdout, packageDir);
        publishStagedTarball(entryDir, stageDir, filename, readyPath);
        return copyCachedTarball(entryDir, filename, resolvedDest);
      } finally {
        rmSync(stageDir, { recursive: true, force: true });
        rmSync(lockDir, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace tarball cache lock for ${packageDir}`);
    }
    await sleepAsync(LOCK_POLL_MS);
  }
}

/**
 * Pack multiple package directories into `destinationDir` with bounded parallelism,
 * preserving the caller's exact input order in the returned tarball paths.
 */
export async function packWorkspaceTarballs(
  directories: readonly string[],
  destinationDir: string,
  options: PackWorkspaceTarballOptions & { concurrency?: number } = {},
): Promise<string[]> {
  const results = new Array<string>(directories.length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, directories.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < directories.length) {
      const index = cursor++;
      results[index] = await packWorkspaceTarball(directories[index]!, destinationDir, options);
    }
  }));
  return results;
}

/** Synchronous variant of {@link packWorkspaceTarball} for sync test setup helpers. */
export function packWorkspaceTarballSync(
  directory: string,
  destinationDir: string,
  options: PackWorkspaceTarballOptions = {},
): string {
  const packageDir = realpathSync(resolve(directory));
  const resolvedDest = resolve(destinationDir);
  const offline = Boolean(options.offline);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runPackSync = options.runPackSync ?? defaultRunPackSync;
  const entryDir = cacheEntryDir(packageDir, offline);

  if (!entryDir) {
    mkdirSync(resolvedDest, { recursive: true });
    const stdout = runPackSync(buildPackArgs(resolvedDest, offline), packageDir, timeoutMs, options.env);
    return join(resolvedDest, parsePackedFilename(stdout, packageDir));
  }

  mkdirSync(entryDir, { recursive: true });
  const readyPath = join(entryDir, "ready.json");
  const lockDir = join(entryDir, ".lock");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const cached = readReadyFilename(readyPath);
    if (cached && existsSync(join(entryDir, cached))) {
      return copyCachedTarball(entryDir, cached, resolvedDest);
    }
    if (tryAcquireLock(lockDir)) {
      const stageDir = join(entryDir, `.stage-${process.pid}-${randomUUID()}`);
      try {
        const rechecked = readReadyFilename(readyPath);
        if (rechecked && existsSync(join(entryDir, rechecked))) {
          return copyCachedTarball(entryDir, rechecked, resolvedDest);
        }
        mkdirSync(stageDir, { recursive: true });
        const stdout = runPackSync(buildPackArgs(stageDir, offline), packageDir, timeoutMs, options.env);
        const filename = parsePackedFilename(stdout, packageDir);
        publishStagedTarball(entryDir, stageDir, filename, readyPath);
        return copyCachedTarball(entryDir, filename, resolvedDest);
      } finally {
        rmSync(stageDir, { recursive: true, force: true });
        rmSync(lockDir, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace tarball cache lock for ${packageDir}`);
    }
    sleepSync(LOCK_POLL_MS);
  }
}

export function packWorkspaceTarballsSync(
  directories: readonly string[],
  destinationDir: string,
  options: PackWorkspaceTarballOptions = {},
): string[] {
  return directories.map((directory) => packWorkspaceTarballSync(directory, destinationDir, options));
}
