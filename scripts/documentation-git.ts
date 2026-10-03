import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDocumentationPath, assertMaterializedDocumentationPath, documentationGit } from "./documentation-routing.ts";
export { documentationGit } from "./documentation-routing.ts";

export type DocumentationObject = { mode: string; digest: string; contents: Buffer };
export type DocumentationBase = { base: string; head: string; provenance: "explicit" | "merge-base" | "pull-request" | "merge-group" | "push" };
const SHA = /^[0-9a-f]{40}$/u;
export const documentationDigest = (bytes: string | Buffer): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
function fullCommit(root: string, ref: string): string {
  const sha = documentationGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]).toString("utf8").trim();
  if (!SHA.test(sha)) throw new Error(`documentation: cannot resolve commit ${ref}`);
  return sha;
}
export function readDocumentationTree(root: string, sha: string): Map<string, DocumentationObject> {
  if (!SHA.test(sha)) throw new Error("documentation: base must be a full commit SHA");
  const rows = documentationGit(root, ["ls-tree", "-rz", "--full-tree", sha]).toString("utf8").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, tab).split(" "); const path = row.slice(tab + 1);
    assertDocumentationPath(path);
    if (type !== "blob" || !["100644", "100755"].includes(mode!)) throw new Error(`documentation: unsupported source object ${path} (${mode})`);
    return { mode: mode!, oid: oid!, path };
  });
  return materializeGitRows(root, rows);
}
export function readDocumentationIndex(root: string): Map<string, DocumentationObject> {
  const rows = documentationGit(root, ["ls-files", "--stage", "-z"]).toString("utf8").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t"); const [mode, oid, stage] = row.slice(0, tab).split(" "); const path = row.slice(tab + 1);
    assertDocumentationPath(path);
    if (stage !== "0" || !["100644", "100755"].includes(mode!)) throw new Error(`documentation: unresolved or unsupported index object ${path}`);
    return { mode: mode!, oid: oid!, path };
  });
  return materializeGitRows(root, rows);
}
function materializeGitRows(root: string, rows: { path: string; mode: string; oid: string }[]): Map<string, DocumentationObject> {
  const ids = [...new Set(rows.map((row) => row.oid))];
  if (ids.length === 0) return new Map();
  const batch = documentationGit(root, ["cat-file", "--batch"], `${ids.join("\n")}\n`, 128 * 1024 * 1024);
  const blobs = new Map<string, { contents: Buffer; digest: string }>();
  let position = 0;
  for (const oid of ids) {
    const newline = batch.indexOf(10, position); const header = batch.subarray(position, newline).toString("utf8");
    const match = /^([0-9a-f]{40}) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== oid) throw new Error("documentation: unreadable base blob batch");
    const size = Number(match[2]); const start = newline + 1; const end = start + size;
    if (!Number.isSafeInteger(size) || end >= batch.length || batch[end] !== 10) throw new Error("documentation: truncated base blob batch");
    const contents = batch.subarray(start, end); blobs.set(oid, { contents, digest: documentationDigest(contents) }); position = end + 1;
  }
  if (position !== batch.length) throw new Error("documentation: unexpected base blob batch output");
  return new Map(rows.map(({ path, mode, oid }) => [path, { mode, ...blobs.get(oid)! }]));
}
export function readDocumentationCandidate(root: string, paths: string[]): Map<string, DocumentationObject> {
  return new Map(paths.map((path) => {
    assertMaterializedDocumentationPath(root, path);
    const contents = readFileSync(join(root, path));
    return [path, { mode: lstatSync(join(root, path)).mode & 0o111 ? "100755" : "100644", digest: documentationDigest(contents), contents }];
  }));
}

