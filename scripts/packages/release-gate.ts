/**
 * The release gate of `@openlup/*` package releases: the decisions that bind a release to `main`,
 * in one implementation for both package workflows.
 *
 * - `in-flight <own run ID>` refuses while a run of a release workflow other than this one is
 *   requested, queued, pending, waiting for approval or in progress, and names each such run.
 *   GitHub keeps one pending run per concurrency group and cancels the older one, so a second
 *   dispatch could otherwise cancel a queued publication.
 * - `commit <sha>` refuses unless the checkout is `<sha>`, `<sha>` is an ancestor of `main` as
 *   fetched from origin now, and each required context passed there: GitHub Actions ran it at
 *   `<sha>` and every latest run of it succeeded.
 * - `tag <sha> <package> <version>` repeats that main ancestry, then creates the annotated tag
 *   `openlup-<package>-v<version>` on `<sha>` itself, never on another commit, and refuses unless
 *   GitHub answers with a tag object of that name on that commit and a reference to that object.
 *
 * `publish-package.yml` runs this file as it is at the dispatched `main` commit, never the
 * target's copy; `publish-packages.yml` runs it at its release commit, as it runs that commit's
 * workflow file. It imports only Node built-ins so that it runs as that one file. The token is
 * GITHUB_TOKEN; `tag` needs the release App's.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type GateFetch = (input: string, init?: RequestInit) => Promise<Response>;
const GITHUB_API = "https://api.github.com/repos/openlup/openlup";
/** The required jobs of `published-tree-ci.yml`, by their check names. */
export const REQUIRED_CONTEXTS = ["dco", "typecheck", "install-proof", "test", "self-check", "gitleaks"] as const;
/** The workflows that release or publish a package; a set release is a run of publish-package.yml. */
export const RELEASE_WORKFLOWS = ["publish-package.yml", "publish-packages.yml"] as const;
/** Every status of a workflow run that has not completed. */
export const ACTIVE_RUN_STATUSES = ["requested", "queued", "pending", "waiting", "in_progress"] as const;
/** Where the fetched `main` lands: a ref of the gate's own, overwritten by every fetch. */
const FRESH_MAIN = "refs/openlup-release/main";
const COMMIT = /^[a-f0-9]{40}$/u;
type Json = Record<string, unknown>;

function record(value: unknown, what: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is malformed`);
  return value as Json;
}

const headers = (token?: string) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function github(path: string, token: string | undefined, fetcher: GateFetch, body?: Json): Promise<Json> {
  const init: RequestInit = body === undefined ? { headers: headers(token) } : { method: "POST", headers: { ...headers(token), "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetcher(`${GITHUB_API}${path}`, init);
  if (!response.ok) throw new Error(`release gate: GitHub refused ${path}: HTTP ${response.status}`);
  return record(await response.json(), `GitHub's answer to ${path}`);
}

/** The checkout is `commit`, which is an ancestor of origin's `main` fetched now. Returns that `main` commit. */
export function assertOnFreshMain(root: string, commit: string): string {
  if (!COMMIT.test(commit)) throw new Error("release gate: the commit must be a full lowercase SHA");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("rev-parse", "HEAD") !== commit) throw new Error(`release gate: the checkout is not ${commit}`);
  git("fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:${FRESH_MAIN}`);
  const mainTip = git("rev-parse", "--verify", `${FRESH_MAIN}^{commit}`);
  try {
    git("merge-base", "--is-ancestor", commit, mainTip);
  } catch {
    throw new Error(`release gate: ${commit} is not on main, whose tip is ${mainTip}`);
  }
  return mainTip;
}

/** One required context passed: GitHub Actions ran it, and every latest run of it succeeded. */
export function contextPassed(answer: unknown): boolean {
  const runs = record(answer, "check runs").check_runs;
  if (!Array.isArray(runs)) throw new Error("check runs are malformed");
  const actions = runs.map((run) => record(run, "check run")).filter((run) => (run.app as Json | null | undefined)?.slug === "github-actions");
  return actions.length > 0 && actions.every((run) => run.conclusion === "success");
}

/** Every required context passed at `commit`. */
export async function assertRequiredChecks(commit: string, token?: string, fetcher: GateFetch = fetch): Promise<void> {
  if (!COMMIT.test(commit)) throw new Error("release gate: the commit must be a full lowercase SHA");
  for (const context of REQUIRED_CONTEXTS) {
    const answer = await github(`/commits/${commit}/check-runs?check_name=${context}&filter=latest&per_page=100`, token, fetcher);
    if (!contextPassed(answer)) throw new Error(`release gate: ${context} has not passed at ${commit}`);
  }
}

