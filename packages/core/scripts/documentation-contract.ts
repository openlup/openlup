import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { assertGuideLinks, assertGuidePage, assertGuideTitle, assertPackageMarkdown, assertPublishableReadmeContent, assertReaderLanguage, checkedTypeScriptFences, pinGuideReleaseLinks, readGuideAllowList, README_MAX_BYTES, typeScriptFences, type Fence } from "./documentation-guide-content.ts";
export { assertPublishableReadmeContent, README_MAX_BYTES };
import { markdownTable, publishedPackages, readCoreVersion, renderSqlInventory, repositoryLink } from "./documentation-sql-inventory.ts";
import { packageKinds } from "./public-api-config.ts";
import { packDryRun } from "./release-npm-checks.ts";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const retiredPackageScope = "veli";
const packageHygieneFiles = [
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "MAINTAINERS.md",
  "SECURITY.md",
  "docs/SPLIT_AND_UPGRADE.md",
  ".github/pull_request_template.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/documentation_problem.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
];
const generatedOutputIgnoreRules = ["/coverage/", "/dist/", "/node_modules/", "/release/"];
const forbiddenPublicRootReferences = [
  [new RegExp(`@${retiredPackageScope}-commerce/core\\b`, "i"), "retired package identity"],
  [/\bVelipet\b/i, "downstream product reference"],
];
const agentGuideSections = [
  "Purpose and kind",
  "Subpath maturity",
  "Wiring example",
  "Sources and declarations",
  "Readiness codes",
  "Using this package in an application",
];
const wiringExamplePath = "smoke/agentsWiringExample.ts";
const readmeExamplePath = "smoke/readmeExample.ts";

type SurfaceContract = { role?: unknown; maturity?: unknown; packageSmokeEvidence?: unknown; snapshot?: string; entrypoint?: string };

export function assertDocumentationContract(
  packageRoot = defaultPackageRoot,
  // The packed file list; by default a real `npm pack --dry-run`.
  packedFiles: () => string[] = () => (packDryRun(packageRoot).files ?? []).map((file) => file.path),
  // The monorepo root that guide links and generated regions read; absent in an extracted root.
  options: { repositoryRoot?: string; write?: boolean } = { repositoryRoot: detectRepositoryRoot(packageRoot) },
): void {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    exports?: Record<string, unknown>;
    repository?: unknown;
    bugs?: unknown;
    homepage?: unknown;
  };
  const gates = JSON.parse(readFileSync(join(packageRoot, "release-gates.json"), "utf8")) as {
    kind?: unknown;
    packageSurface?: Record<string, SurfaceContract>;
  };
  const violations: string[] = [];
  const packed = new Set(packedFiles());
  syncPackageRegions(packageRoot, options.repositoryRoot, options.write === true, violations);
  const starterManifest = options.repositoryRoot && join(options.repositoryRoot, "examples/neutral-store/package.json");
  const starterScripts = starterManifest && existsSync(starterManifest)
    ? (JSON.parse(readFileSync(starterManifest, "utf8")) as { scripts?: Record<string, string> }).scripts
    : undefined;
  const fences = new Map<string, Fence[]>();
  const guideFiles = assertGuideContract(packageRoot, options.repositoryRoot, options.write === true, violations, {
    packed, scripts: manifest.scripts, starterScripts, fences,
  });

  for (const file of markdownFiles(packageRoot)) {
    if (fences.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const label = relative(packageRoot, file).split(sep).join("/");
    assertPackageMarkdown({
      packageRoot, file, label, source, packed, scripts: scriptsForPage(label, manifest.scripts, starterScripts),
    }, guideFiles.includes(file), violations);
  }

  const exports = codeExports(manifest.exports);
  const surface = gates.packageSurface ?? {};
  assertSurfaceTable(packageRoot, "README.md", "Package Surface Maturity", true, exports, surface, violations);
  const readmePath = join(packageRoot, "README.md");
  const readmeSource = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  if (existsSync(readmePath)) assertPublishableReadmeContent("README.md", readmeSource, violations);
  // The README's opening import example is the smoke file that typecheck:smoke compiles.
  const readmeExample = readmeSource.match(/```ts\n(?<code>[\s\S]*?)```/)?.groups?.code;
  const readmeExampleFile = join(packageRoot, readmeExamplePath);
  if (!existsSync(readmeExampleFile) || readmeExample !== readFileSync(readmeExampleFile, "utf8")) {
    violations.push(`README.md: first TypeScript example differs from ${readmeExamplePath}`);
  }
  assertAgentGuide(packageRoot, gates.kind, exports, surface, packed, violations);
  assertSingleUnreleasedSection(packageRoot, violations);
  assertPackageHygiene(packageRoot, violations);
  assertGeneratedOutputIgnores(packageRoot, violations);
  assertAgentsFileSize(packageRoot, "AGENTS.md", violations);
  if (options.repositoryRoot) assertAgentsFileSize(options.repositoryRoot, "AGENTS.md", violations, "repository AGENTS.md");
  assertCompiledFences(packageRoot, [join(packageRoot, "README.md"), join(packageRoot, "AGENTS.md"), ...guideFiles], violations, [readmeExamplePath, wiringExamplePath], fences);

  assert(violations.length === 0, `documentation contract violations:\n${violations.join("\n")}`);
  console.log("extracted-root documentation contract ok");
}

// Every tarball carries an agent guide stating the package's kind, the
// maturity of each subpath and one wiring example that compiles in CI.
/** The code subpaths of an exports map; `./package.json` exports the manifest for tooling and has no surface row. */
function codeExports(exports: Record<string, unknown> | undefined): Record<string, unknown> {
  const { "./package.json": _manifest, ...code } = exports ?? {};
  return code;
}

export function assertAgentGuide(
  packageRoot: string,
  kind: unknown,
  exports: Record<string, unknown>,
  surface: Record<string, SurfaceContract>,
  packedFiles: ReadonlySet<string>,
  violations: string[],
  // null: the package keeps no separate example file; the fence compiler type-checks the example instead.
  exampleSource: string | null = wiringExamplePath,
): void {
  if (typeof kind !== "string" || !packageKinds.includes(kind)) {
    violations.push(`release-gates.json: package kind must be one of ${packageKinds.join(", ")}`);
  }
  if (!packedFiles.has("AGENTS.md")) violations.push("npm pack: tarball is missing AGENTS.md");
  const guidePath = join(packageRoot, "AGENTS.md");
  if (!existsSync(guidePath)) {
    violations.push("AGENTS.md: missing agent guide");
    return;
  }
  const guide = readFileSync(guidePath, "utf8");
  for (const heading of agentGuideSections) {
    if (!markdownSection(guide, heading)) violations.push(`AGENTS.md: missing ${heading} section`);
  }
  if (!guide.includes(`Kind: \`${String(kind)}\`.`)) {
    violations.push("AGENTS.md: kind differs from release gates");
  }
  assertSurfaceTable(packageRoot, "AGENTS.md", "Subpath maturity", false, exports, surface, violations);
  const example = markdownSection(guide, "Wiring example")?.match(/```ts\n(?<code>[\s\S]*?)```/)?.groups?.code;
  if (exampleSource === null) {
    if (!example) violations.push("AGENTS.md: wiring example has no ts fence");
    return;
  }
  const examplePath = join(packageRoot, exampleSource);
  if (!existsSync(examplePath) || example !== readFileSync(examplePath, "utf8")) {
    violations.push(`AGENTS.md: wiring example differs from ${exampleSource}`);
  }
}

