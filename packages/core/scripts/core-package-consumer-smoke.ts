import { execFileSync, spawnSync } from "node:child_process";
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

export function assertInstalledGuide(installedCoreRoot: string): void {
  const readme = join(installedCoreRoot, "docs/guide", "README.md");
  assert(existsSync(readme), "installed core is missing docs/guide/README.md");
  assert(readFileSync(readme, "utf8").startsWith("# OpenLup guide"), "installed guide README must start with # OpenLup guide");
  // Links inside the guide are checked against the packed file list by docs:check.
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

// The same module-mode facts run in a fresh installed-artifact process and
// compile under both consumer resolutions. No identity adapter/SDK is imported.
function readinessModuleScenarioLines(version: string, typed: boolean): string[] {
  return [
    `const readinessModules${typed ? ": ReadinessInput" : ""} = {`,
    "  candidate: { artifact: 'packed', configuration: 'modules', environment: 'test', database: 'db', schema: 'snapshot' }, inventoryComplete: true,",
    `  loadedPackages: [{ name: '@openlup/core', version: '${version}', kind: 'kernel' }, { name: '@openlup/platform', version: '${version}', kind: 'rail', modules: ['foundation', 'identity'] }],`,
    "  contributions: ['foundation', 'identity'].map(id => ({ handlers: [], schedules: [], routes: [], manifest: {",
    `    name: '@openlup/platform', version: '${version}', kind: 'rail'${typed ? " as const" : ""},`,
    `    module: { id, kind: id === 'foundation' ? 'kernel'${typed ? " as const" : ""} : 'capability'${typed ? " as const" : ""}, provides: [id === 'foundation' ? './bff' : './identity/contracts'], dependsOn: id === 'identity' ? [{ module: 'foundation', entries: ['./bff'] }] : [] },`,
    "    emits: [], handles: [], schedules: [], routes: [], requiredPorts: ['store'], env: [],",
    `    requiredSchema: { version: id + '-1', migration: id + '-0001.sql', objects: [{ kind: 'table'${typed ? " as const" : ""}, name: 'public.' + id }] },`,
    "  } })), vocabulary: [], exemptions: [],",
    "  bindings: { ports: { '@openlup/platform/foundation:store': {}, '@openlup/platform/identity:store': {} }, triggers: {}, routes: {}, env: {} },",
    `  schemaProbe: { observe: async (req${typed ? ": RequiredSchema" : ""}) => ({ database: 'db', version: req.version, objects: req.objects.map(object => ({ object, present: true })) }) },`,
    "};",
    `const readinessReport${typed ? ": ReadinessReport" : ""} = await checkReadiness(readinessModules);`,
    "if (readinessReport.state !== 'ready' || readinessReport.issues.length) throw new Error('packed module readiness failed');",
    "readinessModules.loadedPackages[1].modules = ['foundation'];",
    "readinessModules.contributions = readinessModules.contributions.slice(0, 1);",
    "readinessModules.bindings.ports = { '@openlup/platform/foundation:store': {} };",
    "if ((await checkReadiness(readinessModules)).state !== 'ready') throw new Error('disabled module readiness failed');",
  ];
}

function writeConsumerSmoke(consumerDir: string, packageJson: CorePackageJson): void {
  const specifiers = Object.keys(packageJson.exports)
    .filter((subpath) => subpath !== "./package.json")
    .sort()
    .map((subpath) => publicSpecifier(packageJson.name, subpath));
  const dynamicImports = JSON.stringify(specifiers, null, 2);
  const staticImports = specifiers.map((specifier, index) => `import * as module${index} from ${JSON.stringify(specifier)};`);
  const staticModuleRefs = specifiers.map((_, index) => `module${index}`).join(", ");
  const moneyInput = "{ amountBasis: 'exclusive', sources: [], delivery: [], adjustments: [], fees: [{ feeKey: 'fee', amountMinor: 25 }] }";
  const moneyCheck = "if (calculateCatalogueMoneyV2(moneyInput, { kind: 'local', components: [] }).payableMinor !== 25) throw new Error('catalogue money v2 failed');";
  writeFileSync(
    join(consumerDir, "smoke.mjs"),
    [
      ...fixedCatalogRuntimeImports(),
      ...fixedBoxRuntimeImports(),
      "import { calculateCatalogueMoneyV2 } from '@openlup/core/pricing';",
      "import { checkReadiness, buildGroupedPostgresSchemaProbe, decodeGroupedPostgresSchemaRows } from '@openlup/core/readiness';",
      `const specifiers = ${dynamicImports};`,
      "const imported = await Promise.all(specifiers.map((specifier) => import(specifier)));",
      "if (imported.length === 0) throw new Error('core package exported no public subpaths');",
      ...fixedCatalogScenarioLines(false),
      ...fixedBoxRuntimeScenarioLines(),
      `const moneyInput = ${moneyInput};`,
      moneyCheck,
      ...readinessModuleScenarioLines(packageJson.version, false),
      "if (buildGroupedPostgresSchemaProbe([]).values.length !== 3 || decodeGroupedPostgresSchemaRows([], []).length !== 0) throw new Error('grouped schema empty read failed');",
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
      "import { calculateCatalogueMoneyV2, type CatalogueMoneyV2Input } from '@openlup/core/pricing';",
      "import { checkReadiness, buildGroupedPostgresSchemaProbe, decodeGroupedPostgresSchemaRows, type PostgresSchemaCatalogEntry, type SchemaObject, type ReadinessInput, type ReadinessReport, type RequiredSchema } from '@openlup/core/readiness';",
      `const importedModules = [${staticModuleRefs}];`,
      "if (importedModules.length === 0) throw new Error('consumer typecheck imported no modules');",
      "(globalThis as Record<string, unknown>).__coreConsumerExportCounts = importedModules.map((module) => Object.keys(module).length);",
      ...fixedCatalogScenarioLines(true),
      ...fixedBoxTypecheckScenarioLines(),
      `const moneyInput: CatalogueMoneyV2Input = ${moneyInput};`,
      moneyCheck,
      ...readinessModuleScenarioLines(packageJson.version, true),
      "const groupedObjects: readonly SchemaObject[] = [{ kind: 'table', name: 'public.example' }];",
      "const groupedQuery: { text: string; values: readonly unknown[] } = buildGroupedPostgresSchemaProbe(groupedObjects);",
      "const groupedEntries: readonly PostgresSchemaCatalogEntry[] = decodeGroupedPostgresSchemaRows(groupedObjects, [{ ordinal: 1, present: false, shape: null }]);",
      "if (!groupedQuery.text || groupedEntries[0].present) throw new Error('grouped schema consumer failed');",
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

function assertInstalledContextMcp(executable: string, consumerDir: string, version: string, installedCoreRoot = join(consumerDir, "node_modules/@openlup/core")): void {
  const prefix = relative(consumerDir, installedCoreRoot).split(sep).join("/");
  const seam = `${prefix}/docs/guide/how-to/extend/choose-an-extension-seam.md`;
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "packed-consumer", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_openlup_context", arguments: { task: "extension seam" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_openlup_file", arguments: { path: `${prefix}/docs/guide/README.md`, startLine: 1, endLine: 3 } } },
  ];
  const stdout = execFileSync(executable, ["mcp"], {
    cwd: consumerDir, encoding: "utf8", env: consumerEnvironment(), timeout: 10_000,
    input: messages.map(message => JSON.stringify(message)).join("\n") + "\n",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert(JSON.stringify(replies.map(reply => reply.id)) === "[1,2,3,4]", "installed MCP stdout must contain only request replies and finish on EOF");
  assert(replies.every(reply => reply.jsonrpc === "2.0" && !reply.error && !reply.result.isError), "installed MCP request failed");
  assert(replies[0].result.protocolVersion === "2025-06-18" && replies[0].result.serverInfo.name === "openlup-context" && replies[0].result.serverInfo.version === version, "installed MCP initialize identity differs");
  assert(JSON.stringify(replies[0].result.capabilities) === '{"tools":{}}', "installed MCP capabilities differ");
  assert(replies[1].result.tools.map((tool: { name: string }) => tool.name).join(",") === "search_openlup_context,read_openlup_file", "installed MCP tools differ");
  const search = replies[2].result;
  assert(search.structuredContent.version === version && search.structuredContent.hits.some((hit: { file: string }) => hit.file === seam), "installed MCP search did not return the relative installed guide page");
  assert(search.content[0].text.includes(`${prefix}/`), "installed MCP search did not format citations");
  assert(replies[3].result.content[0].text.includes("1: # OpenLup guide"), "installed MCP file range did not contain numbered installed lines");
  const hit = search.structuredContent.hits.find((item: { file: string }) => item.file === seam);
  assert(hit && typeof hit.title === "string" && Number.isInteger(hit.start) && Number.isInteger(hit.end), "installed MCP guide span is missing");
  const readMessages = [messages[0], messages[1], {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_openlup_file", arguments: { path: hit.file, startLine: hit.start, endLine: hit.end } },
  }];
  const readOutput = execFileSync(executable, ["mcp"], {
    cwd: consumerDir, encoding: "utf8", env: consumerEnvironment(), timeout: 10_000,
    input: readMessages.map(message => JSON.stringify(message)).join("\n") + "\n",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readReplies = readOutput.trim().split("\n").map(line => JSON.parse(line));
  assert(JSON.stringify(readReplies.map(reply => reply.id)) === "[1,5]" && readReplies.every(reply => !reply.error && !reply.result.isError), "installed MCP returned-path read failed");
  assert(readReplies[1].result.content[0].text.includes(`${hit.start}:`) && readReplies[1].result.content[0].text.includes(hit.title), "installed MCP returned path did not read its cited heading");
  console.log("core installed context MCP smoke ok (initialize, tools/list, search, read, EOF)");
}

function assertHoistedContext(consumerDir: string, tarballPath: string, packageJson: CorePackageJson, cacheDir: string): void {
  const app = join(consumerDir, "apps/shop"), neighbor = join(consumerDir, "apps/neighbor");
  for (const directory of [app, neighbor]) mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "context-workspace-shop", version: "0.0.0", private: true, type: "module", dependencies: { [packageJson.name]: pathToFileURL(tarballPath).href } }));
  writeFileSync(join(neighbor, "package.json"), JSON.stringify({ name: "context-workspace-neighbor", version: "0.0.0", private: true }));
  for (const directory of [app, neighbor]) writeFileSync(join(directory, "src/context-probe.ts"), "export const workspaceContextWitness = true;\n");
  const rootMetadata = JSON.parse(readFileSync(join(consumerDir, "package.json"), "utf8"));
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ ...rootMetadata, workspaces: ["apps/*"] }));
  run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--fund=false", "--package-lock=true", "--registry=http://127.0.0.1:9", "--cache", cacheDir], consumerDir);
  assertInstalled(consumerDir, [packageJson.name, "zod"]);
  assert(!existsSync(join(app, "node_modules", packageJson.name)), "workspace proof requires hoisted Core");
  assert(!existsSync(join(app, "node_modules/.bin/openlup-context")), "workspace proof must use the installed-manifest executable recipe");
  const appRoot = realpathSync(app), coreRoot = realpathSync(join(consumerDir, "node_modules", packageJson.name));
  const probe = JSON.parse(run(process.execPath, ["--input-type=module", "-e", [
    'import { findPackageJSON } from "node:module";',
    'import { readFileSync } from "node:fs";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const manifest = findPackageJSON(${JSON.stringify(packageJson.name)}, process.cwd() + "/package.json");`,
    'const metadata = JSON.parse(readFileSync(manifest, "utf8"));',
    'const bin = metadata.bin["openlup-context"];',
    'const { nextRetryAttemptAt } = await import("@openlup/core/subscription");',
    'if (typeof nextRetryAttemptAt !== "function") throw Error("public Core import failed");',
    'console.log(JSON.stringify({ manifest, executable: resolve(dirname(manifest), bin), version: metadata.version, imported: fileURLToPath(import.meta.resolve("@openlup/core/subscription")) }));',
  ].join("\n")], appRoot));
  assert(probe.manifest === join(coreRoot, "package.json") && probe.version === packageJson.version, "public import and metadata selected a different Core installation");
  assert(probe.imported.startsWith(`${coreRoot}${sep}`) && probe.executable === join(coreRoot, "src/openlup-context.js"), "workspace import/executable escaped the installed artifact");
  const context = JSON.parse(run(process.execPath, [probe.executable, "search", "extension seam", "--json"], appRoot));
  assert(context.version === probe.version && JSON.stringify(context.packages) === JSON.stringify([packageJson.name]), "workspace CLI selected a different contract/version");
  assert(context.hits.some((hit: { file: string }) => hit.file === join(coreRoot, "docs/guide/how-to/extend/choose-an-extension-seam.md")), "workspace CLI did not cite its installed guide");
  assertInstalledContextMcp(probe.executable, appRoot, packageJson.version, coreRoot);
  const source = JSON.parse(run(process.execPath, [probe.executable, "search", "workspaceContextWitness", "--code", "--json"], appRoot));
  assert(source.hits.length === 1 && source.hits[0].file === join(appRoot, "src/context-probe.ts"), "workspace application scan included sibling or ancestor source");
  const lockPath = join(consumerDir, "package-lock.json"), originalLock = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(originalLock);
  assert(lock.packages?.["apps/shop"]?.dependencies?.[packageJson.name], "npm did not register the selected workspace in its owning lock");
  assert(lock.packages?.[`node_modules/${packageJson.name}`]?.version === packageJson.version, "npm workspace lock did not pin the installed Core version");
  try {
    lock.packages[`node_modules/${packageJson.name}`].version = "0.0.0";
    writeFileSync(lockPath, JSON.stringify(lock));
    const refused = spawnSync(process.execPath, [probe.executable, "search", "extension seam", "--json"], { cwd: appRoot, env: consumerEnvironment(), encoding: "utf8", timeout: 10_000 });
    assert(refused.status === 1 && refused.stdout === "" && refused.stderr.includes("Lockfile and installed package disagree"), "workspace CLI falsely accepted a contradictory owning lock");
  } finally { writeFileSync(lockPath, originalLock); }
  console.log("core hoisted npm workspace context PASS (public import, CLI/MCP, returned read path, source isolation, owning-lock refusal)");
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
    const installedCoreRoot = join(consumerDir, "node_modules", packageName);
    assertInstalledGuide(installedCoreRoot);
    const installedMetadata = JSON.parse(readFileSync(join(installedCoreRoot, "package.json"), "utf8"));
    assert(installedMetadata.bin?.["openlup-context"] === "./src/openlup-context.js", "installed context executable target differs");
    const contextExecutable = join(consumerDir, "node_modules", ".bin", "openlup-context");
    assert(existsSync(contextExecutable), "offline installation did not link the local context executable");
    assert(run(contextExecutable, ["--help"], consumerDir).includes("Usage: openlup-context"), "installed context executable did not print usage");
    const context = JSON.parse(run(contextExecutable, ["search", "extension seam", "--json"], consumerDir));
    assert(context.hits.some((hit: { file?: string }) => hit.file?.endsWith(`/node_modules/${packageName}/docs/guide/how-to/extend/choose-an-extension-seam.md`) === true), "installed context search did not find the installed extension-seam guide page");
    const catalogueSearch = { name: "installed_guide_search_finds_each_recipe", queries: ["new vertical", "add attribute", "add unit", "add axis", "add tax class", "subscription profile", "upgrade a definition"] };
    for (const recipe of catalogueSearch.queries) {
      const found = JSON.parse(run(contextExecutable, ["search", `catalogue ${recipe}`, "--json"], consumerDir));
      assert(found.hits.some((hit: { file?: string; title?: string }) => hit.file?.endsWith("/how-to/extend/catalogue-extension.md") && hit.title?.toLowerCase() === recipe), `${catalogueSearch.name}: ${recipe}`);
    }
    const sourceContext = JSON.parse(run(contextExecutable, ["search", "nextRetryAttemptAt", "--package-code", "--json"], consumerDir));
    for (const scope of ["declarations", "package-source"]) {
      assert(sourceContext.scans.some((scan: { scope: string; packageName?: string; scannedFiles: number }) => scan.scope === scope && scan.packageName === packageName && scan.scannedFiles > 0), `installed context did not report a nonempty ${scope} scan`);
    }
    assertInstalledContextMcp(contextExecutable, consumerDir, packageJson.version);
    run(process.execPath, ["smoke.mjs"], consumerDir);
    run(toolBinary("tsc", dependencyRoots), ["-p", "tsconfig.json", "--noEmit"], consumerDir);
    run(toolBinary("tsc", dependencyRoots), ["-p", "tsconfig.bundler.json", "--noEmit"], consumerDir);
    run(toolBinary("vite", dependencyRoots), ["build", "--logLevel", "error"], consumerDir);
    assertHoistedContext(consumerDir, tarballPath, packageJson, cacheDir);

    console.log("core package tarball consumer smoke ok");
  } finally {
    if (options.keepTemporaryFiles !== true) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) runCorePackageConsumerSmoke();
