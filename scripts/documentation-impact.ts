import {
  DOCUMENTATION_ROUTING_PATH, classifyDocumentationPath, documentationSection, normalizeDocumentation,
  parseDocumentationRouting, resolveDocumentationOwner, unfencedMarkdown,
  type DocumentationOwner, type DocumentationState, type DocumentationSurface,
} from "./documentation-routing.ts";
import {
  documentationDigest, documentationGit, readDocumentationCandidate, readDocumentationIndex, readDocumentationObjects, readDocumentationTree,
  type DocumentationObject,
} from "./documentation-git.ts";
export { resolveDocumentationBase } from "./documentation-git.ts";
export type { DocumentationBase } from "./documentation-git.ts";

export type DocumentationObligation = {
  unit: string; doc: string; anchor: string; changedPaths: string[]; digest: string;
  status: "updated" | "no-impact" | "unanswered";
  answers?: { source: "trailer" | "section"; commit?: string; reason: string }[];
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

function trailerAnswers(root: string, base: string, head: string, failures: string[]): { shallow: boolean; commits: string[]; records: (ReviewComment & { commit: string })[] } {
  const shallow = documentationGit(root, ["rev-parse", "--is-shallow-repository"]).toString("utf8").trim() === "true";
  if (shallow) return { shallow, commits: [], records: [] };
  const commits = documentationGit(root, ["rev-list", "--no-merges", `${base}..${head}`]).toString("utf8").trim().split("\n").filter(Boolean);
  const records: (ReviewComment & { commit: string })[] = [];
  const objects = readDocumentationObjects(root, commits);
  for (const [index, commit] of commits.entries()) {
    const object = objects[index];
    if (object === null || object === undefined) throw new Error("documentation: unreadable commit batch");
    const contents = object.toString("utf8"); const boundary = contents.indexOf("\n\n");
    if (boundary < 0) throw new Error("documentation: commit has no message boundary");
    for (const line of contents.slice(boundary + 2).split("\n")) {
      // Dot-all keeps a CR, U+2028 or U+2029 inside the record, so such a line is parsed or refused, never skipped.
      const trailer = /^OpenLup-Doc-Impact:[ \t]*(.*?)[ \t\r]*$/su.exec(line);
      if (!trailer) continue;
      try {
        let value: unknown;
        try { value = JSON.parse(trailer[1]!); } catch { throw new Error("invalid JSON"); }
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "digest,reason,unit" || typeof row.unit !== "string" || !/^[a-z][a-z0-9-]*$/u.test(row.unit)
          || typeof row.digest !== "string" || !/^sha256-[0-9a-f]{64}$/u.test(row.digest) || typeof row.reason !== "string" || !row.reason.trim())
          throw new Error("needs exactly unit, digest and a nonempty reason");
        records.push({ ...row as ReviewComment, commit });
      } catch (error) { failures.push(`malformed OpenLup-Doc-Impact trailer in ${commit.slice(0, 12)}: ${(error as Error).message}`); }
    }
  }
  return { shallow, commits, records };
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
  // Read the change's own records once, so a malformed one fails even when no obligation needs it.
  const trailers: ReturnType<typeof trailerAnswers> = inputs.size === 0 ? { shallow: false, commits: [], records: [] } : trailerAnswers(root, baseSHA, headSHA, result.failures);
  const ownDocuments = new Map<string, (Buffer | null)[]>();
  for (const { owner, paths } of [...inputs.values()].sort((left, right) => identity(left.owner).localeCompare(identity(right.owner)))) {
    const changedPaths = [...paths].sort();
    const priorSection = ownerSection(before, owner); const section = ownerSection(after, owner);
    const normalized = normalizeDocumentation(section ?? "");
    // The answer binds the source delta and its owner, not the section prose or the base commit.
    const digest = documentationDigest(JSON.stringify({
      version: 3, unit: owner.unit, doc: owner.doc, anchor: owner.anchor,
      source: changedPaths.map((path) => ({ path, before: binding(before.get(path)), after: binding(after.get(path)), ownership: owners.get(path) })),
    }));
    const legacyDigestFor = (text: string) => documentationDigest(JSON.stringify({
      version: 2, unit: owner.unit, doc: owner.doc, anchor: owner.anchor,
      source: changedPaths.map((path) => ({ path, before: binding(before.get(path)), after: binding(after.get(path)), ownership: owners.get(path) })),
      section: documentationDigest(text),
    }));
    const legacyDigest = legacyDigestFor(normalized);
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
    let matching = applicable.filter((comment) => comment.digest === legacyDigest);
    if (applicable.length && !matching.length && trailers.commits.length) {
      // Open pull requests' records survive an owner-section edit on main, as trailers do.
      if (!ownDocuments.has(owner.doc)) ownDocuments.set(owner.doc, readDocumentationObjects(root, trailers.commits.map((commit) => `${commit}:${owner.doc}`)));
      const sections = new Set<string>();
      for (const document of ownDocuments.get(owner.doc)!) {
        if (document === null) continue;
        try { sections.add(normalizeDocumentation(documentationSection(document.toString("utf8"), owner.anchor))); } catch { /* Missing historical anchors cannot answer. */ }
      }
      const digests = new Set([...sections].map(legacyDigestFor));
      matching = applicable.filter((comment) => digests.has(comment.digest));
    }
    const priorComments = priorSection === null ? [] : reviewComments(priorSection);
    const fresh = matching.length === 1 && !priorComments.some((comment) => JSON.stringify(comment) === JSON.stringify(matching[0]));
    if (applicable.length === 1 && fresh) { obligation.status = "no-impact"; obligation.answers = [{ source: "section", reason: matching[0]!.reason }]; continue; }
    const answers = trailers.records.filter((record) => record.unit === owner.unit && record.digest === digest);
    if (answers.length) { obligation.status = "no-impact"; obligation.answers = answers.map(({ commit, reason }) => ({ source: "trailer", commit, reason })); continue; }
    result.failures.push(`${owner.doc}${owner.anchor}: ${owner.unit} needs a substantive section update or a no-impact trailer in this change's own commits: ${renderNoImpactTrailer(obligation, "<why this section stays correct>")}; source: ${changedPaths.join(", ")}${trailers.shallow ? "; this checkout is shallow, so no trailer could be read: fetch complete history" : ""}`);
  }
  return result;
}