/** No run of `workflows` but `ownRunId` has yet to complete. */
export async function assertNoReleaseInFlight(ownRunId: string, token?: string, fetcher: GateFetch = fetch, workflows: readonly string[] = RELEASE_WORKFLOWS): Promise<void> {
  if (!/^[1-9][0-9]*$/u.test(ownRunId)) throw new Error("release gate: the own run ID must be a positive integer");
  const busy = new Map<string, string>();
  for (const workflow of workflows) {
    for (const status of ACTIVE_RUN_STATUSES) {
      const runs = (await github(`/actions/workflows/${workflow}/runs?status=${status}&per_page=100`, token, fetcher)).workflow_runs;
      if (!Array.isArray(runs)) throw new Error(`${workflow} runs are malformed`);
      for (const run of runs.map((value) => record(value, "workflow run"))) {
        if (String(run.id) === ownRunId) continue;
        busy.set(String(run.id), `${String(run.name)} run ${String(run.id)} (${String(run.status)}) ${String(run.html_url)}`);
      }
    }
  }
  if (busy.size > 0) throw new Error(`release gate: one package release or publication runs at a time, and these have not completed: ${[...busy.values()].join("; ")}`);
}

/** The tag name and annotated message of a package release. */
export function packageReleaseTag(directoryName: string, version: string): { tag: string; message: string } {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(directoryName)) throw new Error("release gate: package must be a directory name under packages/");
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) throw new Error("release gate: version must be a MAJOR.MINOR.PATCH release version");
  return { tag: `openlup-${directoryName}-v${version}`, message: `OpenLup package @openlup/${directoryName} ${version}.\n` };
}

/** On the checkout `commit`, which is on main fetched now: the annotated tag object, then its reference. */
export async function createReleaseTag(root: string, commit: string, directoryName: string, version: string, token?: string, fetcher: GateFetch = fetch): Promise<{ tag: string; tagObject: string; mainTip: string }> {
  const { tag, message } = packageReleaseTag(directoryName, version);
  const mainTip = assertOnFreshMain(root, commit);
  const created = await github("/git/tags", token, fetcher, { tag, message, object: commit, type: "commit" });
  const tagged = record(created.object, "created tag target");
  const tagObject = created.sha;
  // The commit, its type and the tag name bind the release. The message is formatting: it may come
  // back as sent or with one more trailing newline, and nothing else.
  const sentMessage = created.message === message || created.message === `${message}\n`;
  if (typeof tagObject !== "string" || !COMMIT.test(tagObject) || tagged.sha !== commit || tagged.type !== "commit" || created.tag !== tag || !sentMessage) throw new Error(`release gate: GitHub created another tag object than ${tag} on ${commit}`);
  const ref = await github("/git/refs", token, fetcher, { ref: `refs/tags/${tag}`, sha: tagObject });
  const referenced = record(ref.object, "created tag reference");
  if (ref.ref !== `refs/tags/${tag}` || referenced.type !== "tag" || referenced.sha !== tagObject) throw new Error(`release gate: refs/tags/${tag} does not name the tag object ${tagObject}`);
  return { tag, tagObject, mainTip };
}

const USAGE = "expected in-flight <own run ID>, commit <sha>, or tag <sha> <package> <version>";

async function main(): Promise<void> {
  const { env, argv } = process;
  const [phase, ...args] = argv.slice(2);
  const token = env.GITHUB_TOKEN || undefined;
  const root = realpathSync(process.cwd());
  if (phase === "in-flight" && args.length === 1) {
    await assertNoReleaseInFlight(args[0]!, token);
    console.log("No other package release or publication is in flight");
    return;
  }
  if (phase === "commit" && args.length === 1) {
    const commit = args[0]!;
    const mainTip = assertOnFreshMain(root, commit);
    await assertRequiredChecks(commit, token);
    console.log(`${commit} is on main at ${mainTip} and passed ${REQUIRED_CONTEXTS.join(", ")}`);
    return;
  }
  if (phase === "tag" && args.length === 3) {
    const created = await createReleaseTag(root, args[0]!, args[1]!, args[2]!, token);
    console.log(`Created ${created.tag} (${created.tagObject}) on ${args[0]}, an ancestor of main at ${created.mainTip}`);
    return;
  }
  throw new Error(USAGE);
}

/** Run as a command, also as a copy outside the checkout; never when imported. */
function invokedDirectly(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "release gate refused"); process.exitCode = 1; });
}
