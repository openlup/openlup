// Local checks before review. The default checks the change since the fork
// point plus working-tree edits; --fast runs the cheap readiness gate;
// --area runs ESLint, Docker-free area tooling guards, and SQL admission;
// --affected adds affected tests, invariant tests, and real pgTAP for SQL changes.
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";

import { findAffectedTests } from "./affected-tests.mjs";
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope } from "./agent-review-derived.mjs";
import { carrierLocale, carrierNpmCli, carrierPlan, describeCarrierToolchain, readReportOwners } from "./agent-review-landing.mjs";
import { TOOLING_INPUTS, excludedToolingTests } from "./ci-test-scope.mjs";
import { readCommits, signOffVerdict } from "./dco-signoff-check.ts";
import { isChangelogFragment, isChangelogFragmentArea } from "./packages/changelog-fragments.ts";
import { checkPlatformMigrationProjection } from "./packages/platform-migration-projection.ts";
import {
  PLATFORM_MIGRATION_MANIFEST,
  readPlatformMigrationManifest,
  runPlatformMigrationManifestCheck,
  selectPlatformMigrationManifest,
  type PlatformMigrationManifest,
  type PlatformMigrationPlan,
} from "./platform-migration-manifest.ts";
import { checkSettingsCandidates, isSettingsCandidateSourcePath } from "./settings-candidate-guard.ts";
import { resolveResourceGateInvocation } from "./resource-gate.mjs";

export type Status = "PASS" | "WARN" | "SKIP" | "FAIL";
export type CheckResult = { check: string; status: Status; detail: string; notes?: string[] };
export type Change = { path: string; deleted: boolean };
export type AddedLine = { path: string; line: number; text: string };
export type Finding = AddedLine & { reason: string };

export function formatCheckLine({ status, check, detail }: CheckResult): string {
  return `${status} ${check}: ${detail}`;
}

/** `git diff --name-status --no-renames -z` output as changed paths. */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) changes.push({ path: fields[index + 1], deleted: fields[index] === "D" });
  return changes;
}

const SQL_TREE = /^(?:db\/.+|packages\/[^/]+\/sql\/.+)\.sql$/u;

/** Migration and package SQL paths whose change makes the installation inventory stale. */
export function sqlTreeChanges(changes: readonly Change[]): string[] {
  return changes.map(({ path }) => path).filter((path) => SQL_TREE.test(path));
}

/** The package directory of a released package's source path: one that takes changelog fragments. */
export function releasedPackageSource(path: string): string | undefined {
  const name = /^packages\/([^/]+)\/src\//u.exec(path)?.[1];
  return name && isChangelogFragmentArea(`packages/${name}/changes`) ? `packages/${name}` : undefined;
}

/** Package directories whose `src/` changed without a new or changed `changes/*.md` fragment. */
export function missingFragments(changes: readonly Change[]): string[] {
  const touched = new Set(changes.flatMap(({ path }) => releasedPackageSource(path) ?? []));
  const fragmented = new Set(changes.filter(({ path, deleted }) => !deleted && isChangelogFragment(path))
    .map(({ path }) => path.slice(0, path.indexOf("/changes/"))));
  return [...touched].filter((directory) => !fragmented.has(directory)).sort();
}

const TEST_ENTRY = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SCRIPT = /\.[cm]?[jt]sx?$/u;
/** A Vitest-style test entry. */
export const isTestEntry = (path: string): boolean => TEST_ENTRY.test(path);
/** A test entry, or a script under a test directory (fixtures, cases and helpers). */
export const isTestFile = (path: string): boolean => isTestEntry(path) || (SCRIPT.test(path) && /(?:^|\/)(?:tests?|__tests__)\//u.test(path));

/** The added lines of one file's `git diff -U0` output, with their new line numbers. */
export function addedLines(path: string, diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let next: number | undefined;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (hunk) next = Number(hunk[1]);
    else if (next === undefined) continue;
    else if (raw.startsWith("+")) lines.push({ path, line: next++, text: raw.slice(1) });
    else if (raw.startsWith(" ")) next++;
  }
  return lines;
}

const DAY_MS = 86_400_000;
export const DATE_WINDOW_DAYS = 400;
// ISO calendar dates, alone or starting a timestamp: 2001-02-03, 2001-02-03T04:05Z.
const ISO_DATE = /(?<![\w.-])(\d{4})-(\d{2})-(\d{2})(?=T\d|[^\w-]|$)/gu;

/**
 * Literal calendar dates within DATE_WINDOW_DAYS of `now`. Such a fixture soon
 * crosses the real clock: a "future" date becomes past and the test changes
 * meaning. Far past or far future dates, and injected clocks, stay stable.
 */
export function nearDates(lines: readonly AddedLine[], now: Date): Finding[] {
  return lines.flatMap((entry) => {
    const hits = [...entry.text.matchAll(ISO_DATE)].filter(([, year, month, day]) => {
      const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
      const date = new Date(time);
      if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return false;
      return Math.abs(time - now.getTime()) <= DATE_WINDOW_DAYS * DAY_MS;
    }).map(([literal]) => literal);
    return hits.length > 0 ? [{ ...entry, reason: `${hits.join(", ")} within ${DATE_WINDOW_DAYS} days of now` }] : [];
  });
}

export const SHORT_EXPIRY_SECONDS = 600;
// A ttl, expir* or maxAge name part: ttl, cacheTtlMs, TTL_SECONDS, expiresIn,
// setExpirationTime, token_expiry, maxAge, max_age. Not "settle" or "subtitle".
const EXPIRY_NAME = /(?:^ttl|_ttl|Ttl|TTL)(?![a-z])|(?:^|_)expir|Expir|EXPIR|(?:^|_)max_?[aA]ge|MaxAge|MAX_AGE/u;
// `name: value`, `name = value` or `name(value)`; the value is a quoted duration
// such as '5m' or "60 seconds", or a literal number or product such as 15 * 60 * 1000.
const EXPIRY_VALUE = /(?<![\w$])([A-Za-z_$][\w$]*)['"]?\s*(?:[:=]|\()\s*(?:(['"`])\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*\2|(\d[\d_]*(?:\.\d+)?(?:\s*\*\s*\d[\d_]*(?:\.\d+)?)*)(?=\s*(?:[,;)}\]]|$)))/gu;
const DURATION_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:ms|msecs?|milliseconds?)$/iu, 0.001], [/^(?:s|secs?|seconds?)$/iu, 1], [/^(?:m|mins?|minutes?)$/iu, 60],
  [/^(?:h|hrs?|hours?)$/iu, 3600], [/^(?:d|days?)$/iu, 86_400],
];
// A bare number takes its unit from the name's suffix, and is seconds otherwise.
const NAME_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/(?:ms|millis(?:econds?)?)$/iu, 0.001], [/(?:secs?|seconds?|_s)$/iu, 1], [/(?:mins?|minutes?)$/iu, 60],
  [/(?:hours?|hrs?)$/iu, 3600], [/days?$/iu, 86_400],
];

/**
 * Expiries and TTLs under SHORT_EXPIRY_SECONDS. A short lifetime can lapse
 * between setup and assertion on a slow hosted runner. Simple patterns only:
 * values built from constants or expressions are not evaluated.
 */
export function shortExpiries(lines: readonly AddedLine[]): Finding[] {
  return lines.flatMap((entry) => {
    const hits: string[] = [];
    for (const [, name, , amount, unit, product] of entry.text.matchAll(EXPIRY_VALUE)) {
      if (!EXPIRY_NAME.test(name)) continue;
      const scale = amount === undefined
        ? NAME_UNITS.find(([pattern]) => pattern.test(name))?.[1] ?? 1
        : DURATION_UNITS.find(([pattern]) => pattern.test(unit))?.[1];
      if (scale === undefined) continue;
      const value = amount === undefined ? product.split("*").reduce((total, factor) => total * Number(factor.replaceAll("_", "").trim()), 1) : Number(amount);
      const seconds = value * scale;
      if (seconds > 0 && seconds < SHORT_EXPIRY_SECONDS) hits.push(`${name} ${Number(seconds.toFixed(3))} s`);
    }
    return hits.length > 0 ? [{ ...entry, reason: `${hits.join(", ")} under ${SHORT_EXPIRY_SECONDS} s` }] : [];
  });
}

type Outcome = { code: number | null; stdout: string; output: string; missing: boolean; timedOut: boolean; seconds: number };

function execute(command: string, args: readonly string[], options: SpawnSyncOptions = {}): Outcome {
  const started = Date.now();
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32", ...options });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    code: result.status,
    stdout: result.stdout?.toString() ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    missing: errorCode === "ENOENT",
    timedOut: errorCode === "ETIMEDOUT",
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

function executeAsync(command: string, args: readonly string[], options: SpawnOptions & { timeout?: number } = {}): Promise<Outcome> {
  const started = Date.now();
  const { timeout, ...spawnOptions } = options;
  return new Promise((resolveOutcome) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...(timeout !== undefined ? { timeout } : {}),
      ...spawnOptions,
    });
    const finish = (code: number | null, missing = false, errorTimedOut = false) => {
      if (settled) return;
      settled = true;
      resolveOutcome({
        code,
        stdout,
        output: `${stdout}${stderr}`,
        missing,
        timedOut: errorTimedOut,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => { finish(null, error.code === "ENOENT", error.code === "ETIMEDOUT"); });
    child.on("close", (code, signal) => { finish(code, false, Boolean(timeout && code === null && signal === "SIGTERM")); });
  });
}

