import {
  DOCUMENTATION_ROUTING_PATH, classifyDocumentationPath, documentationSection, normalizeDocumentation,
  parseDocumentationRouting, resolveDocumentationOwner, unfencedMarkdown,
  type DocumentationOwner, type DocumentationState, type DocumentationSurface,
} from "./documentation-routing.ts";
import {
  documentationDigest, documentationGit, readDocumentationCandidate, readDocumentationIndex, readDocumentationTree,
  type DocumentationObject,
} from "./documentation-git.ts";
export { resolveDocumentationBase } from "./documentation-git.ts";
export type { DocumentationBase } from "./documentation-git.ts";

export type DocumentationObligation = {
  unit: string; doc: string; anchor: string; changedPaths: string[]; digest: string;
  status: "updated" | "no-impact" | "unanswered";
};
export type DocumentationImpactResult = { base: string; obligations: DocumentationObligation[]; failures: string[] };
type ReviewComment = { unit: string; digest: string; reason: string };
type ObligationInput = { owner: DocumentationOwner; paths: Set<string> };
const identity = (owner: DocumentationOwner): string => `${owner.unit}\0${owner.doc}\0${owner.anchor}`;
const binding = (object: DocumentationObject | undefined) => object ? { mode: object.mode, digest: object.digest } : null;
const relevant = (path: string): boolean => !["documentation", "historical", "generated"].includes(classifyDocumentationPath(path));

function ownerSection(tree: Map<string, DocumentationObject>, owner: DocumentationOwner): string | null {
  const document = tree.get(owner.doc);
  if (!document) return null;
  try { return documentationSection(document.contents.toString("utf8"), owner.anchor); } catch { return null; }
}

