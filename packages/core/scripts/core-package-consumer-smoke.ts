import { execFileSync } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { createHash } from "node:crypto";
import { writeViteConsumerConfig } from "./core-package-consumer-vite.ts";
type NpmPackEntry = {
  filename: string;
  files: Array<{ path: string }>;
};
export type CorePackageConsumerSmokeOptions = {
  packageRoot?: string;
  dependencyRoot?: string;
  keepTemporaryFiles?: boolean;
  packManifest?: string;
  packCommit?: string;
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
    env: consumerEnvironment(),
  });
}

function consumerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...processEnvironment };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.npm_config_node_options;
  delete environment.NPM_CONFIG_NODE_OPTIONS;
  return environment;
}

function assertInstalled(consumerDir: string, names: readonly string[]): void {
  const root = realpathSync(consumerDir);
  for (const name of names) {
    const path = join(root, "node_modules", name), state = lstatSync(path);
    assert(state.isDirectory() && !state.isSymbolicLink() && realpathSync(path).startsWith(`${root}${sep}`), `installed ${name} must be a confined ordinary directory`);
  }
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

function packDependency(name: string, roots: string[], packDir: string, cacheDir: string): string {
  assert(name === "zod", `unsupported core runtime dependency ${name}; declare its locked artifact explicitly`);
  const directory = installedPath(name, roots);
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(roots[0], "package-lock.json"), "utf8"));
  assert(metadata.name === name && metadata.version === lock.packages?.[`node_modules/${name}`]?.version, "installed Zod must match the core source lock");
  const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir, "--json", "--cache", cacheDir, "--workspaces=false"], directory)) as NpmPackEntry[];
  const path = tarballPathFromPackResult(packed, packDir);
  const bytes = readFileSync(path);
  console.log(`core consumer runtime input ${name}@${metadata.version} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
  return pathToFileURL(path).href;
}

function packedFiles(directory: string, base = directory): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), state = lstatSync(path);
    assert(!state.isSymbolicLink(), "packed core artifact contains a symlink");
    return state.isDirectory() ? packedFiles(path, base) : [relative(base, path).split(sep).join("/")];
  }).sort();
}

function toolBinary(name: string, roots: string[]): string {
  return installedPath(`.bin/${name}`, roots);
}

function writeConsumerPackageJson(
  consumerDir: string,
  tarballPath: string,
  packageJson: CorePackageJson,
  dependencySpecs: Record<string, string>,
): void {
  const packageName = packageJson.name;

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          [packageName]: pathToFileURL(tarballPath).href,
          ...dependencySpecs,
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
  const packManifest = options.packManifest ?? processEnvironment.OPENLUP_PACK_MANIFEST;
  const packCommit = options.packCommit ?? processEnvironment.OPENLUP_PACK_COMMIT;
  assert((packManifest === undefined) === (packCommit === undefined), "OPENLUP_PACK_MANIFEST and OPENLUP_PACK_COMMIT must be supplied together");
  let supplied: { path: string; name: string; version: string; sha256: string; integrity: string } | undefined;
  if (packManifest !== undefined && packCommit !== undefined) {
    const root = resolveWorkspaceRoot(packageRoot);
    // The root-owned input tool crosses no package import boundary.
    const verified = JSON.parse(run(process.execPath, [
      "--experimental-strip-types", join(root, "scripts/packages/pack-manifest-input.ts"), packManifest, packCommit,
    ], root)) as Array<NonNullable<typeof supplied>>;
    supplied = verified.find(entry => entry.name === "@openlup/core");
    assert(supplied, "supplied package set has no core artifact");
  }
  const workspaceRoot = realpathSync(resolveWorkspaceRoot(packageRoot));
  let ancestor = realpathSync(tmpdir());
  assert(ancestor !== workspaceRoot && !ancestor.startsWith(`${workspaceRoot}${sep}`), "consumer temporary directory must be outside the checkout");
  while (ancestor !== dirname(ancestor)) {
    assert(!existsSync(join(ancestor, "node_modules", "@openlup")), "consumer temporary directory has an ancestor OpenLup installation");
    ancestor = dirname(ancestor);
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "core-package-consumer-"));

  try {
    const cacheDir = join(tempRoot, "npm-cache");
    const packDir = join(tempRoot, "pack");
    const consumerDir = join(tempRoot, "consumer");
    mkdirSync(cacheDir);
    mkdirSync(packDir);
    mkdirSync(consumerDir);

    let tarballPath: string;
    if (supplied) tarballPath = supplied.path;
    else {
      run("npm", ["run", "build", "--workspaces=false"], packageRoot);
      const packOutput = run("npm", ["pack", "--pack-destination", packDir, "--json", "--cache", cacheDir, "--workspaces=false"], packageRoot);
      const packResult = JSON.parse(packOutput) as NpmPackEntry[];
      assert(packResult.length === 1, `expected one packed package, got ${packResult.length}`);
      tarballPath = tarballPathFromPackResult(packResult[0], packDir);
    }
    const bytes = readFileSync(tarballPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (supplied) {
      assert(sha256 === supplied.sha256 && integrity === supplied.integrity, "supplied core artifact changed after validation");
      tarballPath = join(packDir, "core.tgz");
      writeFileSync(tarballPath, bytes);
    }
    console.log(`core consumer artifact sha256=${sha256} integrity=${integrity}`);
    const packedPackageRoot = extractPackedPackage(tarballPath, tempRoot);
    const packageJson = JSON.parse(readFileSync(join(packedPackageRoot, "package.json"), "utf8")) as CorePackageJson;
    const packageName = packageJson.name;
    const packageReadme = readFileSync(join(packedPackageRoot, "README.md"), "utf8");
    assertCorePackagePortabilityProof({
      packageRoot: packedPackageRoot,
      packageName,
      packageJson,
      packageReadme,
      packFiles: packedFiles(packedPackageRoot),
    });

    if (supplied) assert(packageJson.name === supplied.name && packageJson.version === supplied.version, "packed core identity differs from the supplied manifest");
    const dependencySpecs = Object.fromEntries(Object.keys({ ...packageJson.dependencies, ...packageJson.peerDependencies }).sort().map(name => [name, packDependency(name, dependencyRoots, packDir, cacheDir)]));
    writeConsumerPackageJson(consumerDir, tarballPath, packageJson, dependencySpecs);
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
    assertInstalled(consumerDir, [packageName, "zod"]);
    run(process.execPath, ["smoke.mjs"], consumerDir);
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