async function npmVersionForToolchain(npmCli: string, options: SpawnOptions): Promise<string> {
  try {
    const version = await executeAsync(process.execPath, [npmCli, "--version"], { ...options, timeout: 5_000 });
    if (version.timedOut) return "unavailable (timed out after 5 s)";
    if (version.code === 0) return version.stdout.trim() || "unavailable (empty output)";
    if (version.code !== null) return `unavailable (exit status ${version.code})`;
  } catch {
    // Toolchain reporting is advisory even if the launch throws.
  }
  return "unavailable (probe failed)";
}

function git(args: readonly string[], output: "output" | "stdout" = "output"): string {
  const result = execute("git", args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.output.trim()}`);
  return result[output];
}

const tail = (output: string, count = 30): string[] => output.split("\n").filter((line) => line.trim()).slice(-count);
const lastLine = (output: string): string => tail(output, 1)[0]?.trim() ?? "";
const findingNotes = (findings: readonly Finding[]): string[] => findings.map(({ path, line, reason, text }) => `${path}:${line}: ${reason}: ${text.trim().slice(0, 120)}`);

// One line per raised category, as scripts/public-ci-neutrality.mjs reports it.
const NEUTRALITY_INCREASE = /^".+": [\w-]+ increased \d+ -> \d+$/u;

/** The verdict of `node scripts/public-ci-neutrality.mjs`, from its exit code and output. */
export function neutralityVerdict(code: number | null, output: string, seconds: number): CheckResult {
  if (code === 0) return { check: "neutrality", status: "PASS", detail: `no neutrality count increase against the fork point (${seconds} s)` };
  const increases = [...new Set(output.split("\n").map((line) => line.trim()).filter((line) => NEUTRALITY_INCREASE.test(line)))];
  return increases.length > 0
    ? { check: "neutrality", status: "FAIL", detail: `${increases.length} neutrality count increase(s) against the fork point; the required self-check job refuses them (${seconds} s)`, notes: increases }
    : { check: "neutrality", status: "FAIL", detail: `the neutrality ratchet failed (${seconds} s)`, notes: tail(output) };
}

async function typecheck(): Promise<CheckResult> {
  // The required typecheck job builds the packages through `npm run lint`'s prelint first.
  const build = await executeAsync("npm", ["run", "prelint"]);
  if (build.code !== 0) return { check: "typecheck", status: "FAIL", detail: "package build (npm run prelint) failed", notes: tail(build.output) };
  const result = await executeAsync("npm", ["run", "oss:published-tree", "--", "--typecheck"]);
  const detail = `${lastLine(result.output)} (${build.seconds + result.seconds} s)`;
  return result.code === 0 ? { check: "typecheck", status: "PASS", detail } : { check: "typecheck", status: "FAIL", detail, notes: tail(result.output) };
}

async function astGrep(options?: SpawnOptions): Promise<CheckResult> {
  const result = await executeAsync("npx", ["--no", "--", "ast-grep", "scan", "--error=no-suppress-all", "--error=unused-suppression"], options);
  return result.code === 0
    ? { check: "ast-grep", status: "PASS", detail: `no structural rule errors (${result.seconds} s)` }
    : { check: "ast-grep", status: "FAIL", detail: "structural rule errors", notes: tail(result.output) };
}

async function astGrepHygiene(options?: SpawnOptions): Promise<CheckResult> {
  const filewide = await executeAsync(process.execPath, ["scripts/ast-grep/check-filewide-ignore.mjs"]);
  if (filewide.code !== 0) {
    return { check: "ast-grep hygiene", status: "FAIL", detail: `file-wide ast-grep-ignore check failed (${filewide.seconds} s)`, notes: tail(filewide.output) };
  }
  const tests = await executeAsync("npx", ["--no", "--", "ast-grep", "test", "--skip-snapshot-tests"], options);
  const seconds = filewide.seconds + tests.seconds;
  return tests.code === 0
    ? { check: "ast-grep hygiene", status: "PASS", detail: `no file-wide ignores and rule tests pass (${seconds} s)` }
    : { check: "ast-grep hygiene", status: "FAIL", detail: `ast-grep rule tests failed (${seconds} s)`, notes: tail(tests.output) };
}

async function eslintChanged(changes: readonly Change[], options?: SpawnOptions): Promise<CheckResult> {
  const files = changes.filter(({ path, deleted }) => !deleted && SCRIPT.test(path)).map(({ path }) => path);
  if (files.length === 0) return { check: "eslint changed", status: "SKIP", detail: "no changed JS/TS files" };
  const result = await executeAsync("npx", ["--no", "--", "eslint", "--", ...files], options);
  return result.code === 0
    ? { check: "eslint changed", status: "PASS", detail: `${files.length} changed file(s) passed eslint (${result.seconds} s)` }
    : { check: "eslint changed", status: "FAIL", detail: `eslint failed on ${files.length} changed file(s)`, notes: tail(result.output) };
}

async function sqlAdmit(changes: readonly Change[]): Promise<CheckResult> {
  const triggers = sqlTreeChanges(changes);
  if (triggers.length === 0) return { check: "sql admit", status: "SKIP", detail: "no SQL under db/ or packages/*/sql/ changed" };
  if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], "stdout") !== "") {
    return { check: "sql admit", status: "WARN", detail: "commit or stash uncommitted changes to run npm run sql:admit" };
  }
  const result = await executeAsync("npm", ["run", "sql:admit"]);
  return result.code === 0
    ? { check: "sql admit", status: "PASS", detail: `SQL admission passed (${result.seconds} s)` }
    : { check: "sql admit", status: "FAIL", detail: `npm run sql:admit exited ${result.code ?? "on a signal"}`, notes: tail(result.output) };
}

const INVENTORY_CACHE_PATH = ".context/scratch/inventory-cache.json";
const INVENTORY_CLOSURE_FILES = [
  ...MIGRATION_REGISTRIES,
  INVENTORY_PATH,
  "config/ci-images.json",
  "scripts/agent-review-derived.mjs",
  "scripts/agent-review-registry.mjs",
  "scripts/ci-image-pull.mjs",
  "scripts/ci-image-mirror.mjs",
  "scripts/disposable-docker.mjs",
  "scripts/platform-migration-manifest.ts",
  "scripts/installation-inventory-refresh.ts",
  "server/adapters/postgres/migrationRunner.ts",
  "server/adapters/postgres/qualifiedInstall.ts",
  "server/adapters/postgres/selectedCatalogProjection.ts",
  "server/adapters/postgres/connectedStoreCapture.ts",
  "tests/helpers/postgresContainer.ts",
];
const INVENTORY_CLOSURE_DIRS = [
  "db",
  "packages/platform/src/migrations",
  "packages/platform/src/catalog",
  "packages/platform/dist/migrations",
  "packages/platform/dist/catalog",
  "server/adapters/postgres/connectedStoreDomains",
];

function collectFilesRecursive(root: string, dir: string, filter?: (rel: string) => boolean): string[] {
  const full = resolve(root, dir);
  if (!existsSync(full)) return [];
  const entries: string[] = [];
  for (const name of readdirSync(full).sort()) {
    const rel = `${dir}/${name}`;
    const stat = lstatSync(resolve(root, rel));
    if (stat.isDirectory()) entries.push(...collectFilesRecursive(root, rel, filter));
    else if (stat.isFile() && (!filter || filter(rel))) entries.push(rel);
  }
  return entries;
}

/** Content-addressed digest over every file that can influence `inventory:refresh`. */
export function inventoryClosureDigest(root = process.cwd()): string {
  const paths = new Set<string>(INVENTORY_CLOSURE_FILES);
  for (const dir of INVENTORY_CLOSURE_DIRS) {
    const filter = dir === "db" ? (rel: string) => rel.endsWith(".sql") : undefined;
    for (const rel of collectFilesRecursive(root, dir, filter)) paths.add(rel);
  }
  const hasher = createHash("sha256");
  for (const rel of [...paths].sort()) {
    const full = resolve(root, rel);
    hasher.update(`${rel}\0`);
    if (existsSync(full) && statSync(full).isFile()) {
      hasher.update("1\0");
      hasher.update(readFileSync(full));
    } else {
      hasher.update("0\0");
    }
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function readInventoryCache(root = process.cwd()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, INVENTORY_CACHE_PATH), "utf8")) as { digest?: unknown };
    return typeof parsed.digest === "string" ? parsed.digest : null;
  } catch {
    return null;
  }
}

function writeInventoryCache(digest: string, root = process.cwd()): void {
  try {
    const target = resolve(root, INVENTORY_CACHE_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ digest })}\n`, "utf8");
  } catch {
    // Advisory local cache writes never fail preflight.
  }
}

