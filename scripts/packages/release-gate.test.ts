// Seeded falsifiers for the release gate. Each control is a behaviour of a gate module, checked
// against a real Git fixture and a recorded GitHub API. Each planted defect edits the committed
// source, loads the edited module, and must turn its control red. The structural control is a
// predicate over the source text.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_CHECKS } from "../agent-review-gate.mjs";
import { packageReleaseInputs } from "./package-release.ts";
import * as committed from "./release-gate.ts";

type Gate = typeof committed;
const SOURCE_FILE = fileURLToPath(new URL("./release-gate.ts", import.meta.url));
const SOURCE = readFileSync(SOURCE_FILE, "utf8");
const API = "https://api.github.com/repos/openlup/openlup";
/** The six required contexts, written out here so that a context dropped from the gate is noticed. */
const SIX = ["dco", "typecheck", "install-proof", "test", "self-check", "gitleaks"] as const;
const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
const identity = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (cwd: string, args: string[], input = "") => execFileSync("git", args, { cwd, input, encoding: "utf8", env: { ...inherited, ...identity }, stdio: ["pipe", "pipe", "pipe"] }).trim();

/** An origin whose main is base <- mainTip, a side branch base <- side, and a clone of it. */
type Fixture = { scratch: string; origin: string; clone: string; base: string; mainTip: string; side: string };
let fixture: Fixture;
function createFixture(): Fixture {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "openlup-release-gate-")));
  const origin = join(scratch, "origin.git"), clone = join(scratch, "clone");
  execFileSync("git", ["init", "--quiet", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", clone], { stdio: "ignore" });
  const tree = git(origin, ["mktree"]);
  const base = git(origin, ["commit-tree", tree, "-m", "base"]);
  const mainTip = git(origin, ["commit-tree", tree, "-p", base, "-m", "main"]);
  const side = git(origin, ["commit-tree", tree, "-p", base, "-m", "side"]);
  git(origin, ["update-ref", "refs/heads/main", mainTip]);
  git(origin, ["update-ref", "refs/heads/side", side]);
  git(clone, ["remote", "add", "origin", origin]);
  git(clone, ["fetch", "--quiet", "origin"]);
  return { scratch, origin, clone, base, mainTip, side };
}
const checkout = (commit: string) => git(fixture.clone, ["update-ref", "--no-deref", "HEAD", commit]);

type Call = { url: string; method: string; body: unknown; authorization: string | undefined };
/** A GitHub API stub that answers by exact URL and records every request. */
function github(answer: (url: string, body: Record<string, unknown> | undefined) => Response | undefined): committed.GateFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return answer(url, body) ?? new Response(null, { status: 404 });
  };
  return Object.assign(fetcher, { calls });
}

const COMMIT = "a".repeat(40);
type Run = { app: { slug: string } | null; conclusion: string | null };
const run = (conclusion: string | null, slug = "github-actions"): Run => ({ app: { slug }, conclusion });
/** Check runs per context, or an HTTP status for a refused read. */
const checks = (answers: Record<string, Run[] | number>) => github((url) => {
  const context = SIX.find((name) => url === `${API}/commits/${COMMIT}/check-runs?check_name=${name}&filter=latest&per_page=100`);
  const answer = context === undefined ? undefined : answers[context];
  if (answer === undefined) return undefined;
  return typeof answer === "number" ? new Response(null, { status: answer }) : Response.json({ total_count: answer.length, check_runs: answer.map((entry) => ({ name: context, status: "completed", ...entry })) });
});
const PASSING = Object.fromEntries(SIX.map((context) => [context, [run("success")]]));

