import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RECEIPT_MARKER } from "./agent-review-decide.mjs";
import { waitNativeAdmission } from "./agent-review-queue.mjs";
import { git as readGit } from "./agent-review-session.mjs";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.js";
import {
  QUALIFIED_ACQUISITION_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_BASELINE_FILE, QUALIFIED_RUNTIME_FILE,
} from "./platform-migration-manifest.js";
import {
  assertCoLocatedForwardApproval, assertForwardApproval, assertReviewedPlatformForward,
  readReviewedForwardRegistry, REVIEWED_FORWARD_PATH, sqlSha256, type ReviewedForwardRegistry,
} from "./reviewed-platform-forward.js";

// Observe both trusted entry points without replacing their actual Git/SQL checks.
vi.mock("./reviewed-platform-forward.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reviewed-platform-forward.js")>();
  return { ...actual, assertCoLocatedForwardApproval: vi.fn(actual.assertCoLocatedForwardApproval) };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const paths = [QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE];
const bodies = paths.map((_path, index) => Buffer.from(`CREATE TABLE public.qualified_fixture_${index}(id integer);\n`));
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qualified-admission-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path: string, value: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  git("config", "user.name", "Synthetic Contributor");
  git("config", "user.email", "synthetic@example.invalid");
  const registry = JSON.parse(readFileSync(REVIEWED_FORWARD_PATH, "utf8")) as ReviewedForwardRegistry;
  delete registry.qualifiedInstallations;
  put(REVIEWED_FORWARD_PATH, encode(registry));
  put("scripts/platform-migration-manifest.ts", "// existing control fixture\n");
  const base = commit("existing controls");
  const approved = { ...registry, qualifiedInstallations: paths.map((path, index) => ({ path, sha256: sqlSha256(bodies[index]!) })) };
  return { root, put, commit, git, base, approved };
}

it("reads only the fixed ordered qualified identities with exact digest fields", () => {
  const f = fixture();
  expect(() => readReviewedForwardRegistry(Buffer.from(encode(f.approved)))).not.toThrow();
  for (const change of [
    (value: typeof f.approved) => { value.qualifiedInstallations[0]!.path = "db/platform/migrations/q2_arbitrary.sql"; },
    (value: typeof f.approved) => { value.qualifiedInstallations[0]!.sha256 = "invalid"; },
    (value: typeof f.approved) => { value.qualifiedInstallations.reverse(); },
  ]) {
    const changed = structuredClone(f.approved);
    change(changed);
    expect(() => readReviewedForwardRegistry(Buffer.from(encode(changed)))).toThrow(/qualified installation approval/);
  }
});

it("accepts exact separately approved bytes at source and their unique release introduction", () => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const control = f.commit("approve exact qualified bytes");
  f.put(paths[0]!, bodies[0]!);
  const feature = f.commit("introduce approved qualified unit");
  expect(() => assertCoLocatedForwardApproval(f.root, control, feature)).not.toThrow();
  expect(() => assertAdmittedPlatformForward(f.root, control, feature, paths[0]!, bodies[0]!)).not.toThrow();
  expect(() => assertReviewedPlatformForward(f.root, f.base, feature, paths[0]!, bodies[0]!, true)).not.toThrow();
  expect(() => assertReviewedPlatformForward(f.root, control, feature, paths[0]!, Buffer.concat([bodies[0]!, Buffer.from(" ")]))).toThrow("exact approved bytes");
});

it("refuses same-candidate SQL and new pins even when the SQL is expand-only", () => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  f.put(paths[0]!, bodies[0]!);
  const feature = f.commit("unapproved co-located qualified bytes");
  expect(() => assertForwardApproval(f.root, f.base, feature)).toThrow("separate exact approval");
  expect(() => assertCoLocatedForwardApproval(f.root, f.base, feature)).toThrow("separate exact approval");
  expect(() => assertAdmittedPlatformForward(f.root, f.base, feature, paths[0]!, bodies[0]!)).toThrow(/separate exact approval|approved separately/);
});

it("refuses machinery changes alongside new qualified SQL with unchanged pins", () => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const control = f.commit("approve exact qualified bytes");
  f.put(paths[0]!, bodies[0]!);
  f.put("scripts/platform-migration-manifest.ts", "// changed machinery\n");
  const feature = f.commit("change machinery with qualified SQL");
  expect(() => assertCoLocatedForwardApproval(f.root, control, feature)).toThrow("machinery must be approved separately");
});