// One Unreleased section collects every change since the last version.
function assertSingleUnreleasedSection(packageRoot: string, violations: string[]): void {
  const changelogPath = join(packageRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    violations.push("CHANGELOG.md: missing changelog");
    return;
  }
  const changelog = readFileSync(changelogPath, "utf8");
  const sections = changelog.match(/^## \[?Unreleased\b/gm)?.length ?? 0;
  if (sections > 1) violations.push(`CHANGELOG.md: ${sections} Unreleased sections; keep one`);
}

function markdownSection(source: string, heading: string): string | undefined {
  return source.match(new RegExp(`## ${heading}\n(?<body>[\\s\\S]*?)(?:\n## |$)`))?.groups?.body;
}

function assertGeneratedOutputIgnores(packageRoot: string, violations: string[]): void {
  const gitignorePath = join(packageRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    violations.push(".gitignore: missing extracted-root generated-output policy");
    return;
  }
  const rules = readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (JSON.stringify(rules) !== JSON.stringify(generatedOutputIgnoreRules)) {
    violations.push(
      `.gitignore: expected exactly ${generatedOutputIgnoreRules.join(", ")}; received ${rules.join(", ")}`,
    );
  }
}

function assertPackageHygiene(packageRoot: string, violations: string[]): void {
  for (const relativePath of packageHygieneFiles) {
    const file = join(packageRoot, relativePath);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const [pattern, description] of forbiddenPublicRootReferences) {
      if ((pattern as RegExp).test(source)) violations.push(`${relativePath}: ${description}`);
    }
  }
}

function assertSurfaceTable(
  packageRoot: string,
  file: string,
  heading: string,
  withEvidence: boolean,
  exports: Record<string, unknown>,
  packageSurface: Record<string, SurfaceContract>,
  violations: string[],
): void {
  const path = join(packageRoot, file);
  const section = existsSync(path) ? markdownSection(readFileSync(path, "utf8"), heading) : undefined;
  if (!section) {
    violations.push(`${file}: missing ${heading} section`);
    return;
  }
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|"));
  const rows = lines.slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const documented = new Set(rows.map((cells) => cells[0]?.replace(/^`|`$/g, "")));
  const expected = Object.keys(exports).sort();
  if (JSON.stringify([...documented].sort()) !== JSON.stringify(expected)) {
    violations.push(`${file}: maturity table exports differ from package exports`);
  }
  for (const cells of rows) {
    const subpath = cells[0]?.replace(/^`|`$/g, "");
    const contract = subpath ? packageSurface[subpath] : undefined;
    if (!contract) continue;
    const evidence = Array.isArray(contract.packageSmokeEvidence)
      ? contract.packageSmokeEvidence.map((path: unknown) => `\`${String(path)}\``).join("<br>")
      : "";
    const evidenceDiffers = withEvidence ? cells[3] !== evidence : cells.length !== 3;
    if (cells[1] !== contract.role || cells[2] !== contract.maturity || evidenceDiffers) {
      violations.push(`${file}: maturity row differs from release gates for ${subpath}`);
    }
  }
}

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && [".git", "dist", "node_modules"].includes(entry.name)) return [];
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

// ---------------------------------------------------------------------------
// Reader guide, generated regions, compiled fences and instruction-file size.
// Governing document: docs/platform/DOCUMENTATION.md, "Reader guide contract".

const guideDirectory = "docs/guide";
/** Every `AGENTS.md` entry point, package or root, stays within these limits. */
export const agentsFileCap = { lines: 200, bytes: 10240 } as const;
/** The monorepo root when the package sits at `packages/<name>`; undefined in an extracted root. */
export function detectRepositoryRoot(packageRoot: string): string | undefined {
  const candidate = resolve(packageRoot, "..", "..");
  return existsSync(join(candidate, "config", "openlup-packages.json")) ? candidate : undefined;
}

export function assertAgentsFileSize(root: string, file: string, violations: string[], label = file): void {
  const path = join(root, file);
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  const bytes = Buffer.byteLength(source);
  if (lines > agentsFileCap.lines || bytes > agentsFileCap.bytes) {
    violations.push(`${label}: ${lines} lines and ${bytes} bytes exceed the cap of ${agentsFileCap.lines} lines and ${agentsFileCap.bytes} bytes; link to the guide instead`);
  }
}

/**
 * Plans guide regeneration and release-link pins without writing. Paths are absolute;
 * pending files overlay the checkout so callers can include pages not yet written.
 * Only files whose contents change are returned, alongside malformed-region violations.
 */
export function planGuideUpdates(repositoryRoot: string, packageRoot: string, version: string, pendingFiles: ReadonlyMap<string, string> = new Map()): { writes: Array<[string, string]>; violations: string[] } {
  repositoryRoot = resolve(repositoryRoot);
  packageRoot = resolve(packageRoot);
  const guideRoot = join(packageRoot, guideDirectory);
  const sources = new Map(existsSync(guideRoot) ? markdownFiles(guideRoot).map((file) => [file, readFileSync(file, "utf8")] as const) : []);
  for (const [file, source] of pendingFiles) {
    if (file.startsWith(`${guideRoot}${sep}`) && file.endsWith(".md")) sources.set(file, source);
  }
  const writes: Array<[string, string]> = [], violations: string[] = [];
  for (const file of [...sources.keys()].sort()) {
    const original = sources.get(file)!;
    const label = relative(packageRoot, file).split(sep).join("/");
    // Generated links use the target version, so a release's regions point at its own tag.
    const source = pinGuideReleaseLinks(syncGeneratedRegions(original, label, repositoryRoot, true, violations, version), version);
    if (source !== original) writes.push([file, source]);
  }
  return { writes, violations };
}

/** Plan package entry points separately so guide-only regeneration keeps its existing scope. */
export function planPackageDocumentationUpdates(repositoryRoot: string, version: string): Array<[string, string]> {
  const config = readJson<{ packages: Array<{ directory: string; publish: boolean }> }>(repositoryRoot, "config/openlup-packages.json");
  const writes: Array<[string, string]> = [], violations: string[] = [];
  for (const { directory } of config.packages.filter(({ publish }) => publish)) {
    for (const file of ["AGENTS.md", "README.md"]) {
      const path = resolve(repositoryRoot, directory, file);
      if (!existsSync(path)) continue;
      const original = readFileSync(path, "utf8");
      const source = syncGeneratedRegions(original, `${directory}/${file}`, repositoryRoot, true, violations, version)
        .replace(/(https:\/\/github\.com\/openlup\/openlup\/(?:blob|tree)\/openlup-[a-z0-9-]+-v)[0-9A-Za-z.+-]+\//g, (_match, prefix: string) => `${prefix}${version}/`);
      if (source !== original) writes.push([path, source]);
    }
  }
  assert(violations.length === 0, `package documentation planning violations:\n${violations.join("\n")}`);
  return writes;
}

function scriptsForPage(label: string, scripts?: Record<string, string>, starterScripts?: Record<string, string>): Record<string, string> | undefined {
  return /^docs\/guide\/how-to\/(?:build\/customize-the-starter|extend\/catalogue-extension)\.md$/.test(label)
    ? starterScripts : scripts;
}

/**
 * Checks (and with `write`, regenerates) the guide under `docs/guide/`. Returns its Markdown files
 * so the package-wide rules and the fence compiler read the same pages.
 */
export function assertGuideContract(
  packageRoot: string,
  repositoryRoot: string | undefined,
  write: boolean,
  violations: string[],
  packageChecks?: { packed: ReadonlySet<string>; scripts?: Record<string, string>; starterScripts?: Record<string, string>; fences: Map<string, Fence[]> },
): string[] {
  const guideRoot = join(packageRoot, guideDirectory);
  if (!existsSync(guideRoot)) return [];
  const files = markdownFiles(guideRoot).sort();
  if (!repositoryRoot) {
    violations.push(`${guideDirectory}: the guide is checked against the repository; no repository root was found`);
    return files;
  }
  const version = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string }).version;
  const tag = `openlup-core-v${version ?? ""}`;
  const allowed = readGuideAllowList(repositoryRoot, violations);
  const planned = write ? planGuideUpdates(repositoryRoot, packageRoot, version ?? "") : { writes: [], violations: [] };
  violations.push(...planned.violations);
  const updates = new Map(planned.writes);
  for (const file of files) {
    const label = relative(packageRoot, file).split(sep).join("/");
    const original = readFileSync(file, "utf8");
    const source = updates.get(resolve(file)) ?? original;
    if (write && source !== original) writeFileSync(file, source);
    const syncRegions = (markdown: string) => write ? markdown : syncGeneratedRegions(markdown, label, repositoryRoot, false, violations, version);
    if (packageChecks) {
      const { packed, scripts, starterScripts, fences } = packageChecks;
      fences.set(file, assertGuidePage({
        packageRoot, file, label, source, packed, scripts: scriptsForPage(label, scripts, starterScripts),
        repositoryRoot, guideRoot, tag, allowed, syncRegions,
      }, violations));
      continue;
    }
    const checkedSource = syncRegions(source);
    assertGuideTitle(label, checkedSource, violations);
    assertGuideLinks(guideRoot, file, label, checkedSource, repositoryRoot, tag, violations);
    assertReaderLanguage(label, checkedSource, allowed, violations);
  }
  return files;
}