const ACTIVE = ["requested", "queued", "pending", "waiting", "in_progress"] as const;
const WORKFLOWS = ["publish-package.yml", "publish-packages.yml"] as const;
const OWN = { id: 1001, name: "Publish Package", status: "in_progress", html_url: "https://github.com/openlup/openlup/actions/runs/1001" };
/** Workflow runs per workflow file and status. */
const runs = (table: Record<string, Partial<Record<string, object[]>>>) => github((url) => {
  for (const workflow of WORKFLOWS) for (const status of ACTIVE) {
    if (url === `${API}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`) {
      const listed = table[workflow]?.[status] ?? [];
      return Response.json({ total_count: listed.length, workflow_runs: listed });
    }
  }
  return undefined;
});

const TAG_OBJECT = "c".repeat(40);
/** GitHub's answers to the tag object and reference creation, which echo the request unless overridden. */
const tagApi = (tagAnswer: Record<string, unknown> = {}, refAnswer: Record<string, unknown> = {}) => github((url, body) => {
  if (url === `${API}/git/tags` && body) return Response.json({ sha: TAG_OBJECT, tag: body.tag, message: body.message, object: { type: body.type, sha: body.object }, ...tagAnswer }, { status: 201 });
  if (url === `${API}/git/refs` && body) return Response.json({ ref: body.ref, object: { type: "tag", sha: body.sha }, ...refAnswer }, { status: 201 });
  return undefined;
});

