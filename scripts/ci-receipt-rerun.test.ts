import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ECONOMY_RECEIPT_MARKER, RECEIPT_MARKER } from "./agent-review-decide.mjs";
import { RECEIPT_MARKER_PREFIX, RERUN_JOB, WORKFLOW_PATH, WRITE_PERMISSIONS, hasWriteAccess, latestRun, receiptComment, receiptRerun, selectRerun } from "./ci-receipt-rerun.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = "a".repeat(40);
const previous = "b".repeat(40);
const NAMES = ["dco", "typecheck", "install-packages", ...["0", "1,6", "2,4", "3,5"].map((groups) => `install-browser (${groups})`),
  "install-proof", ...[1, 2, 3, 4, 5, 6].map((shard) => `test-full-shard (${shard}/6)`),
  "test", "self-check", "gitleaks", "pgtap", "native-review"];
const source = { branch: "feature", repositoryId: 77 };
type Run = { id: number; run_attempt: number; head_sha: string; head_branch: string; head_repository: { id: number } | null;
  event: string; path: string; status: string; conclusion: string | null };
const run = (overrides: Partial<Run> = {}): Run => ({ id: 200, run_attempt: 1, head_sha: head, head_branch: "feature", head_repository: { id: 77 },
  event: "pull_request", path: WORKFLOW_PATH, status: "completed", conclusion: "failure", ...overrides });
const jobs = (results: Record<string, string> = { "native-review": "failure" }, runId = 200, sha = head) => NAMES.map((name, index) => ({
  id: index + 1, run_id: runId, run_attempt: 1, head_sha: sha, name, status: "completed", conclusion: results[name] ?? "success",
}));
const comment = (body: string, association = "MEMBER", overrides: Record<string, unknown> = {}) => ({
  action: "created", issue: { number: 12, pull_request: { url: "https://api.github.com/repos/openlup/openlup/pulls/12" } },
  comment: { id: 7, body, author_association: association, user: { login: "review-owner", type: "User" } }, ...overrides,
});
const receipt = `${RECEIPT_MARKER}\n\`\`\`json\n{}\n\`\`\``;

describe("receipt comment gate", () => {
  it("matches the marker of every receipt format the producer prints", () => {
    for (const marker of [RECEIPT_MARKER, ECONOMY_RECEIPT_MARKER]) expect(marker.startsWith(RECEIPT_MARKER_PREFIX)).toBe(true);
    const producer = readFileSync(join(ROOT, "scripts/agent-review-session.mjs"), "utf8");
    expect(producer).toContain("if (verb === 'receipt') console.log(`${session.version === 3 ? ECONOMY_RECEIPT_MARKER : RECEIPT_MARKER}\\n");
  });

  it.each([
    [RECEIPT_MARKER, "OWNER"], [RECEIPT_MARKER, "MEMBER"], [ECONOMY_RECEIPT_MARKER, "COLLABORATOR"],
  ])("accepts a %s receipt from %s on a pull request", (marker, association) => {
    expect(receiptComment(comment(`${marker}\n\`\`\`json\n{}\n\`\`\``, association))).toEqual({ ok: true, pr: 12, login: "review-owner" });
  });

  it.each([
    ["an issue comment", comment(receipt, "MEMBER", { issue: { number: 12 } })],
    ["a null pull_request link", comment(receipt, "MEMBER", { issue: { number: 12, pull_request: null } })],
    ["an edited comment", comment(receipt, "MEMBER", { action: "edited" })],
    ["a contributor", comment(receipt, "CONTRIBUTOR")],
    ["a first-time contributor", comment(receipt, "FIRST_TIME_CONTRIBUTOR")],
    ["no association", comment(receipt, "NONE")],
    ["a lower-case association", comment(receipt, "member")],
    ["a body without the marker", comment("Looks good")],
    ["a marker after other text", comment(`note\n${receipt}`)],
    ["a non-string body", { ...comment(receipt), comment: { id: 7, body: { receipt }, author_association: "MEMBER", user: { login: "review-owner", type: "User" } } }],
    ["a bot account", { ...comment(receipt), comment: { id: 7, body: receipt, author_association: "MEMBER", user: { login: "helper[bot]", type: "Bot" } } }],
    ["a missing login", { ...comment(receipt), comment: { id: 7, body: receipt, author_association: "MEMBER", user: { type: "User" } } }],
    ["a missing user", { ...comment(receipt), comment: { id: 7, body: receipt, author_association: "MEMBER" } }],
  ])("ignores %s", (_label, event) => {
    expect(receiptComment(event).ok).toBe(false);
  });
});

