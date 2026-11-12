// Advisory self-checks over the change set since the fork point with origin/main,
// plus uncommitted and untracked files. Not wired into CI or native review; it
// exits non-zero only when a check FAILs. See CONTRIBUTING.md#deliver-a-change.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";

import { INVENTORY_PATH } from "./agent-review-derived.mjs";
import { isChangelogFragment, isChangelogFragmentArea } from "./packages/changelog-fragments.ts";

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

type Outcome = { code: number | null; output: string; missing: boolean; seconds: number };

function execute(command: string, args: readonly string[], options: SpawnSyncOptions = {}): Outcome {
  const started = Date.now();
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32", ...options });
  return {
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    missing: (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

function git(args: readonly string[]): string {
  const result = execute("git", args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.output.trim()}`);
  return result.output;
}

const tail = (output: string, count = 30): string[] => output.split("\n").filter((line) => line.trim()).slice(-count);
const lastLine = (output: string): string => tail(output, 1)[0]?.trim() ?? "";
const findingNotes = (findings: readonly Finding[]): string[] => findings.map(({ path, line, reason, text }) => `${path}:${line}: ${reason}: ${text.trim().slice(0, 120)}`);

function typecheck(): CheckResult {
  // The required typecheck job builds the packages through `npm run lint`'s prelint first.
  const build = execute("npm", ["run", "prelint"]);
  if (build.code !== 0) return { check: "typecheck", status: "FAIL", detail: "package build (npm run prelint) failed", notes: tail(build.output) };
  const result = execute("npm", ["run", "oss:published-tree", "--", "--typecheck"]);
  const detail = `${lastLine(result.output)} (${build.seconds + result.seconds} s)`;
  return result.code === 0 ? { check: "typecheck", status: "PASS", detail } : { check: "typecheck", status: "FAIL", detail, notes: tail(result.output) };
}

function astGrep(): CheckResult {
  const result = execute("npx", ["--no", "--", "ast-grep", "scan", "--error=no-suppress-all", "--error=unused-suppression"]);
  return result.code === 0
    ? { check: "ast-grep", status: "PASS", detail: `no structural rule errors (${result.seconds} s)` }
    : { check: "ast-grep", status: "FAIL", detail: "structural rule errors", notes: tail(result.output) };
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
  if (Number(git(["rev-list", "--count", `${base}..HEAD`]).trim()) > 0) scans.push(["git", ".", ...options, "--log-opts", `${base}..HEAD`]);
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

function rootVitestFiles(candidates: readonly string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "openlup-preflight-"));
  try {
    const listing = join(directory, "files.json");
    const env: NodeJS.ProcessEnv = { ...processEnvironment, VITEST_SKIP_INSTALL_CHECKS: "1" };
    delete env.OPENLUP_VITEST_EXCLUDE_FILE;
    // `--json` takes an optional path, so it goes after the files.
    const result = execute("npx", ["--no", "--", "vitest", "list", ...candidates, "--filesOnly", `--json=${listing}`], { env });
    if (result.code !== 0) throw new Error(`vitest list failed: ${lastLine(result.output)}`);
    let listed: Array<{ file: string }> = [];
    try { listed = JSON.parse(readFileSync(listing, "utf8")) as Array<{ file: string }>; } catch { listed = []; }
    const discovered = new Set(listed.map(({ file }) => relative(process.cwd(), file).split("\\").join("/")));
    return candidates.filter((path) => discovered.has(path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function hostedTests(changes: readonly Change[]): CheckResult {
  const candidates = changes.filter(({ path, deleted }) => !deleted && isTestEntry(path)).map(({ path }) => path);
  if (candidates.length === 0) return { check: "hosted tests", status: "SKIP", detail: "no new or changed test files" };
  const files = rootVitestFiles(candidates);
  const outside = candidates.filter((path) => !files.includes(path));
  const elsewhere = outside.length > 0 ? `; not root Vitest files, run with their own runner: ${outside.join(", ")}` : "";
  if (files.length === 0) return { check: "hosted tests", status: "SKIP", detail: `no changed test file is in the root Vitest inventory${elsewhere}` };
  const result = execute(process.execPath, ["scripts/test-hosted.mjs", ...files]);
  return result.code === 0
    ? { check: "hosted tests", status: "PASS", detail: `${files.length} file(s) passed in hosted parity (${result.seconds} s)${elsewhere}` }
    : { check: "hosted tests", status: "FAIL", detail: `npm run test:hosted -- ${files.join(" ")} exited ${result.code ?? "on a signal"}${elsewhere}`, notes: tail(result.output, 60) };
}

function changedTestLines(base: string, changes: readonly Change[], untracked: ReadonlySet<string>): AddedLine[] | null {
  const files = changes.filter(({ path, deleted }) => !deleted && isTestFile(path)).map(({ path }) => path);
  if (files.length === 0) return null;
  return files.flatMap((path) => untracked.has(path)
    ? readFileSync(path, "utf8").split("\n").map((text, index) => ({ path, line: index + 1, text }))
    : addedLines(path, git(["diff", "-U0", "--no-color", "--no-ext-diff", base, "--", path])));
}

function print(result: CheckResult): void {
  console.log(formatCheckLine(result));
  const notes = result.notes ?? [];
  for (const note of notes.slice(0, 40)) console.log(`    ${note}`);
  if (notes.length > 40) console.log(`    ... ${notes.length - 40} more`);
}

export function main(now: Date): number {
  const started = Date.now();
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
  let base: string;
  try {
    base = git(["merge-base", "HEAD", "origin/main"]).trim();
  } catch (error) {
    print({ check: "fork point", status: "FAIL", detail: `${(error as Error).message}; fetch origin main first` });
    return 1;
  }
  const untrackedPaths = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const changes = [...parseNameStatus(git(["diff", "--name-status", "--no-renames", "-z", base])), ...untrackedPaths.map((path) => ({ path, deleted: false }))];
  console.log(`preflight: ${changes.length} changed path(s) since fork point ${base.slice(0, 12)} with origin/main, including uncommitted files`);
  const checks: Array<[string, () => CheckResult | CheckResult[]]> = [
    ["typecheck", typecheck],
    ["ast-grep", astGrep],
    ["inventory", () => inventory(changes)],
    ["fragments", () => fragments(changes)],
    ["test lines", () => testLineChecks(changedTestLines(base, changes, new Set(untrackedPaths)), now)],
    ["gitleaks", () => gitleaks(base, untrackedPaths)],
    ["hosted tests", () => hostedTests(changes)],
  ];
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(new Date());