/** Each behaviour throws unless it holds for the given gate module. */
const BEHAVIOUR: Record<string, (gate: Gate) => Promise<void>> = {
  "main ancestry against a freshly fetched origin/main": async (gate) => {
    // Every local name of main planted on a commit off main: only the fetch from origin decides.
    checkout(fixture.side);
    for (const ref of ["refs/openlup-release/main", "refs/remotes/origin/main", "refs/heads/main"]) git(fixture.clone, ["update-ref", ref, fixture.side]);
    expect(() => gate.assertOnFreshMain(fixture.clone, fixture.side), "a commit off main").toThrow(`release gate: ${fixture.side} is not on main, whose tip is ${fixture.mainTip}`);
    const absent = "e".repeat(40);
    expect(() => gate.assertOnFreshMain(fixture.clone, absent), "a commit the repository lacks").toThrow(`release gate: ${absent} is not on main, whose tip is ${fixture.mainTip}`);
    // The workflows run the gate in a checkout of main, so what is checked out does not decide.
    for (const commit of [fixture.base, fixture.mainTip]) expect(gate.assertOnFreshMain(fixture.clone, commit), `${commit} on main, the checkout off it`).toBe(fixture.mainTip);
    for (const ref of ["refs/openlup-release/main", "refs/remotes/origin/main", "refs/heads/main"]) git(fixture.clone, ["update-ref", ref, fixture.mainTip]);
  },
  "required contexts: GitHub Actions ran each one and every latest run succeeded": async (gate) => {
    const passing = checks(PASSING);
    await expect(gate.assertRequiredChecks(COMMIT, "token", passing)).resolves.toBeUndefined();
    expect(passing.calls.map(({ url }) => url)).toEqual(SIX.map((context) => `${API}/commits/${COMMIT}/check-runs?check_name=${context}&filter=latest&per_page=100`));
    await expect(gate.assertRequiredChecks(COMMIT, "token", checks({ ...PASSING, test: [run("success"), run("failure", "another-ci")] })), "another app's failure is not GitHub Actions'").resolves.toBeUndefined();
    const refusals: Array<[string, Run[] | number]> = [
      ["no run", []], ["another app's success only", [run("success", "another-ci")]], ["a run without an app", [{ app: null, conclusion: "success" }]],
      ["a failure among successes", [run("success"), run("failure"), run("success")]], ["a failure next to another app's success", [run("failure"), run("success", "another-ci")]],
      ["an unfinished run", [run(null)]], ["a skipped run", [run("skipped")]], ["a refused read", 403],
    ];
    for (const context of SIX) {
      for (const [why, answer] of refusals) {
        await expect(gate.assertRequiredChecks(COMMIT, "token", checks({ ...PASSING, [context]: answer })), `${context}: ${why}`).rejects.toThrow(typeof answer === "number" ? `check_name=${context}&filter=latest&per_page=100: HTTP 403` : `release gate: ${context} has not passed at ${COMMIT}`);
      }
    }
  },
  "the tag lands on the approved commit": async (gate) => {
    checkout(fixture.base);
    const created = tagApi();
    await expect(gate.createReleaseTag(fixture.clone, fixture.base, "core", "0.12.0", "app-token", created)).resolves.toEqual({ tag: "openlup-core-v0.12.0", tagObject: TAG_OBJECT, mainTip: fixture.mainTip });
    expect(created.calls).toEqual([
      { url: `${API}/git/tags`, method: "POST", body: { tag: "openlup-core-v0.12.0", message: "OpenLup package @openlup/core 0.12.0.\n", object: fixture.base, type: "commit" }, authorization: "Bearer app-token" },
      { url: `${API}/git/refs`, method: "POST", body: { ref: "refs/tags/openlup-core-v0.12.0", sha: TAG_OBJECT }, authorization: "Bearer app-token" },
    ]);
    checkout(fixture.side);
    const offMain = tagApi();
    await expect(gate.createReleaseTag(fixture.clone, fixture.side, "core", "0.12.0", "app-token", offMain), "a commit off main").rejects.toThrow(/is not on main/u);
    expect(offMain.calls, "no tag object for a commit off main").toEqual([]);
    checkout(fixture.base);
    const sent = "OpenLup package @openlup/core 0.12.0.\n";
    const refusedAnswers: Array<[string, Record<string, unknown>]> = [
      ["a tag object on another commit", { object: { type: "commit", sha: fixture.mainTip } }],
      ["a tag object on a tree", { object: { type: "tree", sha: fixture.base } }],
      ["a tag object with another name", { tag: "openlup-core-v0.13.0" }],
      ["another message", { message: "OpenLup package @openlup/core 0.13.0.\n" }],
      ["the message with one more trailing newline", { message: `${sent}\n` }],
      ["the message with two more trailing newlines", { message: `${sent}\n\n` }],
      ["the message without its trailing newline", { message: sent.trimEnd() }],
    ];
    for (const [why, answer] of refusedAnswers) {
      const refused = tagApi(answer);
      await expect(gate.createReleaseTag(fixture.clone, fixture.base, "core", "0.12.0", "app-token", refused), why).rejects.toThrow(/created another tag object/u);
      expect(refused.calls.map(({ url }) => url), `no reference after ${why}`).toEqual([`${API}/git/tags`]);
    }
    await expect(gate.createReleaseTag(fixture.clone, fixture.base, "core", "0.12.0", "app-token", tagApi({}, { object: { type: "tag", sha: "d".repeat(40) } }))).rejects.toThrow(/does not name the tag object/u);
  },
  "no release or publication in flight": async (gate) => {
    const quiet = runs({ "publish-package.yml": { in_progress: [OWN] }, "publish-packages.yml": { queued: [] } });
    await expect(gate.assertNoReleaseInFlight("1001", "token", quiet), "only this run").resolves.toBeUndefined();
    expect(quiet.calls.map(({ url }) => url)).toEqual(WORKFLOWS.flatMap((workflow) => ACTIVE.map((status) => `${API}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`)));
    for (const workflow of WORKFLOWS) {
      for (const status of ACTIVE) {
        const other = { id: 42, name: "Publish Packages", status, html_url: "https://github.com/openlup/openlup/actions/runs/42" };
        const table = { "publish-package.yml": { in_progress: [OWN] }, [workflow]: { ...(workflow === "publish-package.yml" ? { in_progress: [OWN] } : {}), [status]: status === "in_progress" && workflow === "publish-package.yml" ? [OWN, other] : [other] } };
        await expect(gate.assertNoReleaseInFlight("1001", "token", runs(table)), `${workflow} ${status}`).rejects.toThrow(`Publish Packages run 42 (${status}) https://github.com/openlup/openlup/actions/runs/42`);
      }
    }
    await expect(gate.assertNoReleaseInFlight("1001", "token", github(() => new Response(null, { status: 403 }))), "a refused read").rejects.toThrow(/HTTP 403/u);
  },
};

