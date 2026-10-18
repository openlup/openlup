import { describe, expect, it } from "vitest";
import { completedMergeGroup } from "./public-ci-reuse.mjs";

const sha = "a".repeat(40);
function fixture() {
  const repository = { id: 1376035358, full_name: "openlup/openlup", private: false };
  const run = { id: 100, workflow_id: 30, run_attempt: 2, event: "merge_group", head_sha: sha,
    path: ".github/workflows/published-tree-ci.yml", repository, head_repository: repository,
    head_branch: "gh-readonly-queue/main/pr-1", status: "completed", conclusion: "success" };
  const jobs = ["dco", "typecheck", "install-proof", "test", "self-check", "gitleaks", "test-full", "pgtap"].map((name, id) => ({
    id: id + 1, name, head_sha: sha, status: "completed", conclusion: "success",
  }));
  const listing = { total_count: 1, workflow_runs: [structuredClone(run)] };
  const result = { total_count: jobs.length, jobs };
  const calls: string[] = [];
  const input = { eventName: "push", ref: "refs/heads/main", sha, checkout: sha,
    event: { repository, ref: "refs/heads/main", after: sha }, token: "fixture-token",
    fetcher: async (url: string, options: RequestInit) => {
      calls.push(url);
      expect(url.startsWith("https://api.github.com/repos/openlup/openlup/")).toBe(true);
      expect(options.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
      const body = url.includes("/jobs?") ? result : url.includes("/actions/runs/") ? run : listing;
      return new Response(JSON.stringify(body));
    },
  };
  return { input, run, listing, result, jobs, calls };
}
type Fixture = ReturnType<typeof fixture>;
describe("exact-commit post-merge reuse", () => {
  it("reuses all completed group checks and reads jobs of the latest attempt", async () => {
    const f = fixture();
    expect(await completedMergeGroup(f.input)).toBe(true);
    expect(f.calls[2]).toContain("/runs/100/attempts/2/jobs?");
    expect(f.calls).toHaveLength(5);
    expect(f.calls.at(-1)).toContain("/actions/runs/100");
  });
  it.each(["pull_request", "merge_group", "workflow_dispatch"])("never reuses on %s", async eventName => {
    const f = fixture(); f.input.eventName = eventName;
    expect(await completedMergeGroup(f.input)).toBe(false); expect(f.calls).toEqual([]);
  });
  it.each([
    (f: Fixture) => { f.input.checkout = "b".repeat(40); },
    (f: Fixture) => { f.input.sha = "main"; },
    (f: Fixture) => { f.input.ref = "refs/heads/other"; },
    (f: Fixture) => { f.input.event.after = "b".repeat(40); },
    (f: Fixture) => { f.input.event.ref = "refs/heads/other"; },
    (f: Fixture) => { f.input.event.repository.private = true; },
    (f: Fixture) => { f.input.event.repository.id++; },
    (f: Fixture) => { f.input.token = ""; },
  ])("runs normally without trusted main-push identity %#", async mutate => {
    const f = fixture(); mutate(f); expect(await completedMergeGroup(f.input)).toBe(false); expect(f.calls).toEqual([]);
  });
  it.each([
    (f: Fixture) => { f.listing.total_count++; },
    (f: Fixture) => { f.listing.workflow_runs = []; f.listing.total_count = 0; },
    (f: Fixture) => { f.listing.workflow_runs.push(structuredClone(f.run)); f.listing.total_count++; },
    (f: Fixture) => { f.run.head_sha = "b".repeat(40); },
    (f: Fixture) => { f.run.event = "pull_request"; },
    (f: Fixture) => { f.run.path = ".github/workflows/other.yml"; },
    (f: Fixture) => { f.run.head_repository = { ...f.run.repository, id: 1 }; },
    (f: Fixture) => { f.run.head_branch = "main"; },
    (f: Fixture) => { f.run.workflow_id++; },
    (f: Fixture) => { f.run.run_attempt++; },
    (f: Fixture) => { f.run.conclusion = "failure"; },
    (f: Fixture) => { f.run.status = "in_progress"; },
    (f: Fixture) => { f.result.total_count++; },
    (f: Fixture) => { f.jobs.pop(); f.result.total_count--; },
    (f: Fixture) => { f.jobs[0]!.conclusion = "skipped"; },
    (f: Fixture) => { f.jobs[0]!.head_sha = "b".repeat(40); },
    (f: Fixture) => { f.jobs[0]!.status = "in_progress"; },
    (f: Fixture) => { f.jobs.push({ ...f.jobs[0]!, id: 20 }); f.result.total_count++; },
  ])("falls back on missing or contradictory execution evidence %#", async mutate => {
    const f = fixture(); mutate(f); expect(await completedMergeGroup(f.input)).toBe(false);
  });
  it("does not use an older successful run when the latest one failed", async () => {
    const f = fixture(); f.listing.workflow_runs.push({ ...f.run, id: 101, conclusion: "failure" }); f.listing.total_count++;
    expect(await completedMergeGroup(f.input)).toBe(false);
  });
  it.each(["rerun", "new-run", "late-rerun"])("refuses %s that supersedes evidence during collection", async movement => {
    const f = fixture();
    const transport = f.input.fetcher;
    let listings = 0;
    f.input.fetcher = async (url, options) => {
      const response = await transport(url, options);
      if (url.includes("/runs?")) listings++;
      if (movement === "late-rerun" ? listings === 2 : url.includes("/jobs?")) {
        if (movement === "new-run") {
          f.listing.workflow_runs.push({ ...f.run, id: 101, conclusion: "failure" }); f.listing.total_count++;
        } else {
          f.run.run_attempt = 3; f.run.status = "queued"; f.run.conclusion = "";
          if (movement !== "late-rerun") Object.assign(f.listing.workflow_runs[0]!, f.run);
        }
      }
      return response;
    };
    expect(await completedMergeGroup(f.input)).toBe(false);
  });
  it.each([new Response("unavailable", { status: 503 }), new Response("{malformed"), new Error("network unavailable")])(
    "falls back when GitHub evidence is unavailable %#", async response => {
      const f = fixture();
      f.input.fetcher = async () => { if (response instanceof Error) throw response; return response; };
      expect(await completedMergeGroup(f.input)).toBe(false);
    },
  );
});
