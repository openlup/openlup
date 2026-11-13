// Local dry run of the hosted SQL admission for a pull-request range. It imports the checks that the
// required self-check and the merge queue run and reimplements none of them. Hosted CI and the merge
// queue remain authoritative; this command only shows a refusal before a push.
//
// The checks read Git objects only. A throwaway bare repository borrows this repository's objects
// through `objects/info/alternates` and holds the pull-request merge objects this command writes.
// This repository's object content, refs,
// index and worktree stay unchanged, but Git may refresh existing objects' timestamps.
// Every Git call runs through the self-check's
// helper, whose closed environment drops inherited repository, index and object redirections.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { needsForwardApproval } from "./agent-review-queue.mjs";
import { captureCommittedReviewCandidate } from "./agent-review-session.mjs";
import { documentationGit } from "./documentation-git.ts";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { assertCoLocatedForwardApproval } from "./reviewed-platform-forward.ts";

export const SQL_ADMIT_USAGE = "usage: npm run sql:admit -- [--base <rev>] [--head <rev>] [--allow-stale-rules]\n"
  + "Checks committed revisions only; commit first; a local commit can be amended.\n"
  + "  --base               comparison base; default: the fetched origin/main (run git fetch origin first)\n"
  + "  --head               candidate commit; default: HEAD (refuses uncommitted changes unless --head is explicit)\n"
  + "  --allow-stale-rules  run even when this checkout's admission code differs from the base; prints a warning";
const RAILS = ["db/platform/migrations/", "supabase/migrations/"];
const DOCS = "docs/platform/DATA_AND_MIGRATIONS.md";
const IDENTITY = ["-c", "user.name=sql-admit", "-c", "user.email=sql-admit@example.invalid"];
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "scripts/sql-admit.ts";

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
type Options = { base: string; head?: string; allowStaleRules: boolean };

class GitFailure extends Error {}
function gitBytes(cwd: string, args: string[], input?: string): Buffer {
  try { return documentationGit(cwd, args, input); }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw Object.assign(new GitFailure(`git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed${stderr ? `: ${stderr}` : ""}`), { status: (error as { status?: unknown }).status });
  }
}
const git = (cwd: string, args: string[], input?: string): string => gitBytes(cwd, args, input).toString("utf8").trim();
// The queue's candidate reader, run through the same closed environment as every other throwaway-store call.
const closedRunGit = (cwd: string, ...args: string[]): Promise<string> => Promise.resolve(gitBytes(cwd, args).toString("utf8"));
function commit(cwd: string, revision: string): string {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
}

/** The repository files this command loads: its relative-import closure, which holds every check it runs. */
export function admissionRuleFiles(): string[] {
  const specifier = /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*["'](\.{1,2}\/[^"']+)["']|(?:^|[\s;])import\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gmu;
  const seen = new Set<string>(), pending = [join(CODE_ROOT, ENTRY)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
      const target = join(dirname(file), match[1] ?? match[2] ?? match[3]!);
      // A real import always resolves, because this process loaded it; text that only looks like one is skipped.
      const resolved = [target, target.replace(/\.js$/u, ".ts")].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  return [...seen].map((file) => relative(CODE_ROOT, file)).sort();
}

/** Hosted CI judges with the merge commit's code and the queue with main's: the code run here must equal the base's. */
function staleRuleFiles(cwd: string, base: string): string[] {
  const files = admissionRuleFiles();
  const local = git(cwd, ["hash-object", "--no-filters", "--stdin-paths"], `${files.map((path) => join(CODE_ROOT, path)).join("\n")}\n`).split("\n");
  const atBase = new Map(git(cwd, ["ls-tree", "-r", "-z", "--full-tree", base, "--", ...files]).split("\0").filter(Boolean)
    .map((row) => [row.slice(row.indexOf("\t") + 1), row.slice(0, row.indexOf("\t")).split(" ")[2]]));
  return files.filter((path, index) => atBase.get(path) !== local[index]);
}

function parseArguments(argv: readonly string[]): Options | "help" {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) return "help";
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (!["--base", "--head", "--allow-stale-rules"].includes(name) || options.has(name)) throw new Error(`unknown or repeated option ${name}`);
    if (name === "--allow-stale-rules") { options.set(name, "true"); continue; }
    const value = argv[++index];
    if (!value || value.startsWith("-")) throw new Error(`missing value for ${name}`);
    options.set(name, value);
  }
  return { base: options.get("--base") ?? "origin/main", head: options.get("--head"), allowStaleRules: options.has("--allow-stale-rules") };
}