function hostedBase(root: string, env: NodeJS.ProcessEnv, head: string): { base: string; provenance: "pull-request" | "merge-group" | "push" } {
  if (env.GITHUB_REPOSITORY !== "openlup/openlup" || !env.GITHUB_EVENT_PATH || !SHA.test(env.GITHUB_SHA ?? "") || head !== env.GITHUB_SHA)
    throw new Error("documentation: hosted checkout identity does not match the public event");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
    repository?: { full_name?: string; private?: boolean }; before?: string; after?: string; action?: string;
    pull_request?: { base?: { sha?: string }; head?: { sha?: string } };
    merge_group?: { base_sha?: string; base_ref?: string; head_sha?: string; head_ref?: string; head_commit?: { id?: string; tree_id?: string } };
  };
  if (event.repository?.full_name !== "openlup/openlup" || event.repository.private !== false)
    throw new Error("documentation: hosted attribution requires the public OpenLup repository");
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const base = event.pull_request?.base?.sha; const source = event.pull_request?.head?.sha;
    const parents = [...documentationGit(root, ["cat-file", "-p", head]).toString("utf8").matchAll(/^parent ([0-9a-f]{40})$/gmu)].map((match) => match[1]!);
    // GITHUB_SHA and the exact parents identify the merge; a synchronize payload's merge_commit_sha can lag it.
    if (!SHA.test(base ?? "") || !SHA.test(source ?? "") || parents.length !== 2 || parents[0] !== base || parents[1] !== source)
      throw new Error("documentation: pull-request checkout is not the event's base/head merge");
    return { base: base!, provenance: "pull-request" };
  }
  if (env.GITHUB_EVENT_NAME === "push" && SHA.test(event.before ?? "") && !/^0+$/u.test(event.before!) && event.after === head)
    return { base: event.before!, provenance: "push" };
  if (env.GITHUB_EVENT_NAME === "merge_group") {
    const group = event.merge_group;
    if (event.action !== "checks_requested" || !SHA.test(group?.base_sha ?? "") || /^0+$/u.test(group!.base_sha!)
      || group!.base_sha === head || group!.base_ref !== "refs/heads/main" || group!.head_sha !== head
      || typeof group!.head_ref !== "string" || !group!.head_ref.startsWith("refs/heads/gh-readonly-queue/main/")
      || group!.head_ref !== env.GITHUB_REF || group!.head_commit?.id !== head
      || group!.head_commit?.tree_id !== documentationGit(root, ["rev-parse", "--verify", "HEAD^{tree}"]).toString("utf8").trim())
      throw new Error("documentation: merge-group checkout does not match the event's base/head/ref");
    try { documentationGit(root, ["check-ref-format", group!.head_ref]); } catch {
      throw new Error("documentation: merge-group event ref is malformed");
    }
    return { base: group!.base_sha!, provenance: "merge-group" };
  }
  throw new Error("documentation: missing or unsupported hosted comparison event");
}

export function resolveDocumentationBase(root: string, options: { base?: string; env?: NodeJS.ProcessEnv } = {}): DocumentationBase {
  const env = options.env ?? process.env; const head = fullCommit(root, "HEAD");
  if (env.GITHUB_ACTIONS === "true") {
    const resolved = hostedBase(root, env, head);
    try { fullCommit(root, resolved.base); } catch {
      // A literal URL and generic header reset do not override URL-specific local settings.
      // Refuse those settings before transport; never print possibly credential-bearing keys.
      const keys = documentationGit(root, ["config", "--includes", "--null", "--name-only", "--list"]).toString("utf8").split("\0");
      if (keys.some((key) => /^(?:url|http|credential)\./iu.test(key) || /^remote\.https:\/\/github\.com\/openlup\/openlup\.git\./iu.test(key)))
        throw new Error("documentation: public base fetch refuses repository/worktree transport or credential configuration");
      documentationGit(root, ["-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.extraHeader=", "-c", "http.followRedirects=false",
        "fetch", "--no-tags", "--depth=1", "--no-write-fetch-head", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=",
        "--no-auto-maintenance", "--no-write-commit-graph", "https://github.com/openlup/openlup.git", resolved.base]);
      fullCommit(root, resolved.base);
    }
    if (resolved.provenance === "merge-group") {
      try { documentationGit(root, ["merge-base", "--is-ancestor", resolved.base, head]); } catch {
        throw new Error("documentation: merge-group event base is not an observed ancestor of the checkout; complete history is required");
      }
    }
    return { ...resolved, head };
  }
  if (options.base !== undefined) {
    if (!SHA.test(options.base)) throw new Error("documentation: explicit base must be a full commit SHA");
    fullCommit(root, options.base);
    try { documentationGit(root, ["merge-base", "--is-ancestor", options.base, head]); } catch { throw new Error("documentation: explicit base is not an ancestor of HEAD"); }
    return { base: options.base, head, provenance: "explicit" };
  }
  const base = documentationGit(root, ["merge-base", "origin/main", head]).toString("utf8").trim();
  if (!SHA.test(base)) throw new Error("documentation: no merge base with origin/main");
  return { base, head, provenance: "merge-base" };
}
