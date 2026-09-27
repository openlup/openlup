import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { observeHostedCandidate, publishHostedAdmission, routeAdmissionEvent } from "./agent-review-hosted.mjs";
import { REQUIRED_CHECKS } from "./agent-review-gate.mjs";

// Fixture API observations and in-memory keys establish no live GitHub authority.
const key = generateKeyPairSync("ed25519");
const repository = "openlup/openlup";
const root = `/repos/${repository}`;
const now = 1_800_000_000_000;
interface WorkflowRun {
  id: number; event: string; head_sha: string; head_repository: { id: number }; head_branch: string;
  workflow_id: number; path: string; repository: { id: number }; run_attempt: number;
  check_suite_id: number; status: string; conclusion: string | null;
}
interface RunPage { total_count: number; workflow_runs: WorkflowRun[] }
interface Job { id: number; name: string; head_sha: string; status: string; conclusion: string | null; check_run_url: string }
interface JobsPage { total_count: number; jobs: Job[] }
interface CheckRun { id: number; name: string; head_sha: string; app: { id: number }; check_suite: { id: number }; status: string; conclusion: string | null }
interface GitCommit { sha: string; tree: { sha: string }; parents: { sha: string }[] }
interface MainRef { ref: string; object: { type: string; sha: string } }
function fixture() {
  const approved = { publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), version: 1, stage: "local", repository,
    base: "1".repeat(40), head: "2".repeat(40), tree: "3".repeat(40), authorityDigest: "4".repeat(64), policyDigest: "5".repeat(64),
    requestId: "request-1", risk: "behavior", requiredRoles: ["correctness", "security"], authorRunId: "author-run", now, maxValidityMs: 60_000 };
  const workflowPath = ".github/workflows/published-tree-ci.yml";
  const workflowBytes = Buffer.from("name: approved workflow\n");
  const policy = { repositoryId: 11, workflowId: 22, workflowPath, workflowSha256: createHash("sha256").update(workflowBytes).digest("hex"), mechanicalAppId: 15368, publisherAppId: 777 };
  const integration = "6".repeat(40);
  const paths = {
    main: `${root}/git/ref/heads/main`, pr: `${root}/pulls/7`, head: `${root}/git/commits/${approved.head}`,
    integration: `${root}/git/commits/${integration}`, workflow: `${root}/actions/workflows/22`,
    content: `${root}/contents/${workflowPath}?ref=${approved.head}`,
    runs: `${root}/actions/workflows/22/runs?event=pull_request&head_sha=${approved.head}&per_page=100&page=1`,
    run: `${root}/actions/runs/44`, jobs: `${root}/actions/runs/44/attempts/2/jobs?per_page=100&page=1`,
  };
  const run: WorkflowRun = { id: 44, event: "pull_request", head_sha: approved.head, head_repository: { id: 11 }, head_branch: "task", workflow_id: 22,
    path: workflowPath, repository: { id: 11 }, run_attempt: 2, check_suite_id: 55, status: "completed", conclusion: "success" };
  const data: Record<string, unknown> = {
    [root]: { id: 11, full_name: repository, default_branch: "main", private: false },
    [paths.main]: { ref: "refs/heads/main", object: { type: "commit", sha: approved.base } },
    [paths.pr]: { number: 7, state: "open", draft: false, merged: false, base: { repo: { id: 11 }, ref: "main", sha: approved.base },
      head: { sha: approved.head, repo: { id: 11 }, ref: "task" }, mergeable: true, merge_commit_sha: integration },
    [paths.head]: { sha: approved.head, tree: { sha: approved.tree } },
    [`${root}/compare/${approved.base}...${approved.head}`]: { status: "ahead", merge_base_commit: { sha: approved.base }, ahead_by: 1, behind_by: 0 },
    [paths.integration]: { sha: integration, tree: { sha: approved.tree }, parents: [{ sha: approved.base }, { sha: approved.head }] },
    [paths.workflow]: { id: 22, path: workflowPath, state: "active" },
    [paths.content]: { type: "file", path: workflowPath, encoding: "base64", size: workflowBytes.length, content: workflowBytes.toString("base64"), sha: createHash("sha1").update(`blob ${workflowBytes.length}\0`).update(workflowBytes).digest("hex") },
    [paths.runs]: { total_count: 1, workflow_runs: [run] }, [paths.run]: run,
    [paths.jobs]: { total_count: 6, jobs: REQUIRED_CHECKS.map((name: string, i: number) => ({ id: 100 + i, name, head_sha: approved.head, status: "completed", conclusion: "success", check_run_url: `https://api.github.com${root}/check-runs/${200 + i}` })) },
    "/app": { id: 777 },
  };
  REQUIRED_CHECKS.forEach((name: string, i: number) => { data[`${root}/check-runs/${200 + i}`] = { id: 200 + i, name, head_sha: approved.head, app: { id: 15368 }, check_suite: { id: 55 }, status: "completed", conclusion: "success" }; });
  let aggregate: Record<string, unknown> | null = null;
  const api = {
    get: vi.fn(async (path: string) => { if (path === `${root}/check-runs/900`) return structuredClone(aggregate); if (!(path in data)) throw new Error(`Unexpected fixture path ${path}`); return structuredClone(data[path]); }),
    post: vi.fn(async (_path: string, body: Record<string, unknown>) => { aggregate = { ...body, id: 900, app: { id: 777 } }; return structuredClone(aggregate); }),
    patch: vi.fn(async (_path: string, body: Record<string, unknown>) => { aggregate = { ...aggregate, ...body }; return structuredClone(aggregate); }),
  };
  const payload = { version: 1, stage: "local", repository, base: approved.base, head: approved.head, tree: approved.tree,
    authorityDigest: approved.authorityDigest, policyDigest: approved.policyDigest, requestId: approved.requestId, risk: approved.risk,
    issuedAt: now - 1000, expiresAt: now + 30_000, unresolvedMaterialFindings: 0, checks: [],
    reviewers: ["correctness", "security"].map((role, i) => ({ id: `reviewer-${i}`, runId: `execution-${i}`, role, cold: true, complete: true, verdict: "pass", simplicityChecked: true })) };
  const envelope = () => { const bytes = Buffer.from(JSON.stringify(payload)); return { payload: bytes.toString("base64"), signature: sign(null, bytes, key.privateKey).toString("base64") }; };
  const input = () => ({ api, repository, prNumber: 7, approved, policy, envelope: envelope(), now: () => now });
  const response = <T,>(path: string) => data[path] as T;
  return { api, data, paths, approved, policy, payload, input, response };
}