function reviewComments(section: string): ReviewComment[] {
  const result: ReviewComment[] = [];
  const visible = unfencedMarkdown(section).replace(/<!--[\s\S]*?-->|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu,
    (match) => match.startsWith("<!--") ? match : match.replace(/[^\n]/gu, " "));
  for (const match of visible.matchAll(/^ {0,3}<!--\s*openlup-doc-impact\b([\s\S]*?)-->[ \t]*$/gmu)) {
    let value: unknown;
    try { value = JSON.parse(match[1]!.trim()); } catch { throw new Error("malformed no-impact comment JSON"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed no-impact comment");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "digest,reason,unit" || typeof row.unit !== "string" || !/^[a-z][a-z0-9-]*$/u.test(row.unit)
      || typeof row.digest !== "string" || !/^sha256-[0-9a-f]{64}$/u.test(row.digest) || typeof row.reason !== "string" || !row.reason.trim())
      throw new Error("no-impact comment needs exactly unit, digest and a nonempty reason");
    result.push(row as ReviewComment);
  }
  if (/^ {0,3}<!--\s*openlup-doc-impact\b/mu.test(visible.replace(/<!--\s*openlup-doc-impact\b[\s\S]*?-->/gu, ""))) throw new Error("unterminated no-impact comment");
  return result;
}

function previousSurfaces(tree: Map<string, DocumentationObject>, state: DocumentationState): { surfaces: DocumentationSurface[]; bootstrap: boolean } {
  const contents = tree.get(DOCUMENTATION_ROUTING_PATH)?.contents.toString("utf8");
  if (contents === undefined) throw new Error("documentation: base has no ownership map");
  const version = (JSON.parse(contents) as { version?: unknown }).version;
  if (version === 1) return { surfaces: state.surfaces, bootstrap: true };
  if (version !== 2) throw new Error("documentation: unsupported base ownership map");
  return { surfaces: parseDocumentationRouting(contents), bootstrap: false };
}

/** Compare exact base objects with the complete materialized candidate, including local work. */
export function checkDocumentationImpact(root: string, state: DocumentationState, baseSHA: string): DocumentationImpactResult {
  const before = readDocumentationTree(root, baseSHA);
  const after = readDocumentationCandidate(root, state.paths);
  const index = readDocumentationIndex(root);
  const headSHA = documentationGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
  const committed = headSHA === baseSHA ? before : readDocumentationTree(root, headSHA);
  // A hidden staged proposal is not the materialized candidate whose owners are being checked.
  for (const path of new Set([...committed.keys(), ...after.keys(), ...index.keys()])) {
    if (!relevant(path)) continue;
    const staged = JSON.stringify(binding(index.get(path)));
    if (staged !== JSON.stringify(binding(committed.get(path))) && staged !== JSON.stringify(binding(after.get(path))))
      throw new Error(`documentation: staged source differs from both HEAD and materialized candidate: ${path}; reconcile the index before verification`);
  }
  const currentRouting = after.get(DOCUMENTATION_ROUTING_PATH)?.contents.toString("utf8");
  if (currentRouting === undefined || JSON.stringify(parseDocumentationRouting(currentRouting)) !== JSON.stringify(state.surfaces))
    throw new Error("documentation: candidate ownership map changed after structural validation");
  const previous = previousSurfaces(before, state);
  const oldMap = { surfaces: previous.surfaces };
  const inputs = new Map<string, ObligationInput>();
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const owners = new Map<string, { before: DocumentationOwner | null; after: DocumentationOwner | null }>();
  for (const path of allPaths) {
    if (!relevant(path)) continue;
    const oldOwner = before.has(path) ? resolveDocumentationOwner(oldMap, path) : null;
    const newOwner = after.has(path) ? resolveDocumentationOwner(state, path) : null;
    owners.set(path, { before: oldOwner, after: newOwner });
    const sourceChanged = JSON.stringify(binding(before.get(path))) !== JSON.stringify(binding(after.get(path)));
    const routingChanged = !previous.bootstrap && JSON.stringify(oldOwner) !== JSON.stringify(newOwner);
    if (!sourceChanged && !routingChanged) continue;
    for (const owner of [oldOwner, newOwner]) {
      if (!owner) continue;
      const key = identity(owner); const input = inputs.get(key) ?? { owner, paths: new Set<string>() };
      input.paths.add(path); inputs.set(key, input);
    }
  }
  const result: DocumentationImpactResult = { base: baseSHA, obligations: [], failures: [] };
  for (const { owner, paths } of [...inputs.values()].sort((left, right) => identity(left.owner).localeCompare(identity(right.owner)))) {
    const changedPaths = [...paths].sort();
    const priorSection = ownerSection(before, owner); const section = ownerSection(after, owner);
    const normalized = normalizeDocumentation(section ?? "");
    // The answer binds the change and the section, not the base commit, so an unrelated move of main keeps it valid.
    const digest = documentationDigest(JSON.stringify({
      version: 2, unit: owner.unit, doc: owner.doc, anchor: owner.anchor,
      source: changedPaths.map((path) => ({ path, before: binding(before.get(path)), after: binding(after.get(path)), ownership: owners.get(path) })),
      section: documentationDigest(normalized),
    }));
    const obligation: DocumentationObligation = { unit: owner.unit, doc: owner.doc, anchor: owner.anchor, changedPaths, digest, status: "unanswered" };
    result.obligations.push(obligation);
    let comments: ReviewComment[];
    try { comments = reviewComments(section ?? ""); } catch (error) {
      result.failures.push(`${owner.doc}${owner.anchor}: ${(error as Error).message}`); continue;
    }
    // A deleted section is an actual documentation change; the new owner's obligation survives.
    const proseChanged = normalizeDocumentation(section ?? "", { includeGenerated: true }) !== normalizeDocumentation(priorSection ?? "", { includeGenerated: true });
    if (proseChanged && normalized !== normalizeDocumentation(priorSection ?? "")) { obligation.status = "updated"; continue; }
    const applicable = comments.filter((comment) => comment.unit === owner.unit);
    const matching = applicable.filter((comment) => comment.digest === digest);
    const priorComments = priorSection === null ? [] : reviewComments(priorSection);
    const fresh = matching.length === 1 && !priorComments.some((comment) => JSON.stringify(comment) === JSON.stringify(matching[0]));
    if (applicable.length === 1 && fresh) { obligation.status = "no-impact"; continue; }
    result.failures.push(`${owner.doc}${owner.anchor}: ${owner.unit} needs a substantive section update or one fresh no-impact comment (${digest}); source: ${changedPaths.join(", ")}`);
  }
  return result;
}

export function renderNoImpactComment(obligation: Pick<DocumentationObligation, "unit" | "digest">, reason: string): string {
  if (!reason.trim() || reason.includes("-->")) throw new Error("documentation: no-impact reason must be nonempty and cannot close its comment");
  return `<!-- openlup-doc-impact ${JSON.stringify({ unit: obligation.unit, digest: obligation.digest, reason })} -->`;
}
export function renderDocumentationImpact(result: DocumentationImpactResult): string[] {
  return [
    `- documentation base: ${result.base}`,
    `- documentation obligations: ${result.obligations.length}; unanswered: ${result.obligations.filter((row) => row.status === "unanswered").length}`,
    ...result.failures.map((failure) => `documentation: ${failure}`),
  ];
}
