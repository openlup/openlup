import { isChangelogFragment } from "./packages/changelog-fragments.ts";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { maskMarkdownCode, resolveDocumentationOwner, type DocumentationState } from "./documentation-routing.ts";
import { documentationDigest } from "./documentation-git.ts";
export { documentationDigest } from "./documentation-git.ts";

export const SOURCE_MAP_PATH = "docs/platform/SOURCE_MAP.md";
export const AGENT_GUIDE_SOURCE_PATH = "AGENTS.md";
export const AGENT_GUIDE_PATH = "docs/platform/AGENT_GUIDE.md";
/** The one source paragraph the generator swaps; every other byte is copied, with relative links relocated. */
export const AGENT_GUIDE_SOURCE_STATUS = [
  "Status: development-preview guidance.",
  "This root file is the single source of the public agent guide; edit it here.",
  "`npm run oss:published-tree -- --policy --docs-update` generates",
  "`docs/platform/AGENT_GUIDE.md` from it with location-adjusted links.",
].join("\n");
const AGENT_GUIDE_STATUS = [
  "Status: development-preview guidance.",
  "This page is generated from the root [AGENTS.md](../../AGENTS.md) with links",
  "adjusted for this location. Edit that file, then run",
  "`npm run oss:published-tree -- --policy --docs-update`.",
].join("\n");

function relocatedAgentGuideLink(raw: string): string {
  if (raw.startsWith("<")) throw new Error(`${AGENT_GUIDE_SOURCE_PATH}: angle-bracket link destinations are not relocated: ${raw}`);
  if (/^(?:[#?]|[a-z][a-z0-9+.-]*:|\/)/iu.test(raw)) return raw;
  const cut = raw.search(/[?#]/u);
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const target = posix.normalize(path);
  if (target === ".." || target.startsWith("../")) throw new Error(`${AGENT_GUIDE_SOURCE_PATH}: link escapes the repository: ${raw}`);
  const relocated = posix.relative(posix.dirname(AGENT_GUIDE_PATH), target) || ".";
  return `${relocated}${path.endsWith("/") && !relocated.endsWith("/") ? "/" : ""}${cut < 0 ? "" : raw.slice(cut)}`;
}

/** Derives the public agent guide from root AGENTS.md: relocated relative links plus the status swap. */
export function renderAgentGuide(source: string): string {
  if (source.split(AGENT_GUIDE_SOURCE_STATUS).length !== 2)
    throw new Error(`${AGENT_GUIDE_SOURCE_PATH}: expected its single-source status paragraph exactly once; keep it or update the guide generator`);
  // Inline destinations and reference definitions, outside code; the mask keeps source offsets.
  const masked = maskMarkdownCode(source);
  let guide = "";
  let cursor = 0;
  for (const match of masked.matchAll(/\]\(\s*([^\s)]+)|^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(\S+)/gmu)) {
    const raw = match[1] ?? match[2]!;
    const start = match.index! + match[0].length - raw.length;
    guide += source.slice(cursor, start) + relocatedAgentGuideLink(raw);
    cursor = start + raw.length;
  }
  return `${guide}${source.slice(cursor)}`.replace(AGENT_GUIDE_SOURCE_STATUS, () => AGENT_GUIDE_STATUS);
}

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
      id: `source:${path}`, path, class: classes.get(path) ?? (isChangelogFragment(path) ? "public-output" : "unregistered-candidate"), role: sourceRole(path),
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
    "[Documentation maintenance](DOCUMENTATION.md) owns regeneration and navigation checks.",
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
