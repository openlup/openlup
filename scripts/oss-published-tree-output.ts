// The materialized output inventory for the published-tree self-checks.
// `scripts/oss-published-tree-check.ts` re-exports every export of this module.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function materializedOutputPaths(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git") return [];
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return materializedOutputPaths(root, path);
    if (!entry.isFile() && !statSync(join(root, path)).isFile()) return [];
    return [path];
  }).sort();
}

export function assertMaterializedOutputInventory(root: string, expectedPaths: Iterable<string>, observedPaths?: Iterable<string>): string[] {
  const actual = [...(observedPaths ?? materializedOutputPaths(root))].sort();
  const expected = [...expectedPaths].sort();
  const missing = expected.filter((path) => !actual.includes(path));
  const extra = actual.filter((path) => !expected.includes(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`materialized output inventory mismatch (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"})`);
  }
  return actual;
}
