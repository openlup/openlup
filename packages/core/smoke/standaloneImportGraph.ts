import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const monorepoPackagePrefix = "packages/core/";
const standaloneSourcePrefixes = ["smoke/", "src/"];
const allowedBareSpecifiers = new Set(["vitest", "zod"]);
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name?: unknown;
  exports?: Record<string, unknown>;
};
const packageSelfName = typeof packageJson.name === "string" ? packageJson.name : "@openlup/core";

function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:type\s+)?[^"']+\s+from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs];
}

export function repoRel(file: string): string {
  return relative(packageRoot, file).split(sep).join("/");
}

function resolveEntrypoint(entry: string): string {
  const normalized = entry.split(sep).join("/");
  const packageRel = normalized.startsWith(monorepoPackagePrefix)
    ? normalized.slice(monorepoPackagePrefix.length)
    : normalized;
  return join(packageRoot, packageRel);
}

function isStandaloneSource(file: string): boolean {
  const rel = repoRel(file);
  return !rel.startsWith("../") && standaloneSourcePrefixes.some((prefix) => rel.startsWith(prefix));
}

function isAllowedBareSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || allowedBareSpecifiers.has(specifier);
}

function resolvePackageSelfFile(specifier: string): string | null {
  const subpath = specifier === packageSelfName
    ? "."
    : specifier.startsWith(`${packageSelfName}/`)
      ? `./${specifier.slice(packageSelfName.length + 1)}`
      : null;
  if (!subpath) return null;

  const entry = packageJson.exports?.[subpath];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const sourcePath = (entry as Record<string, unknown>)["core-source"];
  return typeof sourcePath === "string"
    ? join(packageRoot, sourcePath.replace(/^\.\//, ""))
    : null;
}

function resolveSourceFile(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const absolute = resolve(dirname(importer), specifier);
  const candidates = [
    absolute,
    absolute.replace(/\.js$/, ".ts"),
    absolute.replace(/\.js$/, ".tsx"),
    `${absolute}.ts`,
    `${absolute}.tsx`,
    join(absolute, "index.ts"),
    join(absolute, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function packageSmokeFiles(): string[] {
  return readPackageTsFiles(join(packageRoot, "smoke"));
}

export function packageSourceFiles(): string[] {
  return readPackageTsFiles(join(packageRoot, "src"));
}

function readPackageTsFiles(dir: string): string[] {
  function readFiles(currentDir: string): string[] {
    return readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(currentDir, entry.name);
      if (entry.isDirectory()) return readFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  }
  return readFiles(dir);
}

function readGraphSource(file: string, overrides: ReadonlyMap<string, string>): string {
  return overrides.get(file) ?? readFileSync(file, "utf8");
}

export function inspectStandaloneGraph(
  entryRelPaths: string[],
  sourceOverrides: ReadonlyMap<string, string> = new Map(),
): { files: string[]; violations: string[] } {
  const queue = entryRelPaths.map(resolveEntrypoint);
  const seen = new Set<string>();
  const violations: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const rel = repoRel(file);
    if (!isStandaloneSource(file)) {
      violations.push(`${rel}: outside standalone graph allowlist`);
      continue;
    }

    const source = readGraphSource(file, sourceOverrides);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        const resolved = resolvePackageSelfFile(specifier);
        if (resolved) {
          queue.push(resolved);
          continue;
        }
        if (!isAllowedBareSpecifier(specifier)) violations.push(`${rel} imports disallowed bare specifier ${specifier}`);
        continue;
      }

      const resolved = resolveSourceFile(file, specifier);
      if (!resolved) {
        violations.push(`${rel} imports unresolved specifier ${specifier}`);
        continue;
      }
      if (isStandaloneSource(resolved)) {
        queue.push(resolved);
      } else {
        violations.push(`${rel} imports outside standalone graph ${specifier} -> ${repoRel(resolved)}`);
      }
    }
  }
  return { files: [...seen].filter((file) => isStandaloneSource(file)).sort(), violations };
}