/** Replaces each `<!-- generated:<name> -->` region with its generator's output, or reports a stale one. */
export function syncGeneratedRegions(source: string, label: string, repositoryRoot: string, write: boolean, violations: string[], coreVersion?: string): string {
  const opened = [...source.matchAll(/<!-- generated:([a-z0-9:-]+) -->/g)].length;
  let closed = 0;
  const result = source.replace(/<!-- generated:([a-z0-9:-]+) -->\n([\s\S]*?)<!-- \/generated:\1 -->/g, (region, name: string, body: string) => {
    closed++;
    const expected = renderGeneratedRegion(name, repositoryRoot, coreVersion);
    if (expected === undefined) {
      violations.push(`${label}: unknown generated region ${name}`);
      return region;
    }
    if (name === "refusal-codes") {
      // Check the renderer independently of byte freshness, including during --write.
      assertRefusalCodeReachability(expected, repositoryRoot, violations, label);
      if (!write && body !== expected) assertRefusalCodeReachability(body, repositoryRoot, violations, label);
    }
    if (body === expected) return region;
    if (!write) violations.push(`${label}: generated region ${name} is stale; run docs:check -- --write`);
    return `<!-- generated:${name} -->\n${expected}<!-- /generated:${name} -->`;
  });
  if (opened !== closed) violations.push(`${label}: a generated region is not closed by its matching <!-- /generated:<name> --> marker`);
  return result;
}

/** The generators. Each reads the file that already owns the fact; none keeps a second copy. */
export function renderGeneratedRegion(name: string, repositoryRoot: string, coreVersion = readCoreVersion(repositoryRoot)): string | undefined {
  if (name.startsWith("sql:")) return renderSqlInventory(name, repositoryRoot, coreVersion);
  const link = (path: string, label = path) => repositoryLink(coreVersion, path, label);
  const pkg = /^exports:([a-z]+)$/.exec(name)?.[1];
  if (pkg) {
    if (!(publishedPackages as readonly string[]).includes(pkg)) return undefined;
    const base = `packages/${pkg}`;
    const manifest = readJson<{ exports: Record<string, unknown> }>(repositoryRoot, `${base}/package.json`);
    const gates = readJson<{ packageSurface: Record<string, SurfaceContract> }>(repositoryRoot, `${base}/release-gates.json`);
    const subpaths = Object.keys(codeExports(manifest.exports));
    const omitted = providerSpecificKeys(repositoryRoot, subpaths);
    return markdownTable(["Export", "Role", "Maturity", "API report"], subpaths.filter((subpath) => !omitted.has(subpath)).sort().map((subpath) => {
      const contract = gates.packageSurface[subpath];
      // public-api-config and api-contract use packageSurface.snapshot, including nested subpaths.
      const report = contract?.snapshot;
      return [`\`${subpath}\``, String(contract?.role), String(contract?.maturity), report && existsSync(join(repositoryRoot, base, report)) ? link(`${base}/${report}`, "API report") : "none"];
    })) + omittedSubpaths(pkg, omitted.size, link);
  }
  if (name === "cli:openlup" || name === "cli:openlup-context") {
    // Read static help via the compiler API: no build prerequisite, imports, application loading or
    // child startup. The context bin delegates to agent-context-cli, whose usage constant owns help.
    const path = name === "cli:openlup" ? "packages/platform/src/lifecycle/openlup.mjs" : "packages/core/src/agent-context-cli.ts";
    const constant = name === "cli:openlup" ? "help" : "usage";
    const source = ts.createSourceFile(path, readFileSync(join(repositoryRoot, path), "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === constant && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
          return `\`\`\`text\n${declaration.initializer.text.trimEnd()}\n\`\`\`\n`;
        }
      }
    }
    throw new Error(`${path}: expected a static ${constant} constant`);
  }
  if (name === "versioning") {
    const rows = publishedPackages.flatMap((pkg) => {
      const gates = readJson<{ packageRelease?: Record<string, string>; compatibilityPolicies?: Record<string, string> }>(repositoryRoot, `packages/${pkg}/release-gates.json`);
      return (["packageRelease", "compatibilityPolicies"] as const).flatMap((section) => {
        const fields = Object.entries(gates[section] ?? {}).sort(([left], [right]) => left.localeCompare(right));
        return fields.length ? fields.map(([key, value]) => [`\`@openlup/${pkg}\``, section, key, value]) : [[`\`@openlup/${pkg}\``, section, "none", "not declared"]];
      });
    });
    return `${markdownTable(["Package", "Section", "Field", "Value"], rows)}\n${link(".github/VERSIONING_AND_EOL.md", "Versioning and end-of-life policy")}\n`;
  }
  if (name === "compatibility-policies") {
    // Read the validator's mapping, not a second list inferred from today's exports.
    const path = "packages/core/scripts/public-api-config.ts";
    const source = ts.createSourceFile(path, readFileSync(join(repositoryRoot, path), "utf8"), ts.ScriptTarget.Latest, true);
    const mapping = source.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "compatibilityByMaturity")?.initializer;
    const error = `${path}: expected a nonempty static compatibilityByMaturity object with literal policies`;
    if (!mapping || !ts.isObjectLiteralExpression(mapping) || mapping.properties.length === 0) throw new Error(error);
    const rows = mapping.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) || !ts.isStringLiteralLike(property.initializer)) {
        throw new Error(error);
      }
      return [codeLiteral(property.name.text), codeLiteral(property.initializer.text)];
    }).sort(([left], [right]) => left!.localeCompare(right!));
    return `${markdownTable(["Maturity", "Compatibility policy"], rows)}\n${link(path, "Compatibility policy mapping")}\n`;
  }
  if (name === "refusal-codes" || name === "refusal-codes-open") {
    const types = collectRefusalTypes(repositoryRoot);
    if (name === "refusal-codes-open") {
      return markdownTable(["Package", "Type", "Report", "Open because"], types.filter((type) => type.reason !== undefined)
        .map((type) => [`\`@openlup/${type.packageName}\``, `\`${type.typeName}\``, link(type.report, reportLabel(repositoryRoot, type.packageName, type.report)), type.reason!]));
    }
    const groups = new Map<string, { type: RefusalType; reports: string[] }>();
    for (const type of types.filter((type) => type.codes !== undefined)) {
      const key = JSON.stringify([type.packageName, type.typeName, type.codes]);
      const group = groups.get(key);
      if (group) group.reports.push(type.report);
      else groups.set(key, { type, reports: [type.report] });
    }
    const recipes = catalogueRecipeLinks(repositoryRoot);
    const linkedCode = (code: string): string => recipes.has(code) ? `[${codeLiteral(code)}](${recipes.get(code)})` : codeLiteral(code);
    const rows = [...groups.values()].map(({ type, reports }) => [`\`@openlup/${type.packageName}\``, `\`${type.typeName}\``,
      [...new Set(reports)].sort().map((report) => link(report, reportLabel(repositoryRoot, type.packageName, report))).join(", "), type.codes!.map(linkedCode).join(", ")]);
    if (recipes.size) rows.push(["`@openlup/platform`", "`CatalogConformanceCode`", link("packages/platform/src/catalog/catalogConformance.ts", "catalogue rule record"), [...recipes.keys()].sort().map(linkedCode).join(", ")]);
    const cliPath = "packages/platform/src/lifecycle/openlup.mjs";
    const cliCodes = readCliCodes(repositoryRoot);
    if (cliCodes.length) rows.push(["`@openlup/platform`", "`openlup`", link(cliPath, "command line"), cliCodes.map(codeLiteral).join(", ")]);
    return markdownTable(["Package", "Type", "Reports", "Codes"], rows.sort((left, right) => left[0]!.localeCompare(right[0]!) || left[1]!.localeCompare(right[1]!) || left[3]!.localeCompare(right[3]!)))
      + renderCatalogueRefusals(repositoryRoot);
  }
  const maturity = /^maturity:([a-z]+)$/.exec(name)?.[1];
  if (maturity) {
    if (!(publishedPackages as readonly string[]).includes(maturity)) return undefined;
    const gates = JSON.parse(readFileSync(join(repositoryRoot, "packages", maturity, "release-gates.json"), "utf8")) as { packageSurface?: Record<string, SurfaceContract> };
    const omitted = providerSpecificKeys(repositoryRoot, Object.keys(gates.packageSurface ?? {}));
    const rows = Object.entries(gates.packageSurface ?? {}).filter(([subpath]) => !omitted.has(subpath)).sort(([left], [right]) => left.localeCompare(right))
      .map(([subpath, contract]) => `| \`${subpath}\` | ${String(contract.role)} | ${String(contract.maturity)} |`);
    return ["| Export | Role | Maturity |", "| --- | --- | --- |", ...rows, ""].join("\n") + omittedSubpaths(maturity, omitted.size, link);
  }
  const symbolMaturity = /^maturity-symbols:([a-z]+)$/.exec(name)?.[1];
  if (symbolMaturity) {
    if (!(publishedPackages as readonly string[]).includes(symbolMaturity)) return undefined;
    return renderSymbolMaturity(symbolMaturity, repositoryRoot, link);
  }
  if (name === "configuration-keys") {
    const config = readJson<{ variables: Array<{ name: string; owner: string; category: string; requiredIn: string[]; secret: boolean }> }>(repositoryRoot, "config/environment-variables.json");
    const words = new Set(readdirSync(join(repositoryRoot, "packages")).flatMap((pkg) => sourceFiles(join(repositoryRoot, "packages", pkg, "src")))
      .flatMap((path) => readFileSync(path, "utf8").match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []));
    const read = config.variables.filter((variable) => words.has(variable.name));
    const omitted = providerSpecificKeys(repositoryRoot, read.map((variable) => variable.name));
    const rows = read.filter((variable) => !omitted.has(variable.name)).sort((left, right) => left.name.localeCompare(right.name)).map((variable) =>
      [`\`${variable.name}\``, variable.owner, variable.category, [...variable.requiredIn].sort().join(", ") || "none", variable.secret ? "yes" : "no"]);
    return `${markdownTable(["Name", "Owner", "Category", "Required in", "Secret"], rows)}\n${omitted.size} package-read keys omitted because their names are provider-specific. Complete list: ${link("config/environment-variables.json", "configuration keys")} and ${link("packages/platform/api/", "platform API reports")}.\n`;
  }
  return undefined;
}