/** Builds the pull-request merge commit in a throwaway object store, as hosted CI checks out the merge. */
function prepareRange(cwd: string, scratch: string, base: string, head: string): Range {
  const objects = resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "objects");
  const root = join(scratch, "repository.git");
  git(scratch, ["init", "--bare", "--quiet", root]);
  writeFileSync(join(root, "objects", "info", "alternates"), `${objects}\n`);
  const forks = git(root, ["merge-base", "--all", base, head]).split("\n").filter(Boolean);
  if (forks.length !== 1) throw new GitFailure("head must have a single fork point with base");
  let tree: string;
  try { tree = git(root, ["merge-tree", "--write-tree", "--no-messages", base, head]); }
  catch (error) {
    // Exit status 1 is a conflict; any other failure, such as a Git without `merge-tree --write-tree`, is reported as is.
    if ((error as { status?: unknown }).status !== 1) throw error;
    throw new GitFailure("head does not merge cleanly into base; merge base and resolve the conflict first");
  }
  const merge = git(root, [...IDENTITY, "commit-tree", "--no-gpg-sign", tree, "-p", base, "-p", head, "-m", "sql:admit pull-request merge"]);
  // The self-check reads its head from the checkout; only the throwaway repository's HEAD moves.
  git(root, ["update-ref", "--no-deref", "HEAD", merge]);
  return { root, base, head, fork: forks[0]!, merge };
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
  const candidate = await captureCommittedReviewCandidate(root, fork, head, closedRunGit);
  if (!needsForwardApproval(candidate.changedPaths)) {
    verdicts.push({ status: "PASS", subject: "co-located approval", check: "queue: not run, no registry or reviewed-class migration change" });
    return verdicts;
  }
  attempt("co-located approval", "queue pull request, fork..head", () => assertCoLocatedForwardApproval(root, fork, head));
  attempt("co-located approval", "queue merge group, base..merge", () => assertCoLocatedForwardApproval(root, base, merge));
  return verdicts;
}

/** `temporaryParent` holds the throwaway repository, which is removed before this returns or on SIGINT and SIGTERM. */
export async function sqlAdmit(cwd: string, argv: readonly string[], log: (line: string) => void, fail: (line: string) => void, temporaryParent = tmpdir()): Promise<number> {
  let options: Options | "help";
  try { options = parseArguments(argv); }
  catch (error) { fail(`sql:admit: ${(error as Error).message}\n${SQL_ADMIT_USAGE}`); return 2; }
  if (options === "help") { log(SQL_ADMIT_USAGE); return 0; }
  let base: string, head: string, stale: string[];
  try {
    if (options.head === undefined && git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]) !== "") {
      fail("not checked: uncommitted changes; commit first (a local commit can be amended), or pass --head <rev>");
      return 2;
    }
    base = commit(cwd, options.base); head = commit(cwd, options.head ?? "HEAD"); stale = staleRuleFiles(cwd, base);
  }
  catch (error) { fail(`sql:admit: ${(error as Error).message}`); return 2; }
  if (stale.length > 0 && !options.allowStaleRules) {
    fail(`sql:admit: the admission code this checkout runs differs from ${options.base} in ${stale.join(", ")}; hosted CI and the queue would judge with the base's code. Merge ${options.base} first, or pass --allow-stale-rules to run anyway.`);
    return 2;
  }
  const scratch = mkdtempSync(join(temporaryParent, "openlup-sql-admit-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const interrupted = (signal: NodeJS.Signals) => { cleanup(); process.exit(signal === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", interrupted).once("SIGTERM", interrupted);
  try {
    let range: Range;
    try { range = prepareRange(cwd, scratch, base, head); }
    catch (error) { fail(`sql:admit: ${(error as Error).message}`); return 2; }
    log(`sql:admit: base ${range.base} (${options.base}), head ${range.head} (${options.head ?? "HEAD"}), fork point ${range.fork}`);
    if (stale.length > 0) log(`WARNING  admission code differs from ${options.base} in ${stale.join(", ")}; hosted CI and the queue may judge differently`);
    const verdicts = await admitSqlRange(range);
    for (const verdict of verdicts) {
      log(`${verdict.status.padEnd(8)} ${verdict.subject} [${verdict.check}]${verdict.message === undefined ? "" : `: ${verdict.message}`}`);
      if (verdict.message !== undefined) log(`         capability needed: ${capabilityHint(verdict.message)}`);
    }
    const refused = verdicts.filter((verdict) => verdict.status === "REFUSED").length;
    log(`sql:admit: ${verdicts.length} checks, ${refused} refused. Not run here: npm run oss:published-tree -- --policy and -- --inventory, the neutrality ratchet, the root test suite (including the real-PostgreSQL native catalogue test) and pgTAP. Hosted CI and the merge queue remain authoritative.`);
    return refused === 0 ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", interrupted).removeListener("SIGTERM", interrupted);
    cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  sqlAdmit(process.cwd(), process.argv.slice(2), (line) => process.stdout.write(`${line}\n`), (line) => process.stderr.write(`${line}\n`))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => { process.stderr.write(`sql:admit: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
}