/** The gate runs as one file taken from the main commit, so it imports nothing but Node built-ins. */
const imports = (source: string) => [...source.matchAll(/^import\b[^;]*?from\s+"([^"]+)";?$|\bimport\s*\(|\brequire\s*\(/gmu)].map((match) => match[1] ?? match[0]);
const STRUCTURE: Record<string, (source: string) => boolean> = {
  "one file with Node built-ins only": (source) => imports(source).length > 0 && imports(source).every((specifier) => specifier.startsWith("node:")),
};

type Defect = { control: string; plant: string; from: string; to: string };
/** One or more planted defects per control. Each replaces committed text, so a stale anchor fails too. */
const DEFECTS: Defect[] = [
  { control: "main ancestry against a freshly fetched origin/main", plant: "fetch the target commit instead of main", from: "`+refs/heads/main:${FRESH_MAIN}`", to: "`+${commit}:${FRESH_MAIN}`" },
  { control: "main ancestry against a freshly fetched origin/main", plant: "no fetch: trust a local main ref", from: '  git("fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:${FRESH_MAIN}`);\n', to: "" },
  { control: "main ancestry against a freshly fetched origin/main", plant: "ancestry against the checkout", from: 'git("merge-base", "--is-ancestor", commit, mainTip);', to: 'git("merge-base", "--is-ancestor", commit, "HEAD");' },
  { control: "main ancestry against a freshly fetched origin/main", plant: "a failed ancestry check admitted", from: "    throw new Error(`release gate: ${commit} is not on main, whose tip is ${mainTip}`);", to: "    return mainTip;" },
  { control: "required contexts: GitHub Actions ran each one and every latest run succeeded", plant: "any app's run counts", from: '.filter((run) => (run.app as Json | null | undefined)?.slug === "github-actions")', to: "" },
  { control: "required contexts: GitHub Actions ran each one and every latest run succeeded", plant: "one success among failures", from: "actions.every((run) =>", to: "actions.some((run) =>" },
  { control: "required contexts: GitHub Actions ran each one and every latest run succeeded", plant: "no run counts as passed", from: "actions.length > 0 && ", to: "" },
  { control: "required contexts: GitHub Actions ran each one and every latest run succeeded", plant: "a required context dropped", from: '"install-proof", ', to: "" },
  { control: "required contexts: GitHub Actions ran each one and every latest run succeeded", plant: "a query that reads every run, not the latest", from: "&filter=latest&", to: "&filter=all&" },
  { control: "the tag lands on the approved commit", plant: "the tag on the main tip", from: "{ tag, message, object: commit, type: \"commit\" }", to: "{ tag, message, object: mainTip, type: \"commit\" }" },
  { control: "the tag lands on the approved commit", plant: "the tag without the main ancestry", from: "const mainTip = assertOnFreshMain(root, commit);\n  const created", to: "const mainTip = commit;\n  const created" },
  { control: "the tag lands on the approved commit", plant: "the created tag object's commit unchecked", from: " || tagged.sha !== commit", to: "" },
  { control: "the tag lands on the approved commit", plant: "the created tag object's type unchecked", from: ' || tagged.type !== "commit"', to: "" },
  { control: "the tag lands on the approved commit", plant: "the created tag object's name unchecked", from: " || created.tag !== tag", to: "" },
  { control: "the tag lands on the approved commit", plant: "any message accepted", from: " || created.message !== message)", to: ")" },
  { control: "the tag lands on the approved commit", plant: "one more trailing newline admitted", from: "created.message !== message)", to: "created.message !== message && created.message !== `${message}\\n`)" },
  { control: "the tag lands on the approved commit", plant: "a lightweight tag", from: "{ ref: `refs/tags/${tag}`, sha: tagObject }", to: "{ ref: `refs/tags/${tag}`, sha: commit }" },
  { control: "no release or publication in flight", plant: "a run waiting for approval admitted", from: '"pending", "waiting", ', to: '"pending", ' },
  { control: "no release or publication in flight", plant: "a queued run admitted", from: '"requested", "queued", ', to: '"requested", ' },
  { control: "no release or publication in flight", plant: "publications not watched", from: '["publish-package.yml", "publish-packages.yml"]', to: '["publish-package.yml"]' },
  { control: "no release or publication in flight", plant: "every run taken for this one", from: "if (String(run.id) === ownRunId) continue;", to: 'if (String(run.id) !== "") continue;' },
  { control: "one file with Node built-ins only", plant: "a repository import", from: 'import { pathToFileURL } from "node:url";\n', to: 'import { pathToFileURL } from "node:url";\nimport { RELEASE_VERSION } from "./package-manifest-policy.ts";\n' },
  { control: "one file with Node built-ins only", plant: "a dynamic import", from: "const USAGE =", to: 'await import("./package-manifest-policy.ts");\nconst USAGE =' },
];

