import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.js";
import {
  QUALIFIED_ACQUISITION_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_BASELINE_FILE, QUALIFIED_RUNTIME_FILE,
} from "./platform-migration-manifest.js";
import {
  assertCoLocatedForwardApproval, assertForwardApproval, assertReviewedPlatformForward,
  readReviewedForwardRegistry, REVIEWED_FORWARD_PATH, sqlSha256, type ReviewedForwardRegistry,
} from "./reviewed-platform-forward.js";

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
  return { root, put, commit, base, approved };
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
