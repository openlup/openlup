#!/usr/bin/env node
// Self-checks for an already-published checkout; source-only partition inputs stay out of --policy.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { EXPLICIT_PUBLIC_PROJECTION_PATHS, PUBLIC_EXECUTION_ENTRYPOINTS, SOURCE_RELEASE_CONTRACT_PATH, assertExplicitPublicProjectionWrites, isDirectExecutionEntrypoint, publicProjectionSource, type ProjectionWrite, validateSourceReleaseContract } from "./oss-publication-contract.ts";
import { PUBLICATION_CATALOG_PATH, PUBLIC_POLICY_REGISTRY_PATH, createPublicPublicationCatalog, packageExecutionDigest, parsePublicPolicyRegistry, parsePublicPublicationCatalog, publicPublicationCatalogDigests, type PublicPackageExecutionSurface } from "./oss-publication-policy.ts";
import { carriesPrivateOperationalCoordinate } from "./oss-public-coordinate-detector.ts";
import { runPlatformMigrationManifestCheck } from "./platform-migration-manifest.ts";
import { comparePublicTypecheck, readPublicTypecheckCompatibility, runPublicTypecheckProjects, summarizePublicDiagnostics } from "./oss-public-typecheck.ts";

const MANIFEST = "package.json";
export type ProjectionDriftRow = { selector: string; sourceSelector: string | null; source: { disposition: "present" | "absent"; digest: string | null }; public: { disposition: "projected" | "absent"; digest: string | null } };

export type MaterializedOutputBytesInput = { sourceRoot: string; publicRoot: string; copiedSourcePaths: Iterable<string>; flattenedOutput: { path: string; contents: string | Buffer }; projectionWrites: Iterable<ProjectionWrite>; additionalProjectionPaths?: Iterable<string> };

const trackedFiles = (root: string): string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);

const fileDigest = (path: string): string => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
function sourceState(root: string, selector: string | null): ProjectionDriftRow["source"] {
  if (selector === null || !existsSync(join(root, selector))) return { disposition: "absent", digest: null };
  return { disposition: "present", digest: fileDigest(join(root, selector)) };
}

function publicState(root: string, selector: string): ProjectionDriftRow["public"] {
  if (!existsSync(join(root, selector))) return { disposition: "absent", digest: null };
  return { disposition: "projected", digest: fileDigest(join(root, selector)) };
}