describe("rerun selection", () => {
  it("does not rerun without a run for the current head", () => {
    expect(selectRerun([], [], head, source)).toMatchObject({ rerun: false, reason: expect.stringContaining("no Published Tree CI run") });
  });

  it("reruns once when native-review is the only failed job", () => {
    expect(selectRerun([run()], jobs(), head, source)).toEqual({ rerun: true, runId: 200, attempt: 1,
      reason: `${RERUN_JOB} is the only failed job of run 200 attempt 1` });
  });

  it.each([
    [{ "native-review": "failure", "test-full-shard (3/6)": "failure", test: "failure" }],
    [{ "native-review": "failure", "install-proof": "failure" }],
    [{ "native-review": "failure", "self-check": "cancelled" }],
    [{ "native-review": "failure", pgtap: "timed_out" }],
    [{ "test-full-shard (1/6)": "failure", test: "failure" }],
  ])("does not rerun native-review with another real failure %#", (results) => {
    expect(selectRerun([run()], jobs(results), head, source)).toMatchObject({ rerun: false, reason: expect.stringContaining("not only native-review") });
  });

  it("ignores an older run for a previous head", () => {
    expect(selectRerun([run({ id: 150, head_sha: previous })], jobs({ "native-review": "failure" }, 150, previous), head, source))
      .toMatchObject({ rerun: false, reason: expect.stringContaining("no Published Tree CI run") });
    const decision = selectRerun([run({ id: 150, head_sha: previous }), run({ id: 210 })], jobs({ "native-review": "failure" }, 210), head, source);
    expect(decision).toMatchObject({ rerun: true, runId: 210 });
  });

  it.each(["in_progress", "queued", "waiting", "requested", "pending"])("does not rerun a %s run", (status) => {
    expect(selectRerun([run({ status, conclusion: null })], jobs(), head, source)).toMatchObject({ rerun: false, reason: expect.stringContaining(status) });
  });

  it("does not rerun while a job of the run is unfinished", () => {
    const list = jobs(); list[0].status = "in_progress";
    expect(selectRerun([run()], list, head, source)).toMatchObject({ rerun: false, reason: expect.stringContaining("jobs still running: dco") });
  });

  it("uses only the newest run for the current head", () => {
    expect(selectRerun([run({ id: 190 }), run({ id: 200, conclusion: "success" })], jobs({}, 200), head, source))
      .toMatchObject({ rerun: false, reason: "latest run 200 concluded success" });
    expect(selectRerun([run({ id: 200 }), run({ id: 190, conclusion: "success" })], jobs(), head, source)).toMatchObject({ rerun: true, runId: 200 });
  });

  it.each([
    ["another workflow", [run({ path: ".github/workflows/other.yml" })], jobs()],
    ["a non-pull-request run", [run({ event: "merge_group" })], jobs()],
    ["a cancelled run", [run({ conclusion: "cancelled" })], jobs({ "native-review": "cancelled" })],
    ["a cancelled native-review", [run()], jobs({ "native-review": "cancelled" })],
    ["a timed-out native-review", [run()], jobs({ "native-review": "timed_out" })],
    ["a failed run without failed jobs", [run()], jobs({})],
    ["missing jobs", [run()], []],
    ["jobs of another run", [run()], jobs({ "native-review": "failure" }, 199)],
    ["jobs of another head", [run()], jobs({ "native-review": "failure" }, 200, previous)],
    ["duplicated job names", [run()], [...jobs(), { ...jobs()[0], id: 99 }]],
    ["a later job attempt than the run", [run()], jobs().map((job) => ({ ...job, run_attempt: 2 }))],
    ["an invalid run attempt", [run({ run_attempt: 0 })], jobs()],
    ["an invalid runs value", null, jobs()],
  ])("fails closed on %s", (_label, runs, list) => {
    expect(selectRerun(runs, list, head, source).rerun).toBe(false);
  });

  it.each([
    ["an empty list", []],
    ["a missing list", undefined],
    ["a non-list", { workflow_runs: [run()] }],
    ["only non-object entries", [null, 1, "run"]],
    ["only entries without a valid id", [run({ id: 0 }), run({ id: -1 }), { ...run(), id: "200" }]],
    ["only runs of another head", [run({ head_sha: previous })]],
  ])("finds no latest run in %s without throwing", (_label, runs) => {
    expect(latestRun(runs, head, source)).toBeUndefined();
    expect(selectRerun(runs, jobs(), head, source)).toMatchObject({ rerun: false });
  });

  it("picks the highest run id regardless of order", () => {
    const runs = [run({ id: 190 }), run({ id: 230 }), null, run({ id: 210 })];
    expect(latestRun(runs, head, source)?.id).toBe(230);
    expect(latestRun([...runs].reverse(), head, source)?.id).toBe(230);
    expect(latestRun([run({ id: 5 })], head, source)?.id).toBe(5);
  });

  it("fails closed on an invalid head", () => {
    expect(selectRerun([run()], jobs(), "main", source)).toMatchObject({ rerun: false, reason: "pull request head is invalid" });
  });

  it.each([
    ["another head branch", { head_branch: "other" }],
    ["a fork with the same branch name", { head_repository: { id: 78 } }],
    ["no head repository", { head_repository: null }],
  ])("ignores a run of the same head from %s", (_label, overrides) => {
    expect(selectRerun([run(overrides)], jobs(), head, source)).toMatchObject({ rerun: false, reason: expect.stringContaining("no Published Tree CI run") });
    expect(selectRerun([run({ id: 300, ...overrides }), run({ id: 200 })], jobs(), head, source)).toMatchObject({ rerun: true, runId: 200 });
  });

  it.each([undefined, {}, { branch: "", repositoryId: 77 }, { branch: "feature", repositoryId: 0 }, { branch: "feature" }, { repositoryId: 77 }])(
    "fails closed on the invalid pull request source %j", (value) => {
      expect(selectRerun([run()], jobs(), head, value)).toMatchObject({ rerun: false, reason: "pull request head branch or repository is invalid" });
      expect(latestRun([run()], head, value)).toBeUndefined();
    });
});

