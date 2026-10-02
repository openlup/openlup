#!/usr/bin/env node
// Self-checks for an already-published checkout; source-only partition inputs stay out of --policy.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { PUBLIC_EXECUTION_ENTRYPOINTS, SOURCE_RELEASE_CONTRACT_PATH, isDirectExecutionEntrypoint, validateSourceReleaseContract } from "./oss-publication-contract.ts";
import { PUBLICATION_CATALOG_PATH, PUBLIC_POLICY_REGISTRY_PATH, packageExecutionDigest, parsePublicPolicyRegistry, parsePublicPublicationCatalog, publicPublicationCatalogDigests, type PublicPackageExecutionSurface } from "./oss-publication-policy.ts";
import { carriesPrivateOperationalCoordinate } from "./oss-public-coordinate-detector.ts";
import { runPlatformMigrationManifestCheck } from "./platform-migration-manifest.ts";
import { comparePublicTypecheck, readPublicTypecheckCompatibility, runPublicTypecheckProjects, summarizePublicDiagnostics } from "./oss-public-typecheck.ts";
import { assertDocumentationNavigation, readDocumentationState } from "./documentation-routing.ts";
import { documentationGit, resolveDocumentationBase } from "./documentation-git.ts";
import { checkDocumentationImpact, renderDocumentationImpact } from "./documentation-impact.ts";
import { evaluatePlatformMigrationManifest, type PlatformMigrationManifest } from "./platform-migration-manifest.ts";
import { isExpandOnlyPlatformForward } from "./oss-source-release-contract.ts";
import { assertReviewedPlatformForward } from "./reviewed-platform-forward.ts";
import { renderDocumentationSourceMap, SOURCE_MAP_PATH } from "./documentation-navigation.ts";
import { createDocumentationBundle } from "./documentation-bundle.ts";
import { validateDocumentationBundle, writeDocumentationBundle } from "./documentation-bundle-io.ts";
import { assertMaterializedOutputInventory } from "./oss-published-tree-output.ts";
export { assertMaterializedOutputInventory, materializedOutputPaths } from "./oss-published-tree-output.ts";

/** Append-only migration history at the PR or merge-group boundary. */
const MIGRATION_SHA = /^[a-f0-9]{40}$/u;
const MIGRATION_MANIFEST = "config/platform-migration-manifest.json";
const RAILS = ["db/platform/migrations/", "supabase/migrations/"] as const;
const FORWARD = /^(?:db\/platform|supabase)\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u;
const BASELINES = new Set(["db/platform/migrations/00000000000000_platform_baseline.sql", "supabase/migrations/00000000000000_platform_schema_baseline.sql"]);
type MigrationEntry = { path: string; mode: string; oid: string };

function migrationSnapshot(root: string, revision: string): Map<string, MigrationEntry> {
  const rows = documentationGit(root, ["ls-tree", "-r", "-z", "--full-tree", revision, "--", MIGRATION_MANIFEST, ...RAILS]).toString("utf8").split("\0").filter(Boolean);
  const entries = rows.map((row) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(row);
    if (!match) throw new Error(`migration history: unsupported Git entry at ${revision}`);
    return { path: match[3]!, mode: match[1]!, oid: match[2]! };
  });
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function readMigrationBlob(root: string, entry: MigrationEntry): string {
  return documentationGit(root, ["cat-file", "blob", entry.oid]).toString("utf8");
}