it.each([
  ["pull_request", false], ["pull_request", true],
  ["merge_group", false], ["merge_group", true],
] as const)("trusted %s admission checks unchanged qualified pins with machinery change=%s", async (eventName, changesMachinery) => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const control = f.commit("approve exact qualified bytes before feature");
  f.put(paths[0]!, bodies[0]!);
  if (changesMachinery) f.put("scripts/platform-migration-manifest.ts", "// changed machinery\n");
  const head = f.commit("introduce qualified SQL with unchanged prior pins");
  expect(f.git("diff", "--name-only", control, head)).not.toContain(REVIEWED_FORWARD_PATH);
  const tree = f.git("rev-parse", `${head}^{tree}`);
  const groupHead = f.git("commit-tree", tree, "-p", control, "-p", head, "-m", "synthetic merge group");
  // Synthetic API data tests the admission route; it is not task review evidence.
  const now = 1_000;
  const receipt = { pr: 12, base: control, head, tree, risk: "behavior", reviewers: ["synthetic-review-a", "synthetic-review-b"],
    verdict: "PASS", expires: now + 86_400_000, sessionDigest: "a".repeat(64) };
  const event = { number: 12, repository: { private: false }, pull_request: { head: { sha: head } }, action: "checks_requested",
    merge_group: { base_ref: "refs/heads/main", head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${groupHead}`, base_sha: control, head_sha: groupHead } };
  const api = { get: vi.fn(async (path: string) => {
    if (path.includes("/collaborators/")) return { permission: "write" };
    if (path.includes("/issues/")) return [{ id: 1, body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``, user: { login: "synthetic-supervisor", type: "User" } }];
    if (path.includes("/pulls/")) return { number: 12, state: "open", draft: false, merged: false, base: { ref: "main" }, head: { sha: head } };
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: control } };
    throw new Error(`unexpected synthetic API read: ${path}`);
  }) };
  const runGit = vi.fn(async (cwd: string, ...args: string[]) => {
    // All objects already exist in this owned fixture. Only network transport is omitted.
    if (args.includes("fetch")) return "";
    return readGit(cwd, ...args);
  });
  const guard = vi.mocked(assertCoLocatedForwardApproval);
  guard.mockClear();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const admission = waitNativeAdmission({ event, env: { GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName },
      api, cwd: f.root, runGit, now: () => now, sleep: async () => { throw new Error("unexpected admission poll"); } });
    if (changesMachinery) await expect(admission).rejects.toThrow("machinery must be approved separately");
    else await expect(admission).resolves.toEqual(receipt);
    expect(guard.mock.calls).toEqual([
      [f.root, control, head, control],
      ...(!changesMachinery && eventName === "merge_group" ? [[f.root, control, groupHead, control]] : []),
    ]);
  } finally { log.mockRestore(); }
});

it("does not let a later exact pin repair an unapproved SQL introduction", () => {
  const f = fixture();
  f.put(paths[0]!, bodies[0]!);
  f.commit("unapproved qualified introduction");
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const later = f.commit("late attempted approval");
  expect(() => assertReviewedPlatformForward(f.root, f.base, later, paths[0]!, bodies[0]!, true)).toThrow("approved separately");
});

it("refuses control-only changes to issued pins while allowing preparation for unintroduced bytes", () => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const control = f.commit("approve exact qualified bytes");
  f.put(paths[0]!, bodies[0]!);
  const feature = f.commit("introduce approved qualified unit");
  const repinned = structuredClone(f.approved);
  repinned.qualifiedInstallations[0]!.sha256 = "a".repeat(64);
  f.put(REVIEWED_FORWARD_PATH, encode(repinned));
  const later = f.commit("attempt control-only issued repin");
  expect(() => assertCoLocatedForwardApproval(f.root, feature, later)).toThrow("issued qualified installation approvals are immutable");
  const pending = structuredClone(f.approved);
  pending.qualifiedInstallations[1]!.sha256 = "b".repeat(64);
  f.put(REVIEWED_FORWARD_PATH, encode(pending));
  const preparation = f.commit("prepare still-unintroduced actor bytes");
  expect(() => assertCoLocatedForwardApproval(f.root, feature, preparation)).not.toThrow();
  expect(() => assertCoLocatedForwardApproval(f.root, f.base, control)).not.toThrow();
});