describe("authenticated current hosted observations", () => {
  it("observes all six successful jobs from the latest attempt with their real identities", async () => {
    const f = fixture(); const observed = await observeHostedCandidate(f.input());
    expect(observed.checks).toHaveLength(6); expect(observed.provenance.every((entry: { attempt: number }) => entry.attempt === 2)).toBe(true);
    expect(f.api.get).toHaveBeenCalledWith(f.paths.jobs);
    expect(observed.candidate.integration).toBe("6".repeat(40));
    expect(f.api.post).not.toHaveBeenCalled();
  });
  it.each(["skipped", "cancelled", "neutral", "failure", null])("refuses actual observed job conclusion %s", async conclusion => {
    const f = fixture(); f.response<JobsPage>(f.paths.jobs).jobs[0].conclusion = conclusion;
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it.each(["app", "head", "suite", "name", "status", "conclusion"])("refuses wrong check %s", async field => {
    const f = fixture(); const check = f.response<CheckRun>(`${root}/check-runs/200`);
    if (field === "app") check.app.id = 999;
    if (field === "head") check.head_sha = "9".repeat(40);
    if (field === "suite") check.check_suite.id = 999;
    if (field === "name") check.name = "forged";
    if (field === "status") check.status = "queued";
    if (field === "conclusion") check.conclusion = "skipped";
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it.each(["workflow", "workflow bytes", "base", "head tree", "integration tree", "integration parents", "draft"])("refuses %s drift", async field => {
    const f = fixture();
    if (field === "workflow") f.response<WorkflowRun>(f.paths.run).workflow_id = 999;
    if (field === "workflow bytes") f.policy.workflowSha256 = "9".repeat(64);
    if (field === "base") f.response<MainRef>(f.paths.main).object.sha = "9".repeat(40);
    if (field === "head tree") f.response<GitCommit>(f.paths.head).tree.sha = "9".repeat(40);
    if (field === "integration tree") f.response<GitCommit>(f.paths.integration).tree.sha = "9".repeat(40);
    if (field === "integration parents") f.response<GitCommit>(f.paths.integration).parents.reverse();
    if (field === "draft") f.response<{ draft: boolean }>(f.paths.pr).draft = true;
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it("does not fall back to older green runs when the latest run failed", async () => {
    const f = fixture(); const old = structuredClone(f.response<WorkflowRun>(f.paths.run)); old.id = 43;
    f.response<RunPage>(f.paths.runs).workflow_runs.push(old); f.response<RunPage>(f.paths.runs).total_count = 2;
    f.response<WorkflowRun>(f.paths.run).conclusion = "failure";
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it("refuses pagination that silently omits a run", async () => {
    const f = fixture(); f.response<RunPage>(f.paths.runs).total_count = 2;
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it("follows workflow pagination before selecting the latest matching run", async () => {
    const f = fixture();
    f.data[f.paths.runs] = { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1000, event: "push", head_sha: f.approved.head })) };
    f.data[f.paths.runs.replace("&page=1", "&page=2")] = { total_count: 101, workflow_runs: [f.data[f.paths.run]] };
    const observed = await observeHostedCandidate(f.input()); expect(observed.checks).toHaveLength(6);
    expect(f.api.get).toHaveBeenCalledWith(f.paths.runs.replace("&page=1", "&page=2"));
  });
  it("refuses attempt movement during observation", async () => {
    const f = fixture(); const get = f.api.get.getMockImplementation()!; let reads = 0;
    f.api.get.mockImplementation(async path => { const value = await get(path) as WorkflowRun; if (path === f.paths.run && ++reads === 2) value.run_attempt = 3; return value; });
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it("refuses a newly created workflow run during observation", async () => {
    const f = fixture(); const get = f.api.get.getMockImplementation()!; let reads = 0;
    f.api.get.mockImplementation(async path => {
      const value = await get(path) as RunPage;
      if (path === f.paths.runs && ++reads === 2) { value.workflow_runs.push({ ...value.workflow_runs[0], id: 45 }); value.total_count = 2; }
      return value;
    });
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it.each(["attempt", "in_progress", "queued"])("refuses a rerun visible only in the final listing (%s)", async state => {
    const f = fixture(); const get = f.api.get.getMockImplementation()!; let reads = 0;
    f.api.get.mockImplementation(async path => {
      const value = await get(path) as RunPage;
      if (path === f.paths.runs && ++reads === 2) {
        value.workflow_runs[0].run_attempt = 3;
        if (state !== "attempt") { value.workflow_runs[0].status = state; value.workflow_runs[0].conclusion = null; }
      }
      // The detail endpoint remains the old green attempt throughout.
      return value;
    });
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
  it.each(["queued", "failure"])("refuses a newer attempt visible only in the initial listing (%s)", async state => {
    const f = fixture(); const get = f.api.get.getMockImplementation()!; let reads = 0;
    f.api.get.mockImplementation(async path => {
      const value = await get(path) as RunPage;
      if (path === f.paths.runs && ++reads === 1) {
        value.workflow_runs[0].run_attempt = 3;
        value.workflow_runs[0].status = state === "failure" ? "completed" : "queued";
        value.workflow_runs[0].conclusion = state === "failure" ? "failure" : null;
      }
      // Detail and final listing remain stale successful attempt two.
      return value;
    });
    await expect(observeHostedCandidate(f.input())).rejects.toThrow();
  });
});

describe("protected aggregate requires authentic local review", () => {
  it("publishes success only after authentic review and fresh hosted observations", async () => {
    const f = fixture(); const observed = await publishHostedAdmission(f.input());
    expect(observed.aggregateId).toBe(900); expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.api.patch.mock.calls[0][1].conclusion).toBe("success");
  });
  it.each(["stage", "authority", "request", "policy", "head", "expired", "signature"])("refuses local receipt %s without publishing success", async field => {
    const f = fixture();
    if (field === "stage") f.payload.stage = "hosted";
    if (field === "authority") f.payload.authorityDigest = "9".repeat(64);
    if (field === "request") f.payload.requestId = "another-request";
    if (field === "policy") f.payload.policyDigest = "9".repeat(64);
    if (field === "head") f.payload.head = "9".repeat(40);
    if (field === "expired") f.payload.expiresAt = now - 1;
    const input = f.input(); if (field === "signature") input.envelope.signature = Buffer.alloc(64).toString("base64");
    await expect(publishHostedAdmission(input)).rejects.toThrow();
    expect(f.api.patch.mock.calls.every(call => call[1].conclusion !== "success")).toBe(true);
  });
  it("refuses an authenticated App with the wrong source", async () => {
    const f = fixture(); f.response<{ id: number }>("/app").id = 15368;
    await expect(publishHostedAdmission(f.input())).rejects.toThrow(); expect(f.api.post).not.toHaveBeenCalled();
  });
  it("refuses admission when local hook evidence is absent", async () => {
    const f = fixture(); await expect(publishHostedAdmission({ ...f.input(), envelope: undefined })).rejects.toThrow();
    expect(f.api.patch.mock.calls.every(call => call[1].conclusion === "failure")).toBe(true);
  });
  it("refuses a forged same-name aggregate check source", async () => {
    const f = fixture(); const get = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => { const value = await get(path) as CheckRun; if (path === `${root}/check-runs/900`) value.app.id = 15368; return value; });
    await expect(publishHostedAdmission(f.input())).rejects.toThrow();
    expect(f.api.patch.mock.calls.every(call => call[1].conclusion !== "success")).toBe(true);
  });
  it("refuses a review that expires during hosted observation", async () => {
    const f = fixture(); let clock = now;
    const get = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => {
      const value = await get(path);
      if (path === `${root}/check-runs/205`) clock = f.payload.expiresAt + 1;
      return value;
    });
    await expect(publishHostedAdmission({ ...f.input(), now: () => clock })).rejects.toThrow();
    expect(f.api.patch.mock.calls.every(call => call[1].conclusion !== "success")).toBe(true);
  });
  it("refuses a persisted numeric clock that cannot advance at final verification", async () => {
    const f = fixture();
    await expect(publishHostedAdmission({ ...f.input(), now })).rejects.toThrow();
    expect(f.api.patch.mock.calls.every(call => call[1].conclusion !== "success")).toBe(true);
  });
});

describe("event routing does not omit invalidation events", () => {
  it.each(["opened", "synchronize", "converted_to_draft", "closed"])("routes PR %s for reevaluation", action => {
    expect(routeAdmissionEvent("pull_request", { action, number: 7, repository: { full_name: repository }, pull_request: { number: 7 } })).toEqual({ kind: "candidate", repository, prNumber: 7 });
  });
  it("routes main movement for candidate invalidation", () => {
    expect(routeAdmissionEvent("push", { ref: "refs/heads/main", repository: { full_name: repository } })).toEqual({ kind: "base", repository });
  });
  it("ignores unrelated events", () => { expect(routeAdmissionEvent("issues", {})).toBeNull(); });
});
