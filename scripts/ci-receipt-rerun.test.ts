import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ECONOMY_RECEIPT_MARKER, RECEIPT_MARKER } from "./agent-review-decide.mjs";
import { RECEIPT_MARKER_PREFIX, RERUN_JOB, WORKFLOW_PATH, receiptComment, receiptRerun, selectRerun } from "./ci-receipt-rerun.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = "a".repeat(40);
const previous = "b".repeat(40);
const NAMES = ["dco", "typecheck", "install-proof", ...[1, 2, 3, 4, 5, 6].map((shard) => `test-full-shard (${shard}/6)`),
  "test", "self-check", "gitleaks", "pgtap", "native-review"];
type Run = { id: number; run_attempt: number; head_sha: string; event: string; path: string; status: string; conclusion: string | null };
const run = (overrides: Partial<Run> = {}): Run => ({ id: 200, run_attempt: 1, head_sha: head, event: "pull_request",
  path: WORKFLOW_PATH, status: "completed", conclusion: "failure", ...overrides });
const jobs = (results: Record<string, string> = { "native-review": "failure" }, runId = 200, sha = head) => NAMES.map((name, index) => ({
  id: index + 1, run_id: runId, run_attempt: 1, head_sha: sha, name, status: "completed", conclusion: results[name] ?? "success",
}));
const comment = (body: string, association = "MEMBER", overrides: Record<string, unknown> = {}) => ({
  action: "created", issue: { number: 12, pull_request: { url: "https://api.github.com/repos/openlup/openlup/pulls/12" } },
  comment: { id: 7, body, author_association: association }, ...overrides,
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
    expect(receiptComment(comment(`${marker}\n\`\`\`json\n{}\n\`\`\``, association))).toEqual({ ok: true, pr: 12 });
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
    ["a non-string body", { ...comment(receipt), comment: { id: 7, body: { receipt }, author_association: "MEMBER" } }],
  ])("ignores %s", (_label, event) => {
    expect(receiptComment(event).ok).toBe(false);
  });
});

describe("rerun selection", () => {
  it("does not rerun without a run for the current head", () => {
    expect(selectRerun([], [], head)).toMatchObject({ rerun: false, reason: expect.stringContaining("no Published Tree CI run") });
  });

  it("reruns once when native-review is the only failed job", () => {
    expect(selectRerun([run()], jobs(), head)).toEqual({ rerun: true, runId: 200, attempt: 1,
      reason: `${RERUN_JOB} is the only failed job of run 200 attempt 1` });
  });

  it.each([
    [{ "native-review": "failure", "test-full-shard (3/6)": "failure", test: "failure" }],
    [{ "native-review": "failure", "install-proof": "failure" }],
    [{ "native-review": "failure", "self-check": "cancelled" }],
    [{ "native-review": "failure", pgtap: "timed_out" }],
    [{ "test-full-shard (1/6)": "failure", test: "failure" }],
  ])("does not rerun native-review with another real failure %#", (results) => {
    expect(selectRerun([run()], jobs(results), head)).toMatchObject({ rerun: false, reason: expect.stringContaining("not only native-review") });
  });

  it("ignores an older run for a previous head", () => {
    expect(selectRerun([run({ id: 150, head_sha: previous })], jobs({ "native-review": "failure" }, 150, previous), head))
      .toMatchObject({ rerun: false, reason: expect.stringContaining("no Published Tree CI run") });
    const decision = selectRerun([run({ id: 150, head_sha: previous }), run({ id: 210 })], jobs({ "native-review": "failure" }, 210), head);
    expect(decision).toMatchObject({ rerun: true, runId: 210 });
  });

  it.each(["in_progress", "queued", "waiting", "requested", "pending"])("does not rerun a %s run", (status) => {
    expect(selectRerun([run({ status, conclusion: null })], jobs(), head)).toMatchObject({ rerun: false, reason: expect.stringContaining(status) });
  });

  it("does not rerun while a job of the run is unfinished", () => {
    const list = jobs(); list[0].status = "in_progress";
    expect(selectRerun([run()], list, head)).toMatchObject({ rerun: false, reason: expect.stringContaining("jobs still running: dco") });
  });

  it("uses only the newest run for the current head", () => {
    expect(selectRerun([run({ id: 190 }), run({ id: 200, conclusion: "success" })], jobs({}, 200), head))
      .toMatchObject({ rerun: false, reason: "latest run 200 concluded success" });
    expect(selectRerun([run({ id: 200 }), run({ id: 190, conclusion: "success" })], jobs(), head)).toMatchObject({ rerun: true, runId: 200 });
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
    expect(selectRerun(runs, list, head).rerun).toBe(false);
  });

  it("fails closed on an invalid head", () => {
    expect(selectRerun([run()], jobs(), "main")).toMatchObject({ rerun: false, reason: "pull request head is invalid" });
  });
});

