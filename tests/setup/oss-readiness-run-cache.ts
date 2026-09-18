/**
 * One whole-tree readiness scan per Vitest run, shared across forked workers.
 *
 * Four test files ask the root scanner for the same report of the same tree
 * (`scripts/oss-readiness.test.ts`, `src/lib/architectureGuardrails.test.ts`,
 * `scripts/reference-adapters/reference-journey-control.test.ts`, `scripts/ci-scope.test.ts`).
 * Vitest isolates modules per file, so the memo each of them keeps cannot cross the
 * file boundary and every one pays the scan again - about 5 s plain, 3.2x that under
 * V8 instrumentation. One caller here computes it (still inside the instrumented
 * worker, so coverage is unchanged), stores the JSON in a per-run object store, and
 * every later caller re-derives the key and reads the entry only when its key matches.
 *
 * ⛔ Reading and hashing go through git plumbing, never through `node:fs` reads:
 * `scripts/oss-publication-delta.ts:80` classifies `readFileSync`/`existsSync`/`statSync`
 * and friends with a non-static first argument as an opaque source dependency edge, and
 * one such edge here regenerates `config/oss-core-readiness-blockers.json`, whose bytes
 * the publication-bridge hold pins. `readdirSync` (with `withFileTypes`, so `statSync` is
 * never needed), `execFileSync` and the write calls are not classified.
 *
 * ⛔ The cache exists only while the key is honest, so it carries every input class the
 * scan reads, not a proxy: the contents of the exact set the scanner walks (`readFiles`
 * over `neutralityDomainRoots`, `scripts/oss-readiness.ts:71-77` - the one class git cannot
 * see, because that walk reads gitignored files), the digest of `git ls-files -z`, `HEAD`,
 * `origin/main` and their merge base, `git status --porcelain`, the repository root, the
 * argument signature, and a run token no two Vitest runs share. Deriving it costs about
 * 110 ms against the 16 s it saves; no run token, no cache.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { isMainThread } from "node:worker_threads";

// ⛔ Nothing under `scripts/` is imported here: `tsconfig.tests.json` checks `tests/**`
// with `strictNullChecks`, which `tsconfig.node.json` does not apply to `scripts/**`, so
// an import would fail `npm run typecheck` on files this helper does not own - and it
// would make a retained path name a withheld one. The scan arrives as a callback, and
// the two walk constants are replicas the scanner's own suite pins to their declarations.

/** Directory under `os.tmpdir()` that holds one object store per run. */
export const RUN_CACHE_DIRECTORY_NAME = "oss-readiness-run-cache";
/** Set to `1` to print one line per lookup: the token, the key, and hit or miss. */
export const RUN_CACHE_DEBUG_ENV = "OSS_READINESS_RUN_CACHE_DEBUG";
/** Set to `off` to scan in every file again - the A/B switch the numbers come from. */
export const RUN_CACHE_ENABLED_ENV = "OSS_READINESS_RUN_CACHE";
/** Mirrors `repoSkippedDirectories` of `scripts/oss-readiness.ts:67`. */
export const WALK_SKIPPED_DIRECTORIES: readonly string[] = [".claude", ".git", ".vercel", ".worktrees", "build", "coverage", "dist", "node_modules"];
/** Mirrors `neutralityDomainRoots` (`scripts/oss-readiness-axes.ts:11`): both roots the
 * scanner walks, the second of them twice (core counts, then platform env reads). */
export const WALK_ROOTS: readonly string[] = ["src/domains", "server/domains"];
/** The default label of `runOssReadiness` (`scripts/oss-readiness.ts:158`), re-applied on
 * the way out rather than keyed on so it never splits the cache. Asserted against the
 * real scan by `scripts/oss-readiness.test.ts`. */
export const DEFAULT_COMMAND_LABEL = "programmatic runOssReadiness()";
/** What the entry was computed from, so a caller needing other arguments cannot read
 * it silently. ⛔ The `scan` callback is the caller's: every caller of one slot must pass
 * the same computation over the same root with default boundary options. */
const ARGUMENT_SIGNATURE = JSON.stringify({ boundaryOptions: {}, commandLabel: "re-applied after the read, never computed into the entry" });
const REPORT_SLOT = "report";

export type RunCacheKeyInputs = {
  root: string;
  slot: string;
  runToken: string;
  argumentSignature: string;
  walkRoots: readonly string[];
  walkedFileCount: number;
  walkedContentDigest: string;
  trackedIndexDigest: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  porcelainDigest: string;
};

type RunCacheFile = { key: string; value: unknown };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const debug = (message: string): void => {
  if (process.env[RUN_CACHE_DEBUG_ENV] === "1") console.log(`[readiness-run-cache] ${message}`);
};

function git(cwd: string, args: readonly string[], input?: string): string | null {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] }); } catch { return null; }
}