describe("receipt author authority", () => {
  it("applies the write, maintain or admin rule of hosted admission", () => {
    const admission = readFileSync(join(ROOT, "scripts/agent-review-queue.mjs"), "utf8");
    expect(admission).toContain("permissions.set(key, ['admin', 'maintain', 'write'].includes(access?.permission ?? access?.role_name));");
    expect(WRITE_PERMISSIONS).toEqual(["admin", "maintain", "write"]);
  });

  it.each([
    [{ permission: "admin" }, true], [{ permission: "maintain" }, true], [{ permission: "write", role_name: "custom" }, true],
    [{ role_name: "maintain" }, true], [{ permission: "triage" }, false], [{ permission: "read", role_name: "admin" }, false],
    [{ permission: "none" }, false], [{ permission: "Admin" }, false], [{}, false], [null, false], [undefined, false],
  ])("decides %j as %s", (access, expected) => {
    expect(hasWriteAccess(access)).toBe(expected);
  });
});

describe("receipt rerun flow", () => {
  const fixture = () => {
    type Pull = { number: number; state: string; base: { ref: string }; head: { sha: string; ref: string; repo: { id: number } | null } };
    const pull: Pull = { number: 12, state: "open", base: { ref: "main" }, head: { sha: head, ref: "feature", repo: { id: 77 } } };
    // The pull request as read again immediately before the rerun request.
    const live: Pull = structuredClone(pull);
    const listing = { total_count: 1, workflow_runs: [run()] };
    const jobsResult = { total_count: NAMES.length, jobs: jobs() };
    const latest = run();
    const access: { value: unknown; error?: Error } = { value: { permission: "write", role_name: "write" } };
    const calls: string[] = []; const posts: string[] = []; const logs: string[] = [];
    const api = {
      get: async (path: string) => {
        calls.push(path);
        if (path === "repos/openlup/openlup/collaborators/review-owner/permission") { if (access.error) throw access.error; return access.value; }
        if (path === "repos/openlup/openlup/pulls/12") return calls.filter((call) => call === path).length === 1 ? pull : live;
        if (path === `repos/openlup/openlup/actions/workflows/published-tree-ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`) return listing;
        if (path === "repos/openlup/openlup/actions/runs/200/jobs?filter=latest&per_page=100") return jobsResult;
        if (path === "repos/openlup/openlup/actions/runs/200") return latest;
        throw new Error(`unexpected ${path}`);
      },
      post: async (path: string) => { posts.push(path); calls.push(`POST ${path}`); },
    };
    const input = { event: comment(receipt), repository: "openlup/openlup", api, log: (line: string) => logs.push(line) };
    return { input, pull, live, listing, jobsResult, latest, access, calls, posts, logs };
  };
  type Fixture = ReturnType<typeof fixture>;

  it("checks authority, binds the run and rereads the head immediately before one rerun request", async () => {
    const f = fixture();
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: true, runId: 200, attempt: 1 });
    expect(f.posts).toEqual(["repos/openlup/openlup/actions/runs/200/rerun-failed-jobs"]);
    expect(f.calls).toEqual([
      "repos/openlup/openlup/collaborators/review-owner/permission",
      "repos/openlup/openlup/pulls/12",
      `repos/openlup/openlup/actions/workflows/published-tree-ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`,
      "repos/openlup/openlup/actions/runs/200/jobs?filter=latest&per_page=100",
      "repos/openlup/openlup/actions/runs/200",
      "repos/openlup/openlup/pulls/12",
      "POST repos/openlup/openlup/actions/runs/200/rerun-failed-jobs",
    ]);
    expect(f.logs).toEqual([expect.stringContaining("Requested one rerun")]);
  });

  it("accepts a maintainer whose base permission is absent", async () => {
    const f = fixture(); f.access.value = { role_name: "maintain" };
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: true });
  });

  it.each([
    ["read permission", (f: Fixture) => { f.access.value = { permission: "read", role_name: "triage" }; }],
    ["no permission", (f: Fixture) => { f.access.value = { permission: "none", role_name: "admin" }; }],
    ["an empty answer", (f: Fixture) => { f.access.value = {}; }],
    ["a failed lookup", (f: Fixture) => { f.access.error = new Error("Not Found"); }],
  ])("does nothing after %s for the commenter", async (_label, mutate) => {
    const f = fixture(); mutate(f);
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: false, reason: "commenter has no write, maintain or admin permission" });
    expect(f.calls).toEqual(["repos/openlup/openlup/collaborators/review-owner/permission"]);
    expect(f.posts).toEqual([]);
  });

  it("reads nothing for an untrusted or unrelated comment", async () => {
    const f = fixture(); f.input.event = comment(receipt, "CONTRIBUTOR");
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: false });
    expect(f.calls).toEqual([]); expect(f.posts).toEqual([]);
    expect(f.logs).toEqual([expect.stringContaining("not an owner, member or collaborator")]);
  });

  it("does not read jobs of an unfinished run", async () => {
    const f = fixture(); f.listing.workflow_runs = [run({ status: "in_progress", conclusion: null })];
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: false });
    expect(f.calls).toHaveLength(3); expect(f.posts).toEqual([]);
  });

  it.each([
    ["a closed pull request", (f: Fixture) => { f.pull.state = "closed"; }],
    ["a pull request to another base", (f: Fixture) => { f.pull.base.ref = "release"; }],
    ["a different pull request", (f: Fixture) => { f.pull.number = 13; }],
    ["a deleted head repository", (f: Fixture) => { f.pull.head.repo = null; }],
    ["an incomplete run listing", (f: Fixture) => { f.listing.total_count = 101; }],
    ["only a run of another branch", (f: Fixture) => { f.listing.workflow_runs = [run({ head_branch: "other" })]; }],
    ["only a run of another repository", (f: Fixture) => { f.listing.workflow_runs = [run({ head_repository: { id: 78 } })]; }],
    ["an incomplete job listing", (f: Fixture) => { f.jobsResult.total_count = 30; }],
    ["another failed job", (f: Fixture) => { f.jobsResult.jobs[0].conclusion = "failure"; }],
    ["a rerun started meanwhile", (f: Fixture) => { f.latest.run_attempt = 2; }],
    ["a run now in progress", (f: Fixture) => { f.latest.status = "in_progress"; }],
    ["a run rebound to another branch", (f: Fixture) => { f.latest.head_branch = "other"; }],
    ["a new head pushed before the request", (f: Fixture) => { f.live.head.sha = previous; }],
    ["a head branch changed before the request", (f: Fixture) => { f.live.head.ref = "other"; }],
    ["a head repository changed before the request", (f: Fixture) => { f.live.head.repo = { id: 78 }; }],
    ["a pull request closed before the request", (f: Fixture) => { f.live.state = "closed"; }],
  ])("does not rerun on %s", async (_label, mutate) => {
    const f = fixture(); mutate(f);
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: false });
    expect(f.posts).toEqual([]);
    expect(f.logs).toEqual([expect.stringMatching(/^No rerun: /u)]);
  });

  it.each(["../openlup", "openlup/..", "openlup", "openlup/openlup/pulls", ""])("refuses the invalid repository %j before any read", async (repository) => {
    const f = fixture(); f.input.repository = repository;
    await expect(receiptRerun(f.input)).rejects.toThrow("repository is invalid");
    expect(f.calls).toEqual([]);
  });
});