function omittedSubpaths(pkg: string, count: number, link: (path: string, label?: string) => string): string {
  return count ? `\n${count} subpaths omitted because their names are provider-specific. Complete list: ${link(`packages/${pkg}/package.json`, "package.json")} and ${link(`packages/${pkg}/AGENTS.md#subpath-maturity`, "Subpath maturity")}.\n` : "";
}

const byCodePoint = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** An API report's `## dist/...` sections by file, as `api:update` wrote them. */
function reportSections(report: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headings = [...report.matchAll(/^## (dist\/[^\n]+\.d\.ts)\n\n```ts\n/gm)];
  headings.forEach((heading, index) => {
    const chunk = report.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? report.length);
    sections.set(heading[1]!, chunk.slice(0, chunk.lastIndexOf("\n```")));
  });
  return sections;
}

export type SymbolMaturityRead = { maturity: string; deprecated: boolean };

/**
 * The effective maturity of every symbol a subpath exports, read with the compiler from the declaration files
 * of its API report: `experimental` for a symbol tagged @experimental, else the subpath's maturity, and whether the
 * symbol is tagged @deprecated. A tag on `export { ... } from` or `export * from` applies to the names that
 * statement exports unless their declaration carries a tag of its own, and the declaration's own comment is the last
 * doc comment before it, as the compiler attaches it. A tag on a member is not read. A name whose declaration is
 * not among `files`, such as one re-exported from another package, is returned in `unresolved`, never guessed.
 */
export function declaredSymbolMaturities(files: ReadonlyMap<string, string>, entrypoint: string, subpathMaturity: string): { symbols: Map<string, SymbolMaturityRead>; unresolved: string[] } {
  const root = "/declaration-report/";
  const options: ts.CompilerOptions = { noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const key = (path: string) => (path.startsWith(root) ? path.slice(root.length) : undefined);
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => {
      const text = key(path) === undefined ? undefined : files.get(key(path)!);
      return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => `${root}lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getDirectories: () => [],
    fileExists: (path) => key(path) !== undefined && files.has(key(path)!),
    directoryExists: (path) => [...files.keys()].some((file) => `${root}${file}`.startsWith(path.endsWith("/") ? path : `${path}/`)),
    readFile: (path) => (key(path) === undefined ? undefined : files.get(key(path)!)),
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const entry = `${root}${entrypoint}`;
  const program = ts.createProgram([entry], options, host);
  const checker = program.getTypeChecker();
  const entryFile = program.getSourceFile(entry);
  const moduleSymbol = entryFile && checker.getSymbolAtLocation(entryFile);
  const symbols = new Map<string, SymbolMaturityRead>();
  const unresolved: string[] = [];
  if (!entryFile || !moduleSymbol) return { symbols, unresolved };

  type Found = { experimental: boolean; deprecated: boolean };
  const tagsOf = (node: ts.Node): Found => {
    const names = new Set(ts.getJSDocTags(node).map((tag) => tag.tagName.text));
    return { experimental: names.has("experimental"), deprecated: names.has("deprecated") };
  };
  const tagged = (tags: Found) => tags.experimental || tags.deprecated;
  const merge = (all: Found[]): Found => ({ experimental: all.some((tags) => tags.experimental), deprecated: all.some((tags) => tags.deprecated) });
  const inherit = (inner: Found, statement: Found): Found => (tagged(inner) || !tagged(statement) ? inner : statement);
  const exportsName = (statement: ts.Statement): string[] => {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) || modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return [];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
    }
    return [];
  };
  const topStatement = (node: ts.Node): ts.Node => {
    let current = node;
    while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
    return current;
  };
  const targetOf = (from: ts.SourceFile, specifier: ts.Expression | undefined): ts.SourceFile | undefined => {
    if (!specifier || !ts.isStringLiteral(specifier)) return undefined;
    const resolved = ts.resolveModuleName(specifier.text, from.fileName, options, host).resolvedModule?.resolvedFileName;
    return resolved === undefined ? undefined : program.getSourceFile(resolved);
  };
  // undefined: the file does not export the name. "unresolved": it does, but the declaration is not among the files.
  const find = (file: ts.SourceFile, name: string, seen: Set<string>): Found | "unresolved" | undefined => {
    const visit = `${file.fileName}\0${name}`;
    if (seen.has(visit)) return "unresolved";
    seen.add(visit);
    const declared: Found[] = [];
    for (const statement of file.statements) if (exportsName(statement).includes(name)) declared.push(tagsOf(statement));
    if (declared.length) return merge(declared);
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
      if (ts.isNamespaceExport(statement.exportClause)) {
        if (statement.exportClause.name.text === name) return tagsOf(statement);
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        if (statement.moduleSpecifier) {
          const target = targetOf(file, statement.moduleSpecifier);
          const inner = target ? find(target, (element.propertyName ?? element.name).text, seen) : "unresolved";
          return inner === undefined || inner === "unresolved" ? "unresolved" : inherit(inner, tagsOf(statement));
        }
        let local = checker.getExportSpecifierLocalTargetSymbol(element);
        if (local && local.flags & ts.SymbolFlags.Alias) local = checker.getAliasedSymbol(local);
        const declarations = local?.declarations ?? [];
        return declarations.length ? merge(declarations.map((declaration) => tagsOf(topStatement(declaration)))) : "unresolved";
      }
    }
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier) continue;
      const target = targetOf(file, statement.moduleSpecifier);
      const inner = target ? find(target, name, seen) : undefined;
      if (inner !== undefined && inner !== "unresolved") return inherit(inner, tagsOf(statement));
    }
    return undefined;
  };

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    if (name === "default" || name === "export=") continue;
    const found = find(entryFile, name, new Set());
    if (found === undefined || found === "unresolved") unresolved.push(name);
    else symbols.set(name, { maturity: found.experimental ? "experimental" : subpathMaturity, deprecated: found.deprecated });
  }
  return { symbols, unresolved: unresolved.sort(byCodePoint) };
}

function renderSymbolMaturity(pkg: string, repositoryRoot: string, link: (path: string, label?: string) => string): string {
  const gatesPath = `packages/${pkg}/release-gates.json`;
  const surface = readJson<{ packageSurface?: Record<string, SurfaceContract> }>(repositoryRoot, gatesPath).packageSurface ?? {};
  const omitted = providerSpecificKeys(repositoryRoot, Object.keys(surface));
  const rows: { subpath: string; symbol: string; maturity: string; deprecated: boolean }[] = [];
  let unresolved = 0;
  for (const subpath of Object.keys(surface).filter((candidate) => !omitted.has(candidate)).sort(byCodePoint)) {
    const contract = surface[subpath]!;
    if (typeof contract.snapshot !== "string" || typeof contract.entrypoint !== "string") {
      throw new Error(`${gatesPath}: surface ${subpath} declares no snapshot or no entrypoint; its API report cannot be read for symbol maturity`);
    }
    const report = `packages/${pkg}/${contract.snapshot}`;
    if (!existsSync(join(repositoryRoot, report))) throw new Error(`${report}: missing API report for ${subpath}; run npm run api:update`);
    const files = reportSections(readFileSync(join(repositoryRoot, report), "utf8"));
    if (!files.has(contract.entrypoint)) throw new Error(`${report}: no section for ${contract.entrypoint}; run npm run api:update`);
    const maturity = String(contract.maturity);
    const read = declaredSymbolMaturities(files, contract.entrypoint, maturity);
    unresolved += read.unresolved.length;
    for (const [symbol, value] of read.symbols) if (value.deprecated || value.maturity !== maturity) rows.push({ subpath, symbol, ...value });
  }
  const flagged = providerSpecificKeys(repositoryRoot, rows.map((row) => row.symbol));
  const kept = rows.filter((row) => !flagged.has(row.symbol)).sort((left, right) => byCodePoint(left.subpath, right.subpath) || byCodePoint(left.symbol, right.symbol));
  const table = kept.length
    ? markdownTable(["Export", "Symbol", "Maturity", "Deprecated"], kept.map((row) => [`\`${row.subpath}\``, `\`${row.symbol}\``, row.maturity, row.deprecated ? "yes" : "no"]))
    : "No symbol of this package differs from its subpath's maturity or is deprecated.\n";
  const notes = [
    rows.length > kept.length ? `${rows.length - kept.length} symbols omitted because their names are provider-specific.\n` : "",
    unresolved ? `${unresolved} symbols are not listed because their declarations are not in this package's API reports.\n` : "",
  ].filter(Boolean).map((note) => `\n${note}`).join("");
  return table + notes + omittedSubpaths(pkg, omitted.size, link);
}