let mutants = 0;
async function load(source: string): Promise<Gate> {
  const file = join(fixture.scratch, `release-gate-mutant-${++mutants}.ts`);
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)) as Gate;
}

describe("release gate controls", () => {
  beforeAll(() => { fixture = createFixture(); });
  afterAll(() => { rmSync(fixture.scratch, { recursive: true, force: true }); });

  it("hold on the committed module", async () => {
    for (const [name, holds] of Object.entries(BEHAVIOUR)) await expect(holds(committed), name).resolves.toBeUndefined();
    for (const [name, holds] of Object.entries(STRUCTURE)) expect(holds(SOURCE), name).toBe(true);
  });

  it("each control has a planted defect", () => {
    expect(new Set(DEFECTS.map(({ control }) => control))).toEqual(new Set([...Object.keys(BEHAVIOUR), ...Object.keys(STRUCTURE)]));
  });

  it.each(DEFECTS.map((defect) => [`${defect.control}: ${defect.plant}`, defect] as const))("turns red on %s", async (_, defect) => {
    // A function replacer, so a `$` in the source is never read as a replacement pattern.
    const planted = SOURCE.replace(defect.from, () => defect.to);
    expect(planted, "the planted defect changes the committed source").not.toBe(SOURCE);
    if (defect.control in STRUCTURE) {
      expect(STRUCTURE[defect.control]!(planted)).toBe(false);
      return;
    }
    const gate = await load(planted);
    await expect(BEHAVIOUR[defect.control]!(gate)).rejects.toThrow();
  });
});

describe("the release gate's contracts", () => {
  it("requires exactly the six contexts the native review also requires", () => {
    expect([...committed.REQUIRED_CONTEXTS]).toEqual([...SIX]);
    expect([...committed.REQUIRED_CONTEXTS]).toEqual(REQUIRED_CHECKS);
  });

  it("names the tag and message exactly as the package release checks them", () => {
    for (const [directoryName, version] of [["core", "0.12.0"], ["ui", "1.0.0"], ["data-tools", "10.20.30"]] as const) {
      const input = packageReleaseInputs(directoryName, version, COMMIT, "note\n");
      expect(committed.packageReleaseTag(directoryName, version), `${directoryName} ${version}`).toEqual({ tag: input.tag, message: `${input.message}\n` });
    }
    for (const [directoryName, version] of [["Core", "0.12.0"], ["../core", "0.12.0"], ["-core", "0.12.0"], ["core", "0.12"], ["core", "0.12.0-rc.1"], ["core", "v0.12.0"], ["core", "01.0.0"], ["core", "0.12.0\n"]]) {
      expect(() => committed.packageReleaseTag(directoryName!, version!), `${directoryName} ${version}`).toThrow(/release gate: (?:package|version) must be/u);
    }
  });

  it("refuses malformed commits and run IDs before any read", async () => {
    const untouched = github(() => undefined);
    for (const commit of ["main", "A".repeat(40), "a".repeat(39), `${COMMIT}\n`]) {
      expect(() => committed.assertOnFreshMain(tmpdir(), commit), commit).toThrow(/full lowercase SHA/u);
      await expect(committed.assertRequiredChecks(commit, "token", untouched), commit).rejects.toThrow(/full lowercase SHA/u);
    }
    for (const id of ["", "0", "x", "-1", "01"]) await expect(committed.assertNoReleaseInFlight(id, "token", untouched), id).rejects.toThrow(/own run ID/u);
    expect(untouched.calls).toEqual([]);
  });
});