describe("receipt rerun workflow controls", () => {
  const source = readFileSync(join(ROOT, ".github/workflows/native-review-receipt-rerun.yml"), "utf8");
  const permissionBlocks = (value: string) => [...value.matchAll(/^( *)permissions:([^\n]*)\n((?:\1 +[^\n]*\n)*)/gmu)].map(([block]) => block.trimEnd());
  const assertControls = (value: string) => {
    expect(value.match(/^on:\n(?: +[^\n]*\n|\n)*/mu)?.[0].trimEnd()).toBe("on:\n  issue_comment:\n    types: [created]");
    expect(permissionBlocks(value)).toEqual(["permissions: {}",
      "    permissions:\n      actions: write\n      contents: read\n      pull-requests: read"]);
    expect(value).toContain("concurrency:\n  group: native-review-receipt-rerun-${{ github.event.comment.id }}\n  cancel-in-progress: false\n");
    expect([...(value.split("\njobs:\n")[1] ?? "").matchAll(/^ {2}([a-z-]+):$/gmu)].map((match) => match[1])).toEqual(["rerun"]);
    const condition = /^ {4}if: \$\{\{ (.+) \}\}$/mu.exec(value)?.[1] ?? "";
    expect(condition.split(" && ")).toEqual(["github.repository == 'openlup/openlup'", "vars.OPENLUP_NATIVE_QUEUE == 'enabled'",
      "github.event.issue.pull_request", `startsWith(github.event.comment.body, '${RECEIPT_MARKER_PREFIX}')`,
      "contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association)"]);
    // The untrusted body appears only in the job condition, never in a step.
    expect(value.match(/github\.event\.comment\.body/gu)).toHaveLength(1);
    expect(value).not.toMatch(/secrets\.|pull_request\.head|issue\.title|github\.head_ref|upload-artifact|download-artifact|npm |write-all/u);
    const actions = [...value.matchAll(/uses: ([^@\n]+)@([^\s#]+)/gu)].map((match) => [match[1], match[2]]);
    expect(actions).toEqual([["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"], ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"]]);
    expect(value).toContain("          ref: ${{ github.sha }}\n          persist-credentials: false\n          sparse-checkout: scripts/ci-receipt-rerun.mjs\n");
    const runs = [...value.matchAll(/^ *(?:- )?run: (.*)$/gmu)].map((match) => match[1]);
    expect(runs).toEqual(["node scripts/ci-receipt-rerun.mjs"]);
    expect(value).toContain("        env:\n          GH_TOKEN: ${{ github.token }}\n        run: node scripts/ci-receipt-rerun.mjs\n");
  };

  it("runs trusted default-branch code once per comment with least privilege", () => assertControls(source));

  it.each([
    ["  issue_comment:\n    types: [created]", "  issue_comment:\n    types: [created, edited]"],
    ["  issue_comment:\n", "  pull_request_target:\n  issue_comment:\n"],
    ["permissions: {}\n", "permissions: write-all\n"],
    ["      actions: write\n", "      actions: write\n      issues: write\n"],
    ["      contents: read\n", "      contents: write\n"],
    ["      pull-requests: read\n", "      pull-requests: write\n"],
    ["cancel-in-progress: false", "cancel-in-progress: true"],
    ["${{ github.event.comment.id }}", "${{ github.event.issue.number }}"],
    ["github.repository == 'openlup/openlup' && ", ""],
    ["github.event.issue.pull_request && ", ""],
    ["\"OWNER\",\"MEMBER\",\"COLLABORATOR\"", "\"OWNER\",\"MEMBER\",\"COLLABORATOR\",\"CONTRIBUTOR\""],
    ["ref: ${{ github.sha }}", "ref: refs/pull/${{ github.event.issue.number }}/head"],
    ["persist-credentials: false", "persist-credentials: true"],
    ["run: node scripts/ci-receipt-rerun.mjs", "run: echo '${{ github.event.comment.body }}' && node scripts/ci-receipt-rerun.mjs"],
    ["run: node scripts/ci-receipt-rerun.mjs", "run: gh run rerun --failed"],
    ["actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38", "actions/setup-node@v6"],
  ])("refuses an unsafe substitution %s", (before, after) => {
    expect(source).toContain(before);
    expect(() => assertControls(source.replace(before, after))).toThrow();
  });

});

// Workflow tests in this repository read YAML as text; it has no YAML parser dependency.
// This bounded reader accepts the scalar, flow-list and block-list forms of a job's
// `needs` and refuses any other job or `needs` form instead of guessing.
function jobNeeds(source: string): Map<string, string[]> {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (start < 0) throw new Error("workflow has no block jobs mapping");
  const indent = (line: string) => line.length - line.trimStart().length;
  const uncomment = (value: string) => value.replace(/(?:^|\s+)#.*$/u, "").trim();
  const entry = (value: string) => {
    const name = uncomment(value).replace(/^(['"])(.*)\1$/u, "$2");
    if (!/^[A-Za-z_][\w-]*$/u.test(name)) throw new Error(`unsupported needs entry: ${value}`);
    return name;
  };
  const graph = new Map<string, string[]>();
  let jobIndent: number | undefined; let propertyIndent: number | undefined; let job: string | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!uncomment(line)) continue;
    const depth = indent(line);
    if (depth === 0) break;
    jobIndent ??= depth;
    if (depth < jobIndent) throw new Error(`unexpected indentation: ${line}`);
    if (depth === jobIndent) {
      const key = /^\s*(['"]?)([A-Za-z_][\w-]*)\1:\s*(?:#.*)?$/u.exec(line);
      if (!key) throw new Error(`unsupported job declaration: ${line}`);
      job = key[2]; propertyIndent = undefined; graph.set(job, []);
      continue;
    }
    propertyIndent ??= depth;
    const needs = depth === propertyIndent ? /^\s*(['"]?)needs\1:(.*)$/u.exec(line) : null;
    if (!needs || !job) continue;
    let value = uncomment(needs[2]);
    const entries: string[] = [];
    if (value === "") {
      while (index + 1 < lines.length && (!uncomment(lines[index + 1]) || indent(lines[index + 1]) > depth
        || (indent(lines[index + 1]) === depth && lines[index + 1].trimStart().startsWith("-")))) {
        index += 1;
        const item = uncomment(lines[index]);
        if (!item) continue;
        if (!item.startsWith("- ")) throw new Error(`unsupported needs block: ${item}`);
        entries.push(entry(item.slice(2)));
      }
    } else if (value.startsWith("[")) {
      while (!value.includes("]") && index + 1 < lines.length) { index += 1; value += ` ${uncomment(lines[index])}`; }
      if (!value.endsWith("]")) throw new Error(`unsupported needs list: ${value}`);
      entries.push(...value.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean).map(entry));
    } else entries.push(entry(value));
    graph.get(job)!.push(...entries);
  }
  return graph;
}

describe("native-review aggregation", () => {
  const workflows = () => readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/u.test(name)).sort()
    .map((name) => ({ name, source: readFileSync(join(ROOT, ".github/workflows", name), "utf8") }));
  const aggregators = (sources: Array<{ name: string; source: string }>) => sources.flatMap(({ name, source }) =>
    [...jobNeeds(source)].filter(([, needs]) => needs.includes(RERUN_JOB)).map(([job]) => `${name}:${job}`));
  const ci = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  const plant = (job: string) => [...workflows().filter(({ name }) => name !== "published-tree-ci.yml"), { name: "published-tree-ci.yml", source: `${ci.trimEnd()}\n\n${job}` }];

  it("reads the real job graph and finds no job in any workflow that needs native-review", () => {
    const graph = jobNeeds(ci);
    expect(graph.get(RERUN_JOB)).toEqual(["dco", "typecheck", "install-proof", "test", "self-check", "gitleaks"]);
    expect(graph.get("test")).toEqual(["test-full-shard", "pgtap"]);
    expect(graph.get("install-proof")).toEqual(["install-packages", "install-browser"]);
    expect(graph.get("install-browser")).toEqual(["install-packages"]);
    expect(graph.get("dco")).toEqual([]);
    expect(jobNeeds(readFileSync(join(ROOT, ".github/workflows/native-review-receipt-rerun.yml"), "utf8"))).toEqual(new Map([["rerun", []]]));
    expect(workflows().length).toBeGreaterThan(1);
    expect(aggregators(workflows())).toEqual([]);
  });

  it.each([
    ["a scalar", "  planted:\n    runs-on: ubuntu-latest\n    needs: native-review\n"],
    ["a quoted scalar", "  planted:\n    needs: 'native-review' # aggregate\n"],
    ["a flow list", "  planted:\n    needs: [test, native-review]\n"],
    ["a multi-line flow list", "  planted:\n    needs: [\n      test,\n      \"native-review\",\n    ]\n"],
    ["a block list", "  planted:\n    needs:\n      - test\n      # aggregate\n      - native-review\n    runs-on: ubuntu-latest\n"],
    ["an unindented block list", "  planted:\n    needs:\n    - native-review\n"],
    ["a quoted key", "  \"planted\":\n    \"needs\": [native-review]\n"],
  ])("detects an aggregate written as %s", (_label, job) => {
    expect(aggregators(plant(job))).toEqual(["published-tree-ci.yml:planted"]);
  });

  it.each([
    ["an inline job mapping", "  planted: {needs: native-review, runs-on: ubuntu-latest}\n"],
    ["an alias", "  planted:\n    needs: *jobs\n"],
    ["an expression", "  planted:\n    needs: ${{ fromJSON('[\"native-review\"]') }}\n"],
    ["a block mapping entry", "  planted:\n    needs:\n      native-review: true\n"],
    ["an unclosed flow list", "  planted:\n    needs: [test, native-review\n"],
  ])("refuses an unsupported form: %s", (_label, job) => {
    expect(() => aggregators(plant(job))).toThrow();
  });
});