export function renderNoImpactTrailer(obligation: Pick<DocumentationObligation, "unit" | "digest">, reason: string): string {
  if (!reason.trim() || /[\r\n\u2028\u2029]/u.test(reason)) throw new Error("documentation: no-impact reason must be nonempty and on one line");
  return `OpenLup-Doc-Impact: ${JSON.stringify({ unit: obligation.unit, digest: obligation.digest, reason })}`;
}
// Render the compatibility record for legacy in-section answers.
export function renderNoImpactComment(obligation: Pick<DocumentationObligation, "unit" | "digest">, reason: string): string {
  if (!reason.trim() || reason.includes("-->")) throw new Error("documentation: no-impact reason must be nonempty and cannot close its comment");
  return `<!-- openlup-doc-impact ${JSON.stringify({ unit: obligation.unit, digest: obligation.digest, reason })} -->`;
}
export function renderDocumentationImpact(result: DocumentationImpactResult): string[] {
  return [
    `- documentation base: ${result.base}`,
    `- documentation obligations: ${result.obligations.length}; unanswered: ${result.obligations.filter((row) => row.status === "unanswered").length}`,
    // Reasons are author text: print them escaped so one cannot add or forge log lines.
    ...result.obligations.flatMap((row) => (row.answers ?? []).map((answer) => `- documentation no-impact: ${row.unit} ${row.doc}${row.anchor} (${answer.commit?.slice(0, 12) ?? "section record"}): ${JSON.stringify(answer.reason).replace(/[\u0085\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}`)),
    ...result.failures.map((failure) => `documentation: ${failure}`),
  ];
}