export function assertAppendOnlyMigrationHistory(root: string, base: string, head: string): void {
  if (!MIGRATION_SHA.test(base) || !MIGRATION_SHA.test(head) || base === head) throw new Error("migration history requires distinct full base and head commit SHAs");
  const actualHead = documentationGit(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (actualHead !== head) throw new Error("migration history head differs from the checkout");
  documentationGit(root, ["merge-base", "--is-ancestor", base, head]);
  const before = migrationSnapshot(root, base), after = migrationSnapshot(root, head);
  const additions: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (path === MIGRATION_MANIFEST) continue;
    const old = before.get(path), next = after.get(path);
    if (old?.oid === next?.oid && old?.mode === next?.mode) continue;
    if (old || !next || next.mode !== "100644" || BASELINES.has(path) || !FORWARD.test(path))
      throw new Error(`migration history refuses an edit, deletion, mode change or unsupported addition: ${path}`);
    const bytes = documentationGit(root, ["cat-file", "blob", next.oid]);
    if (!isExpandOnlyPlatformForward(bytes.toString("utf8"))) assertReviewedPlatformForward(root, base, head, path, bytes);
    additions.push(path);
  }
  for (const rail of RAILS) {
    let version = [...before.keys()].filter((path) => path.startsWith(rail)).map((path) => /^\d{14}/u.exec(path.slice(rail.length))?.[0] ?? "").sort().at(-1) ?? "";
    for (const path of additions.filter((item) => item.startsWith(rail)).sort()) {
      const next = path.slice(rail.length, rail.length + 14);
      if (next <= version) throw new Error(`migration history refuses a non-increasing version: ${path}`);
      version = next;
    }
  }
  if (additions.some((path) => path.startsWith(RAILS[1])) && !before.has("supabase/migrations/00000000000000_platform_schema_baseline.sql"))
    throw new Error("migration history requires the frozen managed baseline");
  const priorEntry = before.get(MIGRATION_MANIFEST), currentEntry = after.get(MIGRATION_MANIFEST);
  if (!priorEntry || !currentEntry || priorEntry.mode !== "100644" || currentEntry.mode !== "100644") throw new Error("migration history requires both regular portable manifests");
  const prior = JSON.parse(readMigrationBlob(root, priorEntry)) as PlatformMigrationManifest;
  const current = JSON.parse(readMigrationBlob(root, currentEntry)) as PlatformMigrationManifest;
  const migrations = [...after.values()].filter(({ path }) => path.startsWith(RAILS[0])).map((entry) => ({ file: entry.path, content: readMigrationBlob(root, entry) }));
  const errors = evaluatePlatformMigrationManifest({ manifest: current, migrations });
  if (errors.length) throw new Error(`migration history manifest refuses: ${errors.join("; ")}`);
  if (prior.schemaVersion !== current.schemaVersion || JSON.stringify(prior.baseline) !== JSON.stringify(current.baseline) || !Array.isArray(prior.forward) || !Array.isArray(current.forward) || JSON.stringify(current.forward.slice(0, prior.forward.length)) !== JSON.stringify(prior.forward))
    throw new Error("migration history manifest must preserve the previous prefix");
  const appended = current.forward.slice(prior.forward.length).map(({ file }) => file).sort();
  if (JSON.stringify(appended) !== JSON.stringify(additions.filter((path) => path.startsWith(RAILS[0])).sort())) throw new Error("migration history manifest must bind exactly the appended portable forwards");
  if (appended.length === 0 && priorEntry.oid !== currentEntry.oid) throw new Error("migration history manifest cannot change without a portable forward");
}

const MANIFEST = "package.json";

const AGENT_INSTRUCTION_FILE = /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$|(^|\/)\.cursor\/rules(\/|$)/u;
const ADOPTER_KIT = "docs/platform/adopter-kit";
const ADOPTER_KIT_DEPENDENCIES = `${ADOPTER_KIT}/dependabot.template.yml`;

/**
 * Keeps contributor and adopter agent guidance apart. Agent tools load instruction files by name,
 * so one outside the repository root or a package root would govern contributors working in that
 * folder, and an adopter-kit template under such a name would too. The kit's dependency template
 * must also group every published package, or an adopter upgrades a mixed set.
 */