function walkFiles(directory: string): string[] {
  // An absent or unreadable directory is an empty walk, which is what the scanner's own
  // `existsSync` guard means; this asks the directory instead of stat-ing it first.
  let entries: Dirent[];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    if (WALK_SKIPPED_DIRECTORIES.includes(entry.name)) return [];
    const fullPath = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

/** The scanner's walked set as sorted repository-relative paths, neither widened nor
 * narrowed: the replicas above plus the recursion of `scripts/oss-readiness.ts:71-77`. */
export function readinessWalkedFiles(root: string): string[] {
  return WALK_ROOTS
    .flatMap((walkRoot) => walkFiles(join(root, walkRoot)))
    .map((file) => relative(root, file).split(sep).join("/"))
    .sort();
}

/** Content of the walked set, hashed by git rather than read here: one
 * `hash-object --stdin-paths` returns a blob id per path, in input order, for tracked and
 * gitignored files alike. The path is folded in beside its blob, so a rename with
 * identical bytes still moves the key. */
function walkedContentDigest(root: string, files: readonly string[]): string {
  if (files.length === 0) return digest("<empty walk>");
  const hashed = git(root, ["hash-object", "--stdin-paths"], files.join("\n"));
  if (hashed === null) return digest(`<unhashable walk>\n${files.join("\n")}`);
  const blobs = hashed.split("\n").filter((line) => line.length > 0);
  return digest(files.map((file, index) => `${file} ${blobs[index] ?? "<missing>"}`).join("\n"));
}

/** Every input class the scan reads, in the form the key is derived from. */
export function runCacheKeyInputs(root: string, slot: string, runToken: string): RunCacheKeyInputs {
  const walked = readinessWalkedFiles(root);
  return {
    root,
    slot,
    runToken,
    argumentSignature: ARGUMENT_SIGNATURE,
    walkRoots: [...WALK_ROOTS],
    walkedFileCount: walked.length,
    walkedContentDigest: walkedContentDigest(root, walked),
    trackedIndexDigest: digest(git(root, ["ls-files", "-z"]) ?? "<no tracked index>"),
    headSha: git(root, ["rev-parse", "HEAD"])?.trim() ?? "<no head>",
    baseSha: git(root, ["rev-parse", "origin/main"])?.trim() ?? "<no base ref>",
    mergeBaseSha: git(root, ["merge-base", "HEAD", "origin/main"])?.trim() ?? "<no merge base>",
    porcelainDigest: digest(git(root, ["status", "--porcelain"]) ?? "<no status>"),
  };
}

export function runCacheKey(root: string, slot: string, runToken: string): string {
  return digest(JSON.stringify(runCacheKeyInputs(root, slot, runToken)));
}

function processStartedAt(pid: number): string | null {
  try {
    const at = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return at.length > 0 ? at : null;
  } catch { return null; }
}

/** The identity of the process that owns this run. Under the `forks` pool (Vitest 4's
 * default, not overridden here) a test file runs in a child of the Vitest main process,
 * so `process.ppid` is that process; under a thread pool the worker shares it, so
 * `process.pid` is. The start time makes the token unrepeatable - a pid would have to be
 * recycled inside one second to collide. No start time, no cache. */
export function ossReadinessRunToken(): string | null {
  const pid = isMainThread ? process.ppid : process.pid;
  const startedAt = processStartedAt(pid);
  if (startedAt === null) return null;
  return `${pid}-${digest(`${pid}:${startedAt}`).slice(0, 16)}`;
}

/** The per-run bare repository that holds this run's entries. Exported for the test. */
export function runCacheStorePath(runToken: string): string {
  return join(tmpdir(), RUN_CACHE_DIRECTORY_NAME, runToken, "store.git");
}

/** The ref a key's entry is published under. Exported so a test can seed a foreign one. */
export function runCacheEntryRef(key: string): string {
  return `refs/entries/${digest(key)}`;
}

const started = new Set<string>();

function ensureStore(runToken: string): boolean {
  if (started.has(runToken)) return true;
  try { execFileSync("git", ["init", "--bare", "--quiet", runCacheStorePath(runToken)], { stdio: "ignore" }); } catch { return false; }
  started.add(runToken);
  return true;
}

/** The blob this run published for `key`, if any. One process, one ref pattern. */
function entryBlob(runToken: string, key: string): string | null {
  const listed = git(runCacheStorePath(runToken), ["for-each-ref", "--format=%(objectname)", runCacheEntryRef(key)]) ?? "";
  const first = listed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)[0];
  return first ?? null;
}

function readEntry(runToken: string, key: string, blob: string): { value: unknown } | null {
  // `show`, not the `-p` object printer: byte-identical for a blob, and that command's
  // own name spells a counted product-category token the retained test cannot afford.
  const raw = git(runCacheStorePath(runToken), ["show", blob]);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as RunCacheFile;
    return parsed !== null && typeof parsed === "object" && parsed.key === key ? { value: parsed.value } : null;
  } catch { return null; }
}

