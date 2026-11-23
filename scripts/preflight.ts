// Local checks before review. The default checks the change since the fork
// point plus working-tree edits; --fast runs the cheap readiness gate;
// --area runs ESLint, Docker-free area tooling guards, and SQL admission.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";

import { INVENTORY_PATH } from "./agent-review-derived.mjs";
import { carrierLocale, carrierNpmCli, carrierPlan, describeCarrierToolchain, readReportOwners } from "./agent-review-landing.mjs";
import { TOOLING_INPUTS, excludedToolingTests } from "./ci-test-scope.mjs";
import { readCommits, signOffVerdict } from "./dco-signoff-check.ts";
import { isChangelogFragment, isChangelogFragmentArea } from "./packages/changelog-fragments.ts";
import { checkPlatformMigrationProjection } from "./packages/platform-migration-projection.ts";
import { checkSettingsCandidates, isSettingsCandidateSourcePath } from "./settings-candidate-guard.ts";

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

function npmVersionForToolchain(npmCli: string, options: SpawnSyncOptions): string {
  try {
    const version = execute(process.execPath, [npmCli, "--version"], { ...options, timeout: 5_000 });
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

function typecheck(): CheckResult {
  // The required typecheck job builds the packages through `npm run lint`'s prelint first.
  const build = execute("npm", ["run", "prelint"]);
  if (build.code !== 0) return { check: "typecheck", status: "FAIL", detail: "package build (npm run prelint) failed", notes: tail(build.output) };
  const result = execute("npm", ["run", "oss:published-tree", "--", "--typecheck"]);
  const detail = `${lastLine(result.output)} (${build.seconds + result.seconds} s)`;
  return result.code === 0 ? { check: "typecheck", status: "PASS", detail } : { check: "typecheck", status: "FAIL", detail, notes: tail(result.output) };
}

function astGrep(options?: SpawnSyncOptions): CheckResult {
  const result = execute("npx", ["--no", "--", "ast-grep", "scan", "--error=no-suppress-all", "--error=unused-suppression"], options);
  return result.code === 0
    ? { check: "ast-grep", status: "PASS", detail: `no structural rule errors (${result.seconds} s)` }
    : { check: "ast-grep", status: "FAIL", detail: "structural rule errors", notes: tail(result.output) };
}

function astGrepHygiene(options?: SpawnSyncOptions): CheckResult {
  const filewide = execute(process.execPath, ["scripts/ast-grep/check-filewide-ignore.mjs"]);
  if (filewide.code !== 0) {
    return { check: "ast-grep hygiene", status: "FAIL", detail: `file-wide ast-grep-ignore check failed (${filewide.seconds} s)`, notes: tail(filewide.output) };
  }
  const tests = execute("npx", ["--no", "--", "ast-grep", "test", "--skip-snapshot-tests"], options);
  const seconds = filewide.seconds + tests.seconds;
  return tests.code === 0
    ? { check: "ast-grep hygiene", status: "PASS", detail: `no file-wide ignores and rule tests pass (${seconds} s)` }
    : { check: "ast-grep hygiene", status: "FAIL", detail: `ast-grep rule tests failed (${seconds} s)`, notes: tail(tests.output) };
}

function eslintChanged(changes: readonly Change[]): CheckResult {
  const files = changes.filter(({ path, deleted }) => !deleted && SCRIPT.test(path)).map(({ path }) => path);
  if (files.length === 0) return { check: "eslint changed", status: "SKIP", detail: "no changed JS/TS files" };
  const result = execute("npx", ["--no", "--", "eslint", "--", ...files]);
  return result.code === 0
    ? { check: "eslint changed", status: "PASS", detail: `${files.length} changed file(s) passed eslint (${result.seconds} s)` }
    : { check: "eslint changed", status: "FAIL", detail: `eslint failed on ${files.length} changed file(s)`, notes: tail(result.output) };
}

function sqlAdmit(changes: readonly Change[]): CheckResult {
  const triggers = sqlTreeChanges(changes);
  if (triggers.length === 0) return { check: "sql admit", status: "SKIP", detail: "no SQL under db/ or packages/*/sql/ changed" };
  if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], "stdout") !== "") {
    return { check: "sql admit", status: "WARN", detail: "commit or stash uncommitted changes to run npm run sql:admit" };
  }
  const result = execute("npm", ["run", "sql:admit"]);
  return result.code === 0
    ? { check: "sql admit", status: "PASS", detail: `SQL admission passed (${result.seconds} s)` }
    : { check: "sql admit", status: "FAIL", detail: `npm run sql:admit exited ${result.code ?? "on a signal"}`, notes: tail(result.output) };
}