export function assertAgentGuidancePlacement(root: string, paths: Iterable<string>): void {
  const violations: string[] = [];
  const packages: string[] = [];
  for (const path of paths) {
    const allowed = /^(packages\/[^/]+\/)?([^/]+|\.cursor\/rules\/.+)$/u.test(path);
    if (AGENT_INSTRUCTION_FILE.test(path) && !allowed) {
      violations.push(`${path}: an agent-instruction file may sit only at the repository root or a package root`);
    }
    if (/^packages\/[^/]+\/package\.json$/u.test(path)) packages.push(path);
  }
  const template = join(root, ADOPTER_KIT_DEPENDENCIES);
  const patterns = existsSync(template)
    ? [...readFileSync(template, "utf8").matchAll(/^\s*-\s*"([^"]+)"\s*$/gmu)].map((match) => match[1]!)
    : [];
  if (!existsSync(template)) violations.push(`${ADOPTER_KIT_DEPENDENCIES}: the adopter kit's dependency template is missing`);
  const covers = (name: string) => patterns.some((pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*")}$`, "u").test(name));
  for (const path of packages) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as { name?: string; private?: boolean };
    if (manifest.private === true || typeof manifest.name !== "string") continue;
    if (!covers(manifest.name)) violations.push(`${ADOPTER_KIT_DEPENDENCIES}: no group pattern covers published package ${manifest.name}`);
  }
  if (violations.length > 0) throw new Error(`agent guidance placement:\n${violations.join("\n")}`);
}

const trackedFiles = (root: string): string[] =>
  documentationGit(root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);

function assertMaterializedMarkdownLinks(root: string, paths: Iterable<string>): void {
  const inventory = new Set(paths); const exactPath = /^(?:(?:\.\.?\/)|(?:\.github|api|config|db|deploy|docs|mcp|packages|scripts|server|src|supabase|tests)\/)[A-Za-z0-9_.@%+[\]/-]+\.(?:md|json|ts|tsx|js|mjs|cjs|sh|sql|toml|ya?ml)(?:#[A-Za-z0-9_.:-]+)?$/u;
  const variants = (path: string): string[] => path.endsWith(".mjs") ? [path, `${path.slice(0, -4)}.mts`] : path.endsWith(".cjs") ? [path, `${path.slice(0, -4)}.cts`] : path.endsWith(".js") ? [path, `${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`] : [path];
  for (const path of inventory) {
    if (!path.endsWith(".md")) continue;
    const markdown = readFileSync(join(root, path), "utf8");
    for (const [, raw] of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
      if (raw.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(raw)) continue;
      const target = raw.split(/[?#]/u)[0]; const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const candidate = posix.normalize(posix.join(parent, target)).replace(/\/$/u, ""); const materialized = candidate !== ".." && !candidate.startsWith("../") && (inventory.has(candidate) || (target.endsWith("/") && [...inventory].some((item) => item.startsWith(`${candidate}/`)))); if (target !== "" && !materialized) throw new Error(`${path}: local Markdown link is missing ${raw}`);
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
  const tracked = trackedFiles(root);
  assertMaterializedPublicationCatalog(root, catalogSource, tracked);
  assertAgentGuidancePlacement(root, tracked);
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
  const documentationArgs = argv.filter((arg) => arg.startsWith("--docs-"));
  if (documentationArgs.length > 0 && modes[0] !== "--policy") throw new Error("documentation options require --policy");
  if (modes[0] === "--policy") return documentationPolicyCommand(root, argv, log);
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

export function documentationPolicyCommand(root: string, argv: string[], log: (line: string) => void): number {
  const valued = new Set(["--docs-base", "--docs-export", "--docs-check-bundle", "--docs-source", "--docs-digest"]);
  const flags = new Set(["--policy", "--docs-update", "--docs-local"]);
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if ((!valued.has(arg) && !flags.has(arg)) || options.has(arg)) throw new Error(`unknown or repeated documentation option ${arg}`);
    const value = valued.has(arg) ? argv[++index] : "true";
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    options.set(arg, value);
  }
  if (options.has("--docs-local") && !options.has("--docs-export")) throw new Error("--docs-local requires --docs-export");
  const bundleInput = options.get("--docs-check-bundle");
  if (bundleInput) {
    if (["--docs-export", "--docs-update", "--docs-base", "--docs-local"].some((arg) => options.has(arg))) throw new Error("bundle validation cannot be combined with source operations");
    const manifest = validateDocumentationBundle(join(root, bundleInput), { sourceCommit: options.get("--docs-source"), bundleDigest: options.get("--docs-digest") });
    log(`documentation bundle integrity valid: ${manifest.bundleDigest}; ${manifest.provenance.kind}; publishable=${manifest.provenance.publishable}`);
    log("This validates the selected bundle, not the current source tree or behavioral meaning.");
    return 0;
  }
  if (options.has("--docs-source") || options.has("--docs-digest")) throw new Error("consumer pins require --docs-check-bundle");
  let state = readDocumentationState(root);
  if (options.has("--docs-update")) {
    writeFileSync(join(root, SOURCE_MAP_PATH), renderDocumentationSourceMap(state));
    state = readDocumentationState(root);
  }
  if (!existsSync(join(root, SOURCE_MAP_PATH)) || readFileSync(join(root, SOURCE_MAP_PATH), "utf8") !== renderDocumentationSourceMap(state)) throw new Error("documentation source map is stale; run --policy --docs-update");
  assertDocumentationNavigation(state);
  policyVerdict(root, log);
  const base = resolveDocumentationBase(root, { base: options.get("--docs-base") });
  log(`- documentation comparison: ${base.base} (${base.provenance})`);
  if (base.provenance === "pull-request" || base.provenance === "merge-group") {
    const head = documentationGit(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
    assertAppendOnlyMigrationHistory(root, base.base, head);
    log(`- append-only migration history: ${base.base}..${head}`);
  }
  const result = checkDocumentationImpact(root, state, base.base);
  for (const line of renderDocumentationImpact(result)) log(line);
  if (result.failures.length > 0) return 1;
  const output = options.get("--docs-export");
  if (output) {
    const bundle = createDocumentationBundle(root, state, options.has("--docs-local"));
    writeDocumentationBundle(root, output, bundle);
    log(`- documentation bundle: ${output}; ${bundle.manifest.bundleDigest}; ${bundle.manifest.provenance.kind}; publishable=${bundle.manifest.provenance.publishable}`);
  }
  log("the tree satisfies its public policy catalogue and documentation ownership/impact checks.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { process.exit(main(process.cwd(), process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
}