function readJson<T>(root: string, path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const vendorPatternCache = new Map<string, { raw: string; patterns: RegExp[] }>();

function parseRegexLiteral(text: string, preserveStatefulFlags: boolean): RegExp {
  const lastSlash = text.lastIndexOf("/");
  const source = text.slice(1, lastSlash);
  const rawFlags = text.slice(lastSlash + 1);
  return new RegExp(source, preserveStatefulFlags ? rawFlags : rawFlags.replace(/[gy]/gu, ""));
}

function evalStaticString(
  node: ts.Expression,
  initializers: ReadonlyMap<string, ts.Expression>,
  bindings: Map<string, string>,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isParenthesizedExpression(node)) return evalStaticString(node.expression, initializers, bindings, sourceFile);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const cached = bindings.get(node.text);
    if (cached !== undefined) return cached;
    const initializer = initializers.get(node.text);
    assert(initializer !== undefined, `${sourceFile.fileName}: unsupported identifier ${node.text} in neutrality scanner`);
    const resolved = evalStaticString(initializer, initializers, bindings, sourceFile);
    bindings.set(node.text, resolved);
    return resolved;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return evalStaticString(node.left, initializers, bindings, sourceFile) + evalStaticString(node.right, initializers, bindings, sourceFile);
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => evalStaticString(span.expression, initializers, bindings, sourceFile) + span.literal.text).join("");
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const receiver = evalStaticString(node.expression.expression, initializers, bindings, sourceFile);
    if (method === "toUpperCase" && node.arguments.length === 0) return receiver.toUpperCase();
    if (method === "toLowerCase" && node.arguments.length === 0) return receiver.toLowerCase();
    if (method === "replace" && node.arguments.length === 2) {
      const first = node.arguments[0]!;
      const search = ts.isRegularExpressionLiteral(first)
        ? parseRegexLiteral(first.text, true)
        : evalStaticString(first, initializers, bindings, sourceFile);
      return receiver.replace(search, evalStaticString(node.arguments[1]!, initializers, bindings, sourceFile));
    }
  }
  throw new Error(`${sourceFile.fileName}: unsupported string expression in neutrality scanner`);
}

function evalStaticRegex(
  node: ts.Expression,
  initializers: ReadonlyMap<string, ts.Expression>,
  bindings: Map<string, string>,
  sourceFile: ts.SourceFile,
): RegExp {
  if (ts.isParenthesizedExpression(node)) return evalStaticRegex(node.expression, initializers, bindings, sourceFile);
  if (ts.isRegularExpressionLiteral(node)) return parseRegexLiteral(node.text, false);
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
    const args = node.arguments ?? [];
    assert(args.length >= 1 && args.length <= 2, `${sourceFile.fileName}: unexpected RegExp argument count in neutrality scanner`);
    const pattern = evalStaticString(args[0]!, initializers, bindings, sourceFile);
    const flags = args[1] ? evalStaticString(args[1], initializers, bindings, sourceFile).replace(/[gy]/gu, "") : "";
    return new RegExp(pattern, flags);
  }
  throw new Error(`${sourceFile.fileName}: unsupported regex expression in neutrality scanner`);
}