function inventory(changes: readonly Change[]): CheckResult {
  const triggers = sqlTreeChanges(changes);
  if (triggers.length === 0) return { check: "inventory", status: "SKIP", detail: "no SQL under db/ or packages/*/sql/ changed" };
  if (execute("docker", ["info"], { timeout: 30_000 }).code !== 0) {
    return { check: "inventory", status: "WARN", detail: `${triggers.length} SQL file(s) changed but Docker is unavailable; run npm run inventory:refresh with Docker and commit ${INVENTORY_PATH}` };
  }
  // inventory:refresh has no check mode: it rewrites the file's `current` section.
  const before = readFileSync(INVENTORY_PATH, "utf8");
  const result = execute("npm", ["run", "inventory:refresh"]);
  if (result.code !== 0) return { check: "inventory", status: "FAIL", detail: "npm run inventory:refresh failed", notes: tail(result.output) };
  if (readFileSync(INVENTORY_PATH, "utf8") !== before) {
    return { check: "inventory", status: "FAIL", detail: `refresh rewrote ${INVENTORY_PATH} and left it in the working tree; review it with git diff and commit it (${result.seconds} s)` };
  }
  if (git(["status", "--porcelain", "--", INVENTORY_PATH]).trim()) {
    return { check: "inventory", status: "WARN", detail: `${INVENTORY_PATH} matches the measured installations but is not committed (${result.seconds} s)` };
  }
  return { check: "inventory", status: "PASS", detail: `${INVENTORY_PATH} matches the measured installations (${result.seconds} s)` };
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

function gitleaks(base: string, untracked: readonly string[]): CheckResult {
  if (execute("gitleaks", ["version"]).missing) return { check: "gitleaks", status: "SKIP", detail: "gitleaks is not on PATH; the required gitleaks job still scans the pull request" };
  const options = ["--config", "config/gitleaks.toml", "--gitleaks-ignore-path", ".gitleaksignore", "--redact", "--no-banner", "--no-color"];
  const scans: string[][] = [];
  if (Number(git(["rev-list", "--count", `${base}..HEAD`], "stdout").trim()) > 0) scans.push(["git", ".", ...options, "--log-opts", `${base}..HEAD`]);
  scans.push(["git", ".", ...options, "--pre-commit", "--staged"], ["git", ".", ...options, "--pre-commit"]);
  for (const path of untracked) scans.push(["dir", path, ...options]);
  let seconds = 0;
  for (const scan of scans) {
    const result = execute("gitleaks", scan);
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

function discoverTests(changes: readonly Change[]): TestSelection {
  const candidates = changes.filter(({ path, deleted }) => !deleted && isTestEntry(path)).map(({ path }) => path);
  if (candidates.length === 0) return { files: [], separate: [], unknown: [] };
  const files = vitestFiles(candidates);
  const outside = candidates.filter((path) => !files.includes(path));
  const separate = outside.length > 0 ? separateTestFiles(outside) : [];
  return { files, separate, unknown: outside.filter((path) => !separate.some((entry) => entry.path === path)) };
}

function hostedTests(selection: TestSelection | undefined): CheckResult {
  if (!selection) return { check: "hosted tests", status: "FAIL", detail: "test discovery failed; restore discovery before running changed root tests" };
  const { files } = selection;
  if (files.length === 0) return { check: "hosted tests", status: "SKIP", detail: "no changed root Vitest file; see test discovery for separate runners and missing proof" };
  const result = execute(process.execPath, ["scripts/test-hosted.mjs", ...files]);
  return result.code === 0
    ? { check: "hosted tests", status: "PASS", detail: `${files.length} file(s) passed in hosted parity (${result.seconds} s)` }
    : { check: "hosted tests", status: "FAIL", detail: `npm run test:hosted -- ${files.join(" ")} exited ${result.code ?? "on a signal"}`, notes: tail(result.output, 60) };
}

function neutrality(base: string): CheckResult {
  // The required self-check job's tree-wide ratchet; it scans the working tree, untracked files included.
  const result = execute(process.execPath, ["scripts/public-ci-neutrality.mjs", "--base-commit", base]);
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

const AREA_EXCLUDED_TESTS = new Set([
  "scripts/packages/outbox-consumer-proof.test.ts",
  "scripts/packages/distribution-cli-proof.test.ts",
  "scripts/packages/distribution-cli-settings.test.ts",
  "scripts/packages/platform-cold-consumer.test.ts",
  "scripts/packages/reference-delegation-consumer.test.ts",
]);
const CATALOG_BOUNDARY_TEST = "scripts/catalog-document-boundary.test.ts";
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

function areaToolingGuards(changes: readonly Change[]): CheckResult {
  const files = areaGuardTests([...new Set(changes.map(({ path }) => path))]);
  if (files.length === 0) return { check: "area guards", status: "SKIP", detail: "no area tooling guard tests triggered" };
  const result = execute(process.execPath, ["scripts/test-hosted.mjs", ...files]);
  return result.code === 0
    ? { check: "area guards", status: "PASS", detail: `${files.length} area guard file(s) passed in hosted parity (${result.seconds} s)` }
    : { check: "area guards", status: "FAIL", detail: `npm run test:hosted -- ${files.join(" ")} exited ${result.code ?? "on a signal"}`, notes: tail(result.output, 60) };
}

function fastPreflight(now: Date): number {
  const head = git(["rev-parse", "HEAD"], "stdout").trim();
  if (execute("git", ["fetch", "origin", "main"], { timeout: 5_000 }).code !== 0) {
    console.error("preflight: git fetch origin main failed. Using local origin/main.");
  }
  const offlineNpm = { env: { ...processEnvironment, ...carrierLocale, npm_config_offline: "true", npm_config_update_notifier: "false" } };
  const npmInvocation = "preflight -- --fast";
  const command = (check: string, bin: string, args: string[], options?: SpawnSyncOptions): CheckResult => {
    const { code, output } = execute(bin, args, options);
    return { check, status: code === 0 ? "PASS" : "FAIL", detail: lastLine(output) || `${bin} did not complete successfully`,
      notes: code === 0 ? undefined : tail(output) };
  };
  let fork: string | undefined;
  const forkPoint = (): string => (fork ??= git(["merge-base", "HEAD", "origin/main"], "stdout").trim());
  let cachedChanges: Change[] | undefined;
  const fastChanges = (): Change[] => (cachedChanges ??= parseNameStatus(git(["diff", "--name-status", "--no-renames", "-z", forkPoint(), "HEAD"], "stdout")));
  let clean = false;
  const checkCarrier = (check: string, bin: string, args: string[], remedy?: string): CheckResult => {
    const result = command(check, bin, args, offlineNpm);
    if (result.status === "FAIL") {
      const message = result.notes?.find(line => line.startsWith("Error: "))?.slice("Error: ".length) ?? result.detail;
      result.detail = remedy ? `${message}. ${remedy}` : message;
    }
    return result;
  };
  const carrierChecks = (): CheckResult[] => {
    if (!clean) return [{ check: "carriers", status: "SKIP", detail: "clean committed checkout required" }];
    const { builds, reports, settings } = carrierPlan(readReportOwners(process.cwd()), fastChanges().map(({ path }) => path));
    if (!builds.length) return [{ check: "carriers", status: "SKIP", detail: "no report or settings inputs changed" }];
    const buildDirectories = JSON.stringify(builds.map(({ directory }: { directory: string }) => directory));
    const prerequisites = checkCarrier("carrier prerequisites", process.execPath, ["--input-type=module", "-e",
      `import { assertCarrierBuildOutputs, assertCarrierToolchain } from './scripts/agent-review-landing.mjs';
        await assertCarrierBuildOutputs(process.cwd(), ${buildDirectories});
        assertCarrierToolchain(process.cwd(), ${JSON.stringify(npmInvocation)});`],
    "Use the required Node and npm majors and run npm ci in this checkout.");
    const results = [prerequisites];
    if (prerequisites.status === "FAIL") return results;
    const npmCli = carrierNpmCli(npmInvocation);
    for (const { name } of builds) {
      const build = checkCarrier(`carrier build ${name}`, process.execPath, [npmCli, "run", "build", `--workspace=${name}`], "Fix the workspace build before checking carrier bytes.");
      results.push(build);
      if (build.status === "FAIL") return results;
    }
    for (const { name } of reports) results.push(checkCarrier(`api:check ${name}`, process.execPath, [npmCli, "run", "api:check", `--workspace=${name}`]));
    if (settings) results.push(checkCarrier("settings-catalogue", process.execPath, ["scripts/settings-catalogue.ts"], "Run node scripts/settings-catalogue.ts --write."));
    return results;
  };
  const checks: Array<[string, () => CheckResult | CheckResult[]]> = [
    ["clean", () => {
      clean = !git(["status", "--porcelain", "--untracked-files=all"], "stdout").trim();
      return { check: "clean", status: clean ? "PASS" : "FAIL", detail: "worktree has uncommitted changes. Commit or remove them." };
    }],
    ["merge-clean", () => {
      const stackBase = processEnvironment.OPENLUP_STACK_BASE;
      if (stackBase !== undefined && STACK_BASE_SHA.test(stackBase)
        && execute("git", ["merge-base", "--is-ancestor", stackBase, "HEAD"]).code === 0
        && execute("git", ["merge-base", "--is-ancestor", stackBase, "origin/main"]).code === 1) {
        return { check: "merge-clean", status: "SKIP", detail: "unlanded OPENLUP_STACK_BASE; merge-tree skipped" };
      }
      return command("merge-clean", "git", ["merge-tree", "--write-tree", "origin/main", "HEAD"]);
    }],
    ["neutrality", () => neutrality(forkPoint())],
    ["ui-neutrality", () => command("ui-neutrality", process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts"])],
    ["ast-grep", () => astGrep(offlineNpm)],
    ["ast-grep-hygiene", () => astGrepHygiene(offlineNpm)],
    ["publication", () => {
      let npmCli: string;
      let npmVersion = "unavailable (npm CLI path missing or relative)";
      try {
        npmCli = carrierNpmCli(npmInvocation);
        npmVersion = npmVersionForToolchain(npmCli, offlineNpm);
      } finally {
        console.log(describeCarrierToolchain(npmVersion));
      }
      const result = command("publication", process.execPath, [npmCli, "run", "oss:published-tree", "--", "--self-check",
        ...(processEnvironment.OPENLUP_STACK_BASE !== undefined ? [] : ["--docs-base", forkPoint()]),
      ], offlineNpm);
      const missing = result.notes?.find(line => /materialized output inventory mismatch .*; extra (?!none\))/u.test(line));
      if (missing) result.detail = `${missing}. Add the reviewed classification in config/openlup-publication-catalog.json.`;
      return result;
    }],
    ["carriers", carrierChecks],
    ["migration projection", () => {
      if (!clean) return { check: "migration projection", status: "SKIP", detail: "clean committed checkout required" };
      const errors = checkPlatformMigrationProjection(process.cwd());
      return { check: "migration projection", status: errors.length ? "FAIL" : "PASS", detail: errors[0] ?? "fresh", notes: errors };
    }],
    ["fragments", () => fragments(fastChanges())],
    ["settings-candidates", () => settingsCandidateGuard(forkPoint(), fastChanges(), new Set(), "HEAD")],
    ["test-lines", () => testLineChecks(changedTestLines(forkPoint(), fastChanges(), new Set(), "HEAD"), now)],
    ["gitleaks", () => gitleaks(forkPoint(), [])],
    ["guide-check", () => fastChanges().some(({ path }) => GUIDE_TRIGGER.test(path))
      ? command("guide-check", process.execPath, ["--experimental-strip-types", "packages/core/scripts/documentation-contract.ts", "--check-guide", "packages/core"], offlineNpm)
      : { check: "guide-check", status: "SKIP", detail: "no guide or rule files changed" }],
    ["package-manifest", () => fastChanges().some(({ path }) => PACKAGE_MANIFEST_TRIGGER.test(path))
      ? command("package-manifest", "npm", ["run", "packages:check", "--", "--manifest-only"], offlineNpm)
      : { check: "package-manifest", status: "SKIP", detail: "no package manifests or config/openlup-packages.json changed" }],
    ["dco", () => {
      const upstream = git(["rev-parse", "origin/main"], "stdout").trim();
      const commits = readCommits(process.cwd(), upstream, head);
      const { missing } = signOffVerdict(commits);
      return { check: "dco", status: missing.length ? "FAIL" : "PASS",
        detail: `missing Signed-off-by on ${missing.map(({ sha }) => sha.slice(0, 12)).join(", ")}` };
    }],
  ];
  const failed: string[] = [];
  for (const [name, check] of checks) {
    let outcome: CheckResult[];
    try {
      outcome = [check()].flat();
    } catch (error) {
      const detail = (error as Error).message;
      outcome = [{ check: name, status: "FAIL", detail, notes: tail(detail) }];
    }
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

function readForkChanges(): ForkChanges | { error: CheckResult } {
  let base: string;
  try {
    base = git(["merge-base", "HEAD", "origin/main"], "stdout").trim();
  } catch (error) {
    return { error: { check: "fork point", status: "FAIL", detail: `${(error as Error).message}; fetch origin main first` } };
  }
  const untrackedPaths = git(["ls-files", "--others", "--exclude-standard", "-z"], "stdout").split("\0").filter(Boolean);
  const changes = [...parseNameStatus(git(["diff", "--name-status", "--no-renames", "-z", base], "stdout")), ...untrackedPaths.map((path) => ({ path, deleted: false }))];
  console.log(`preflight: ${changes.length} changed path(s) since fork point ${base.slice(0, 12)} with origin/main, including uncommitted files`);
  return { base, untrackedPaths, changes };
}

function runChecks(started: number, checks: ReadonlyArray<readonly [string, () => CheckResult | CheckResult[]]>): number {
  const results: CheckResult[] = [];
  for (const [name, check] of checks) {
    process.stderr.write(`preflight: running ${name}\n`);
    let outcome: CheckResult[];
    try {
      outcome = [check()].flat();
    } catch (error) {
      outcome = [{ check: name, status: "FAIL", detail: (error as Error).message }];
    }
    for (const result of outcome) print(result);
    results.push(...outcome);
  }
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  console.log(`preflight: ${count("PASS")} PASS, ${count("WARN")} WARN, ${count("SKIP")} SKIP, ${count("FAIL")} FAIL in ${Math.round((Date.now() - started) / 1000)} s`);
  return count("FAIL") > 0 ? 1 : 0;
}

function areaPreflight(): number {
  const started = Date.now();
  const fork = readForkChanges();
  if ("error" in fork) {
    print(fork.error);
    return 1;
  }
  const { changes } = fork;
  return runChecks(started, [
    ["eslint changed", () => eslintChanged(changes)],
    ["area guards", () => areaToolingGuards(changes)],
    ["sql admit", () => sqlAdmit(changes)],
  ]);
}

export function main(now: Date, args: readonly string[] = []): number {
  const fast = args.includes("--fast");
  const area = args.includes("--area");
  if (fast && area) {
    console.error("preflight: --fast and --area are mutually exclusive");
    return 2;
  }
  if (fast) {
    const optionalLocks = processEnvironment.GIT_OPTIONAL_LOCKS;
    processEnvironment.GIT_OPTIONAL_LOCKS = "0";
    try {
      process.chdir(git(["rev-parse", "--show-toplevel"], "stdout").trim());
      return fastPreflight(now);
    } finally {
      if (optionalLocks === undefined) delete processEnvironment.GIT_OPTIONAL_LOCKS;
      else processEnvironment.GIT_OPTIONAL_LOCKS = optionalLocks;
    }
  }
  process.chdir(git(["rev-parse", "--show-toplevel"], "stdout").trim());
  if (area) return areaPreflight();
  const started = Date.now();
  const fork = readForkChanges();
  if ("error" in fork) {
    print(fork.error);
    return 1;
  }
  const { base, untrackedPaths, changes } = fork;
  let selection: TestSelection | undefined;
  return runChecks(started, [
    ["ast-grep", astGrep],
    ["ast-grep hygiene", () => astGrepHygiene()],
    ["neutrality", () => neutrality(base)],
    ["fragments", () => fragments(changes)],
    ["settings-candidates", () => settingsCandidateGuard(base, changes, new Set(untrackedPaths))],
    ["test lines", () => testLineChecks(changedTestLines(base, changes, new Set(untrackedPaths)), now)],
    ["gitleaks", () => gitleaks(base, untrackedPaths)],
    ["test discovery", () => { selection = discoverTests(changes); return testDiscoveryVerdict(selection); }],
    ["eslint changed", () => eslintChanged(changes)],
    ["sql admit", () => sqlAdmit(changes)],
    ["typecheck", typecheck],
    ["inventory", () => inventory(changes)],
    ["hosted tests", () => hostedTests(selection)],
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(new Date(), process.argv.slice(2));
