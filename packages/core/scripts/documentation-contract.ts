import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageKinds } from "./public-api-config.ts";
import { packDryRun } from "./release-npm-checks.ts";

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
  "AGENTS.md",
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
const agentGuideSections = [
  "Purpose and kind",
  "Subpath maturity",
  "Wiring example",
  "Sources and declarations",
  "Readiness codes",
  "Using this package in an application",
];
const wiringExamplePath = "smoke/agentsWiringExample.ts";

type SurfaceContract = { role?: unknown; maturity?: unknown; packageSmokeEvidence?: unknown };

export function assertDocumentationContract(
  packageRoot = defaultPackageRoot,
  // The packed file list; by default a real `npm pack --dry-run`.
  packedFiles: () => string[] = () => (packDryRun(packageRoot).files ?? []).map((file) => file.path),
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

  for (const file of markdownFiles(packageRoot)) {
    const source = readFileSync(file, "utf8");
    const label = relative(packageRoot, file).split(sep).join("/");
    for (const [pattern, description] of forbiddenExtractedRootReferences) {
      if ((pattern as RegExp).test(source)) violations.push(`${label}: ${description}`);
    }
    for (const target of markdownLinkTargets(source, (reason) => violations.push(`${label}: ${reason}`))) {
      if (isExternalOrAnchor(target)) continue;
      // Do not interpret an entity or Unicode separator as a different packed
      // destination. Authors can use literal punctuation or percent encoding.
      if (/[&<>]|[^\S \t\r\n]/u.test(target)) {
        violations.push(`${label}: unsupported local link destination ${target}; use literal punctuation or percent encoding, and ASCII title separators`);
        continue;
      }
      const unescaped = target.replace(/\\([!-/:-@[-`{-~])/g, "$1");
      let cleanTarget: string;
      try {
        cleanTarget = decodeURIComponent(unescaped.split(/[?#]/, 1)[0] ?? "");
      } catch {
        violations.push(`${label}: malformed percent encoding in local link ${target}`);
        continue;
      }
      const resolvedTarget = resolve(dirname(file), cleanTarget);
      const insidePackage = resolvedTarget === packageRoot || resolvedTarget.startsWith(`${packageRoot}${sep}`);
      if (!insidePackage) {
        violations.push(`${label}: local link escapes package ${target}`);
      } else if (!cleanTarget || !existsSync(resolvedTarget)) {
        violations.push(`${label}: dangling local link ${target}`);
      } else if (packed.has(label) && !packed.has(relative(packageRoot, resolvedTarget).split(sep).join("/"))) {
        violations.push(`${label}: local link ${target} targets a file missing from npm pack`);
      }
    }
    for (const match of source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      const script = match[1];
      if (!manifest.scripts?.[script]) violations.push(`${label}: unknown npm script ${script}`);
    }
  }

  const exports = manifest.exports ?? {};
  const surface = gates.packageSurface ?? {};
  assertSurfaceTable(packageRoot, "README.md", "Package Surface Maturity", true, exports, surface, violations);
  assertAgentGuide(packageRoot, gates.kind, exports, surface, packed, violations);
  assertSingleUnreleasedSection(packageRoot, violations);
  assertPackageHygiene(packageRoot, violations);
  assertGeneratedOutputIgnores(packageRoot, violations);

  assert(violations.length === 0, `documentation contract violations:\n${violations.join("\n")}`);
  console.log("extracted-root documentation contract ok");
}

// Every tarball carries an agent guide stating the package's kind, the
// maturity of each subpath and one wiring example that compiles in CI.
function assertAgentGuide(
  packageRoot: string,
  kind: unknown,
  exports: Record<string, unknown>,
  surface: Record<string, SurfaceContract>,
  packedFiles: ReadonlySet<string>,
  violations: string[],
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
  const examplePath = join(packageRoot, wiringExamplePath);
  if (!existsSync(examplePath) || example !== readFileSync(examplePath, "utf8")) {
    violations.push(`AGENTS.md: wiring example differs from ${wiringExamplePath}`);
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

function markdownLinkTargets(source: string, refuse: (reason: string) => void): string[] {
  // Inspect destination delimiters conservatively; nested/escaped label text
  // and blockquote/list containers must not hide a package-local target.
  const inline = [...source.matchAll(/\]\([ \t\r\n]*/g)]
    .map((match) => linkDestination(source.slice(match.index + match[0].length), refuse));
  // Generated declarations contain index signatures, not link definitions.
  const referenceSource = source
    .replace(/^ {0,3}(`{3,})[^`\r\n]*\r?\n[\s\S]*?^ {0,3}\1`*[ \t]*\r?$/gm, "")
    .replace(/^ {0,3}(~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1~*[ \t]*\r?$/gm, "");
  const references = [...referenceSource.matchAll(/\[(?:\\.|[^\]\\])+\]:[ \t\r\n]*/g)]
    .map((match) => linkDestination(referenceSource.slice(match.index + match[0].length), refuse));
  return [...inline, ...references].filter((target): target is string => target !== undefined);
}

function linkDestination(source: string, refuse: (reason: string) => void): string | undefined {
  // Inspect the destination independently of optional title syntax. Unknown
  // boundaries refuse explicitly instead of disappearing from the inventory.
  const angle = source.startsWith("<");
  let depth = 0;
  const start = angle ? 1 : 0;
  for (let end = start; end < source.length; end++) {
    const character = source[end];
    if (character === "\\" && end + 1 < source.length) { end++; continue; }
    if (angle) {
      if (character === ">") return source.slice(start, end);
      if (character === "\r" || character === "\n") break;
    } else {
      if (character === "(") depth++;
      else if (character === ")" && depth > 0) depth--;
      else if (character === ")" || /[ \t\r\n]/.test(character ?? "")) {
        if (depth === 0) return source.slice(start, end);
        break;
      }
    }
  }
  if (!angle && depth === 0 && source.length > 0) return source;
  refuse("unsupported Markdown link destination boundary; use a balanced destination or an angle-delimited path");
  return undefined;
}

function isExternalOrAnchor(target: string): boolean {
  return target === "" || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) assertDocumentationContract();