async function inventory(changes: readonly Change[]): Promise<CheckResult> {
  const triggers = sqlTreeChanges(changes);
  if (triggers.length === 0) return { check: "inventory", status: "SKIP", detail: "no SQL under db/ or packages/*/sql/ changed" };
  const useCache = processEnvironment.CI !== "true" && processEnvironment.OPENLUP_PREFLIGHT_NO_CACHE !== "1";
  const closureDigest = useCache ? inventoryClosureDigest() : null;
  if (useCache && closureDigest && readInventoryCache() === closureDigest) {
    if (git(["status", "--porcelain", "--", INVENTORY_PATH]).trim()) {
      return { check: "inventory", status: "WARN", detail: `${INVENTORY_PATH} matches the cached clean measurement but is not committed (0 s)` };
    }
    return { check: "inventory", status: "PASS", detail: `${INVENTORY_PATH} matches the cached clean measurement for unchanged SQL closure (0 s)` };
  }
  if ((await executeAsync("docker", ["info"], { timeout: 30_000 })).code !== 0) {
    return { check: "inventory", status: "WARN", detail: `${triggers.length} SQL file(s) changed but Docker is unavailable; run npm run inventory:refresh with Docker and commit ${INVENTORY_PATH}` };
  }
  // inventory:refresh has no check mode: it rewrites the file's `current` section.
  const before = readFileSync(INVENTORY_PATH, "utf8");
  const result = await executeAsync("npm", ["run", "inventory:refresh"]);
  if (result.code !== 0) return { check: "inventory", status: "FAIL", detail: "npm run inventory:refresh failed", notes: tail(result.output) };
  if (readFileSync(INVENTORY_PATH, "utf8") !== before) {
    return { check: "inventory", status: "FAIL", detail: `refresh rewrote ${INVENTORY_PATH} and left it in the working tree; review it with git diff and commit it (${result.seconds} s)` };
  }
  if (useCache && closureDigest) writeInventoryCache(closureDigest);
  if (git(["status", "--porcelain", "--", INVENTORY_PATH]).trim()) {
    return { check: "inventory", status: "WARN", detail: `${INVENTORY_PATH} matches the measured installations but is not committed (${result.seconds} s)` };
  }
  return { check: "inventory", status: "PASS", detail: `${INVENTORY_PATH} matches the measured installations (${result.seconds} s)` };
}

const RELEASE_GATES_HEADROOM_WARN_RATIO = 0.10;

async function releaseGatesHeadroom(changes: readonly Change[], typecheckPassed: boolean): Promise<CheckResult> {
  if (!changes.some(({ path }) => path.startsWith("packages/platform/"))) {
    return { check: "release-gates headroom", status: "SKIP", detail: "no packages/platform/ files changed" };
  }
  if (!typecheckPassed) {
    return { check: "release-gates headroom", status: "SKIP", detail: "typecheck build did not complete" };
  }
  const gatesPath = "packages/platform/release-gates.json";
  if (!existsSync(gatesPath)) return { check: "release-gates headroom", status: "SKIP", detail: `${gatesPath} absent` };
  const budget = (JSON.parse(readFileSync(gatesPath, "utf8")) as { pack?: { maxFiles?: number; maxUnpackedBytes?: number } }).pack;
  if (!budget?.maxFiles || !budget?.maxUnpackedBytes) {
    return { check: "release-gates headroom", status: "SKIP", detail: "pack caps unavailable" };
  }
  const result = await executeAsync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces=false"],
    { cwd: resolve("packages/platform") },
  );
  if (result.code !== 0) {
    return { check: "release-gates headroom", status: "WARN", detail: `npm pack --dry-run unavailable (${result.seconds} s)`, notes: tail(result.output) };
  }
  let report: { entryCount?: number; unpackedSize?: number } | undefined;
  try {
    const reports = JSON.parse(result.stdout) as Array<{ entryCount?: number; unpackedSize?: number }>;
    report = Array.isArray(reports) ? reports[0] : undefined;
  } catch {
    report = undefined;
  }
  if (!report || typeof report.entryCount !== "number" || typeof report.unpackedSize !== "number") {
    return { check: "release-gates headroom", status: "WARN", detail: "npm pack --json --dry-run output unreadable" };
  }
  const checks: Array<[string, number, number]> = [
    ["files", report.entryCount, budget.maxFiles],
    ["unpacked bytes", report.unpackedSize, budget.maxUnpackedBytes],
  ];
  const exceeded: string[] = [];
  const low: string[] = [];
  for (const [label, value, limit] of checks) {
    if (value > limit) exceeded.push(`${label} ${value} exceeds cap ${limit}`);
    else if ((limit - value) / limit < RELEASE_GATES_HEADROOM_WARN_RATIO) {
      low.push(`${label} ${value}/${limit} (${((limit - value) / limit * 100).toFixed(1)}% headroom)`);
    }
  }
  if (exceeded.length > 0) {
    return { check: "release-gates headroom", status: "FAIL", detail: `packages/platform pack budget exceeded (${result.seconds} s)`, notes: exceeded };
  }
  if (low.length > 0) {
    return { check: "release-gates headroom", status: "WARN", detail: `packages/platform pack headroom under 10% (${result.seconds} s)`, notes: low };
  }
  return { check: "release-gates headroom", status: "PASS", detail: `packages/platform ${report.entryCount}/${budget.maxFiles} files, ${report.unpackedSize}/${budget.maxUnpackedBytes} unpacked bytes (${result.seconds} s)` };
}

function fragments(changes: readonly Change[]): CheckResult {
  const missing = missingFragments(changes);
  if (missing.length > 0) return { check: "fragments", status: "WARN", detail: `source changed without a changes/*.md fragment in ${missing.join(", ")}` };
  const touched = changes.some(({ path }) => releasedPackageSource(path) !== undefined);
  return touched ? { check: "fragments", status: "PASS", detail: "every changed released package source has a fragment" } : { check: "fragments", status: "SKIP", detail: "no released package source changed" };
}

function settingsCandidateGuard(
  base: string,
  changes: readonly Change[],
  untracked: ReadonlySet<string>,
  target?: string,
): CheckResult {
  const eligible = changes.filter(({ path, deleted }) => !deleted && isSettingsCandidateSourcePath(path));
  if (eligible.length === 0) {
    return { check: "settings-candidates", status: "SKIP", detail: "no packages/platform/src/**/*.ts files changed" };
  }
  const findings = checkSettingsCandidates(process.cwd(), base, changes, {
    target,
    untracked,
    runDiff: (args, cwd) => {
      const result = execute("git", args, { cwd });
      return { status: result.code, stdout: result.stdout, stderr: result.output };
    },
  });
  if (findings.length === 0) {
    return { check: "settings-candidates", status: "PASS", detail: `no unaccounted settings candidates in ${eligible.length} changed platform source file(s)` };
  }
  return {
    check: "settings-candidates",
    status: "FAIL",
    detail: `${findings.length} unaccounted settings candidate(s); evaluate against CONTRIBUTING.md#add-a-setting`,
    notes: findings.map(({ path, line, symbol, remediation }) => `${path}:${line}: ${symbol}: ${remediation}`),
  };
}

function testLineChecks(lines: readonly AddedLine[] | null, now: Date): CheckResult[] {
  if (lines === null) return ["test dates", "test expiries"].map((check): CheckResult => ({ check, status: "SKIP", detail: "no new or changed test files" }));
  const dates = nearDates(lines, now);
  const expiries = shortExpiries(lines);
  return [
    dates.length > 0
      ? { check: "test dates", status: "WARN", detail: `${dates.length} added line(s) with a calendar date within ${DATE_WINDOW_DAYS} days of now; prefer an injected clock or a far date`, notes: findingNotes(dates) }
      : { check: "test dates", status: "PASS", detail: `no added calendar date within ${DATE_WINDOW_DAYS} days of now` },
    expiries.length > 0
      ? { check: "test expiries", status: "WARN", detail: `${expiries.length} added line(s) with an expiry or TTL under ${SHORT_EXPIRY_SECONDS} s; prefer an injected clock or a longer lifetime`, notes: findingNotes(expiries) }
      : { check: "test expiries", status: "PASS", detail: `no added expiry or TTL under ${SHORT_EXPIRY_SECONDS} s` },
  ];
}

async function gitleaks(base: string, untracked: readonly string[]): Promise<CheckResult> {
  if ((await executeAsync("gitleaks", ["version"])).missing) return { check: "gitleaks", status: "SKIP", detail: "gitleaks is not on PATH; the required gitleaks job still scans the pull request" };
  const options = ["--config", "config/gitleaks.toml", "--gitleaks-ignore-path", ".gitleaksignore", "--redact", "--no-banner", "--no-color"];
  const scans: string[][] = [];
  if (Number(git(["rev-list", "--count", `${base}..HEAD`], "stdout").trim()) > 0) scans.push(["git", ".", ...options, "--log-opts", `${base}..HEAD`]);
  scans.push(["git", ".", ...options, "--pre-commit", "--staged"], ["git", ".", ...options, "--pre-commit"]);
  for (const path of untracked) scans.push(["dir", path, ...options]);
  let seconds = 0;
  for (const scan of scans) {
    const result = await executeAsync("gitleaks", scan);
    seconds += result.seconds;
    if (result.code !== 0) return { check: "gitleaks", status: "FAIL", detail: `gitleaks ${scan[0]} reported findings or failed`, notes: tail(result.output) };
  }
  return { check: "gitleaks", status: "PASS", detail: `no leaks in commits since the fork point, staged, unstaged or untracked files (${seconds} s)` };
}