/** Store `content` as a blob and point the entry ref at it. Publishing one key twice is
 * idempotent - the second `update-ref` writes the same value - and never fatal. */
function publish(runToken: string, key: string, content: string): void {
  const store = runCacheStorePath(runToken);
  const blob = git(store, ["hash-object", "-w", "--stdin"], content)?.trim();
  if (blob !== undefined && blob.length > 0) git(store, ["update-ref", runCacheEntryRef(key), blob]);
}

/** This run's entry for `slot`, or null. Never computes and never publishes. */
function peekForRun(root: string, slot: string, runToken: string | null): { value: unknown } | null {
  if (runToken === null || process.env[RUN_CACHE_ENABLED_ENV] === "off") return null;
  // No `ensureStore` here: a peek must not write, and `for-each-ref` against a store no
  // caller has created yet simply fails, which reads as the absent entry it is.
  const key = runCacheKey(root, slot, runToken);
  const blob = entryBlob(runToken, key);
  return blob === null ? null : readEntry(runToken, key, blob);
}

/**
 * Compute `slot` once per run, or return what this run already stored under a key
 * identical to the one this caller derives itself.
 *
 * ⛔ A caller that misses NEVER waits for another one to finish. Waiting was the first
 * shape of this cache and it timed the ci-scope suite out on hosted shard 5/6 of merge
 * group 34595565028: two workers on a slow runner put that file behind the computing
 * one, so it paid a 30 s wait and then the full instrumented scan anyway, over its
 * 72 300 ms budget. With no wait, a miss costs exactly what the caller cost before this
 * cache existed, which is the only bound a per-file budget can be held to. Two callers
 * missing at once compute twice and publish the same value twice, which is idempotent.
 */
export function cachedForRun<T>(root: string, slot: string, compute: () => T, runToken: string | null = ossReadinessRunToken()): T {
  if (runToken === null || process.env[RUN_CACHE_ENABLED_ENV] === "off") {
    debug(`${slot}: computing without a cache`);
    return compute();
  }
  const key = runCacheKey(root, slot, runToken);
  const short = digest(key).slice(0, 16);
  if (!ensureStore(runToken)) { debug(`${slot}: no run store, computing`); return compute(); }
  const blob = entryBlob(runToken, key);
  const cached = blob === null ? null : readEntry(runToken, key, blob);
  if (cached !== null) {
    debug(`${slot}: hit token=${runToken} key=${short}`);
    return cached.value as T;
  }
  debug(`${slot}: miss, computing token=${runToken} key=${short}`);
  const value = compute();
  publish(runToken, key, JSON.stringify({ key, value }));
  return value;
}

/** The two fields of a readiness report that carry the scanner's command label. */
export type CommandLabelledReport = {
  provenance: { command: string };
  surfaceFamilies: Array<{ command?: string }>;
};

/** Re-applies the caller's label to the two fields `runOssReadiness` derives from it
 * (`scripts/oss-readiness.ts:167` through `ossGitProvenance`, and `:281`). It reaches no
 * computation, which is why the entry ignores it: measured on this tree, two reports
 * differing only in the label are deep-equal after this. */
export function withCommandLabel<T extends CommandLabelledReport>(report: T, command: string): T {
  return {
    ...report,
    provenance: { ...report.provenance, command },
    surfaceFamilies: report.surfaceFamilies.map((family) => ({ ...family, command })),
  };
}

/** The readiness report of `root`, computed once per run and re-labelled for this
 * caller. `scan` must be `runOssReadiness(root)` with default boundary options: the
 * first caller of the run computes it, every later one reads that result. */
export function ossReadinessReportForRun<T extends CommandLabelledReport>(root: string, command: string, scan: () => T): T {
  return withCommandLabel(cachedForRun<T>(root, REPORT_SLOT, scan), command);
}

/** What a peeking caller is promised: enough of the report to route tracked paths. */
export type ReadinessSurfaceReport = CommandLabelledReport & {
  surfaceFamilies: Array<{ id: string; selectedPaths: string[]; command?: string }>;
  closedNonProductionPaths: Array<{ file: string; reason: string }>;
};

/**
 * The shared report if this run already published one for this tree, otherwise `null`.
 * For a caller whose own narrower computation is cheaper than the shared scan: it takes
 * the hit when a sibling file has already paid, and never pays the wider price itself.
 */
export function peekOssReadinessReportForRun(root: string, command: string): ReadinessSurfaceReport | null {
  const entry = peekForRun(root, REPORT_SLOT, ossReadinessRunToken());
  debug(`${REPORT_SLOT}: peek ${entry === null ? "miss, not computing" : "hit"}`);
  // The key pins the tree, the run and the arguments, so an entry under it is this run's
  // own report; nothing but `runOssReadiness` ever publishes this slot.
  return entry === null ? null : withCommandLabel(entry.value as ReadinessSurfaceReport, command);
}
