import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type Failure = { id: string; message: string };
export type Classification = { status: string; explicit: boolean };
export type DocumentationIndexConfig = {
  file: string;
  directory: string;
  allowedStatuses: string[];
  expectedStatuses?: Record<string, string>;
};

/**
 * The only subtrees of the documentation directory whose documents the index must classify,
 * alongside the top level: both hold documents an agent is routed to as current guidance, so an
 * unindexed file in either is the same failure as an unindexed top-level document. Every other
 * `docs/` subtree is out of scope by name and for a stated reason - `plan/` has its own lifecycle
 * contract (Plan Protocol, `npm run audit:plan-status`); `archive/` is by definition not active
 * guidance; `evidence/`, `audit/` and `fixtures/` hold dated artifacts that are cited, never
 * routed to; `legal/`, `local-runtime/`, `templates/` and `sql/` hold non-prose or
 * machine-consumed material. Widening this list is a decision, not a side effect: add the
 * subtree here and index its documents in the same change.
 */
const CLASSIFIED_SUBTREES = ["adr", "protocols"];

export function localMarkdownTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    targets.push(raw);
  }
  return targets;
}

type IndexedBullet = { section: string; text: string };

function indexedBullets(markdown: string): IndexedBullet[] {
  const bullets: IndexedBullet[] = [];
  let section = "";
  let current: IndexedBullet | null = null;
  const flush = () => {
    if (current) bullets.push(current);
    current = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      section = heading[1];
      continue;
    }
    if (/^-\s+/.test(line)) {
      flush();
      current = { section, text: line };
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) current.text += `\n${line}`;
  }
  flush();
  return bullets;
}

/**
 * Reads the class of every top-level document out of the index. `README.md` is the one document
 * whose class cannot be written in the index it *is*, so it is hardcoded and exempt from the
 * explicit-label rule. Every other classifying entry must carry a `**[status]**` label: a class
 * that depends on which section a bullet sits in silently reclassifies a document on a reorder.
 */
export function indexClassifications(
  root: string,
  config: DocumentationIndexConfig,
): { classifications: Map<string, Classification>; failures: Failure[] } {
  const failures: Failure[] = [];
  const classifications = new Map<string, Classification>();
  classifications.set("README.md", { status: "source-of-truth", explicit: false });
  const docsPath = resolve(root, config.directory);
  const allowed = new Set(config.allowedStatuses);
  const markdown = readFileSync(join(root, config.file), "utf8");
  const inScope = new Set(classifiedDocs(root, config.directory));

  for (const bullet of indexedBullets(markdown)) {
    if (bullet.section !== "Documentation Index" && bullet.section !== "Operational Runbooks") continue;
    const labels = [...bullet.text.matchAll(/\*\*\[([^\]]+)\]\*\*/g)].map((match) => match[1]);
    if (labels.length > 1) {
      failures.push({ id: "docs-index-status", message: `Index entry has multiple status labels: ${labels.join(", ")}` });
      continue;
    }
    const explicit = labels.length === 1;
    const status = labels[0] ?? (bullet.section === "Operational Runbooks" ? "runbook" : "source-of-truth");
    if (!allowed.has(status)) {
      failures.push({ id: "docs-index-status", message: `Index entry uses unknown status '${status}'` });
      continue;
    }
    const named = localMarkdownTargets(bullet.text)
      .map((target) => resolve(root, config.directory, target.split("#", 1)[0]))
      .filter((path) => path.startsWith(`${docsPath}/`) && path.endsWith(".md"))
      .map((path) => path.slice(docsPath.length + 1))
      .filter((name) => name !== "README.md" && inScope.has(name));
    if (named.length > 0 && !explicit) {
      failures.push({
        id: "docs-index-implicit-status",
        message: `Index entry classifies ${named.join(", ")} without an explicit **[status]** label`,
      });
    }
    for (const name of new Set(named)) {
      const previous = classifications.get(name);
      if (!previous) classifications.set(name, { status, explicit });
      else failures.push({
        id: "docs-index-duplicate",
        message: `${config.directory}/${name} is classified by more than one index entry: ${previous.status}, ${status}`,
      });
    }
  }
  return { classifications, failures };
}

function markdownUnder(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? (prefix === "" && !CLASSIFIED_SUBTREES.includes(entry.name) ? [] : markdownUnder(join(dir, entry.name), `${prefix}${entry.name}/`))
      : entry.name.endsWith(".md") ? [`${prefix}${entry.name}`] : []);
}

/** Documents the index must classify: the top level plus every classified subtree, at any depth. */
export function classifiedDocs(root: string, directory: string): string[] {
  return markdownUnder(join(root, directory), "").sort();
}

/**
 * The narrower set the header-truth gate reads: the top level, where a canon header belongs. An
 * ADR carries `Decision status:` and a protocol carries its own fields, so widening the header
 * gate to the classified subtrees would be a different decision from widening the index gate.
 */
export function topLevelDocs(root: string, directory: string): string[] {
  return classifiedDocs(root, directory).filter((name) => !name.includes("/"));
}