function vendorPatterns(repositoryRoot: string): readonly RegExp[] {
  const path = join(repositoryRoot, "packages/ui/smoke/neutrality.ts");
  const raw = readFileSync(path, "utf8");
  const cached = vendorPatternCache.get(path);
  if (cached?.raw === raw) return cached.patterns;

  const source = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
  const initializers = new Map<string, ts.Expression>();
  let patternList: ts.ArrayLiteralExpression | undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (declaration.name.text === "forbiddenPatterns" && ts.isArrayLiteralExpression(declaration.initializer)) {
        patternList = declaration.initializer;
      } else {
        initializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const bindings = new Map<string, string>();
  const patterns: RegExp[] = [];
  for (const element of patternList?.elements ?? []) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const label = element.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "label");
    if (!label || !ts.isPropertyAssignment(label) || !ts.isStringLiteral(label.initializer) || !label.initializer.text.startsWith("vendor:")) continue;
    const patternProp = element.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "pattern");
    assert(patternProp && ts.isPropertyAssignment(patternProp), `${path}: vendor rule ${label.initializer.text} missing pattern`);
    patterns.push(evalStaticRegex(patternProp.initializer, initializers, bindings, source));
  }
  assert(patterns.length > 0, `${path}: missing vendor vocabulary in neutrality scanner`);
  vendorPatternCache.set(path, { raw, patterns });
  return patterns;
}

/** Uses the repository scanner's vendor rules, including its scoped-package pattern, on arbitrary strings and their name components. */
export function providerSpecificKeys(repositoryRoot: string, names: string[]): Set<string> {
  const patterns = vendorPatterns(repositoryRoot);
  if (names.length === 0) return new Set();
  // scanSnapshots uses this same --counts-json probing shape. Probe name components as words and
  // scoped packages, including environment keys and export paths, without bypassing either pattern.
  const flagged = new Set<string>();
  for (const name of names) {
    const contents = `${name} ${name.split(/[^A-Za-z0-9-]+/).filter(Boolean).map((part) => `@${part}/ ${part}`).join(" ")}`;
    if (patterns.some((pattern) => pattern.test(contents))) flagged.add(name);
  }
  return flagged;
}

/** Selection rule A, shared by the inventory and its reachability check. */
export const refusalTypeSuffixes = ["Refusal", "RefusalCode", "RejectionReason", "FailureReason", "BlockReason", "ErrorCode", "ReasonCode", "Code"] as const;

type RefusalType = { packageName: string; typeName: string; report: string; codes?: string[]; reason?: string };

function unparenthesized(type: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(type) ? unparenthesized(type.type) : type;
}

function literalCodes(nodes: readonly ts.TypeNode[], allowNull: boolean): string[] | undefined {
  const codes: string[] = [];
  const visit = (node: ts.TypeNode): boolean => {
    const type = unparenthesized(node);
    if (allowNull && ts.isUnionTypeNode(type)) return type.types.every(visit);
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) { codes.push(type.literal.text); return true; }
    return allowNull && ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword;
  };
  return nodes.every(visit) && codes.length ? [...new Set(codes)].sort() : undefined;
}

// Ordinary codes stay readable in Markdown source; unusual string literals remain lossless and
// cannot split a table or end a code span. Reachability decodes the same HTML character references.
const codeCharacters: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "\n": "&#10;", "\r": "&#13;", "`": "&#96;" };
function codeLiteral(value: string): string {
  return value && !/[`|\r\n]/.test(value) ? `\`${value}\`` : `<code>${value.replace(/[&<>|\r\n`]/g, (character) => codeCharacters[character]!)}</code>`;
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function classifyRefusal(type: ts.TypeNode, constants: Map<string, ts.TypeNode[]>): Pick<RefusalType, "codes" | "reason"> {
  type = unparenthesized(type);
  const codes = literalCodes(ts.isUnionTypeNode(type) ? type.types : [type], true);
  if (codes) return { codes };
  if (ts.isIndexedAccessTypeNode(type) && type.indexType.kind === ts.SyntaxKind.NumberKeyword) {
    const object = unparenthesized(type.objectType);
    if (ts.isTypeQueryNode(object) && ts.isIdentifier(object.exprName)) {
      const name = object.exprName.text;
      const declarations = constants.get(name) ?? [];
      const resolved = declarations.map((declaration) => {
        const tuple = unparenthesized(declaration);
        return ts.isTypeOperatorNode(tuple) && tuple.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isTupleTypeNode(tuple.type)
          ? literalCodes(tuple.type.elements, false) : undefined;
      });
      if (resolved.length && resolved.every((value) => value !== undefined && JSON.stringify(value) === JSON.stringify(resolved[0]))) return { codes: resolved[0] };
      return { reason: `unresolved string-literal tuple ${name}` };
    }
  }
  const members = ts.isUnionTypeNode(type) ? type.types.map(unparenthesized) : [type];
  if (members.some(ts.isTypeLiteralNode)) return { reason: "object type" };
  if (members.some(ts.isIntersectionTypeNode)) return { reason: "intersection type permits values beyond string literals" };
  if (members.some(ts.isTypeReferenceNode)) return { reason: "reference to another type" };
  return { reason: "definition is not a closed set of string literals" };
}

// Parsing every API report is the slowest generator; the region, the open list and the
// reachability check share one parse per unchanged set of report files.
const refusalTypeCache = new Map<string, RefusalType[]>();
function collectRefusalTypes(repositoryRoot: string): RefusalType[] {
  // Keyed by the exact report bytes: reading is cheap next to parsing, and no stale entry survives an edit.
  const hash = createHash("sha256");
  for (const packageName of publishedPackages) {
    const directory = join(repositoryRoot, "packages", packageName, "api");
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter((file) => file.endsWith(".api.md")).sort()) {
      hash.update(`${packageName}/${file}\0`).update(readFileSync(join(directory, file))).update("\0");
    }
  }
  const key = hash.digest("hex");
  const cached = refusalTypeCache.get(key);
  if (cached) return cached;
  const result = collectRefusalTypesUncached(repositoryRoot);
  refusalTypeCache.set(key, result);
  return result;
}

function collectRefusalTypesUncached(repositoryRoot: string): RefusalType[] {
  const found: RefusalType[] = [];
  for (const packageName of publishedPackages) {
    const directory = join(repositoryRoot, "packages", packageName, "api");
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter((file) => file.endsWith(".api.md")).sort()) {
      const report = `packages/${packageName}/api/${file}`;
      const statements = typeScriptFences(readFileSync(join(repositoryRoot, report), "utf8"))
        .flatMap((fence, index) => [...ts.createSourceFile(`${report}.${index}.ts`, fence.code, ts.ScriptTarget.Latest, true).statements]);
      const constants = new Map<string, ts.TypeNode[]>();
      for (const statement of statements) {
        // A selected exported alias may index a constant the report declares without exporting it.
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.type) {
            constants.set(declaration.name.text, [...constants.get(declaration.name.text) ?? [], declaration.type]);
          }
        }
      }
      for (const statement of statements) {
        if (!ts.isTypeAliasDeclaration(statement) || !exported(statement) || !refusalTypeSuffixes.some((suffix) => statement.name.text.endsWith(suffix))) continue;
        found.push({ packageName, typeName: statement.name.text, report, ...classifyRefusal(statement.type, constants) });
      }
    }
  }
  return [...new Map(found.map((type) => [JSON.stringify(type), type])).values()]
    .sort((left, right) => left.packageName.localeCompare(right.packageName) || left.typeName.localeCompare(right.typeName) || left.report.localeCompare(right.report) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/** Selected aliases whose reports do not establish a closed code set; never silently discarded. */
export function listOpenRefusalTypes(repositoryRoot: string): RefusalType[] {
  return collectRefusalTypes(repositoryRoot).filter((type) => type.reason !== undefined);
}

function reportLabel(repositoryRoot: string, packageName: string, report: string): string {
  const gates = readJson<{ packageSurface: Record<string, SurfaceContract> }>(repositoryRoot, `packages/${packageName}/release-gates.json`);
  const subpaths = Object.entries(gates.packageSurface).filter(([, contract]) => `packages/${packageName}/${contract.snapshot}` === report)
    .map(([subpath]) => `\`${subpath}\``).sort();
  return subpaths.length ? subpaths.join(", ") : report.split("/").at(-1)!;
}

function readCliCodes(repositoryRoot: string): string[] {
  const path = join(repositoryRoot, "packages/platform/src/lifecycle/openlup.mjs");
  if (!existsSync(path)) return [];
  return [...new Set(readFileSync(path, "utf8").match(/\bOPENLUP_E_[A-Z_]+\b/g) ?? [])].filter((code) => code.startsWith("OPENLUP_E_CLI_")).sort();
}

