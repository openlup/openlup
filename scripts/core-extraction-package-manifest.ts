import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assert } from "./core-extraction-command.ts";

type DependencyMap = Record<string, string>;
type ExportEntry = Record<string, string>;

export type CorePackageJson = {
  name: string;
  version?: string;
  license?: string;
  engines?: Record<string, string>;
  packageManager?: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  exports: Record<string, ExportEntry>;
};

type PackageLock = {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      name?: string;
      version?: string;
      resolved?: string;
      link?: boolean;
      dependencies?: DependencyMap;
      devDependencies?: DependencyMap;
      peerDependencies?: DependencyMap;
    }
  >;
};

export function assertPackageManifest(packageRoot: string): CorePackageJson {
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as CorePackageJson;
  assert(
    packageJson.name === "@openlup/core",
    "split-root package name drifted",
  );
  assert(
    packageJson.license === "Apache-2.0",
    "split-root package must carry Apache-2.0 license metadata",
  );
  assert(
    packageJson.engines?.node === "24.x",
    "split-root package must record Node 24",
  );
  assert(
    packageJson.packageManager === "npm@11.19.0",
    "split-root package must record npm version",
  );
  assert(
    packageJson.files?.join("|") ===
      [
        "dist/**",
        "src/**",
        "CHANGELOG.md",
        "CODE_OF_CONDUCT.md",
        "CONTRIBUTING.md",
        "LICENSE",
        "MAINTAINERS.md",
        "README.md",
        "SECURITY.md",
        "release-gates.json",
      ].join("|"),
    "split-root package files list drifted",
  );
  assert(
    packageJson.scripts?.build?.includes("tsc -p tsconfig.build.json"),
    "missing package-local build script",
  );
  assert(
    packageJson.scripts?.["test:smoke"] ===
      "npm run build && npm run test:runtime-import && vitest run --config vitest.config.ts",
    "test:smoke must be package-local",
  );
  assert(
    packageJson.scripts?.["typecheck:smoke"] ===
      "tsc -p tsconfig.smoke.json --noEmit",
    "missing package-local typecheck",
  );
  assert(
    packageJson.dependencies?.zod === "^4.4.3",
    "zod must remain a package dependency",
  );
  assert(
    packageJson.devDependencies?.typescript === "^6.0.3",
    "typescript must be a package devDependency",
  );
  assert(
    packageJson.devDependencies?.vitest === "^4.1.11",
    "vitest must be a package devDependency",
  );
  assert(
    packageJson.devDependencies?.["@types/node"] === "^24.13.3",
    "@types/node must be a package devDependency",
  );
  const scriptSource = Object.values(packageJson.scripts ?? {}).join("\n");
  assert(
    !scriptSource.includes("../../"),
    "package scripts must not depend on monorepo parent paths",
  );
  assert(
    !scriptSource.includes("scripts/run-vitest"),
    "package scripts must not depend on root run-vitest helper",
  );
  return packageJson;
}

function sortedRecord(record: DependencyMap | undefined): DependencyMap {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    ),
  );
}

function assertDependencyParity(
  label: string,
  manifest: DependencyMap | undefined,
  locked: DependencyMap | undefined,
): void {
  assert(
    JSON.stringify(sortedRecord(locked)) ===
      JSON.stringify(sortedRecord(manifest)),
    `package-lock root ${label} must match package.json`,
  );
}

export function assertPackageLocalLock(
  packageRoot: string,
  packageJson: CorePackageJson,
): void {
  const lockPath = join(packageRoot, "package-lock.json");
  assert(
    existsSync(lockPath),
    "split candidate requires a tracked package-local package-lock.json",
  );
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as PackageLock;
  const lockRoot = lock.packages?.[""];
  assert(lock.lockfileVersion === 3, "package-local lockfileVersion must be 3");
  assert(
    lock.name === packageJson.name && lockRoot?.name === packageJson.name,
    "package-local lock name drifted",
  );
  assert(
    lock.version === packageJson.version &&
      lockRoot.version === packageJson.version,
    "package-local lock version drifted",
  );
  assertDependencyParity(
    "dependencies",
    packageJson.dependencies,
    lockRoot.dependencies,
  );
  assertDependencyParity(
    "devDependencies",
    packageJson.devDependencies,
    lockRoot.devDependencies,
  );
  assertDependencyParity(
    "peerDependencies",
    packageJson.peerDependencies,
    lockRoot.peerDependencies,
  );
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  };
  for (const [dependency, specifier] of Object.entries(dependencies)) {
    assert(
      !/^(?:file|link|workspace):/i.test(specifier),
      `${dependency} must not use a local/workspace dependency specifier`,
    );
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    assert(
      entry.link !== true,
      `package-local lock must not contain linked entry: ${path || "<root>"}`,
    );
    assert(
      !entry.resolved?.startsWith("file:"),
      `package-local lock must not resolve outside the package: ${path}`,
    );
  }
}
