import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCorePackagePortabilityProof,
  type CorePackageJson,
} from "./core-package-consumer-audit.ts";
import {
  fixedCatalogRuntimeImports,
  fixedCatalogScenarioLines,
  fixedCatalogTypecheckImports,
} from "./core-package-consumer-fixed-catalog-subscription-fixture.ts";
import {
  fixedBoxRuntimeImports,
  fixedBoxRuntimeScenarioLines,
  fixedBoxTypecheckImports,
  fixedBoxTypecheckScenarioLines,
} from "./core-package-consumer-fixed-box-fixture.ts";
import { writeViteConsumerConfig } from "./core-package-consumer-vite.ts";
type NpmPackEntry = {
  filename: string;
  files: Array<{ path: string }>;
};
export type CorePackageConsumerSmokeOptions = {
  packageRoot?: string;
  dependencyRoot?: string;
  keepTemporaryFiles?: boolean;
};

const defaultPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function publicSpecifier(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
}

function tarballPathFromPackResult(entry: NpmPackEntry, packDir: string): string {
  return isAbsolute(entry.filename) ? entry.filename : join(packDir, entry.filename);
}

function extractPackedPackage(tarballPath: string, tempRoot: string): string {
  const artifactRoot = join(tempRoot, "artifact");
  mkdirSync(artifactRoot);
  run("tar", ["-xzf", tarballPath, "-C", artifactRoot], artifactRoot);
  const packageRoot = join(artifactRoot, "package");
  assert(existsSync(packageRoot), "packed core tarball did not extract a package root");
  return packageRoot;
}

function installedPath(name: string, roots: string[]): string {
  const candidates = [...new Set(roots)].map((root) => join(root, "node_modules", name));
  const installed = candidates.find((candidate) => existsSync(candidate));
  assert(installed, `core dependency ${name} is not installed; checked ${candidates.join(", ")}`);
  return installed;
}

export function resolveDependencyRoots(
  packageRoot: string,
  options: { dependencyRoot?: string } = {},
): string[] {
  const resolvedPackageRoot = resolve(packageRoot);
  const candidates = [
    resolvedPackageRoot,
    ...(options.dependencyRoot ? [resolve(options.dependencyRoot)] : []),
    resolveWorkspaceRoot(resolvedPackageRoot),
  ];
  return [...new Set(candidates)].filter((candidate) => {
    const fromCandidate = relative(candidate, resolvedPackageRoot);
    return fromCandidate === "" || (
      fromCandidate !== ".." &&
      !fromCandidate.startsWith(`..${sep}`) &&
      !isAbsolute(fromCandidate)
    );
  });
}

function resolveWorkspaceRoot(packageRoot: string): string {
  let candidate = dirname(packageRoot);
  while (candidate !== dirname(candidate)) {
    const manifestPath = join(candidate, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        workspaces?: unknown;
      };
      const workspaces = Array.isArray(manifest.workspaces)
        ? manifest.workspaces
        : typeof manifest.workspaces === "object" && manifest.workspaces !== null &&
          Array.isArray((manifest.workspaces as { packages?: unknown }).packages)
        ? (manifest.workspaces as { packages: unknown[] }).packages
        : [];
      const packagePath = relative(candidate, packageRoot).split(sep).join("/");
      if (workspaces.includes(packagePath)) return candidate;
    }
    candidate = dirname(candidate);
  }
  return packageRoot;
}

function dependencyFileSpec(name: string, roots: string[]): string {
  return pathToFileURL(installedPath(name, roots)).href;
}

function toolBinary(name: string, roots: string[]): string {
  return installedPath(`.bin/${name}`, roots);
}

