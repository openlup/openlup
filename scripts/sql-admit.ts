// Local dry run of the hosted SQL admission for a pull-request range. It imports the checks that the
// required self-check and the merge queue run and reimplements none of them. Hosted CI and the merge
// queue remain authoritative; this command only shows a refusal before a push.
//
// The checks read Git objects only. A throwaway bare repository borrows this repository's objects
// through `objects/info/alternates` and keeps every object this command writes: the working-tree
// commit and the pull-request merge commit. No ref, index, worktree file or object of this
// repository changes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { needsForwardApproval } from "./agent-review-queue.mjs";
import { captureCommittedReviewCandidate } from "./agent-review-session.mjs";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { assertCoLocatedForwardApproval } from "./reviewed-platform-forward.ts";

export const SQL_ADMIT_USAGE = "usage: npm run sql:admit -- [--base <rev>] [--head <rev>]\n"
  + "  --base  comparison base; default: the fetched origin/main (run git fetch origin first)\n"
  + "  --head  candidate commit; default: the working tree, including untracked files that are not ignored";
const RAILS = ["db/platform/migrations/", "supabase/migrations/"];
const DOCS = "docs/platform/DATA_AND_MIGRATIONS.md";
const IDENTITY = { GIT_AUTHOR_NAME: "sql-admit", GIT_AUTHOR_EMAIL: "sql-admit@example.invalid", GIT_COMMITTER_NAME: "sql-admit", GIT_COMMITTER_EMAIL: "sql-admit@example.invalid" };

/** Known refusals and the capability each needs. The first match wins; unknown messages keep the generic hint. */
export const CAPABILITY_HINTS: readonly (readonly [RegExp, string])[] = [
  [/reviewed replacement pin must be approved separately unless its SQL is introduced in this PR/u,
    `a separate approval PR for this reviewed replacement pin, or its SQL in this PR (${DOCS}#co-located-sql-and-approval-pins)`],
  [/admission machinery must be approved separately/u,
    `land the admission machinery change as its own PR before the SQL (${DOCS}#co-located-sql-and-approval-pins)`],
  [/new slot time must be later than every base migration|refuses a non-increasing version/u,
    `slot order: give the forward and its slot a timestamp later than every migration on the base (${DOCS}#closed-native-store-forwards)`],
  [/immutable/u,
    `issued approvals, slots and bindings never change; add a new forward instead (${DOCS}#co-located-sql-and-approval-pins)`],
  [/must be approved separately/u,
    `a separate approval PR for the registry change (${DOCS}#co-located-sql-and-approval-pins)`],
  [/requires an exact slot and feature binding|requires a binding|has no reviewed replacement approval|differs from reviewed replacement path or bytes|differs from its exact approved bytes/u,
    `an exact reviewed binding for these bytes; an unadmitted shape needs a class-slot or capability PR first (${DOCS}#exact-reviewed-function-forwards, ${DOCS}#closed-native-store-forwards)`],
  [/refuses an edit, deletion, mode change or unsupported addition/u,
    `migration history is append-only; add a new forward instead (${DOCS}#additive-forward-release-path)`],
  [/manifest refuses|manifest must|regular portable manifests/u,
    `bind exactly the appended portable forwards in config/platform-migration-manifest.json (${DOCS}#additive-forward-release-path)`],
  [/control characters/u,
    `remove control characters other than tab and line feed (${DOCS}#additive-forward-release-path)`],
  [/slot path, row or order drifted|feature path, order or inventory drifted|closed signature, preimage or search_path drifted|requires a closed slots list|invalid fixed identity or hash/u,
    `the reviewed registry fails its strict reader; correct the class data, and a new class shape needs a capability PR first (${DOCS}#closed-native-store-forwards)`],
];
export function capabilityHint(message: string): string {
  return CAPABILITY_HINTS.find(([pattern]) => pattern.test(message))?.[1] ?? `see ${DOCS}`;
}

export type SqlAdmitVerdict = { status: "PASS" | "REFUSED"; subject: string; check: string; message?: string };
type Range = { root: string; base: string; head: string; fork: string; merge: string };

// Inherited repository redirections would point the plumbing at another repository, index or object store.
const REDIRECTIONS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]);
class GitFailure extends Error {}
function gitBytes(cwd: string, args: string[], extra: Record<string, string> = {}): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !REDIRECTIONS.has(key)));
  try {
    return execFileSync("git", ["--no-replace-objects", "-C", cwd, "-c", "core.fsmonitor=false", ...args],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: { ...env, ...extra } });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new GitFailure(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}
const git = (cwd: string, args: string[], extra: Record<string, string> = {}): string => gitBytes(cwd, args, extra).toString("utf8").trim();
function commit(cwd: string, revision: string): string {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
}

function parseArguments(argv: readonly string[]): { base: string; head?: string } | "help" {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) return "help";
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index]!, argv[index + 1]];
    if (!["--base", "--head"].includes(name) || options.has(name)) throw new Error(`unknown or repeated option ${name}`);
    if (!value || value.startsWith("-")) throw new Error(`missing value for ${name}`);
    options.set(name, value);
  }
  return { base: options.get("--base") ?? "origin/main", head: options.get("--head") };
}

