import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repoRoot = process.cwd();
const manifestPath = "config/backend-db-boundary-legacy-allowlist.json";

const PATTERNS = {
  supabaseImport: /from\s+["']@supabase\/supabase-js["']/g,
  createClient: /\bcreateClient(?:\s*<[^>]+>)?\s*\(/g,
  dbChain: /\.(?:from|rpc)\s*\(|\.storage\b/g,
  functionsInvoke: /\.functions\s*\.\s*invoke\s*\(/g,
} as const;

type PatternKey = keyof typeof PATTERNS;
type Counts = Record<PatternKey, number>;

interface LegacyBackendDbBoundaryEntry {
  path: string;
  owner: string;
  plannedWave: string;
  counts: Counts;
  reason: string;
}

interface LegacyBackendDbBoundaryManifest {
  schemaVersion: number;
  scannedRoots: string[];
  entries: LegacyBackendDbBoundaryEntry[];
}

function readManifest(): LegacyBackendDbBoundaryManifest {
  return JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8")) as LegacyBackendDbBoundaryManifest;
}

function readFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return readFiles(full);
    return [full];
  });
}

function rel(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}

function runtimeFiles(roots: string[]): string[] {
  return roots
    .flatMap((root) => readFiles(join(repoRoot, root)))
    .map(rel)
    .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
    .filter((file) => !/\.(test|spec)\./.test(file))
    .sort();
}

function countPatterns(source: string): Counts {
  return Object.fromEntries(
    Object.entries(PATTERNS).map(([key, pattern]) => [key, (source.match(pattern) ?? []).length]),
  ) as Counts;
}

function total(counts: Counts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

describe("backend DB boundary", () => {
  it("counts typed and untyped Supabase client construction", () => {
    expect("createClient(url, key)".match(PATTERNS.createClient)?.length).toBe(1);
    expect("createClient<Database>(url, key)".match(PATTERNS.createClient)?.length).toBe(1);
  });

  it("keeps new BFF and cron Supabase access behind the legacy ratchet allowlist", () => {
    const manifest = readManifest();
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const duplicates = manifest.entries
      .map((entry) => entry.path)
      .filter((path, index, all) => all.indexOf(path) !== index);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.scannedRoots).toEqual(["api/_cron", "api/cron", "server/bff"]);
    expect(duplicates).toEqual([]);

    const missingMetadata = manifest.entries.filter(
      (entry) =>
        !entry.owner ||
        !["wave-2-bff-gateway", "wave-3-cron-gateway"].includes(entry.plannedWave) ||
        !entry.reason,
    );
    expect(missingMetadata).toEqual([]);

    const observed = runtimeFiles(manifest.scannedRoots)
      .map((file) => ({ file, counts: countPatterns(readFileSync(join(repoRoot, file), "utf8")) }))
      .filter(({ counts }) => total(counts) > 0);

    const unexpectedFiles = observed
      .filter(({ file }) => !byPath.has(file))
      .map(({ file, counts }) => ({ file, counts }));
    expect(unexpectedFiles).toEqual([]);

    const increasedCounts = observed.flatMap(({ file, counts }) => {
      const allowed = byPath.get(file)?.counts;
      if (!allowed) return [];
      return (Object.keys(PATTERNS) as PatternKey[])
        .filter((key) => counts[key] > allowed[key])
        .map((key) => ({ file, key, actual: counts[key], allowed: allowed[key] }));
    });
    expect(increasedCounts).toEqual([]);

    const staleEntries = manifest.entries
      .filter((entry) => !existsSync(join(repoRoot, entry.path)))
      .map((entry) => entry.path);
    expect(staleEntries).toEqual([]);

    const clearedEntries = manifest.entries
      .map((entry) => ({ entry, counts: countPatterns(readFileSync(join(repoRoot, entry.path), "utf8")) }))
      .filter(({ counts }) => total(counts) === 0)
      .map(({ entry }) => entry.path);
    expect(clearedEntries).toEqual([]);
  });
});
