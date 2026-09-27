import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { resolveDocumentationOwner, type DocumentationState } from "./documentation-routing.ts";
import { documentationDigest } from "./documentation-git.ts";
export { documentationDigest } from "./documentation-git.ts";

export const SOURCE_MAP_PATH = "docs/platform/SOURCE_MAP.md";

export type DocumentationSource = {
  id: string;
  path: string;
  class: string;
  role: string;
  owner: { unit: string; page: string; anchor: string; purpose: string };
  descriptionSource: "authored-owner";
  symbols: string[];
  symbolSource: "syntactic-export-declarations" | "none";
  digest: string;
};

function sourceRole(path: string): string {
  if (/\.mdx?$/u.test(path)) return path.startsWith("docs/platform/plans/") ? "dated-plan" : "documentation";
  if (/(?:\.test\.|\.spec\.|(?:^|\/)tests?\/|__tests__\/)/u.test(path)) return "test-source";
  if (/\.sql$/u.test(path)) return /(?:^|\/)migrations\//u.test(path) ? "ordered-migration" : "database-source";
  if (/\.(?:png|jpe?g|webp|svg|woff2?|ico)$/u.test(path)) return "asset";
  if (/\.(?:json|ya?ml|toml)$/u.test(path)) return "configuration";
  return "source-or-repository-input";
}

/** A navigation hint, not a parser, API check, inferred purpose or completeness claim. */
function declaredSymbols(path: string, contents: string): string[] {
  if (!/\.[cm]?[jt]sx?$/u.test(path)) return [];
  return [...new Set([...contents.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/gmu)]
    .map((match) => match[1]))].sort();
}

export function documentationSources(root: string, state: DocumentationState): DocumentationSource[] {
  const catalog = JSON.parse(readFileSync(join(root, "config/openlup-publication-catalog.json"), "utf8")) as {
    publicPaths: { path: string; class: string }[];
  };
  const classes = new Map(catalog.publicPaths.map((row) => [row.path, row.class]));
  return state.paths.map((path) => {
    const owner = resolveDocumentationOwner(state, path);
    const bytes = readFileSync(join(root, path));
    const symbols = declaredSymbols(path, bytes.includes(0) ? "" : bytes.toString("utf8"));
    return {
      id: `source:${path}`, path, class: classes.get(path) ?? "unregistered-candidate", role: sourceRole(path),
      owner: { unit: owner.unit, page: owner.doc, anchor: owner.anchor, purpose: owner.when },
      descriptionSource: "authored-owner", symbols,
      symbolSource: symbols.length > 0 ? "syntactic-export-declarations" : "none",
      digest: documentationDigest(bytes),
    };
  });
}

const tableText = (value: string): string => value.replaceAll("|", "\\|").replace(/\s+/gu, " ");
const mapLink = (path: string): string => posix.relative(posix.dirname(SOURCE_MAP_PATH), path) || posix.basename(path);

export function renderDocumentationSourceMap(state: DocumentationState): string {
  const lines = [
    "# Platform source map", "",
    "Status: development-preview navigation, generated from the public ownership map.", "",
    "Start with a responsibility below, then open its owner and the linked code.",
    "Descriptions are authored routing purposes. File and symbol inventories are structural",
    "navigation hints; neither establishes behavior, test results or profile availability.", "",
    "[Documentation maintenance](DOCUMENTATION.md) owns regeneration and impact checks.",
    "[Subscription workflows](SUBSCRIPTION_WORKFLOWS.md) drills into significant internal paths.", "",
    "<!-- openlup-generated:start -->", "## Domains", "",
    "The domain list is read from the platform domain registry. Shared and server code",
    "use one canonical domain owner unless a narrower workflow route applies.", "",
    "| Domain | Responsibility | Owner | Source |", "| --- | --- | --- | --- |",
  ];
  for (const domain of state.coreDomains) {
    const surface = state.surfaces.find((row) => row.id === `domain-${domain}`)!;
    const roots = [`src/domains/${domain}`, `server/domains/${domain}`].filter((prefix) => state.paths.some((path) => path.startsWith(`${prefix}/`)));
    lines.push(`| ${domain} | ${tableText(surface.when)} | [README](${mapLink(surface.doc)}${surface.anchor}) | ${roots.map((path) => `[${path.startsWith("server/") ? "server" : "shared"}](${mapLink(path)}/)`).join(" · ")} |`);
  }
  lines.push("", "## Other responsibilities", "", "| Surface | Purpose | Canonical owner | Selectors |", "| --- | --- | --- | --- |");
  for (const surface of state.surfaces.filter((row) => !row.id.startsWith("domain-"))) {
    lines.push(`| ${surface.id} | ${tableText(surface.when)} | [${surface.doc}](${mapLink(surface.doc)}${surface.anchor}) | ${surface.paths.map((path) => `\`${path}\``).join("; ")} |`);
  }
  lines.push("<!-- openlup-generated:end -->", "",
    "## Drill down to a file", "",
    "The checked documentation bundle's `sources.json` lists every selected public path,",
    "publication class, structural role, canonical owner, content digest and syntactically",
    "declared export names. It labels the origin of those descriptions. Read the owner's",
    "invariants and tests before changing behavior; a file name is not a behavioral contract.", "");
  return lines.join("\n");
}