/** Builds the head and the pull-request merge commit in a throwaway object store, as hosted CI checks out the merge. */
function prepareRange(cwd: string, scratch: string, options: { base: string; head?: string }): Range & { headLabel: string } {
  const objects = resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "objects");
  const root = join(scratch, "repository.git");
  git(scratch, ["init", "--bare", "--quiet", root]);
  writeFileSync(join(root, "objects", "info", "alternates"), `${objects}\n`);
  const base = commit(cwd, options.base);
  let head: string;
  if (options.head !== undefined) head = commit(cwd, options.head);
  else {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new GitFailure("the working-tree mode needs a worktree; pass --head <rev>");
    const top = git(cwd, ["rev-parse", "--show-toplevel"]), parent = commit(cwd, "HEAD");
    // A temporary index and object directory: the real index, refs and object store stay untouched.
    const scoped = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OBJECT_DIRECTORY: join(root, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    git(top, ["read-tree", parent], scoped);
    git(top, ["add", "--all"], scoped);
    const tree = git(top, ["write-tree"], scoped);
    head = git(root, ["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-m", "sql:admit working tree"], IDENTITY);
  }
  const forks = git(root, ["merge-base", "--all", base, head]).split("\n").filter(Boolean);
  if (forks.length !== 1) throw new GitFailure("head must have a single fork point with base");
  let tree: string;
  try { tree = git(root, ["merge-tree", "--write-tree", "--no-messages", base, head]); }
  catch { throw new GitFailure("head does not merge cleanly into base; merge base and resolve the conflict first"); }
  const merge = git(root, ["commit-tree", "--no-gpg-sign", tree, "-p", base, "-p", head, "-m", "sql:admit pull-request merge"], IDENTITY);
  // The self-check reads its head from the checkout; only the throwaway repository's HEAD moves.
  git(root, ["update-ref", "--no-deref", "HEAD", merge]);
  return { root, base, head, fork: forks[0]!, merge, headLabel: options.head ?? "working tree" };
}

/** Runs each hosted check in the mode the self-check and the queue use for a pull request. */
export async function admitSqlRange({ root, base, head, fork, merge }: Range): Promise<SqlAdmitVerdict[]> {
  const verdicts: SqlAdmitVerdict[] = [];
  const attempt = (subject: string, check: string, action: () => void) => {
    try { action(); verdicts.push({ status: "PASS", subject, check }); }
    catch (error) { verdicts.push({ status: "REFUSED", subject, check, message: error instanceof Error ? error.message : String(error) }); }
  };
  // Required self-check (`--policy`, pull-request provenance): base is main, head is the PR merge commit.
  const added = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, merge, "--", ...RAILS]).split("\0").filter((path) => path.endsWith(".sql"));
  for (const path of added) {
    attempt(path, "self-check forward admission", () => assertAdmittedPlatformForward(root, base, merge, path, gitBytes(root, ["cat-file", "blob", `${merge}:${path}`])));
  }
  attempt("migration history", "self-check, base..merge", () => assertAppendOnlyMigrationHistory(root, base, merge));
  // Merge queue: the PR head on its fork point, then the merge-group head on main.
  const candidate = await captureCommittedReviewCandidate(root, fork, head);
  if (!needsForwardApproval(candidate.changedPaths)) {
    verdicts.push({ status: "PASS", subject: "co-located approval", check: "queue: not run, no registry or reviewed-class migration change" });
    return verdicts;
  }
  attempt("co-located approval", "queue pull request, fork..head", () => assertCoLocatedForwardApproval(root, fork, head));
  attempt("co-located approval", "queue merge group, base..merge", () => assertCoLocatedForwardApproval(root, base, merge));
  return verdicts;
}

export async function sqlAdmit(cwd: string, argv: readonly string[], log: (line: string) => void, fail: (line: string) => void): Promise<number> {
  let options: ReturnType<typeof parseArguments>;
  try { options = parseArguments(argv); }
  catch (error) { fail(`sql:admit: ${(error as Error).message}\n${SQL_ADMIT_USAGE}`); return 2; }
  if (options === "help") { log(SQL_ADMIT_USAGE); return 0; }
  const scratch = mkdtempSync(join(tmpdir(), "openlup-sql-admit-"));
  try {
    let range: ReturnType<typeof prepareRange>;
    try { range = prepareRange(cwd, scratch, options); }
    catch (error) { fail(`sql:admit: ${(error as Error).message}`); return 2; }
    log(`sql:admit: base ${range.base} (${options.base}), head ${range.head} (${range.headLabel}), fork point ${range.fork}`);
    const verdicts = await admitSqlRange(range);
    for (const verdict of verdicts) {
      log(`${verdict.status.padEnd(8)} ${verdict.subject} [${verdict.check}]${verdict.message === undefined ? "" : `: ${verdict.message}`}`);
      if (verdict.message !== undefined) log(`         capability needed: ${capabilityHint(verdict.message)}`);
    }
    const refused = verdicts.filter((verdict) => verdict.status === "REFUSED").length;
    log(`sql:admit: ${verdicts.length} checks, ${refused} refused. Hosted CI and the merge queue remain authoritative.`);
    return refused === 0 ? 0 : 1;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  sqlAdmit(process.cwd(), process.argv.slice(2), (line) => process.stdout.write(`${line}\n`), (line) => process.stderr.write(`${line}\n`))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => { process.stderr.write(`sql:admit: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
}