function catalogueBindings(repositoryRoot: string, file: string): Map<string, ts.Expression> {
  const path = join(repositoryRoot, "packages/platform/src/catalog", file);
  if (!existsSync(path)) return new Map();
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (ts.isIdentifier(name) && initializer) bindings.set(name.text, initializer);
    }
  }
  return bindings;
}

function catalogueFields(expression: ts.Expression | undefined, allowConformanceSpread = false): Map<string, ts.Expression> {
  while (expression && (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))) expression = expression.expression;
  if (!expression || !ts.isObjectLiteralExpression(expression)) throw new Error("Catalogue refusal metadata must be a static object");
  const fields = new Map<string, ts.Expression>();
  for (const property of expression.properties) {
    if (allowConformanceSpread && ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)
      && property.expression.text === "CATALOG_CONFORMANCE_RULES") continue;
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      throw new Error("Catalogue refusal metadata must use named static properties");
    fields.set(property.name.text, property.initializer);
  }
  return fields;
}

function catalogueText(expression: ts.Expression | undefined, bindings?: Map<string, ts.Expression>): string {
  const value = expression && ts.isIdentifier(expression) ? bindings?.get(expression.text) : expression;
  if (!value || !ts.isStringLiteralLike(value)) throw new Error("Catalogue refusal text must be literal");
  return value.text;
}

function renderCatalogueRefusals(repositoryRoot: string): string {
  const publication = catalogueBindings(repositoryRoot, "publicationError.ts");
  const builder = catalogueBindings(repositoryRoot, "releaseDraftBuilder.ts");
  if (!publication.size && !builder.size) return "";
  const rows: string[][] = [];
  for (const [code, entry] of catalogueFields(publication.get("publicationRefusals"), true)) {
    if (!code.startsWith("catalog_publication_")) continue;
    let reason: ts.Expression | undefined, fix: ts.Expression | undefined, cause: ts.Expression | undefined;
    if (ts.isArrayLiteralExpression(entry)) {
      [reason, fix, cause] = entry.elements;
    } else {
      const fields = catalogueFields(entry);
      fix = fields.get("fix");
      cause = fields.get("cause");
    }
    rows.push([codeLiteral(code), reason ? codeLiteral(catalogueText(reason)) : "", cause ? catalogueText(cause) : "", catalogueText(fix, publication)]);
  }
  rows.sort(([left], [right]) => left! < right! ? -1 : left! > right! ? 1 : 0);
  const refusal = catalogueFields(builder.get("releaseDraftRefusal"));
  const fixes = catalogueFields(refusal.get("fixes"));
  const shape = catalogueFields(fixes.get("shape"));
  fixes.delete("shape");
  const variants = [...fixes.values()].map(entry => {
    const fields = catalogueFields(entry);
    return [catalogueText(fields.get("when")), catalogueText(fields.get("fix"))];
  });
  return "\n## Catalogue refusal code fixes\n\n"
    + "Cause is shown when the owner supplies a sentence explaining the refusal.\n\n"
    + markdownTable(["Code", "Reason", "Cause", "Fix"], rows)
    + `\n### ${codeLiteral(catalogueText(refusal.get("code")))}\n\n`
    + `**Cause** ${catalogueText(refusal.get("cause"))}\n\n**Fix** ${catalogueText(shape.get("fix"))}\n\n`
    + markdownTable(["When", "Fix"], variants);
}

/** Derive installed recipe links from the exhaustive owner record, without executing pack code. */
export function catalogueRecipeLinks(repositoryRoot: string): Map<string, string> {
  const path = join(repositoryRoot, "packages/platform/src/catalog/catalogConformance.ts");
  if (!existsSync(path)) return new Map();
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === "CATALOG_CONFORMANCE_RULES");
  const call = declaration?.initializer;
  const record = call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
  if (!record || !ts.isObjectLiteralExpression(record)) throw new Error("Catalogue rule record must remain a static typed object");
  const links = new Map<string, string>();
  for (const property of record.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      || !ts.isCallExpression(property.initializer) || !ts.isIdentifier(property.initializer.expression)
      || property.initializer.expression.text !== "rule") throw new Error("Catalogue rule metadata must use rule(rule, fix, recipe)");
    const anchor = property.initializer.arguments[2];
    if (!anchor || !ts.isStringLiteral(anchor)) throw new Error("Catalogue recipe anchor must be literal");
    links.set(property.name.text, `../how-to/extend/catalogue-extension.md#${anchor.text}`);
  }
  return links;
}

