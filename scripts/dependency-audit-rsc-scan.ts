import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

// The reachability half of the dependency-audit gate: it does not read audit
// JSON at all, it greps the tracked working tree for the tokens that would mean
// a forbidden surface has become reachable. Kept beside the policy rather than
// inside it so the evaluator stays about findings and this stays about files.

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

export function findRscHitsInEntries(
  entries: Array<{ path: string; content: string }>,
  forbiddenTokens: string[],
  excludedPaths: string[],
): string[] {
  const excluded = new Set(excludedPaths);
  const hits: string[] = [];
  for (const entry of entries) {
    if (excluded.has(entry.path)) continue;
    for (const token of forbiddenTokens) {
      if (entry.content.includes(token)) hits.push(`${entry.path}:${token}`);
    }
  }
  return hits.sort();
}

export function findRscHits(
  repoRoot: string,
  forbiddenTokens: string[],
  excludedPaths: string[],
): string[] {
  const textExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
  const entries: Array<{ path: string; content: string }> = [];
  for (const path of trackedFiles()) {
    if (!textExtensions.has(extname(path)) && path !== "package.json") continue;
    entries.push({ path, content: readFileSync(resolve(repoRoot, path), "utf8") });
  }
  return findRscHitsInEntries(entries, forbiddenTokens, excludedPaths);
}
