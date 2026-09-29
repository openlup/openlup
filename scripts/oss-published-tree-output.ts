// Materialized output helpers for the published-tree self-checks: the output inventory, its bytes
// and the materialized catalogue.
// `scripts/oss-published-tree-check.ts` re-exports every export of this module.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertExplicitPublicProjectionWrites, type ProjectionWrite } from "./oss-publication-contract.ts";
import { createPublicPublicationCatalog, parsePublicPublicationCatalog } from "./oss-publication-policy.ts";

export type MaterializedOutputBytesInput = { sourceRoot: string; publicRoot: string; copiedSourcePaths: Iterable<string>; flattenedOutput: { path: string; contents: string | Buffer }; projectionWrites: Iterable<ProjectionWrite>; additionalProjectionPaths?: Iterable<string> };

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

export function assertMaterializedOutputBytes(input: MaterializedOutputBytesInput): void {
  const expected = new Map<string, Buffer>();
  for (const path of input.copiedSourcePaths) expected.set(path, readFileSync(join(input.sourceRoot, path)));
  if (expected.has(input.flattenedOutput.path)) throw new Error(`materialized output duplicates flattened path ${input.flattenedOutput.path}`);
  expected.set(input.flattenedOutput.path, Buffer.from(input.flattenedOutput.contents));
  const writes = [...input.projectionWrites];
  assertExplicitPublicProjectionWrites(writes, input.additionalProjectionPaths);
  for (const write of writes) expected.set(write.path, Buffer.from(write.contents));
  for (const [path, contents] of expected) {
    if (!existsSync(join(input.publicRoot, path)) || !readFileSync(join(input.publicRoot, path)).equals(contents)) {
      throw new Error(`materialized output bytes diverge at ${path}`);
    }
  }
}

export function materializePublicPublicationCatalog(outputPaths: Iterable<string>, seedSource: string) {
  const seed = parsePublicPublicationCatalog(seedSource);
  const classes = new Map(seed.publicPaths.map((row) => [row.path, row.class]));
  const paths = [...outputPaths];
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error("materialized publication catalogue requires a sorted, unique output inventory");
  }
  return createPublicPublicationCatalog(
    paths.map((path) => ({ path, class: classes.get(path) ?? "public-output" })),
    seed.guardViability,
  );
}