function assertMaterializedMarkdownLinks(root: string, paths: Iterable<string>): void {
  const inventory = new Set(paths); const exactPath = /^(?:(?:\.\.?\/)|(?:\.github|api|config|db|deploy|docs|mcp|packages|scripts|server|src|supabase|tests)\/)[A-Za-z0-9_.@%+[\]/-]+\.(?:md|json|ts|tsx|js|mjs|cjs|sh|sql|toml|ya?ml)(?:#[A-Za-z0-9_.:-]+)?$/u;
  const variants = (path: string): string[] => path.endsWith(".mjs") ? [path, `${path.slice(0, -4)}.mts`] : path.endsWith(".cjs") ? [path, `${path.slice(0, -4)}.cts`] : path.endsWith(".js") ? [path, `${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`] : [path];
  for (const path of inventory) {
    if (!path.endsWith(".md")) continue;
    const markdown = readFileSync(join(root, path), "utf8");
    for (const [, raw] of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
      if (raw.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(raw)) continue;
      const target = raw.split(/[?#]/u)[0]; const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const candidate = posix.normalize(posix.join(parent, target)); const materialized = candidate !== ".." && !candidate.startsWith("../") && (inventory.has(candidate) || (target.endsWith("/") && [...inventory].some((item) => item.startsWith(`${candidate}/`)))); if (target !== "" && !materialized) throw new Error(`${path}: local Markdown link is missing ${raw}`);
    }
    for (const [, raw] of markdown.matchAll(/`([^`\n]+)`/gu)) {
      if (!exactPath.test(raw)) continue;
      const target = raw.split("#", 1)[0]; const parent = posix.dirname(path) === "." ? "" : posix.dirname(path); let workspace = parent;
      while (workspace !== "" && !inventory.has(`${workspace}/package.json`)) workspace = workspace.includes("/") ? workspace.slice(0, workspace.lastIndexOf("/")) : "";
      const bases = /^\.\.?\//u.test(raw) ? [parent] : ["", workspace]; const candidates = [...new Set(bases.flatMap((base) => variants(posix.normalize(posix.join(base, target)))))].filter((candidate) => candidate !== ".." && !candidate.startsWith("../"));
      if (!candidates.some((candidate) => inventory.has(candidate))) throw new Error(`${path}: inline-code repository path is missing ${raw}`);
    }
  }
} function assertMaterializedRepositoryDocReferences(root: string, paths: Set<string>): void { for (const path of paths) { const bytes = readFileSync(join(root, path)); if (bytes.includes(0)) continue; const contents = bytes.toString("utf8"); if (new RegExp(["real GitHub", " schedule|Production runs ", "measured|production runs ", "measured on|github\\.com\\/example\\/app"].join(""), "iu").test(contents)) throw new Error(`${path}: private schedule provenance or dead runtime default is present in the public tree`); for (const match of contents.matchAll(/["']\/(docs\/[A-Za-z0-9_.@%+[\]/-]+\.md)(?:#[A-Za-z0-9_.:-]+)?["']/gu)) if (!paths.has(match[1]!)) throw new Error(`${path}: runtime runbook reference is absent from the public tree: ${match[0]}`); for (const match of contents.matchAll(/["'](\.agents\/hooks\/[A-Za-z0-9_.@%+[\]/-]+)["']/gu)) if (!paths.has(match[1]!)) throw new Error(`${path}: runtime support reference is absent from the public tree: ${match[0]}`); } }

function assertMaterializedExecutionReferences(root: string, paths: Set<string>, commands: Set<string>): void {
  const packageCommands = (path: string): readonly [string, Set<string>] => { let parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; for (;;) { const manifest = parent === "" ? MANIFEST : `${parent}/${MANIFEST}`; if (paths.has(manifest)) return [manifest, new Set(Object.keys((JSON.parse(readFileSync(join(root, manifest), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}))]; if (parent === "") return [MANIFEST, commands]; parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : ""; } };
  const workspaceCommandSets = (path: string, invocation: string): readonly (readonly [string, Set<string>])[] | null => { const selectors = [...invocation.matchAll(/(?:^|\s)(?:--workspace|-w)(?:=|\s+)([^\s`"']+)/gu)].map((match) => (match[1] ?? "").replace(/^\.\//u, "").replace(/\/+$/u, "")); const invalidMode = /(?:^|\s)(?:--workspaces|-ws)=((?!true(?:\s|$)|false(?:\s|$))[^\s`"']+)/u.exec(invocation)?.[1]; if (invalidMode) throw new Error(`${path}: unsupported npm workspaces mode: ${invalidMode}`); const workspaceModes = [...invocation.matchAll(/(?:^|\s)(?:--workspaces|-ws)(?:=(true|false))?(?=\s|$)/gu)].map((match) => match[1] !== "false"); if (new Set(workspaceModes).size > 1) throw new Error(`${path}: npm workspace mode is contradictory`); const all = workspaceModes[0] === true; const disabled = workspaceModes[0] === false; const includeRoot = /(?:^|\s)--include-workspace-root(?:=true)?(?=\s|$)/u.test(invocation); if (disabled) { if (selectors.length > 0) throw new Error(`${path}: disabled npm workspaces cannot combine with named selectors`); return [[MANIFEST, commands]]; } if (!all && selectors.length === 0) return null; if (all && selectors.length > 0) throw new Error(`${path}: npm workspace selection cannot combine --workspaces with named selectors`); const rootManifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as { workspaces?: string[] }; const declared = new Set(rootManifest.workspaces ?? []); const candidates = [...paths].filter((manifest) => manifest.endsWith(`/${MANIFEST}`)).flatMap((manifest) => { const directory = manifest.slice(0, -(`/${MANIFEST}`).length); if (!declared.has(directory)) return []; const value = JSON.parse(readFileSync(join(root, manifest), "utf8")) as { name?: string; scripts?: Record<string, string> }; return [{ manifest, directory, name: value.name ?? "", commands: new Set(Object.keys(value.scripts ?? {})) }]; }); if (candidates.length !== declared.size) throw new Error(`${path}: public workspace manifests do not exactly match root workspaces`); const selected = all ? candidates : selectors.map((selector) => { const matches = candidates.filter((candidate) => selector === candidate.directory || selector === candidate.name); if (matches.length !== 1) throw new Error(`${path}: npm workspace selector is unknown or ambiguous: ${selector}`); return matches[0]!; }); const unique = [...new Map(selected.map((candidate) => [candidate.manifest, candidate])).values()]; return [...unique.map((candidate) => [candidate.manifest, candidate.commands] as const), ...(includeRoot ? [[MANIFEST, commands] as const] : [])]; };
  const assertModeledNpmOptions = (path: string, contents: string): void => { if (/\bnpm_config_(?:prefix|workspace|workspaces|location)\s*=/iu.test(contents)) throw new Error(`${path}: npm package context cannot be supplied through environment configuration`); const allowed = new Set(["--workspace", "-w", "--workspaces", "-ws", "--include-workspace-root", "--prefix", "-C", "--silent", "-s", "--if-present", "--ignore-scripts", "--foreground-scripts", "--loglevel", "--json", "--color", "--timing", "--dry-run"]); const allowedValues = new Map([["--loglevel", new Set(["silent", "error", "warn", "notice", "http", "info", "verbose", "silly"])], ["--color", new Set(["true", "false", "always", "never"])]]); const runner = /(?:^|\s)(?:run(?:-script)?|rum|urn|test|start|stop|restart|t|tst)(?=\s|$)/u; for (const candidate of contents.matchAll(/\bnpm\s+([^\n\r`]+)/gu)) { const invocation = (candidate[1] ?? "").split(/\s+--(?:\s|$)/u, 1)[0] ?? ""; if (/["']/u.test(invocation) && runner.test(invocation.replace(/["']/gu, ""))) throw new Error(`${path}: unsupported shell quoting in npm command`); if (!runner.test(invocation)) continue; for (const option of invocation.matchAll(/(?:^|\s)(--[\w-]+|-[A-Za-z]+)(?:=[^\s`"']+)?(?=\s|$)/gu)) if (!allowed.has(option[1]!)) throw new Error(`${path}: unmodeled npm option changes or obscures package execution context: ${option[1]}`); const valued = [...invocation.matchAll(/(?:^|\s)(--loglevel|--color)(?:=|\s+)([^\s`"']+)/gu)]; const valueTokens = [...invocation.matchAll(/(?:^|\s)(--loglevel|--color)(?==|\s|$)/gu)]; if (valued.length !== valueTokens.length || valued.some((match) => !allowedValues.get(match[1]!)?.has(match[2]!))) throw new Error(`${path}: npm option has a missing or unsupported value`); } };
  const prefixCommandSet = (path: string, invocation: string): readonly [string, Set<string>] | null => { const rawPrefixes = [...invocation.matchAll(/(?:^|\s)(?:--prefix|-C)(?:=|\s+)([^\s`"']+)/gu)].map((match) => match[1] ?? ""); if (rawPrefixes.length === 0) return null; const manifests = rawPrefixes.map((raw) => { const cleaned = raw.replace(/^\.\//u, "").replace(/\/+$/u, "") || "."; const normalized = posix.normalize(cleaned); if (isAbsolute(raw) || raw.includes("\\") || normalized !== cleaned || normalized === ".." || normalized.startsWith("../")) throw new Error(`${path}: npm prefix must be a normalized repository-local package path: ${raw}`); const manifest = normalized === "." ? MANIFEST : `${normalized}/${MANIFEST}`; if (!paths.has(manifest)) throw new Error(`${path}: npm prefix has no exact public package manifest: ${raw}`); return manifest; }); if (new Set(manifests).size !== 1) throw new Error(`${path}: npm prefix selection is contradictory`); const manifest = manifests[0]!; return [manifest, new Set(Object.keys((JSON.parse(readFileSync(join(root, manifest), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}))]; };
  for (const path of paths) {
    if (!(path.startsWith("mcp/") || path.endsWith(".md") || path === ".env.example") || (!path.endsWith(".md") && !path.endsWith(".json") && !path.endsWith(".json.example") && path !== ".env.example")) continue;
    const contents = readFileSync(join(root, path), "utf8"); const [manifestPath, knownCommands] = packageCommands(path); assertModeledNpmOptions(path, contents);
    for (const match of contents.matchAll(/\bnpm\s+(?:(?:(?:--workspaces|-ws)(?:=[^\s`"']+)?|(?:--workspace|-w|--prefix|-C|--loglevel|--color)(?:=|\s+)[^\s`"']+|--[\w-]+(?:=[^\s`"']+)?|-[A-Za-z]+)\s+)*(?:(?:run(?:-script)?|rum|urn)\s+(?:(?:(?:--workspaces|-ws)(?:=[^\s`"']+)?|(?:--workspace|-w|--prefix|-C|--loglevel|--color)(?:=|\s+)[^\s`"']+|--[\w-]+(?:=[^\s`"']+)?|-[A-Za-z]+)\s+)*([\w:-]+)|(test|start|stop|restart|t|tst))(?:(?:\s+(?:(?:--workspaces|-ws)(?:=[^\s`"']+)?|(?:--workspace|-w|--prefix|-C|--loglevel|--color)(?:=|\s+)[^\s`"']+|--[\w-]+(?:=[^\s`"']+)?|-[A-Za-z]+))*)\b/gu)) {
      const command = match[1] ?? ({ t: "test", tst: "test" }[match[2] ?? ""] ?? match[2]); const workspaceScopes = workspaceCommandSets(path, match[0]); const prefixScope = prefixCommandSet(path, match[0]); if (workspaceScopes && prefixScope) throw new Error(`${path}: npm prefix and workspace package contexts cannot be combined`); const scopes = workspaceScopes ?? (prefixScope ? [prefixScope] : [[manifestPath, knownCommands] as const]); const missing = scopes.find(([, available]) => !command || !available.has(command)); if (missing) throw new Error(`${path}: npm command is absent from ${missing[0]}: ${command ?? "unknown"}`);
    }
    for (const match of contents.matchAll(/(?:^|[\s`"'(])((?:(?:scripts|mcp)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|mjs|sh)|\.\/openlup))\b/gmu)) {
      if (!paths.has(match[1].replace(/^\.\//u, ""))) throw new Error(`${path}: executable reference is absent from the public tree: ${match[1]}`);
    }
  }
}

export function sourceReleaseProjectionDrift(sourceRoot: string, publicRoot: string): ProjectionDriftRow[] {
  const explicit = EXPLICIT_PUBLIC_PROJECTION_PATHS.map((selector) => ({
    selector,
    sourceSelector: publicProjectionSource(selector),
    source: sourceState(sourceRoot, publicProjectionSource(selector)),
    public: publicState(publicRoot, selector),
  }));
  const named = new Set<string>(EXPLICIT_PUBLIC_PROJECTION_PATHS);
  const dynamic = materializedOutputPaths(publicRoot).filter((path) => !named.has(path) && existsSync(join(sourceRoot, path)) && fileDigest(join(sourceRoot, path)) !== fileDigest(join(publicRoot, path)))
    .map((selector) => ({ selector, sourceSelector: selector, source: sourceState(sourceRoot, selector), public: publicState(publicRoot, selector) }));
  return [...explicit, ...dynamic].sort((left, right) => left.selector.localeCompare(right.selector));
}

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

function namedNpmCommand(command: string): string | null {
  return /^npm\s+run(?:\s+--[\w-]+(?:=[^\s]+)?)*\s+([\w:-]+)$/u.exec(command)?.[1] ?? null;
}

function assertPackageExecutionSurfaces(root: string, paths: Set<string>, allowed: Set<string>, declared: PublicPackageExecutionSurface[]): void {
  const manifests = [...paths].filter((path) => path === MANIFEST || path.endsWith("/package.json")).sort();
  if (JSON.stringify(manifests) !== JSON.stringify(declared.map(({ path }) => path))) throw new Error(`${PUBLICATION_CATALOG_PATH}: package manifest inventory differs from packageExecutionSurfaces`);
  for (const { path: manifestPath, digest: expectedDigest } of declared) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8")) as { scripts?: Record<string, string>; bin?: string | Record<string, string> };
    if (packageExecutionDigest(manifest) !== expectedDigest) throw new Error(`${manifestPath}: scripts/bin execution surface differs from the public catalogue`);
    const base = manifestPath === MANIFEST ? "" : manifestPath.slice(0, -MANIFEST.length);
    const commands = [...Object.values(manifest.scripts ?? {}), ...(typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {}))];
    for (const command of commands) for (const match of command.matchAll(/(?:^|[\s"'])((?:\.\/)?[A-Za-z0-9_./[\]-]+\.(?:[cm]?[jt]sx?|mjs|sh))\b/gu)) {
      const target = `${base}${match[1].replace(/^\.\//u, "")}`;
      if (!paths.has(target)) throw new Error(`${manifestPath}: executable target is absent from the public tree: ${target}`);
      if (!allowed.has(target)) throw new Error(`${manifestPath}: executable target is not registered: ${target}`);
    }
  }
}

export function assertMaterializedPublicationCatalog(root: string, catalogSource: string, observedPaths?: Iterable<string>): void {
  const observed = observedPaths ? [...observedPaths] : trackedFiles(root);
  for (const path of observed) { const bytes = readFileSync(join(root, path)); if (!bytes.includes(0) && carriesPrivateOperationalCoordinate(bytes.toString("utf8"), path)) throw new Error(`${PUBLICATION_CATALOG_PATH}: ${path} carries unapproved adopter-owned materialized state`); } assertMaterializedRepositoryDocReferences(root, new Set(observed));
  const { catalog } = validatePublicPolicyState(
    root,
    readFileSync(join(root, PUBLIC_POLICY_REGISTRY_PATH), "utf8"),
    catalogSource,
  );
  assertMaterializedOutputInventory(root, catalog.publicPaths.map((row) => row.path), observed);
  const scripts = JSON.parse(readFileSync(join(root, MANIFEST), "utf8") as string) as { scripts?: Record<string, string> };
  const actualScripts = Object.entries(scripts.scripts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const catalogScripts = catalog.packageCommands.map(({ name, command }) => [name, command] as [string, string]).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualScripts) !== JSON.stringify(catalogScripts)) throw new Error(`${PUBLICATION_CATALOG_PATH}: packageCommands differ from the materialized package.json scripts`);
  const commands = new Set(actualScripts.map(([name]) => name));
  const paths = new Set(catalog.publicPaths.map((row) => row.path));
  assertMaterializedExecutionReferences(root, paths, commands);
  const allowedEntrypoints = new Set<string>(PUBLIC_EXECUTION_ENTRYPOINTS);
  assertPackageExecutionSurfaces(root, paths, allowedEntrypoints, catalog.packageExecutionSurfaces);
  const leakedEntrypoints = [...paths].filter((path) => existsSync(join(root, path)) &&
    isDirectExecutionEntrypoint(path, readFileSync(join(root, path), "utf8")) && !allowedEntrypoints.has(path));
  if (leakedEntrypoints.length > 0) throw new Error(`${PUBLICATION_CATALOG_PATH}: unregistered direct execution entrypoint(s): ${leakedEntrypoints.join(", ")}`);
  for (const guard of catalog.guardViability) {
    if (guard.status === "withheld") {
      const leaked = guard.withheldPaths.filter((path) => paths.has(path));
      const commandsLeaked = guard.withheldCommands.filter((command) => commands.has(command));
      if (leaked.length > 0 || commandsLeaked.length > 0) {
        throw new Error(`${PUBLICATION_CATALOG_PATH}: withheld guard ${guard.id} leaked ${[...leaked, ...commandsLeaked].join(", ")}`);
      }
      continue;
    }
    const named = namedNpmCommand(guard.command);
    const required = [guard.path, ...guard.publicInputs, ...guard.publicDocs, guard.publicCiEntrypoint, guard.seededFalsifier];
    if (required.some((path) => !paths.has(path)) || (named !== null && !commands.has(named))) {
      throw new Error(`${PUBLICATION_CATALOG_PATH}: published guard ${guard.id} is not viable in the materialized catalogue`);
    }
  }
}

export function validatePublicPolicyState(root: string, policySource: string, catalogSource: string) {
  const policy = parsePublicPolicyRegistry(policySource);
  const catalog = parsePublicPublicationCatalog(catalogSource);
  const catalogPaths = new Set(catalog.publicPaths.map((row) => row.path));
  for (const path of policy.activePaths) {
    if (!catalogPaths.has(path)) throw new Error(`${PUBLICATION_CATALOG_PATH}: public policy path missing from public catalogue: ${path}`);
    if (!existsSync(join(root, path))) throw new Error(`${PUBLIC_POLICY_REGISTRY_PATH}: registered public path does not exist: ${path}`);
    const contents = readFileSync(join(root, path), "utf8");
    if (carriesPrivateOperationalCoordinate(contents, path) || /source-sync|public\/private gate/iu.test(contents)) {
      throw new Error(`${PUBLIC_POLICY_REGISTRY_PATH}: ${path} contains a prohibited private coordinate, source-sync flow, or public/private gate owner`);
    }
  }
  for (const guard of catalog.guardViability) {
    if (guard.status !== "published") continue;
    for (const path of [guard.path, ...guard.publicInputs, ...guard.publicDocs, guard.publicCiEntrypoint, guard.seededFalsifier]) {
      if (!existsSync(join(root, path))) throw new Error(`${PUBLICATION_CATALOG_PATH}: published guard ${guard.id} names missing public path ${path}`);
    }
  }
  assertMaterializedMarkdownLinks(root, catalog.publicPaths.map((row) => row.path));
  return { policy, catalog };
}

/**
 * The compiler stage, in place. The asset and SQL stages are switched off rather than faked: both
 * measure edges that leave the published set, and in a tree that IS the published set there is no
 * such edge to find. Reporting them as zero against an enabled pin would read as debt paid.
 */
export function typecheckVerdict(root: string, contractSource: string, log: (line: string) => void): boolean {
  const typecheck = readPublicTypecheckCompatibility(contractSource).typecheck;
  const projects = typecheck.projects;
  const pin = typecheck.signedPreviewDebt;
  const { positioned, unpositioned } = runPublicTypecheckProjects(root, projects);
  // A project that could not start reports errors with no file position; treating that as "no
  // diagnostics" is how this check would go green while compiling nothing.
  if (unpositioned.length > 0) throw new Error(`a project reported an error with no file position, so nothing was measured:\n  ${unpositioned.join("\n  ")}`);
  const measured = summarizePublicDiagnostics(positioned);
  log(`- projects: ${projects.join(", ")}`);
  log(`- unresolved edges: ${measured.pairs.length} pair(s), ${measured.importers} importer(s), ${measured.targets} target(s) against a pin of ${pin.unresolvedEdges.pairs}`);
  log(`- consumer-side errors in files with no unresolved edge: ${measured.cascades} against ceiling ${pin.inferenceCascades.diagnostics}`);
  const verdict = comparePublicTypecheck(measured, pin);
  for (const line of verdict.lines) log(line);
  return verdict.ok;
}

export function publicInventoryVerdict(root: string, log: (line: string) => void): boolean {
  const catalogSource = readFileSync(join(root, PUBLICATION_CATALOG_PATH), "utf8");
  const { catalog } = validatePublicPolicyState(root, readFileSync(join(root, PUBLIC_POLICY_REGISTRY_PATH), "utf8"), catalogSource);
  const tracked = trackedFiles(root);
  assertMaterializedPublicationCatalog(root, catalogSource, tracked);
  const expectedPaths = catalog.publicPaths.map((row) => row.path);
  const contractSource = readFileSync(join(root, SOURCE_RELEASE_CONTRACT_PATH), "utf8");
  validateSourceReleaseContract(contractSource);
  const contract = JSON.parse(contractSource) as { inventory: { digest: string }; packages: { manifestDigest: string; rootLockDigest: string; coreLockDigest: string }; platformMigrationManifest: { path: string; digest: string }; databaseSchema: { path: string; digest: string }; policy: { registryDigest: string; publicationCatalogDigest: string } };
  const digest = (contents: string | Buffer) => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
  const bindings = [
    ["inventory", contract.inventory.digest, publicPublicationCatalogDigests(catalogSource).inventoryDigest],
    [MANIFEST, contract.packages.manifestDigest, digest(readFileSync(join(root, MANIFEST)))],
    ["package-lock.json", contract.packages.rootLockDigest, digest(readFileSync(join(root, "package-lock.json")))],
    ["packages/core/package-lock.json", contract.packages.coreLockDigest, digest(readFileSync(join(root, "packages/core/package-lock.json")))],
    [contract.platformMigrationManifest.path, contract.platformMigrationManifest.digest, digest(readFileSync(join(root, contract.platformMigrationManifest.path)))],
    [contract.databaseSchema.path, contract.databaseSchema.digest, digest(readFileSync(join(root, contract.databaseSchema.path)))],
    [PUBLIC_POLICY_REGISTRY_PATH, contract.policy.registryDigest, digest(readFileSync(join(root, PUBLIC_POLICY_REGISTRY_PATH)))],
    [PUBLICATION_CATALOG_PATH, contract.policy.publicationCatalogDigest, digest(catalogSource)],
  ];
  const failures = bindings.filter(([, expected, actual]) => expected !== actual).map(([name]) => `${name} digest is not bound to ${SOURCE_RELEASE_CONTRACT_PATH}`);
  failures.push(...runPlatformMigrationManifestCheck(root));
  if (JSON.stringify(tracked) !== JSON.stringify(expectedPaths)) failures.push("tracked paths differ from the public publication catalogue");
  const manifest = readFileSync(join(root, MANIFEST), "utf8");
  if (Object.values((JSON.parse(manifest) as { imports?: Record<string, unknown> }).imports ?? {}).some((target) => typeof target !== "string")) failures.push(`${MANIFEST} retains an unresolved conditional seam`);
  log(`- tracked public paths: ${tracked.length}`);
  log(`- ${MANIFEST}: ${digest(manifest)}`);
  for (const failure of failures) log(failure);
  return failures.length === 0;
}

/**
 * Public-only policy proof.  Do not move either private catalogue constant into this function:
 * an exported checkout may delete all private programme/readiness inputs and still execute this
 * mode using only the two public authorities and files named by them.
 */
export function policyVerdict(root: string, log: (line: string) => void): boolean {
  const catalogSource = readFileSync(join(root, PUBLICATION_CATALOG_PATH), "utf8");
  const state = validatePublicPolicyState(root, readFileSync(join(root, PUBLIC_POLICY_REGISTRY_PATH), "utf8"), catalogSource);
  assertMaterializedPublicationCatalog(root, catalogSource, trackedFiles(root));
  log(`- public policy paths: ${state.policy.activePaths.length}`);
  log(`- public policy contracts: ${state.policy.contracts.length}`);
  log(`- guard viability entries: ${state.catalog.guardViability.length}`);
  return true;
}

function main(root: string, argv: string[]): number {
  const modes = ["--typecheck", "--inventory", "--policy"].filter((mode) => argv.includes(mode));
  if (modes.length !== 1) {
    process.stderr.write("usage: oss-published-tree-check.ts --typecheck | --inventory | --policy\n  run inside a checkout of the published tree\n");
    return 2;
  }
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const ok = modes[0] === "--typecheck"
    ? typecheckVerdict(root, readFileSync(join(root, SOURCE_RELEASE_CONTRACT_PATH), "utf8"), log)
    : modes[0] === "--inventory"
      ? publicInventoryVerdict(root, log)
      : policyVerdict(root, log);
  log(ok
    ? `${modes[0] === "--typecheck" ? "the tree compiles to its signed debt" : modes[0] === "--inventory" ? "the tree is the inventory the manifest describes" : "the tree satisfies its public policy catalogue"}.`
    : `${modes[0] === "--typecheck" ? "the tree does not compile to its signed debt" : modes[0] === "--inventory" ? "the tree is not the inventory the manifest describes" : "the tree does not satisfy its public policy catalogue"}.`);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.cwd(), process.argv.slice(2)));
