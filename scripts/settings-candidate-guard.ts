import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXED_GIT_PATHS = [
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
] as const;

function resolveFixedGitBinary(): string {
  for (const candidate of FIXED_GIT_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to locate git binary in fixed system directories.");
}

export type SettingsCandidateDiffRunner = (
  args: readonly string[],
  cwd: string,
) => { status: number | null; stdout?: string; stderr?: string };

export type SettingsCandidateFinding = {
  path: string;
  line: number;
  symbol: string;
  domain: string;
  remediation: string;
};

export type SettingsCandidateChange = {
  path: string;
  deleted?: boolean;
};

const PLATFORM_DOMAIN_TS = /^packages\/platform\/src\/([^/]+)\/.+\.ts$/u;
const TEST_TS = /\.test\.ts$/u;
const CANDIDATE_EXPORT =
  /^export\s+const\s+(DEFAULT_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(?:MINUTES|DAYS|HOURS|SECONDS|THRESHOLD|LIMIT|BPS|MINOR))\b/u;
const CANDIDATE_ANNOTATION =
  /\/\/\s*settings-candidate:\s*(?:excluded|planned)\s*\(([^)]+)\)/u;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** True when `path` is a non-test TypeScript source file under `packages/platform/src/<domain>/`. */
export function isSettingsCandidateSourcePath(path: string): boolean {
  return PLATFORM_DOMAIN_TS.test(path) && !TEST_TS.test(path);
}

function domainForPath(path: string): string | undefined {
  if (TEST_TS.test(path)) return undefined;
  return PLATFORM_DOMAIN_TS.exec(path)?.[1];
}

function isCommentLine(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith("//") ||
    trimmedLine.startsWith("/*") ||
    trimmedLine.startsWith("*")
  );
}

function hasValidAnnotationAbove(newLines: ReadonlyMap<number, string>, line: number): boolean {
  for (const offset of [1, 2]) {
    const previous = newLines.get(line - offset);
    if (!previous) continue;
    const match = CANDIDATE_ANNOTATION.exec(previous);
    if (match && match[1].trim().length > 0) return true;
  }
  return false;
}

/**
 * Pure diff analyzer: inspects added lines in a unified diff (`git diff --unified=2 --no-color`)
 * under `packages/platform/src/<domain>/**\/*.ts` (excluding `*.test.ts` and comment lines) and
 * reports newly added exported policy/threshold/window constants that are neither accompanied by
 * `packages/platform/src/<domain>/settings-data.json` in `changedPaths` nor annotated within 2
 * lines above with `// settings-candidate: excluded (<reason>)` or `planned (<ref>)`.
 */
export function findUnaccountedSettingsCandidates(
  diffText: string,
  changedPaths: Iterable<string>,
): SettingsCandidateFinding[] {
  const changed = new Set(changedPaths);
  const findings: SettingsCandidateFinding[] = [];

  let currentPath: string | undefined;
  let currentDomain: string | undefined;
  let currentLine: number | undefined;
  let newLines = new Map<number, string>();

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      currentPath = undefined;
      currentDomain = undefined;
      currentLine = undefined;
      newLines = new Map();
      continue;
    }

    if (currentLine === undefined && raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (target === "/dev/null" || !target.startsWith("b/")) {
        currentPath = undefined;
        currentDomain = undefined;
      } else {
        currentPath = target.slice(2);
        currentDomain = domainForPath(currentPath);
      }
      currentLine = undefined;
      newLines = new Map();
      continue;
    }

    if (!currentPath || !currentDomain) continue;

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      currentLine = Number(hunk[1]);
      newLines = new Map();
      continue;
    }

    if (currentLine === undefined) continue;

    if (raw.startsWith("-")) {
      // Removed lines do not exist in the post-image and do not advance line numbers.
      continue;
    }

    if (raw.startsWith(" ")) {
      newLines.set(currentLine, raw.slice(1));
      currentLine++;
      continue;
    }

    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      const line = currentLine;
      newLines.set(line, text);
      currentLine++;

      const trimmed = text.trimStart();
      if (isCommentLine(trimmed)) continue;

      const match = CANDIDATE_EXPORT.exec(trimmed);
      if (!match) continue;

      const symbol = match[1];
      const settingsDataPath = `packages/platform/src/${currentDomain}/settings-data.json`;
      if (changed.has(settingsDataPath)) continue;
      if (hasValidAnnotationAbove(newLines, line)) continue;

      findings.push({
        path: currentPath,
        line,
        symbol,
        domain: currentDomain,
        remediation:
          `Evaluate ${symbol} against the 5 settings tests (CONTRIBUTING.md#add-a-setting): ` +
          `add it to ${settingsDataPath} (and regenerate the catalogue), or document within 2 lines above ` +
          `with \`// settings-candidate: excluded (<reason>)\` or \`// settings-candidate: planned (<ref>)\`.`,
      });
    }
  }

  return findings;
}

function synthesizeUntrackedDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

/**
 * Runs the settings-candidate guard against tracked diffs (`git diff --unified=2 --no-color`)
 * and untracked `.ts` files under `packages/platform/src/<domain>/`.
 */
export function checkSettingsCandidates(
  root: string,
  base: string,
  changes: readonly SettingsCandidateChange[],
  options: {
    target?: string;
    untracked?: ReadonlySet<string>;
    runDiff?: SettingsCandidateDiffRunner;
  } = {},
): SettingsCandidateFinding[] {
  const untracked = options.untracked ?? new Set<string>();
  const changedPaths = changes.filter(({ deleted }) => !deleted).map(({ path }) => path);
  const eligible = changedPaths.filter((path) => isSettingsCandidateSourcePath(path));
  if (eligible.length === 0) return [];

  const trackedEligible = eligible.filter((path) => !untracked.has(path));
  const untrackedEligible = eligible.filter((path) => untracked.has(path));

  const diffChunks: string[] = [];

  if (trackedEligible.length > 0) {
    const range = options.target ? [base, options.target] : [base];
    const diffArgs = [
      "diff",
      "--unified=2",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...range,
      "--",
      ...trackedEligible,
    ];
    const result = options.runDiff
      ? options.runDiff(diffArgs, root)
      : spawnSync(resolveFixedGitBinary(), diffArgs, {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        });
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      throw new Error(`git diff for settings-candidate-guard failed: ${detail}`);
    }
    if (result.stdout) diffChunks.push(result.stdout);
  }

  for (const path of untrackedEligible) {
    const content = readFileSync(join(root, path), "utf8");
    diffChunks.push(synthesizeUntrackedDiff(path, content));
  }

  return findUnaccountedSettingsCandidates(diffChunks.join("\n"), changedPaths);
}