export function assertCatalogueRecipeReachability(rendered: string, repositoryRoot: string, violations: string[]): void {
  const links = catalogueRecipeLinks(repositoryRoot);
  if (!links.size) return;
  const guide = readFileSync(join(repositoryRoot, "packages/core/docs/guide/how-to/extend/catalogue-extension.md"), "utf8");
  const anchors = new Set([...guide.matchAll(/^## (.+)$/gm)].map(match => match[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")));
  for (const [code, recipe] of links) {
    if (!anchors.has(recipe.split("#")[1]!)) violations.push(`catalogue recipe missing anchor: ${recipe}`);
    if (!rendered.includes(`[${codeLiteral(code)}](${recipe})`)) violations.push(`catalogue code missing recipe link: ${code}`);
  }
  for (const match of rendered.matchAll(/\[(`[^`]+`)\]\((\.\.\/how-to\/extend\/catalogue-extension\.md#[^)]+)\)/g)) {
    if (links.get(match[1]!.slice(1, -1)) !== match[2]) violations.push(`catalogue recipe link has no matching owner code: ${match[1]}`);
  }
}

/** Independent inventory-to-render check: byte freshness alone cannot catch a lossy renderer. */
export function assertRefusalCodeReachability(rendered: string, repositoryRoot: string, violations: string[], label = "refusal-codes"): void {
  const codes = new Set([...collectRefusalTypes(repositoryRoot).flatMap((type) => type.codes ?? []), ...readCliCodes(repositoryRoot)]);
  // Codes must be table cell contents, not an incidental mention in a link or explanatory prose.
  const decoded = Object.fromEntries(Object.entries(codeCharacters).map(([character, entity]) => [entity, character]));
  const visible = new Set(rendered.split("\n").filter((line) => line.startsWith("|"))
    .flatMap((line) => [...line.slice(line.lastIndexOf("|", line.length - 2) + 1, line.lastIndexOf("|")).matchAll(/`([^`]+)`|<code>(.*?)<\/code>/g)]
      .map((match) => match[1] ?? match[2]!.replace(/&(?:amp|lt|gt|#124|#10|#13|#96);/g, (entity) => decoded[entity]!))));
  assertCatalogueRecipeReachability(rendered, repositoryRoot, violations);
  const missing = [...codes].filter((code) => !visible.has(code)).sort();
  if (missing.length) violations.push(`${label}: refusal-codes is missing reachable codes: ${missing.join(", ")}`);
}

// Reuse only immutable TypeScript libraries; package and dependency declarations stay fresh.
const fenceCompilerHosts = new Map<string, ts.CompilerHost>();
function fenceCompilerHost(options: ts.CompilerOptions): ts.CompilerHost {
  const key = JSON.stringify(options);
  const existing = fenceCompilerHosts.get(key);
  if (existing) return existing;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const libraries = new Map<string, ts.SourceFile>();
  const libraryRoot = dirname(ts.getDefaultLibFilePath(options));
  host.getSourceFile = (name, language, ...rest) => {
    if (dirname(name) !== libraryRoot || !/^lib(?:\..*)?\.d\.ts$/.test(name.slice(libraryRoot.length + 1))) return getSourceFile(name, language, ...rest);
    const libraryKey = `${name}:${JSON.stringify(language)}`;
    const cached = libraries.get(libraryKey);
    if (cached) return cached;
    const source = getSourceFile(name, language, ...rest);
    if (source) libraries.set(libraryKey, source);
    return source;
  };
  fenceCompilerHosts.set(key, host);
  return host;
}

/**
 * Type-checks every `ts` fence against the built packages. A fence byte-identical to one of the
 * `compiledSources` is already compiled by the package's own smoke typecheck. A fence that must not
 * compile is marked `ts nocheck` and opens with a `//` reason line.
 */
export function assertCompiledFences(
  packageRoot: string,
  files: string[],
  violations: string[],
  compiledSources: string[] = [],
  checkedFences: ReadonlyMap<string, readonly Fence[]> = new Map(),
): void {
  const proven = new Set(compiledSources.map((path) => join(packageRoot, path)).filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8")));
  const virtual = new Map<string, { label: string; line: number; code: string }>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const label = relative(packageRoot, file).split(sep).join("/");
    const fences = checkedFences.get(file) ?? checkedTypeScriptFences(label, readFileSync(file, "utf8"), violations);
    for (const fence of fences) {
      if (proven.has(fence.code)) continue;
      virtual.set(join(packageRoot, `__documentation_fence_${virtual.size}.${fence.extension}`), { label, line: fence.line, code: `${fence.code}\nexport {};\n` });
    }
  }
  if (virtual.size === 0) return;
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, skipLibCheck: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"],
    // Node's declarations come from this tool's installation, wherever the checked package sits.
    typeRoots: [dirname(dirname(createRequire(import.meta.url).resolve("@types/node/package.json")))],
  };
  const host = { ...fenceCompilerHost(options) };
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => virtual.has(name) || fileExists.call(host, name);
  host.readFile = (name) => virtual.get(name)?.code ?? readFile.call(host, name);
  host.getSourceFile = (name, language, ...rest) => {
    const entry = virtual.get(name);
    return entry ? ts.createSourceFile(name, entry.code, language) : getSourceFile.call(host, name, language, ...rest);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const entry = diagnostic.file ? virtual.get(diagnostic.file.fileName) : undefined;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (!entry) {
      violations.push(`TypeScript fences: ${message}`);
      continue;
    }
    const offset = diagnostic.start === undefined ? 0 : diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start).line;
    violations.push(`${entry.label}:${entry.line + offset}: TypeScript fence does not compile: ${message}`);
  }
}

/** The documentation contract of a package other than core: agent guide, size cap, compiled fences and regions. */
export function assertPackageDocumentation(packageRoot: string, exampleSource: string | null, packedFiles?: () => string[], options: { write?: boolean } = {}): void {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const gates = JSON.parse(readFileSync(join(packageRoot, "release-gates.json"), "utf8"));
  const packed = new Set(packedFiles ? packedFiles() : (packDryRun(packageRoot).files ?? []).map((file) => file.path));
  const violations: string[] = [];
  syncPackageRegions(packageRoot, detectRepositoryRoot(packageRoot), options.write === true, violations);
  assertAgentGuide(packageRoot, gates.kind, codeExports(manifest.exports), gates.packageSurface, packed, violations, exampleSource);
  assertAgentsFileSize(packageRoot, "AGENTS.md", violations);
  const readmePath = join(packageRoot, "README.md");
  if (existsSync(readmePath)) assertPublishableReadmeContent("README.md", readFileSync(readmePath, "utf8"), violations);
  assertCompiledFences(packageRoot, [join(packageRoot, "README.md"), join(packageRoot, "AGENTS.md")], violations, exampleSource ? [exampleSource] : []);
  assert(violations.length === 0, `documentation contract violations:\n${violations.join("\n")}`);
  console.log(`package documentation contract ok (${relative(resolve(packageRoot, ".."), packageRoot) || packageRoot})`);
}

function syncPackageRegions(packageRoot: string, repositoryRoot: string | undefined, write: boolean, violations: string[]): void {
  if (!repositoryRoot) return;
  for (const file of ["README.md", "AGENTS.md"]) {
    const path = join(packageRoot, file);
    if (!existsSync(path)) continue;
    const original = readFileSync(path, "utf8");
    const source = syncGeneratedRegions(original, file, repositoryRoot, write, violations);
    if (write && source !== original) writeFileSync(path, source);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 0) assertDocumentationContract();
  else if (args.length === 1 && args[0] === "--write") {
    assertDocumentationContract(defaultPackageRoot, undefined, { repositoryRoot: detectRepositoryRoot(defaultPackageRoot), write: true });
  } else if ((args.length === 2 || args.length === 3) && args[0] === "--plan-guide") {
    // The root release tools run this helper from the candidate repository root.
    const repositoryRoot = resolve(args[2] ?? process.cwd()), packageRoot = join(repositoryRoot, "packages/core");
    const guideRoot = join(packageRoot, guideDirectory), version = args[1]!;
    const input: unknown = JSON.parse(readFileSync(0, "utf8"));
    assert(input !== null && typeof input === "object" && !Array.isArray(input), "pending guide files must be a JSON object of paths and contents");
    const pending = new Map<string, string>();
    for (const [path, source] of Object.entries(input)) {
      const file = resolve(packageRoot, path);
      assert(file.startsWith(`${guideRoot}${sep}`) && file.endsWith(".md") && typeof source === "string", `invalid pending guide file ${path}`);
      pending.set(file, source);
    }
    const planned = planGuideUpdates(repositoryRoot, packageRoot, version, pending);
    planned.writes.push(...planPackageDocumentationUpdates(repositoryRoot, version));
    const updates = new Map(planned.writes), pageViolations: Record<string, string[]> = {};
    if (pending.size > 0) {
      const allowed = readGuideAllowList(repositoryRoot, planned.violations);
      for (const [file, original] of pending) {
        const source = updates.get(file) ?? original, violations: string[] = [];
        const label = relative(packageRoot, file).split(sep).join("/");
        assertReaderLanguage(label, source, allowed, violations);
        assertGuideLinks(guideRoot, file, label, source, repositoryRoot, `openlup-core-v${version}`, violations);
        pageViolations[file] = violations;
      }
    }
    console.log(JSON.stringify({ ...planned, pageViolations }));
  } else if (args.length === 2 && args[0] === "--check-guide") {
    const packageRoot = resolve(args[1]!), violations: string[] = [];
    assertGuideContract(packageRoot, resolve(packageRoot, "../.."), false, violations);
    assert(violations.length === 0, `guide contract violations:\n${violations.join("\n")}`);
    console.log("guide contract ok");
  } else if (args[0] === "--package" && args[1] && !args[1].startsWith("-")
    && args.length >= 2 && args.length <= 4
    && (args.length === 2 || (args.length === 3 && (args[2] === "--write" || !args[2]!.startsWith("-")))
      || (args.length === 4 && !args[2]!.startsWith("-") && args[3] === "--write"))) {
    const write = args.at(-1) === "--write";
    assertPackageDocumentation(resolve(args[1]), args[2] && args[2] !== "--write" ? args[2] : null, undefined, { write });
  } else if (args.length === 3 && args[0] === "--agent-guide" && args.slice(1).every((arg) => !arg.startsWith("-"))) {
    // Root source tooling can check another package without importing its helpers.
    const packageRoot = resolve(args[1]);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const gates = JSON.parse(readFileSync(join(packageRoot, "release-gates.json"), "utf8"));
    const packed = new Set((packDryRun(packageRoot).files ?? []).map(file => file.path));
    const violations: string[] = [];
    assertAgentGuide(packageRoot, gates.kind, codeExports(manifest.exports), gates.packageSurface, packed, violations, args[2]);
    assert(violations.length === 0, `agent guide contract violations:\n${violations.join("\n")}`);
  } else throw new Error("Usage: documentation-contract.ts [--write | --plan-guide <version> [<repository-root>] | --check-guide <package-root> | --agent-guide <package-root> <example-source> | --package <package-root> [<example-source>] [--write]]");
}