function writeConsumerPackageJson(
  consumerDir: string,
  tarballPath: string,
  packageJson: CorePackageJson,
  dependencyRoots: string[],
): void {
  const packageName = packageJson.name;
  const coreDependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  };
  const localDependencies = Object.fromEntries(
    Object.keys(coreDependencies)
      .sort()
      .map((name) => [name, dependencyFileSpec(name, dependencyRoots)]),
  );

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          [packageName]: pathToFileURL(tarballPath).href,
          ...localDependencies,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeConsumerTsConfig(
  consumerDir: string,
  filename: string,
  module: "ESNext" | "NodeNext",
  moduleResolution: "Bundler" | "NodeNext",
): void {
  writeFileSync(join(consumerDir, filename), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module,
      moduleResolution,
      moduleDetection: "force",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["consumer.ts"],
  }, null, 2)}\n`);
}

function writeConsumerSmoke(consumerDir: string, packageJson: CorePackageJson): void {
  const specifiers = Object.keys(packageJson.exports)
    .sort()
    .map((subpath) => publicSpecifier(packageJson.name, subpath));
  const dynamicImports = JSON.stringify(specifiers, null, 2);
  const staticImports = specifiers.map((specifier, index) => `import * as module${index} from ${JSON.stringify(specifier)};`);
  const staticModuleRefs = specifiers.map((_, index) => `module${index}`).join(", ");
  writeFileSync(
    join(consumerDir, "smoke.mjs"),
    [
      ...fixedCatalogRuntimeImports(),
      ...fixedBoxRuntimeImports(),
      `const specifiers = ${dynamicImports};`,
      "const imported = await Promise.all(specifiers.map((specifier) => import(specifier)));",
      "if (imported.length === 0) throw new Error('core package exported no public subpaths');",
      ...fixedCatalogScenarioLines(false),
      ...fixedBoxRuntimeScenarioLines(),
      "console.log(`core package tarball consumer ok (${imported.length} exports, total ${fixedCatalogBreakdown.orderTotalMinor})`);",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(consumerDir, "consumer.ts"),
    [
      ...staticImports,
      ...fixedCatalogTypecheckImports(),
      ...fixedBoxTypecheckImports(),
      `const importedModules = [${staticModuleRefs}];`,
      "if (importedModules.length === 0) throw new Error('consumer typecheck imported no modules');",
      "(globalThis as Record<string, unknown>).__coreConsumerExportCounts = importedModules.map((module) => Object.keys(module).length);",
      ...fixedCatalogScenarioLines(true),
      ...fixedBoxTypecheckScenarioLines(),
      "export const consumerProof = {",
      "  subscriptionStatus: fixedCatalogResumed.subscription.status,",
      "  cycleStatus: fixedCatalogCycle.cycle.status,",
      "  resizedCoreQty: fixedCatalogResized.coreLines.reduce((sum, line) => sum + line.qty, 0),",
      "  orderTotalMinor: fixedCatalogBreakdown.orderTotalMinor,",
      "};",
      "",
    ].join("\n"),
  );

  writeFileSync(join(consumerDir, "index.html"), "<script type=\"module\" src=\"/consumer.ts\"></script>\n");
  writeViteConsumerConfig(consumerDir, packageJson.name, specifiers.length);

  writeConsumerTsConfig(consumerDir, "tsconfig.json", "NodeNext", "NodeNext");
  writeConsumerTsConfig(consumerDir, "tsconfig.bundler.json", "ESNext", "Bundler");
}

export function runCorePackageConsumerSmoke(options: CorePackageConsumerSmokeOptions = {}): void {
  const packageRoot = resolve(options.packageRoot ?? defaultPackageRoot);
  const dependencyRoots = resolveDependencyRoots(packageRoot, {
    dependencyRoot: options.dependencyRoot,
  });
  const tempRoot = mkdtempSync(join(tmpdir(), "core-package-consumer-"));

  try {
    const cacheDir = join(tempRoot, "npm-cache");
    const packDir = join(tempRoot, "pack");
    const consumerDir = join(tempRoot, "consumer");
    mkdirSync(cacheDir);
    mkdirSync(packDir);
    mkdirSync(consumerDir);

    run("npm", ["run", "build", "--workspaces=false"], packageRoot);

    const packOutput = run(
      "npm",
      ["pack", "--pack-destination", packDir, "--json", "--cache", cacheDir, "--workspaces=false"],
      packageRoot,
    );
    const packResult = JSON.parse(packOutput) as NpmPackEntry[];
    assert(packResult.length === 1, `expected one packed package, got ${packResult.length}`);

    const tarballPath = tarballPathFromPackResult(packResult[0], packDir);
    const packedPackageRoot = extractPackedPackage(tarballPath, tempRoot);
    const packageJson = JSON.parse(readFileSync(join(packedPackageRoot, "package.json"), "utf8")) as CorePackageJson;
    const packageName = packageJson.name;
    const packageReadme = readFileSync(join(packedPackageRoot, "README.md"), "utf8");
    assertCorePackagePortabilityProof({
      packageRoot: packedPackageRoot,
      packageName,
      packageJson,
      packageReadme,
      packFiles: packResult[0].files.map((file) => file.path).sort(),
    });

    writeConsumerPackageJson(consumerDir, tarballPath, packageJson, dependencyRoots);
    writeConsumerSmoke(consumerDir, packageJson);

    run(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--fund=false",
        "--package-lock=false",
        "--registry=http://127.0.0.1:9",
        "--cache",
        cacheDir,
      ],
      consumerDir,
    );
    run("node", ["smoke.mjs"], consumerDir);
    run(toolBinary("tsc", dependencyRoots), ["-p", "tsconfig.json", "--noEmit"], consumerDir);
    run(toolBinary("tsc", dependencyRoots), ["-p", "tsconfig.bundler.json", "--noEmit"], consumerDir);
    run(toolBinary("vite", dependencyRoots), ["build", "--logLevel", "error"], consumerDir);

    console.log("core package tarball consumer smoke ok");
  } finally {
    if (options.keepTemporaryFiles !== true) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) runCorePackageConsumerSmoke();
