import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const DEFAULT_INCREMENTAL_PACKAGES = [
  "packages/core",
  "packages/outbox",
  "packages/platform",
];

export const TSBUILDINFO_FILENAME = ".tsbuildinfo-build";

const EMITTED_CODE_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js", ".mjs", ".cjs"];
const SOURCE_CANDIDATE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

function listFilesRecursive(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function hasMatchingSourceFile(srcDir, relDistPath) {
  if (relDistPath.endsWith(".json")) {
    return existsSync(join(srcDir, relDistPath));
  }
  const matchedSuffix = EMITTED_CODE_SUFFIXES.find((suffix) => relDistPath.endsWith(suffix));
  if (!matchedSuffix) {
    return false;
  }
  const stem = relDistPath.slice(0, -matchedSuffix.length);
  return SOURCE_CANDIDATE_EXTENSIONS.some((ext) => existsSync(join(srcDir, `${stem}${ext}`)));
}

export function hasOrphanDistFiles(packageDir) {
  const srcDir = join(packageDir, "src");
  const distDir = join(packageDir, "dist");
  if (!existsSync(distDir)) return false;
  const distFiles = listFilesRecursive(distDir);
  for (const file of distFiles) {
    const rel = relative(distDir, file).split("\\").join("/");
    if (!hasMatchingSourceFile(srcDir, rel)) {
      return true;
    }
  }
  return false;
}

export function buildPackageIncremental(packageDir, options = {}) {
  const absDir = resolve(packageDir);
  const distDir = join(absDir, "dist");
  const tsbuildinfoPath = join(absDir, TSBUILDINFO_FILENAME);
  const tscBin = options.tscBin ?? require.resolve("typescript/bin/tsc");

  let resetReason = null;
  if (!existsSync(distDir) && existsSync(tsbuildinfoPath)) {
    rmSync(tsbuildinfoPath, { force: true });
    resetReason = "stale-tsbuildinfo";
  } else if (hasOrphanDistFiles(absDir)) {
    rmSync(distDir, { recursive: true, force: true });
    rmSync(tsbuildinfoPath, { force: true });
    resetReason = "orphan-dist";
  }

  execFileSync(
    process.execPath,
    [tscBin, "-p", "tsconfig.build.json", "--incremental", "--tsBuildInfoFile", TSBUILDINFO_FILENAME],
    {
      cwd: absDir,
      stdio: options.stdio ?? "inherit",
    },
  );

  return { packageDir: absDir, resetReason };
}

export function buildPackagesIncremental(options = {}) {
  const rootDir = resolve(options.rootDir ?? join(fileURLToPath(new URL(".", import.meta.url)), ".."));
  const packages = options.packages ?? DEFAULT_INCREMENTAL_PACKAGES;
  const results = [];
  for (const pkg of packages) {
    results.push(buildPackageIncremental(resolve(rootDir, pkg), options));
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPackagesIncremental();
}
