import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const downstreamRepositoryCommand = "veli";
const retiredPackageScope = "veli";
const forbiddenExtractedRootReferences = [
  [/(^|\W)packages\/core(?:\/|\b)/, "monorepo package path"],
  [/\bnpm\s+--workspace\b/, "monorepo workspace command"],
  [
    new RegExp(`(^|[^A-Za-z0-9_])\\./${downstreamRepositoryCommand}(?=$|[^A-Za-z0-9_/-])`),
    "downstream repository command",
  ],
  [/\bdocs\/OSS_READINESS\.md\b/, "downstream readiness document"],
  [/\bpackages\/(?:ui|create-[a-z0-9-]+)\b/, "sibling monorepo package"],
];
const packageHygieneFiles = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "MAINTAINERS.md",
  "SECURITY.md",
  "docs/SPLIT_AND_UPGRADE.md",
  ".github/pull_request_template.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
];
const generatedOutputIgnoreRules = ["/coverage/", "/dist/", "/node_modules/", "/release/"];
const forbiddenPublicRootReferences = [
  [new RegExp(`@${retiredPackageScope}-commerce/core\\b`, "i"), "retired package identity"],
  [/\bVelipet\b/i, "downstream product reference"],
];
const forbiddenContributionClaims = [
  ["stable headline", "retired stable headline claim"],
  ["public package subpath", "retired public package-subpath claim"],
  ["public package subpaths", "retired public package-subpath claim"],
  ["adopter evidence", "retired adopter-evidence claim"],
  ["stable API change", "retired stable API claim"],
  ["stable API changes", "retired stable API claim"],
] as const;

export function assertDocumentationContract(packageRoot = defaultPackageRoot): void {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    exports?: Record<string, unknown>;
    repository?: unknown;
    bugs?: unknown;
    homepage?: unknown;
  };
  const gates = JSON.parse(readFileSync(join(packageRoot, "release-gates.json"), "utf8")) as {
    packageSurface?: Record<string, { role?: unknown; maturity?: unknown; packageSmokeEvidence?: unknown }>;
  };
  const violations: string[] = [];

  for (const file of markdownFiles(packageRoot)) {
    const source = readFileSync(file, "utf8");
    const label = relative(packageRoot, file).split(sep).join("/");
    for (const [pattern, description] of forbiddenExtractedRootReferences) {
      if ((pattern as RegExp).test(source)) violations.push(`${label}: ${description}`);
    }
    for (const target of markdownLinkTargets(source)) {
      if (isExternalOrAnchor(target)) continue;
      const cleanTarget = decodeURI(target.split(/[?#]/, 1)[0] ?? "");
      const resolvedTarget = resolve(dirname(file), cleanTarget);
      const insidePackage = resolvedTarget === packageRoot || resolvedTarget.startsWith(`${packageRoot}${sep}`);
      if (!insidePackage) {
        violations.push(`${label}: local link escapes package ${target}`);
      } else if (!cleanTarget || !existsSync(resolvedTarget)) {
        violations.push(`${label}: dangling local link ${target}`);
      }
    }
    for (const match of source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      const script = match[1];
      if (!manifest.scripts?.[script]) violations.push(`${label}: unknown npm script ${script}`);
    }
  }

  assertSurfaceTable(packageRoot, manifest.exports ?? {}, gates.packageSurface ?? {}, violations);
  assertPackageHygiene(packageRoot, violations);
  assertGeneratedOutputIgnores(packageRoot, violations);

  assert(violations.length === 0, `documentation contract violations:\n${violations.join("\n")}`);
  console.log("extracted-root documentation contract ok");
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
    for (const [claim, description] of forbiddenContributionClaims) {
      if (hasUnnegatedClaim(source, claim)) violations.push(`${relativePath}: ${description}`);
    }
  }
}

function hasUnnegatedClaim(source: string, claim: string): boolean {
  const pattern = new RegExp(`\\b${claim.replaceAll(" ", "\\s+")}\\b`, "ig");
  for (const match of source.matchAll(pattern)) {
    const prefix = source.slice(0, match.index);
    if (!/\b(?:not|no)\s+(?:an?\s+)?$/i.test(prefix)) return true;
  }
  return false;
}

function assertSurfaceTable(
  packageRoot: string,
  exports: Record<string, unknown>,
  packageSurface: Record<string, { role?: unknown; maturity?: unknown; packageSmokeEvidence?: unknown }>,
  violations: string[],
): void {
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  const section = readme.match(/## Package Surface Maturity\n(?<body>[\s\S]*?)(?:\n## |$)/)?.groups?.body;
  if (!section) {
    violations.push("README.md: missing Package Surface Maturity section");
    return;
  }
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|"));
  const rows = lines.slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const documented = new Set(rows.map((cells) => cells[0]?.replace(/^`|`$/g, "")));
  const expected = Object.keys(exports).sort();
  if (JSON.stringify([...documented].sort()) !== JSON.stringify(expected)) {
    violations.push("README.md: maturity table exports differ from package exports");
  }
  for (const cells of rows) {
    const subpath = cells[0]?.replace(/^`|`$/g, "");
    const contract = subpath ? packageSurface[subpath] : undefined;
    if (!contract) continue;
    const evidence = Array.isArray(contract.packageSmokeEvidence)
      ? contract.packageSmokeEvidence.map((path: unknown) => `\`${String(path)}\``).join("<br>")
      : "";
    if (cells[1] !== contract.role || cells[2] !== contract.maturity || cells[3] !== evidence) {
      violations.push(`README.md: maturity row differs from release gates for ${subpath}`);
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

function markdownLinkTargets(source: string): string[] {
  const inline = [...source.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1] ?? match[2]);
  const references = [...source.matchAll(/^\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)]
    .map((match) => match[1] ?? match[2]);
  return [...inline, ...references].filter((target): target is string => Boolean(target));
}

function isExternalOrAnchor(target: string): boolean {
  return target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) assertDocumentationContract();