describe("the release gate as one file outside the checkout", () => {
  beforeAll(() => { fixture = createFixture(); });
  afterAll(() => { rmSync(fixture.scratch, { recursive: true, force: true }); });

  /** Runs the committed source the way publish-package.yml does: copied to a .mts file outside the checkout. */
  function gate(args: string[]) {
    const file = join(fixture.scratch, "release-gate.mts");
    writeFileSync(file, SOURCE);
    return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", file, ...args], { cwd: fixture.clone, encoding: "utf8", timeout: 20_000, env: { ...inherited, GITHUB_TOKEN: "" } });
  }

  it("refuses a commit off main, and a tag on it, before any GitHub read", () => {
    checkout(fixture.side);
    for (const args of [["commit", fixture.side], ["tag", fixture.side, "core", "0.12.0"]]) {
      const result = gate(args);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr.trim()).toBe(`release gate: ${fixture.side} is not on main, whose tip is ${fixture.mainTip}`);
    }
  });

  /** Runs `source` as a module imported by a script whose entry is another copy named release-gate.mts. */
  function misdetected(source: string) {
    const imported = join(fixture.scratch, "imported", "release-gate.mts"), entry = join(fixture.scratch, "entry", "release-gate.mts");
    for (const file of [imported, entry]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); }
    const loader = `await import(${JSON.stringify(pathToFileURL(imported).href)});`;
    return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", loader, entry, "commit", COMMIT], { cwd: fixture.clone, encoding: "utf8", timeout: 20_000, env: { ...inherited, GITHUB_TOKEN: "" } });
  }
  // Joined, so that this test file does not read as a command entrypoint to the publication policy.
  const ARGV = ["process", "argv"].join(".");
  const FAIL_CLOSED = "  // Started as a gate command, yet not detected as the entry module: an exit 0 would pass the gate.\n  console.error(`release gate: ${" + ARGV + "[1]} started, but this module is not its entry; refusing`);\n  process.exitCode = 1;\n";

  it("fails closed when started as a gate command it is not the entry module of", () => {
    const refused = misdetected(SOURCE);
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr.trim()).toMatch(/^release gate: .*[\\/]entry[\\/]release-gate\.mts started, but this module is not its entry; refusing$/u);
    for (const [plant, from, to] of [
      ["a silent exit 0", FAIL_CLOSED, ""],
      ["the refusal only logged", "  process.exitCode = 1;\n}", "}"],
      ["only a .ts entry watched", "release-gate\\.m?ts$/u", "release-gate\\.ts$/u"],
    ] as const) {
      expect(SOURCE.split(from), plant).toHaveLength(2);
      expect(misdetected(SOURCE.replace(from, () => to)).status, plant).toBe(0);
    }
  });

  it("refuses an unknown phase or argument count", () => {
    for (const args of [[], ["publish"], ["commit"], ["commit", COMMIT, "extra"], ["in-flight"], ["tag", COMMIT, "core"]]) {
      const result = gate(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr.trim()).toBe("expected in-flight <own run ID>, commit <sha>, or tag <sha> <package> <version>");
    }
  });
});