export function vitestFiles(candidates: readonly string[], config?: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "openlup-preflight-"));
  try {
    const listing = join(directory, "files.json");
    const env: NodeJS.ProcessEnv = { ...processEnvironment, VITEST_SKIP_INSTALL_CHECKS: "1" };
    delete env.OPENLUP_VITEST_EXCLUDE_FILE;
    // `--json` takes an optional path, so it goes after the files.
    const result = execute("npx", ["--no", "--", "vitest", "list", ...(config ? ["--config", resolve(config), "--root", dirname(config)] : []), ...candidates.map((path) => config ? relative(dirname(config), path) : path), "--filesOnly", `--json=${listing}`], { env });
    if (result.code !== 0) throw new Error(`vitest list failed: ${lastLine(result.output)}`);
    const listed = JSON.parse(readFileSync(listing, "utf8")) as Array<{ file: string }>;
    const discovered = new Set(listed.map(({ file }) => relative(process.cwd(), file).split("\\").join("/")));
    return candidates.filter((path) => discovered.has(path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type SeparateTest = { path: string; command: string };
type TestSelection = { files: string[]; separate: SeparateTest[]; unknown: string[] };

/** Positive discovery from existing runner configurations; this never executes a test. */
export function separateTestFiles(candidates: readonly string[]): SeparateTest[] {
  const configs = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*vitest.config.*", "*playwright*.config.*"]).split("\0").filter(Boolean);
  const found: SeparateTest[] = [];
  for (const config of configs) {
    const directory = dirname(config);
    const files = candidates.filter((path) => !found.some((entry) => entry.path === path)
      && (directory === "." || path.startsWith(`${directory}/`)));
    if (files.length === 0 || config === "vitest.config.ts") continue;
    if (/(?:^|\/)vitest\.config\./u.test(config)) {
      try {
        for (const path of vitestFiles(files, config)) found.push({ path, command: `npx --no -- vitest list --root ${directory} --config ${basename(config)} --filesOnly` });
      } catch { /* An unavailable owning config leaves explicit missing discovery proof. */ }
    } else {
      // Browser suites retain their explicit setup/profile runner. Listing does
      // not start webServer or browser workers; a config requiring owned setup
      // may refuse, which leaves discovery unconfirmed and actionable below.
      const browserFiles = files.filter((path) => /\.spec\.[cm]?[jt]sx?$/u.test(path));
      if (browserFiles.length === 0) continue;
      const listing = execute("npx", ["--no", "--", "playwright", "test", "--config", config, "--list", "--reporter=json", ...browserFiles.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))]);
      if (listing.code !== 0) continue;
      let report: { config: { rootDir: string }; suites: Array<{ file: string }> };
      try { report = JSON.parse(listing.output); } catch { continue; }
      const listed = new Set(report.suites.map(({ file }) => relative(process.cwd(), resolve(report.config.rootDir, file)).split("\\").join("/")));
      for (const path of browserFiles.filter((path) => listed.has(path))) found.push({ path, command: `npx --no -- playwright test --config ${config} --list` });
    }
  }
  return found;
}

export function testDiscoveryVerdict(selection: TestSelection): CheckResult {
  const notes = selection.separate.map(({ path, command }) => `${path}: separate runner confirmed by ${command}; run its owning package/profile proof`);
  notes.push(...selection.unknown.map((path) => `${path}: not collected by root Vitest or confirmed in a separate runner; check the suffix/location against vitest.config.ts and CONTRIBUTING.md#choose-a-location-and-proof, or demonstrate its owning runner with list --filesOnly / --list`));
  if (selection.unknown.length > 0) return { check: "test discovery", status: "WARN", detail: `${selection.unknown.length} changed test file(s) have no confirmed runner; their execution remains missing proof`, notes };
  return { check: "test discovery", status: selection.files.length + selection.separate.length > 0 ? "PASS" : "SKIP",
    detail: `${selection.files.length} root Vitest file(s), ${selection.separate.length} confirmed separate-runner file(s); discovery is not execution`, notes };
}

type FindAffectedTestsFn = (options: { changedFiles: string[]; rootDir: string }) => {
  affectedTests: Array<{ path: string; reasons: string[] }>;
};

export function affectedTestCandidates(changes: readonly Change[], rootDir = process.cwd()): string[] {
  const allPaths = changes.map(({ path }) => path);
  if (allPaths.length === 0) return [];
  const direct = changes.filter(({ path, deleted }) => !deleted && isTestEntry(path)).map(({ path }) => path);
  const { affectedTests } = (findAffectedTests as unknown as FindAffectedTestsFn)({ changedFiles: allPaths, rootDir });
  return [...new Set([...direct, ...affectedTests.map(({ path }) => path)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const CATALOG_BOUNDARY_TEST = "scripts/catalog-document-boundary.test.ts";
const INVARIANT_TESTS = [
  "scripts/packages/package-size-policy.test.ts",
  CATALOG_BOUNDARY_TEST,
  "scripts/ci-test-scope.test.ts",
  "scripts/strip-types-entrypoint-specifiers.test.ts",
  "packages/platform/test/packageBoundary.test.ts",
  "packages/platform/test/storefront/exports.test.ts",
  "packages/platform/test/storefront/testing/exports.test.ts",
  "scripts/preflight.test.ts",
];
const COLD_PREFLIGHT_TEST = /^scripts\/preflight-integration(?:-[\w-]+)?\.test\.ts$/u;

function discoverTests(changes: readonly Change[], affected: boolean, proof: boolean): TestSelection {
  let candidates = affected
    ? affectedTestCandidates(changes)
    : changes.filter(({ path, deleted }) => !deleted && isTestEntry(path)).map(({ path }) => path);
  if (proof) candidates = [...new Set([...candidates.filter((path) => !COLD_PREFLIGHT_TEST.test(path)), ...INVARIANT_TESTS])].sort();
  if (candidates.length === 0) return { files: [], separate: [], unknown: [] };
  const files = vitestFiles(candidates);
  const outside = candidates.filter((path) => !files.includes(path));
  const separate = outside.length > 0 ? separateTestFiles(outside) : [];
  return { files, separate, unknown: outside.filter((path) => !separate.some((entry) => entry.path === path)) };
}

async function hostedTests(selection: TestSelection | undefined, proof = false): Promise<CheckResult> {
  if (!selection) return { check: "hosted tests", status: "FAIL", detail: "test discovery failed; restore discovery before running changed root tests" };
  const { files } = selection;
  const missing = proof ? INVARIANT_TESTS.filter((path) => !files.includes(path)) : [];
  if (missing.length) return { check: "hosted tests", status: "FAIL", detail: `required invariant tests were not discovered: ${missing.join(", ")}` };
  if (files.length === 0) return { check: "hosted tests", status: "SKIP", detail: "no changed root Vitest file; see test discovery for separate runners and missing proof" };
  const directory = proof ? mkdtempSync(join(tmpdir(), "openlup-hosted-proof-")) : undefined;
  const report = directory && join(directory, "results.json");
  try {
    const result = await executeAsync(process.execPath, ["scripts/test-hosted.mjs", ...files,
      ...(report ? ["--reporter=default", "--reporter=json", `--outputFile.json=${report}`] : [])]);
    if (result.code !== 0) {
      const failed = proof ? [...new Set([...result.output.matchAll(/^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/gmu)].map(([, path]) => path))] : [];
      return { check: "hosted tests", status: "FAIL", detail: `npm run test:hosted -- ${(failed.length ? failed : files).join(" ")} exited ${result.code ?? "on a signal"}`, notes: tail(result.output, 60) };
    }
    if (report && !existsSync(report)) return { check: "hosted tests", status: "FAIL", detail: `missing Vitest execution report for ${files.join(", ")}` };
    if (report) {
      const { testResults } = JSON.parse(readFileSync(report, "utf8")) as {
        testResults: Array<{ name: string; assertionResults: Array<{ status: string }> }>;
      };
      const passed = new Set(testResults.filter(({ name, assertionResults }) => assertionResults.some(({ status }) => status === "passed")
        && (!INVARIANT_TESTS.includes(relative(process.cwd(), name).split("\\").join("/"))
          || assertionResults.every(({ status }) => status === "passed"))).map(({ name }) => resolve(name)));
      const skipped = files.filter((path) => !passed.has(resolve(path)));
      if (skipped.length) return { check: "hosted tests", status: "FAIL", detail: `required tests skipped or missing: ${skipped.join(", ")}` };
    }
    return { check: "hosted tests", status: "PASS", detail: `${files.length} file(s) passed in hosted parity (${result.seconds} s)` };
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

async function pgtap(): Promise<CheckResult> {
  if (processEnvironment.AI_RESOURCE_GATE_ACTIVE === "1" || processEnvironment.OPENLUP_HEAVY_ACTIVE) {
    throw new Error("pgTAP needs its own ai-resource-gate lease; run preflight outside the current broker");
  }
  const gate = resolveResourceGateInvocation({
    cwd: process.cwd(), profile: "openlup:pgtap", command: process.execPath, args: ["scripts/public-ci-pgtap.mjs"],
    lane: "supabase-db", queueTimeout: 600, executionTimeout: 1800, requireBroker: true,
  })!;
  const result = await executeAsync(gate.command, gate.args);
  const skip = /^\s*(?:ok\b.*|1\.\.0\s*)#\s*SKIP\b.*$/imu.exec(result.output)?.[0].trim();
  if (skip) return { check: "pgTAP", status: "FAIL", detail: `required assertion or suite skipped: ${skip}` };
  return result.code === 0 && /^Result: PASS\s*$/mu.test(result.output) && /^Files=\d+, Tests=[1-9]\d*/mu.test(result.output)
    ? { check: "pgTAP", status: "PASS", detail: `real PostgreSQL suite passed (${result.seconds} s)` }
    : { check: "pgTAP", status: "FAIL", detail: `scripts/public-ci-pgtap.mjs did not report a passing suite (exit ${result.code ?? "unavailable"})`, notes: tail(result.output, 60) };
}

async function neutrality(base: string): Promise<CheckResult> {
  // The required self-check job's tree-wide ratchet; it scans the working tree, untracked files included.
  const result = await executeAsync(process.execPath, ["scripts/public-ci-neutrality.mjs", "--base-commit", base]);
  return neutralityVerdict(result.code, result.output, result.seconds);
}

function changedTestLines(base: string, changes: readonly Change[], untracked: ReadonlySet<string>, target?: string): AddedLine[] | null {
  const files = changes.filter(({ path, deleted }) => !deleted && isTestFile(path)).map(({ path }) => path);
  if (files.length === 0) return null;
  const range = target ? [base, target] : [base];
  return files.flatMap((path) => untracked.has(path)
    ? readFileSync(path, "utf8").split("\n").map((text, index) => ({ path, line: index + 1, text }))
    : addedLines(path, git(["diff", "-U0", "--no-color", "--no-ext-diff", ...range, "--", path], "stdout")));
}

function print(result: CheckResult): void {
  console.log(formatCheckLine(result));
  const notes = result.notes ?? [];
  for (const note of notes.slice(0, 40)) console.log(`    ${note}`);
  if (notes.length > 40) console.log(`    ... ${notes.length - 40} more`);
}

const STACK_BASE_SHA = /^[0-9a-f]{40}$/u;
const GUIDE_TRIGGER = /^(?:AGENTS\.md$|CONTRIBUTING\.md$|packages\/[^/]+\/(?:api\/|src\/|sql\/.*\.sql$|(?:AGENTS|README)\.md$|(?:package|release-gates)\.json$)|packages\/core\/(?:docs\/guide\/|scripts\/(?:documentation[^/]*|public-api-config)\.ts$)|packages\/platform\/settings-refusals\.json$|packages\/ui\/smoke\/neutrality\.ts$|config\/(?:environment-variables|documentation-guide-allowlist)\.json$)/u;
const PACKAGE_MANIFEST_TRIGGER = /^(?:packages\/[^/]+\/package\.json|config\/openlup-packages\.json)$/u;
export const CLIENT_SECRET_BOUNDARY_TRIGGER = /^(?:src\/|server\/|api\/|config\/environment-variables\.json$|scripts\/check-client-secret-boundary\.ts$)/u;
export const SITE_ROUTES_TRIGGER = /^(?:config\/site-routes\.json$|config\/public-reference-site-routes\.json$|scripts\/site-routes)/u;
export const MIGRATION_MANIFEST_TRIGGER = /^(?:db\/platform\/migrations\/|packages\/platform\/sql\/|packages\/platform\/src\/migrations\/catalog\.ts$|config\/platform-migration-manifest\.json$|tests\/postgres\/current-installation-inventory\.json$|scripts\/platform-migration-manifest\.ts$|scripts\/packages\/platform-migration-projection\.ts$)/u;

const INVENTORY_TAIL_ANCHOR = "db/platform/migrations/20261109150000_subscription_auto_resume_paid_history.sql";

const isManifestEntry = (value: unknown): value is { file: string; sha256: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.file === "string" && typeof record.sha256 === "string";
};

function checkFiveProfileInventoryParity(root: string): string[] {
  let rawManifest: unknown;
  try {
    rawManifest = readPlatformMigrationManifest(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${PLATFORM_MIGRATION_MANIFEST}: failed to read manifest: ${message}`];
  }
  if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    return [`${PLATFORM_MIGRATION_MANIFEST}: missing or invalid manifest`];
  }
  const manifest = rawManifest as PlatformMigrationManifest;
  if (manifest.schemaVersion !== 3) {
    return [`${PLATFORM_MIGRATION_MANIFEST}: expected schemaVersion 3 for 5-profile inventory parity`];
  }
  const inventoryFullPath = resolve(root, INVENTORY_PATH);
  if (!existsSync(inventoryFullPath)) {
    return [`${INVENTORY_PATH}: missing installation inventory`];
  }
  let profilesUnknown: unknown;
  try {
    profilesUnknown = inventoryEnvelope(readFileSync(inventoryFullPath, "utf8")).value.current.profiles;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${INVENTORY_PATH}: invalid installation inventory: ${message}`];
  }
  if (!profilesUnknown || typeof profilesUnknown !== "object" || Array.isArray(profilesUnknown)) {
    return [`${INVENTORY_PATH}: missing current.profiles object`];
  }
  const profileMap = profilesUnknown as Record<string, unknown>;
  let selections: ReadonlyArray<readonly [string, PlatformMigrationPlan]>;
  try {
    selections = [
      ["legacy", selectPlatformMigrationManifest(manifest, "legacy")],
      ["bootstrap", selectPlatformMigrationManifest(manifest, "qualified-v2", { migrationIsBootstrap: true, hasRestore: true })],
      ["separate", selectPlatformMigrationManifest(manifest, "qualified-v2", { migrationIsBootstrap: false, hasRestore: true })],
      ["admin-managed", selectPlatformMigrationManifest(manifest, "qualified-admin", { roleMode: "installer-managed" })],
      ["admin-operator", selectPlatformMigrationManifest(manifest, "qualified-admin", { roleMode: "operator-provisioned" })],
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${PLATFORM_MIGRATION_MANIFEST}: unable to select all 5 profiles: ${message}`];
  }
  const errors: string[] = [];
  const expectedProfiles = new Set(selections.map(([profileName]) => profileName));
  const extraProfiles = Object.keys(profileMap).filter((name) => !expectedProfiles.has(name)).sort();
  if (extraProfiles.length > 0) {
    errors.push(`${INVENTORY_PATH}: unexpected current.profiles key(s): ${extraProfiles.join(", ")}`);
  }
  for (const [profileName, plan] of selections) {
    const rawProfile = profileMap[profileName];
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      errors.push(`${INVENTORY_PATH}: missing current.profiles.${profileName}`);
      continue;
    }
    const profile = rawProfile as Record<string, unknown>;
    if (profile.objectInventorySha256 !== plan.objectInventorySha256) {
      errors.push(`${INVENTORY_PATH}: current.profiles.${profileName}.objectInventorySha256 does not match ${PLATFORM_MIGRATION_MANIFEST} (run npm run inventory:refresh with Docker)`);
    }
    if (!isManifestEntry(plan.baseline) || !Array.isArray(plan.forward) || !plan.forward.every(isManifestEntry)) {
      errors.push(`${PLATFORM_MIGRATION_MANIFEST}: invalid baseline/forward entry in ${profileName}`);
      continue;
    }
    const expectedTail = [plan.baseline, ...plan.forward].reverse().map(({ file, sha256 }) => ({ file, sha256 }));
    const expectedExactTailCount = expectedTail.findIndex(({ file }) => file === INVENTORY_TAIL_ANCHOR);
    if (profile.count !== expectedTail.length) {
      errors.push(`${INVENTORY_PATH}: current.profiles.${profileName}.count (${String(profile.count)}) does not match manifest length (${expectedTail.length})`);
    }
    if (expectedExactTailCount < 0) {
      errors.push(`${PLATFORM_MIGRATION_MANIFEST}: missing exact-installation tail anchor ${INVENTORY_TAIL_ANCHOR} in ${profileName}`);
    } else if (profile.exactTailCount !== expectedExactTailCount) {
      errors.push(`${INVENTORY_PATH}: current.profiles.${profileName}.exactTailCount (${String(profile.exactTailCount)}) does not match manifest anchor index (${expectedExactTailCount})`);
    }
    const tailMatches = Array.isArray(profile.tail)
      && profile.tail.length === expectedTail.length
      && profile.tail.every((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        const expected = expectedTail[index]!;
        return Object.keys(record).length === 2 && record.file === expected.file && record.sha256 === expected.sha256;
      });
    if (!tailMatches) {
      errors.push(`${INVENTORY_PATH}: current.profiles.${profileName}.tail does not match ${PLATFORM_MIGRATION_MANIFEST}`);
    }
  }
  return errors;
}

/** Fast pure-Node check of canonical migration manifest, package projection, and 5-profile inventory parity. */
export function checkMigrationManifestAndInventory(root = process.cwd()): string[] {
  const errors = [...runPlatformMigrationManifestCheck(root)];
  try {
    errors.push(...checkPlatformMigrationProjection(root));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    errors.push(...checkFiveProfileInventoryParity(root));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function migrationManifestGuard(changes: readonly Change[], root = process.cwd()): CheckResult {
  if (!changes.some(({ path }) => MIGRATION_MANIFEST_TRIGGER.test(path))) {
    return { check: "migration manifest", status: "SKIP", detail: "no migration manifest, projection, or inventory inputs changed" };
  }
  const started = Date.now();
  const errors = checkMigrationManifestAndInventory(root);
  const seconds = Math.round((Date.now() - started) / 1000);
  return errors.length === 0
    ? { check: "migration manifest", status: "PASS", detail: `manifest, projection, and 5-profile inventory match (${seconds} s)` }
    : { check: "migration manifest", status: "FAIL", detail: errors[0]!, notes: errors };
}

async function runTriggeredGuard(
  check: string,
  changes: readonly Change[],
  trigger: RegExp,
  args: readonly string[],
  skipDetail: string,
  options?: SpawnOptions & { timeout?: number },
): Promise<CheckResult> {
  if (!changes.some(({ path }) => trigger.test(path))) return { check, status: "SKIP", detail: skipDetail };
  const result = await executeAsync(process.execPath, args, options);
  return result.code === 0
    ? { check, status: "PASS", detail: `passed (${result.seconds} s)` }
    : { check, status: "FAIL", detail: `node ${args.join(" ")} exited ${result.code ?? "on a signal"}`, notes: tail(result.output) };
}

const AREA_EXCLUDED_TESTS = new Set([
  "scripts/agent-review-derived-inventory.test.ts",
  "scripts/packages/outbox-consumer-proof.test.ts",
  "scripts/packages/distribution-cli-proof.test.ts",
  "scripts/packages/distribution-cli-settings.test.ts",
  "scripts/packages/platform-cold-consumer.test.ts",
  "scripts/packages/reference-delegation-consumer.test.ts",
]);
const CATALOG_BOUNDARY_PREFIXES = [
  "packages/platform/src/catalog/",
  "packages/core/src/catalog/",
  "src/domains/catalog/",
  "server/domains/catalog/",
  "db/platform/",
  "server/adapters/postgres/",
  "scripts/",
  "docs/",
];

/** Docker-free, consumer-pack-free area tooling guard tests triggered by `changedPaths`. */
export function areaGuardTests(changedPaths: readonly string[]): string[] {
  if (changedPaths.length === 0) return [];
  const excluded = new Set(excludedToolingTests(changedPaths));
  const selected = new Set(
    Object.keys(TOOLING_INPUTS).filter(
      (test) => !excluded.has(test) && !AREA_EXCLUDED_TESTS.has(test) && !test.startsWith("tests/postgres/"),
    ),
  );
  if (changedPaths.some((path) => CATALOG_BOUNDARY_PREFIXES.some((prefix) => path.startsWith(prefix)))) {
    selected.add(CATALOG_BOUNDARY_TEST);
  }
  return [...selected].sort();
}

async function areaToolingGuards(changes: readonly Change[]): Promise<CheckResult> {
  const files = areaGuardTests([...new Set(changes.map(({ path }) => path))]);
  if (files.length === 0) return { check: "area guards", status: "SKIP", detail: "no area tooling guard tests triggered" };
  const result = await executeAsync(process.execPath, ["scripts/test-hosted.mjs", ...files]);
  return result.code === 0
    ? { check: "area guards", status: "PASS", detail: `${files.length} area guard file(s) passed in hosted parity (${result.seconds} s)` }
    : { check: "area guards", status: "FAIL", detail: `npm run test:hosted -- ${files.join(" ")} exited ${result.code ?? "on a signal"}`, notes: tail(result.output, 60) };
}

type FastEntry = { name: string; preamble?: string[]; outcome: CheckResult[] };

async function runFastItem(name: string, work: () => Promise<CheckResult | CheckResult[] | { preamble?: string[]; outcome: CheckResult | CheckResult[] }> | CheckResult | CheckResult[]): Promise<FastEntry> {
  try {
    const raw = await work();
    if (raw && !Array.isArray(raw) && "outcome" in raw) {
      return { name, preamble: raw.preamble, outcome: [raw.outcome].flat() };
    }
    return { name, outcome: [raw as CheckResult | CheckResult[]].flat() };
  } catch (error) {
    const detail = (error as Error).message;
    return { name, outcome: [{ check: name, status: "FAIL", detail, notes: tail(detail) }] };
  }
}

async function fastPreflight(now: Date): Promise<number> {
  const head = git(["rev-parse", "HEAD"], "stdout").trim();
  if ((await executeAsync("git", ["fetch", "origin", "main"], { timeout: 5_000 })).code !== 0) {
    console.error("preflight: git fetch origin main failed. Using local origin/main.");
  }
  const offlineNpm = { env: { ...processEnvironment, ...carrierLocale, npm_config_offline: "true", npm_config_update_notifier: "false" } };
  const npmInvocation = "preflight -- --fast";
  const command = async (check: string, bin: string, args: string[], options?: SpawnOptions): Promise<CheckResult> => {
    const { code, output } = await executeAsync(bin, args, options);
    return { check, status: code === 0 ? "PASS" : "FAIL", detail: lastLine(output) || `${bin} did not complete successfully`,
      notes: code === 0 ? undefined : tail(output) };
  };
  let fork: string | undefined;
  const forkPoint = (): string => (fork ??= git(["merge-base", "HEAD", "origin/main"], "stdout").trim());
  let cachedChanges: Change[] | undefined;
  const fastChanges = (): Change[] => (cachedChanges ??= parseNameStatus(git(["diff", "--name-status", "--no-renames", "-z", forkPoint(), "HEAD"], "stdout")));
  const clean = !git(["status", "--porcelain", "--untracked-files=all"], "stdout").trim();
  const cleanEntry: FastEntry = {
    name: "clean",
    outcome: [{ check: "clean", status: clean ? "PASS" : "FAIL", detail: "worktree has uncommitted changes. Commit or remove them." }],
  };
  const checkCarrier = async (check: string, bin: string, args: string[], remedy?: string): Promise<CheckResult> => {
    const result = await command(check, bin, args, offlineNpm);
    if (result.status === "FAIL") {
      const message = result.notes?.find(line => line.startsWith("Error: "))?.slice("Error: ".length) ?? result.detail;
      result.detail = remedy ? `${message}. ${remedy}` : message;
    }
    return result;
  };
  const carrierChecks = async (): Promise<CheckResult[]> => {
    if (!clean) return [{ check: "carriers", status: "SKIP", detail: "clean committed checkout required" }];
    const { builds, reports, settings } = carrierPlan(readReportOwners(process.cwd()), fastChanges().map(({ path }) => path));
    if (!builds.length) return [{ check: "carriers", status: "SKIP", detail: "no report or settings inputs changed" }];
    const buildDirectories = JSON.stringify(builds.map(({ directory }: { directory: string }) => directory));
    const prerequisites = await checkCarrier("carrier prerequisites", process.execPath, ["--input-type=module", "-e",
      `import { assertCarrierBuildOutputs, assertCarrierToolchain } from './scripts/agent-review-landing.mjs';
        await assertCarrierBuildOutputs(process.cwd(), ${buildDirectories});
        assertCarrierToolchain(process.cwd(), ${JSON.stringify(npmInvocation)});`],
    "Use the required Node and npm majors and run npm ci in this checkout.");
    const results = [prerequisites];
    if (prerequisites.status === "FAIL") return results;
    const npmCli = carrierNpmCli(npmInvocation);
    for (const { name } of builds) {
      const build = await checkCarrier(`carrier build ${name}`, process.execPath, [npmCli, "run", "build", `--workspace=${name}`], "Fix the workspace build before checking carrier bytes.");
      results.push(build);
      if (build.status === "FAIL") return results;
    }
    for (const { name } of reports) results.push(await checkCarrier(`api:check ${name}`, process.execPath, [npmCli, "run", "api:check", `--workspace=${name}`]));
    if (settings) results.push(await checkCarrier("settings-catalogue", process.execPath, ["scripts/settings-catalogue.ts"], "Run node scripts/settings-catalogue.ts --write."));
    return results;
  };
  // Precompute shared fork-point and changed-paths before the parallel read-only wave.
  let forkError: string | undefined;
  try {
    forkPoint();
    fastChanges();
  } catch (error) {
    forkError = (error as Error).message;
  }
  const requireFork = (): string => {
    if (forkError) throw new Error(forkError);
    return forkPoint();
  };
  const requireChanges = (): Change[] => {
    if (forkError) throw new Error(forkError);
    return fastChanges();
  };
  // Wave 1: read-only checks run concurrently; buffered results emit in canonical order.
  const [
    mergeCleanEntry,
    neutralityEntry,
    uiNeutralityEntry,
    astGrepEntry,
    astGrepHygieneEntry,
    eslintChangedEntry,
    clientSecretBoundaryEntry,
    siteRoutesEntry,
    publicationEntry,
    migrationProjectionEntry,
    fragmentsEntry,
    settingsCandidatesEntry,
    testLinesEntry,
    gitleaksEntry,
    guideCheckEntry,
    packageManifestEntry,
    dcoEntry,
  ] = await Promise.all([
    runFastItem("merge-clean", async () => {
      const stackBase = processEnvironment.OPENLUP_STACK_BASE;
      if (stackBase !== undefined && STACK_BASE_SHA.test(stackBase)
        && (await executeAsync("git", ["merge-base", "--is-ancestor", stackBase, "HEAD"])).code === 0
        && (await executeAsync("git", ["merge-base", "--is-ancestor", stackBase, "origin/main"])).code === 1) {
        return { check: "merge-clean", status: "SKIP", detail: "unlanded OPENLUP_STACK_BASE; merge-tree skipped" };
      }
      return command("merge-clean", "git", ["merge-tree", "--write-tree", "origin/main", "HEAD"]);
    }),
    runFastItem("neutrality", () => neutrality(requireFork())),
    runFastItem("ui-neutrality", () => command("ui-neutrality", process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts"])),
    runFastItem("ast-grep", () => astGrep(offlineNpm)),
    runFastItem("ast-grep-hygiene", () => astGrepHygiene(offlineNpm)),
    runFastItem("eslint-changed", () => eslintChanged(requireChanges(), offlineNpm)),
    runFastItem("client-secret-boundary", () => runTriggeredGuard(
      "client-secret-boundary", requireChanges(), CLIENT_SECRET_BOUNDARY_TRIGGER,
      ["--experimental-strip-types", "scripts/check-client-secret-boundary.ts"],
      "no client-secret-boundary inputs changed", offlineNpm,
    )),
    runFastItem("site-routes", () => runTriggeredGuard(
      "site-routes", requireChanges(), SITE_ROUTES_TRIGGER,
      ["scripts/site-routes.mjs", "--public-reference"],
      "no site route inputs changed", offlineNpm,
    )),
    runFastItem("publication", async () => {
      let npmCli: string;
      let npmVersion = "unavailable (npm CLI path missing or relative)";
      const preamble: string[] = [];
      try {
        npmCli = carrierNpmCli(npmInvocation);
        npmVersion = await npmVersionForToolchain(npmCli, offlineNpm);
      } catch (error) {
        preamble.push(describeCarrierToolchain(npmVersion));
        const detail = (error as Error).message;
        return { preamble, outcome: { check: "publication", status: "FAIL", detail, notes: tail(detail) } };
      }
      preamble.push(describeCarrierToolchain(npmVersion));
      const result = await command("publication", process.execPath, [npmCli, "run", "oss:published-tree", "--", "--self-check",
        ...(processEnvironment.OPENLUP_STACK_BASE !== undefined ? [] : ["--docs-base", requireFork()]),
      ], offlineNpm);
      const missing = result.notes?.find(line => /materialized output inventory mismatch .*; extra (?!none\))/u.test(line));
      if (missing) result.detail = `${missing}. Add the reviewed classification in config/openlup-publication-catalog.json.`;
      return { preamble, outcome: result };
    }),
    runFastItem("migration projection", () => {
      if (!clean) return { check: "migration projection", status: "SKIP", detail: "clean committed checkout required" };
      const errors = checkMigrationManifestAndInventory(process.cwd());
      return { check: "migration projection", status: errors.length ? "FAIL" : "PASS", detail: errors[0] ?? "fresh", notes: errors };
    }),
    runFastItem("fragments", () => fragments(requireChanges())),
    runFastItem("settings-candidates", () => settingsCandidateGuard(requireFork(), requireChanges(), new Set(), "HEAD")),
    runFastItem("test-lines", () => testLineChecks(changedTestLines(requireFork(), requireChanges(), new Set(), "HEAD"), now)),
    runFastItem("gitleaks", () => gitleaks(requireFork(), [])),
    runFastItem("guide-check", () => requireChanges().some(({ path }) => GUIDE_TRIGGER.test(path))
      ? command("guide-check", process.execPath, ["--experimental-strip-types", "packages/core/scripts/documentation-contract.ts", "--check-guide", "packages/core"], offlineNpm)
      : { check: "guide-check", status: "SKIP", detail: "no guide or rule files changed" }),
    runFastItem("package-manifest", () => requireChanges().some(({ path }) => PACKAGE_MANIFEST_TRIGGER.test(path))
      ? command("package-manifest", "npm", ["run", "packages:check", "--", "--manifest-only"], offlineNpm)
      : { check: "package-manifest", status: "SKIP", detail: "no package manifests or config/openlup-packages.json changed" }),
    runFastItem("dco", () => {
      const upstream = git(["rev-parse", "origin/main"], "stdout").trim();
      const commits = readCommits(process.cwd(), upstream, head);
      const { missing } = signOffVerdict(commits);
      return { check: "dco", status: missing.length ? "FAIL" : "PASS",
        detail: `missing Signed-off-by on ${missing.map(({ sha }) => sha.slice(0, 12)).join(", ")}` };
    }),
  ]);
  // Wave 2: carrier builds mutate packages/*/dist/, so run after Wave 1 finishes.
  const carriersEntry = await runFastItem("carriers", carrierChecks);

  const ordered: FastEntry[] = [
    cleanEntry, mergeCleanEntry, neutralityEntry, uiNeutralityEntry, astGrepEntry, astGrepHygieneEntry,
    eslintChangedEntry, clientSecretBoundaryEntry, siteRoutesEntry,
    publicationEntry, carriersEntry, migrationProjectionEntry, fragmentsEntry, settingsCandidatesEntry,
    testLinesEntry, gitleaksEntry, guideCheckEntry, packageManifestEntry, dcoEntry,
  ];
  const failed: string[] = [];
  for (const { name, preamble, outcome } of ordered) {
    for (const line of preamble ?? []) console.log(line);
    for (const result of outcome) {
      const label = outcome.length > 1 || name === "carriers" ? result.check : name;
      if (result.status === "PASS") {
        console.log(`${label}: ok`);
        continue;
      }
      if (result.status === "SKIP") {
        console.log(`${label}: skip ${lastLine(result.detail)}`);
        continue;
      }
      if (result.status === "WARN") {
        console.log(`${label}: warn ${lastLine(result.detail)}`);
        for (const line of (result.notes ?? []).slice(-15)) console.log(`    ${line}`);
        continue;
      }
      failed.push(label);
      const notes = result.notes ?? [];
      const increases = label === "neutrality" ? notes.filter((line) => NEUTRALITY_INCREASE.test(line)) : [];
      const detail = label === "neutrality" && !increases.length ? notes[0] ?? result.detail : result.detail;
      console.log(`${label}: FAIL ${lastLine(detail)}`);
      for (const line of increases.length ? increases : notes.slice(-15)) console.log(`    ${line}`);
    }
  }
  console.log(JSON.stringify({ preflight: "fast", result: failed.length ? "fail" : "pass", head, failed }));
  return failed.length ? 1 : 0;
}

type ForkChanges = { base: string; untrackedPaths: string[]; changes: Change[] };

function readForkChanges(target?: string): ForkChanges | { error: CheckResult } {
  let base: string;
  try {
    base = comparisonBase(target ?? "HEAD");
  } catch (error) {
    return { error: { check: "fork point", status: "FAIL", detail: `${(error as Error).message}; run git fetch origin main and retry preflight` } };
  }
  const untrackedPaths = target ? [] : git(["ls-files", "--others", "--exclude-standard", "-z"], "stdout").split("\0").filter(Boolean);
  const changes = [...parseNameStatus(git(["diff", "--name-status", "--no-renames", "-z", base, ...(target ? [target] : [])], "stdout")), ...untrackedPaths.map((path) => ({ path, deleted: false }))];
  console.log(`preflight: ${changes.length} changed path(s) since fork point ${base.slice(0, 12)} with origin/main${target ? "" : ", including uncommitted files"}`);
  return { base, untrackedPaths, changes };
}

const PROOF_PROFILE = "affected-hosted-invariants-pgtap-v1";
const RERUN_PROOF = "npm run preflight -- --affected";

function comparisonBase(head: string): string {
  return git(["merge-base", head, "origin/main"], "stdout").trim();
}

function cleanWorktree(): boolean {
  return git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], "stdout") === "";
}

function proofDirectory(): string {
  return join(git(["rev-parse", "--absolute-git-dir"], "stdout").trim(), "openlup-preflight");
}

function hookInstallation(install: boolean): number {
  const directory = proofDirectory();
  const hooks = join(directory, "hooks");
  const hook = join(hooks, "pre-push");
  // Git can copy config.worktree when adding a sibling. Only this Git directory activates the include.
  const include = `includeIf.gitdir:${dirname(directory).replace(/[\\*?[]/gu, "\\$&")}.path`;
  const config = join(directory, "hook.config");
  const current = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], "stdout").trim();
  const body = `#!/bin/sh
# Managed by OpenLup preflight.
if ! command -v node >/dev/null || [ ! -f scripts/preflight.ts ]; then
  echo 'pre-push proof: restore Node and scripts/preflight.ts, then run ${RERUN_PROOF}' >&2
  exit 1
fi
exec node --experimental-strip-types scripts/preflight.ts --check-push
`;
  if (!install) {
    if (current !== hooks) throw new Error("this worktree has no managed hook; run npm run preflight -- --install-hook to enable it");
    git(["config", "--worktree", "--fixed-value", "--unset-all", include, config]);
    console.log("pre-push proof: managed hook disabled in this worktree");
    return 0;
  }
  const configured = execute("git", ["config", "--get", "core.hooksPath"]);
  if (current !== hooks && (configured.code !== 1 || (existsSync(current) &&
    readdirSync(current).some((name) => !name.endsWith(".sample") && (statSync(join(current, name)).mode & 0o111) !== 0)))) {
    throw new Error(`existing hooks would be shadowed; keep them and run ${RERUN_PROOF} before pushing`);
  }
  if (existsSync(hook) && (!lstatSync(hook).isFile() || readFileSync(hook, "utf8") !== body)) {
    throw new Error(`managed hook path contains different content; preserve it and run ${RERUN_PROOF} before pushing`);
  }
  const extension = execute("git", ["config", "--local", "--type=bool", "--get", "extensions.worktreeConfig"]);
  if (extension.stdout.trim() !== "true") {
    const worktree = execute("git", ["config", "--get", "core.worktree"]);
    const bare = execute("git", ["config", "--local", "--type=bool", "--get", "core.bare"]);
    if (worktree.code !== 1 || (bare.code !== 1 && bare.stdout.trim() !== "false")) {
      throw new Error(`worktree-specific Git configuration needs manual setup; run ${RERUN_PROOF} before pushing`);
    }
    git(["config", "--local", "extensions.worktreeConfig", "true"]);
  }
  mkdirSync(hooks, { recursive: true });
  if (!existsSync(hook)) writeFileSync(hook, body, { mode: 0o755, flag: "wx" });
  chmodSync(hook, 0o755);
  git(["config", "--file", config, "core.hooksPath", hooks]);
  if (current !== hooks) git(["config", "--worktree", "--add", include, config]);
  console.log(`pre-push proof: managed hook enabled in this worktree; run ${RERUN_PROOF} on the committed head`);
  return 0;
}

function checkPush(input: string): void {
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const [ref, object, remote, oldObject, extra] = line.trim().split(/\s+/u);
    if (!ref || !STACK_BASE_SHA.test(object ?? "") || !remote || !STACK_BASE_SHA.test(oldObject ?? "") || extra) {
      throw new Error("invalid Git pre-push update; retry git push so Git supplies the outgoing refs");
    }
    if (/^0{40}$/u.test(object!)) continue; // A deletion has no outgoing commit.
    const head = git(["rev-parse", "--verify", `${object}^{commit}`], "stdout").trim();
    const base = comparisonBase(head);
    const file = join(proofDirectory(), `${head}.json`);
    if (existsSync(`${file}.running`)) throw new Error(`${ref} at ${head}: proof is incomplete; wait for checks or run ${RERUN_PROOF}`);
    let proof: { profile?: string; base?: string; head?: string; failures?: string[] };
    try {
      proof = JSON.parse(readFileSync(file, "utf8")) ?? {};
    } catch {
      throw new Error(`${ref} at ${head}: missing or stale proof for the outgoing head; check out that head and run ${RERUN_PROOF}`);
    }
    if (proof.head !== head || proof.base !== base || proof.profile !== PROOF_PROFILE) {
      throw new Error(`${ref} at ${head}: stale proof for the outgoing head, comparison base or profile; check out that head and run ${RERUN_PROOF}`);
    }
    if (!Array.isArray(proof.failures) || proof.failures.length) {
      throw new Error(`${ref} at ${head}: proof incomplete or failed (${Array.isArray(proof.failures) ? proof.failures.join(", ") : "checks did not complete"}); run ${RERUN_PROOF}`);
    }
  }
}

type CheckSpec = readonly [string, () => Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[]];

async function executeCheckSpec([name, check]: CheckSpec): Promise<CheckResult[]> {
  try {
    return [await check()].flat();
  } catch (error) {
    return [{ check: name, status: "FAIL", detail: (error as Error).message }];
  }
}

async function runCheckWaves(started: number, waves: ReadonlyArray<{ parallel: boolean; checks: ReadonlyArray<CheckSpec> }>): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const wave of waves) {
    if (wave.parallel) {
      process.stderr.write(`preflight: running ${wave.checks.map(([name]) => name).join(", ")} in parallel\n`);
      const outcomes = await Promise.all(wave.checks.map(executeCheckSpec));
      for (const outcome of outcomes) {
        for (const result of outcome) print(result);
        results.push(...outcome);
      }
    } else {
      for (const spec of wave.checks) {
        process.stderr.write(`preflight: running ${spec[0]}\n`);
        const outcome = await executeCheckSpec(spec);
        for (const result of outcome) print(result);
        results.push(...outcome);
      }
    }
  }
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  console.log(`preflight: ${count("PASS")} PASS, ${count("WARN")} WARN, ${count("SKIP")} SKIP, ${count("FAIL")} FAIL in ${Math.round((Date.now() - started) / 1000)} s`);
  return results;
}

async function areaPreflight(): Promise<number> {
  const started = Date.now();
  const fork = readForkChanges();
  if ("error" in fork) {
    print(fork.error);
    return 1;
  }
  const { changes } = fork;
  const results = await runCheckWaves(started, [{
    parallel: false,
    checks: [
      ["eslint changed", () => eslintChanged(changes)],
      ["migration manifest", () => migrationManifestGuard(changes)],
      ["area guards", () => areaToolingGuards(changes)],
      ["sql admit", () => sqlAdmit(changes)],
    ],
  }]);
  return results.some(({ status }) => status === "FAIL") ? 1 : 0;
}

export async function main(now: Date, args: readonly string[] = []): Promise<number> {
  const hookFlag = args.find((arg) => ["--install-hook", "--uninstall-hook", "--check-push"].includes(arg));
  if (hookFlag) {
    try {
      if (args.length !== 1) throw new Error(`use npm run preflight -- ${hookFlag} on its own`);
      process.chdir(git(["rev-parse", "--show-toplevel"], "stdout").trim());
      if (hookFlag !== "--check-push") return hookInstallation(hookFlag === "--install-hook");
      checkPush(readFileSync(0, "utf8"));
      return 0;
    } catch (error) {
      const detail = (error as Error).message;
      console.error(`pre-push proof: ${detail}${detail.startsWith("git ") ? `; restore the comparison history with git fetch origin main, then run ${RERUN_PROOF}` : ""}`);
      return 1;
    }
  }
  const fast = args.includes("--fast");
  const area = args.includes("--area");
  const proof = args.includes("--affected");
  const legacyAffected = args.includes("--affected-only");
  const affected = proof || legacyAffected;
  if ((proof && legacyAffected) || (legacyAffected && (fast || area))) {
    console.error("preflight: use --affected-only on its own");
    return 2;
  }
  if ((fast && area) || (fast && affected) || (area && affected)) {
    console.error("preflight: --fast, --area, and --affected are mutually exclusive");
    return 2;
  }
  if (fast) {
    const optionalLocks = processEnvironment.GIT_OPTIONAL_LOCKS;
    processEnvironment.GIT_OPTIONAL_LOCKS = "0";
    try {
      process.chdir(git(["rev-parse", "--show-toplevel"], "stdout").trim());
      return await fastPreflight(now);
    } finally {
      if (optionalLocks === undefined) delete processEnvironment.GIT_OPTIONAL_LOCKS;
      else processEnvironment.GIT_OPTIONAL_LOCKS = optionalLocks;
    }
  }
  process.chdir(git(["rev-parse", "--show-toplevel"], "stdout").trim());
  if (area) return await areaPreflight();
  const started = Date.now();
  const head = proof && cleanWorktree() ? git(["rev-parse", "HEAD"], "stdout").trim() : undefined;
  const fork = readForkChanges(head);
  if ("error" in fork) {
    print(fork.error);
    return 1;
  }
  const { base, untrackedPaths, changes } = fork;
  let selection: TestSelection | undefined;
  let typecheckPassed = false;
  const optionalLocks = processEnvironment.GIT_OPTIONAL_LOCKS;
  processEnvironment.GIT_OPTIONAL_LOCKS = "0";
  let lock: string | undefined;
  try {
    const evidence = head ? { head, base, profile: PROOF_PROFILE } : undefined;
    const file = evidence && join(proofDirectory(), `${evidence.head}.json`);
    const save = (failures: string[]) => {
      if (!file || !lock) return;
      const temporary = join(lock, "proof.json");
      writeFileSync(temporary, `${JSON.stringify({ ...evidence, failures })}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    };
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      try {
        mkdirSync(`${file}.running`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(`proof is already running for ${head}. Wait for it, or if it stopped, remove its lock with rm -r -- "${file}.running", then run ${RERUN_PROOF}`);
      }
      lock = `${file}.running`;
      rmSync(file, { force: true });
    }
    const results = await runCheckWaves(started, [
      {
        parallel: true,
        checks: [
          ["ast-grep", () => astGrep()],
          ["ast-grep hygiene", () => astGrepHygiene()],
          ["neutrality", () => neutrality(base)],
          ["fragments", () => fragments(changes)],
          ["settings-candidates", () => settingsCandidateGuard(base, changes, new Set(untrackedPaths), head)],
          ["test lines", () => testLineChecks(changedTestLines(base, changes, new Set(untrackedPaths), head), now)],
          ["gitleaks", () => gitleaks(base, untrackedPaths)],
          ["test discovery", () => { selection = discoverTests(changes, affected, proof); return testDiscoveryVerdict(selection); }],
          ["eslint changed", () => eslintChanged(changes)],
          ["client-secret-boundary", () => runTriggeredGuard(
            "client-secret-boundary", changes, CLIENT_SECRET_BOUNDARY_TRIGGER,
            ["--experimental-strip-types", "scripts/check-client-secret-boundary.ts"],
            "no client-secret-boundary inputs changed",
          )],
          ["site-routes", () => runTriggeredGuard(
            "site-routes", changes, SITE_ROUTES_TRIGGER,
            ["scripts/site-routes.mjs", "--public-reference"],
            "no site route inputs changed",
          )],
          ["migration manifest", () => migrationManifestGuard(changes)],
          ["sql admit", () => sqlAdmit(changes)],
        ],
      },
      {
        parallel: false,
        checks: [
          ["typecheck", async () => { const res = await typecheck(); typecheckPassed = res.status === "PASS"; return res; }],
          ["release-gates headroom", () => releaseGatesHeadroom(changes, typecheckPassed)],
          ["inventory", () => inventory(changes)],
          ["hosted tests", () => hostedTests(selection, proof)],
          ...(proof && changes.some(({ path }) => /\.sql$/iu.test(path)) ? [["pgTAP", pgtap] as const] : []),
        ],
      },
    ]);
    const failures = results.filter(({ status }) => status === "FAIL")
      .map(({ check, detail }) => check === "hosted tests" || check === "pgTAP" ? `${check}: ${detail}` : check);
    if (evidence && (!cleanWorktree() || git(["rev-parse", "HEAD"], "stdout").trim() !== evidence.head || comparisonBase(evidence.head) !== base)) {
      failures.push("head, comparison base or worktree changed during preflight");
    }
    save(failures);
    if (proof && failures.length) console.error(`pre-push proof: ${failures.join("; ")}. Resolve the failures and run ${RERUN_PROOF}`);
    if (proof && !head) console.log(`pre-push proof: commit the intended head and run ${RERUN_PROOF} to record evidence`);
    return failures.length ? 1 : 0;
  } finally {
    if (lock) rmSync(lock, { recursive: true, force: true });
    if (optionalLocks === undefined) delete processEnvironment.GIT_OPTIONAL_LOCKS;
    else processEnvironment.GIT_OPTIONAL_LOCKS = optionalLocks;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(new Date(), process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