describe("receipt rerun flow", () => {
  const fixture = () => {
    const pull = { number: 12, state: "open", base: { ref: "main" }, head: { sha: head } };
    const listing = { total_count: 1, workflow_runs: [run()] };
    const jobsResult = { total_count: NAMES.length, jobs: jobs() };
    const latest = run();
    const calls: string[] = []; const posts: string[] = []; const logs: string[] = [];
    const api = {
      get: async (path: string) => {
        calls.push(path);
        if (path === "repos/openlup/openlup/pulls/12") return pull;
        if (path === `repos/openlup/openlup/actions/workflows/published-tree-ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`) return listing;
        if (path === "repos/openlup/openlup/actions/runs/200/jobs?filter=latest&per_page=100") return jobsResult;
        if (path === "repos/openlup/openlup/actions/runs/200") return latest;
        throw new Error(`unexpected ${path}`);
      },
      post: async (path: string) => { posts.push(path); },
    };
    const input = { event: comment(receipt), repository: "openlup/openlup", api, log: (line: string) => logs.push(line) };
    return { input, pull, listing, jobsResult, latest, calls, posts, logs };
  };
  type Fixture = ReturnType<typeof fixture>;

  it("requests one failed-jobs rerun for the current head's latest run", async () => {
    const f = fixture();
    expect(await receiptRerun(f.input)).toMatchObject({ rerun: true, runId: 200, attempt: 1 });
    expect(f.posts).toEqual(["repos/openlup/openlup/actions/runs/200/rerun-failed-jobs"]);
    expect(f.calls).toHaveLength(4);
    expect(f.logs).toEqual([expect.stringContaining("Requested one rerun")]);
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
    expect(f.calls).toHaveLength(2); expect(f.posts).toEqual([]);
  });

  it.each([
    ["a closed pull request", (f: Fixture) => { f.pull.state = "closed"; }],
    ["a pull request to another base", (f: Fixture) => { f.pull.base.ref = "release"; }],
    ["a different pull request", (f: Fixture) => { f.pull.number = 13; }],
    ["an incomplete run listing", (f: Fixture) => { f.listing.total_count = 101; }],
    ["an incomplete job listing", (f: Fixture) => { f.jobsResult.total_count = 30; }],
    ["another failed job", (f: Fixture) => { f.jobsResult.jobs[0].conclusion = "failure"; }],
    ["a rerun started meanwhile", (f: Fixture) => { f.latest.run_attempt = 2; }],
    ["a run now in progress", (f: Fixture) => { f.latest.status = "in_progress"; }],
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

  it("allows only native-review to fail because no Published Tree CI job aggregates it", () => {
    const ci = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
    expect(ci).toContain(`\n  native-review:\n    name: ${RERUN_JOB}\n`);
    const needs = [...ci.matchAll(/^ {4}needs: (.+)$/gmu)].map((match) => match[1]);
    expect(needs.length).toBeGreaterThan(0);
    expect(needs.filter((value) => value.includes(RERUN_JOB))).toEqual([]);
  });
});
