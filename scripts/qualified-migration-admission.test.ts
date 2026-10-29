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
  ADMIN_ACQUISITION_FILE, ADMIN_ACTOR_FILE, ADMIN_BASELINE_FILE, ADMIN_IMPORT_FILE, ADMIN_RUNTIME_FILE,
  REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_IMPORT_FILE, REVISED_ADMIN_RUNTIME_FILE,
  QUALIFIED_ACQUISITION_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_BASELINE_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, QUALIFIED_OWNER_PATH_FILE,
} from "./platform-migration-manifest.js";
import {
  assertCoLocatedForwardApproval, assertForwardApproval, assertQualifiedOwnerPathForward, assertReviewedPlatformForward,
  readReviewedForwardRegistry, REVIEWED_FORWARD_PATH, sqlSha256, sqlStatements, type ReviewedForwardRegistry,
} from "./reviewed-platform-forward.js";

// Observe both trusted entry points without replacing their actual Git/SQL checks.
vi.mock("./reviewed-platform-forward.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reviewed-platform-forward.js")>();
  return { ...actual, assertCoLocatedForwardApproval: vi.fn(actual.assertCoLocatedForwardApproval) };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const paths = [QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE,
  QUALIFIED_OWNER_PATH_FILE, ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE,
  REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_RUNTIME_FILE, REVISED_ADMIN_IMPORT_FILE];
const signatures = [
  "acquisition_private.keyed_digest(text,jsonb)",
  "acquisition_private.case_projection(uuid)",
  "acquisition_private.refuse_append_only_mutation()",
  "public.acquisition_case_submit_v1(text,text,text,text,boolean,text,text,text,text,text,text,text,text,timestamptz)",
  "public.acquisition_case_operator_list_v1(uuid,timestamptz,uuid,integer)",
  "public.acquisition_case_transition_v1(uuid,text,bigint,text,text,text,timestamptz)",
  "public.acquisition_case_active_count_v1()",
  "public.customer_subject_capture_lifecycle()",
  "public.subscription_delivery_alignment_guard_cycle_insert()",
];
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
  const approved = { ...registry, qualifiedInstallations: paths.map((path, index) => index === 6
    ? { path, sha256: sqlSha256(bodies[index]!), functions: signatures.map(signature => ({ signature, beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64) })) }
    : { path, sha256: sqlSha256(bodies[index]!) }) };
  return { root, put, commit, git, base, approved };
}

it("reads only the fixed ordered qualified identities with exact digest fields", () => {
  const f = fixture();
  for (const length of [4, 5, 6, 7, 12, 16]) expect(() => readReviewedForwardRegistry(Buffer.from(encode({ ...f.approved, qualifiedInstallations: f.approved.qualifiedInstallations.slice(0, length) })))).not.toThrow();
  for (const length of [8, 9, 10, 11, 13, 14, 15]) expect(() => readReviewedForwardRegistry(Buffer.from(encode({ ...f.approved, qualifiedInstallations: f.approved.qualifiedInstallations.slice(0, length) })))).toThrow(/qualified installation approval/);
  for (const change of [
    (value: typeof f.approved) => { value.qualifiedInstallations[0]!.path = "db/platform/migrations/q2_arbitrary.sql"; },
    (value: typeof f.approved) => { value.qualifiedInstallations[0]!.sha256 = "invalid"; },
    (value: typeof f.approved) => { value.qualifiedInstallations.reverse(); },
    (value: typeof f.approved) => { value.qualifiedInstallations[5]!.path = "db/platform/migrations/q2_20261028100000_other_runtime.sql"; },
    (value: typeof f.approved) => { value.qualifiedInstallations[6]!.path = "db/platform/migrations/qa_00000000000001_wrong_baseline.sql"; },
    (value: typeof f.approved) => { value.qualifiedInstallations.splice(6, 1); },
    (value: typeof f.approved) => { [value.qualifiedInstallations[6], value.qualifiedInstallations[7]] = [value.qualifiedInstallations[7]!, value.qualifiedInstallations[6]!]; },
    (value: typeof f.approved) => { value.qualifiedInstallations.push({ path: "db/platform/migrations/q2_20261028100001_extra.sql", sha256: "a".repeat(64) }); },
  ]) {
    const changed = structuredClone(f.approved);
    change(changed);
    expect(() => readReviewedForwardRegistry(Buffer.from(encode(changed)))).toThrow(/qualified installation approval/);
  }
});

it("pins the appended owner definitions to the issued preimages and exact path-only replacement", () => {
  const sources = [QUALIFIED_ACQUISITION_FILE, QUALIFIED_IMPORT_FILE].map(path => readFileSync(path));
  const prior = sources.flatMap(source => sqlStatements(source.toString("utf8")));
  const statements = signatures.map(signature => {
    const name = signature.slice(0, signature.indexOf("("));
    const statement = prior.find(value => value.startsWith(`CREATE FUNCTION ${name}(`) || value.startsWith(`CREATE OR REPLACE FUNCTION ${name}(`));
    if (!statement) throw new Error(`missing issued source for ${name}`);
    return statement;
  });
  const after = statements.map(statement => statement.replace(/^CREATE FUNCTION /u, "CREATE OR REPLACE FUNCTION ")
    .replace(/SET search_path = pg_catalog(\s+AS\b)/u, "SET search_path = pg_catalog, pg_temp$1"));
  const bytes = Buffer.from(`${after.join("\n\n")}\n`);
  const binding = { path: QUALIFIED_OWNER_PATH_FILE, sha256: sqlSha256(bytes), functions: signatures.map((signature, index) => ({
    signature, beforeSha256: sqlSha256(statements[index]!), afterSha256: sqlSha256(after[index]!),
  })) };
  const f = fixture();
  const approved = { ...f.approved, qualifiedInstallations: [...f.approved.qualifiedInstallations.slice(0, 6), binding, ...f.approved.qualifiedInstallations.slice(7)] };
  expect(() => readReviewedForwardRegistry(Buffer.from(encode(approved)))).not.toThrow();
  expect(() => assertQualifiedOwnerPathForward(binding, bytes, sources)).not.toThrow();
  const registry = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH));
  expect(registry.qualifiedInstallations).toHaveLength(12);
  expect(registry.qualifiedInstallations![6]).toEqual(binding);
  const reviewedBytes = readFileSync(`scripts/fixtures/reviewed-m14-qualified/${QUALIFIED_OWNER_PATH_FILE}`);
  expect(reviewedBytes).toEqual(bytes);
  expect(() => assertQualifiedOwnerPathForward(registry.qualifiedInstallations![6] as typeof binding, reviewedBytes, sources)).not.toThrow();
  const wrongBody = Buffer.from(bytes.toString("utf8").replace("RAISE EXCEPTION 'acquisition_append_only'", "RAISE EXCEPTION 'changed'"));
  expect(() => assertQualifiedOwnerPathForward({ ...binding, sha256: sqlSha256(wrongBody) }, wrongBody, sources)).toThrow("function identity or preimage drifted");
  const wrongAttribute = Buffer.from(bytes.toString("utf8").replace("SECURITY DEFINER", "SECURITY INVOKER"));
  expect(wrongAttribute.equals(bytes)).toBe(false);
  const alteredAttributeBinding = structuredClone(binding);
  alteredAttributeBinding.sha256 = sqlSha256(wrongAttribute);
  sqlStatements(wrongAttribute.toString("utf8")).forEach((statement, index) => {
    alteredAttributeBinding.functions[index]!.afterSha256 = sqlSha256(statement);
  });
  expect(() => assertQualifiedOwnerPathForward(alteredAttributeBinding, wrongAttribute, sources)).toThrow("changes more than the pinned name-resolution attribute");
  const extra = Buffer.from(`${bytes}SELECT 1;\n`);
  expect(() => assertQualifiedOwnerPathForward({ ...binding, sha256: sqlSha256(extra) }, extra, sources)).toThrow("missing or extra definition");
  for (const forbidden of [
    "GRANT EXECUTE ON FUNCTION public.acquisition_case_active_count_v1() TO PUBLIC;",
    "ALTER FUNCTION public.acquisition_case_active_count_v1() OWNER TO public;",
  ]) {
    const changed = Buffer.from(`${bytes}\n${forbidden}\n`);
    expect(() => assertQualifiedOwnerPathForward({ ...binding, sha256: sqlSha256(changed) }, changed, sources)).toThrow("missing or extra definition");
  }
  const wrongPreimage = structuredClone(binding);
  wrongPreimage.functions[0]!.beforeSha256 = "a".repeat(64);
  expect(() => assertQualifiedOwnerPathForward(wrongPreimage, bytes, sources)).toThrow("preimage drifted");
  const reordered = { ...approved, qualifiedInstallations: [...approved.qualifiedInstallations].reverse() };
  expect(() => readReviewedForwardRegistry(Buffer.from(encode(reordered)))).toThrow("qualified installation approval");
});

it("preserves the issued qualified identities and pins all five restricted replacements", () => {
  const registry = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH));
  const issued = registry.qualifiedInstallations!;
  expect(issued).toHaveLength(12);
  expect(issued.map(({ path }) => path)).toEqual(paths.slice(0, issued.length));
  for (const entry of registry.qualifiedInstallations!) {
    const bytes = readFileSync(`scripts/fixtures/reviewed-m14-qualified/${entry.path}`);
    expect(sqlSha256(bytes), entry.path).toBe(entry.sha256);
  }
  // The issued completion identity stays pinned across the new approval.
  const completion = readFileSync(`scripts/fixtures/reviewed-m14-qualified/${QUALIFIED_RUNTIME_COMPLETION_FILE}`);
  expect(sqlSha256(completion)).toBe("ec05d0e86a570724fad21916a6fd06976a5e32ae0d0323b1ff902f69c2ae189e");
  const restrictedHashes = [
    "a19f78b5e948f96d5bdca6cc14159230cf5197c5ff7fe94f7fc10f26e585a710",
    "afbba5c95206a579325239a315772095ba47e608b21c8b26d5bbac16a2e0aaa9",
    "db8e461b3559d0c0c0f7789b61e1f853d327110b9ff0b305e412054454bb6b87",
    "7083a206e7cedfbb87d009d35234360975d9247b80ccd99a6478d89a12e95cb7",
    "09be0b6f7caedf8a16d1de574e74856d6eda26863f759af184ee4ba2d63e6cae",
  ];
  for (const [index, path] of paths.slice(7, 12).entries()) {
    const approved = issued[index + 7]!;
    expect(approved.sha256).toBe(restrictedHashes[index]);
    expect(sqlSha256(readFileSync(`scripts/fixtures/reviewed-m14-qualified/${path}`))).toBe(restrictedHashes[index]);
  }
});

it("keeps the four revised restricted fixtures inert, exact, and separate from issued approvals", () => {
  const issued = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH)).qualifiedInstallations!;
  expect(issued).toHaveLength(12);
  const revised = [REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_RUNTIME_FILE, REVISED_ADMIN_IMPORT_FILE];
  const prior = [ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE];
  const hashes = [
    "3290eaabbc0c7ec946c837d42023e2534abfea71ad09369ac4ee06ed1c18503e",
    "e7ea29581b2c960c217b6a13d7474f13c7ea98a735339a264607ceecc0d351f2",
    "04bb75899f7850f997c79474194d63bd22dfdd20ce8ab88c0aaff6409712a56b",
    "05e664066073b8f053c729feaaf45984c328431a2f3baa0caadea3234c1a22b9",
  ];
  for (const [index, path] of revised.entries()) {
    const bytes = readFileSync(`scripts/fixtures/reviewed-m14-qualified/${path}`, "utf8");
    const old = readFileSync(`scripts/fixtures/reviewed-m14-qualified/${prior[index]}`, "utf8");
    expect(sqlSha256(bytes)).toBe(hashes[index]);
    expect(bytes).toBe(old.replaceAll("<> CASE WHEN v_mode = 'installer-managed' THEN 1 ELSE 2 END",
      "<> (CASE WHEN v_mode = 'installer-managed' THEN 1 ELSE 2 END)")
      .replaceAll(" + CASE WHEN v_runtime_group THEN 1 ELSE 0 END", " + (CASE WHEN v_runtime_group THEN 1 ELSE 0 END)")
      .replaceAll(" + CASE WHEN v_group = 'platform_acquisition_owner' THEN 1 ELSE 0 END",
        " + (CASE WHEN v_group = 'platform_acquisition_owner' THEN 1 ELSE 0 END)"));
  }
});

it("admits only an atomic four-identity append after the twelve issued rows", () => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode({ ...f.approved, qualifiedInstallations: f.approved.qualifiedInstallations.slice(0, 12) }));
  const issued = f.commit("twelve issued qualified approvals");
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const appended = f.commit("four revised identities approved separately");
  expect(() => assertCoLocatedForwardApproval(f.root, issued, appended)).not.toThrow();
  const repinned = structuredClone(f.approved);
  repinned.qualifiedInstallations[8]!.sha256 = "a".repeat(64);
  f.put(REVIEWED_FORWARD_PATH, encode(repinned));
  const invalid = f.commit("attempt prior identity change");
  expect(() => assertCoLocatedForwardApproval(f.root, appended, invalid)).toThrow("issued qualified installation approvals are immutable");

  const colocated = fixture();
  colocated.put(REVIEWED_FORWARD_PATH, encode({ ...colocated.approved, qualifiedInstallations: colocated.approved.qualifiedInstallations.slice(0, 12) }));
  const prior = colocated.commit("twelve issued approvals");
  colocated.put(REVIEWED_FORWARD_PATH, encode(colocated.approved));
  colocated.put(REVISED_ADMIN_ACTOR_FILE, bodies[12]!);
  const same = colocated.commit("attempt pin and SQL together");
  expect(() => assertCoLocatedForwardApproval(colocated.root, prior, same)).toThrow("separate exact approval");
});

it("keeps every restricted owner body aligned with the issued name-resolution forward", () => {
  const restricted = [ADMIN_ACQUISITION_FILE, ADMIN_IMPORT_FILE].flatMap(path =>
    sqlStatements(readFileSync(`scripts/fixtures/reviewed-m14-qualified/${path}`, "utf8")));
  const definitions = restricted.filter(statement => /^CREATE (?:OR REPLACE )?FUNCTION /u.test(statement));
  expect(definitions).toHaveLength(11);
  const hardened = sqlStatements(readFileSync(QUALIFIED_OWNER_PATH_FILE, "utf8"));
  expect(hardened).toHaveLength(9);
  for (const forward of hardened) {
    const name = /^CREATE OR REPLACE FUNCTION ([\w.]+)\(/u.exec(forward)?.[1];
    expect(name).toBeDefined();
    const source = definitions.find(statement => statement.startsWith(`CREATE FUNCTION ${name}(`)
      || statement.startsWith(`CREATE OR REPLACE FUNCTION ${name}(`));
    expect(source?.replace(/^CREATE FUNCTION /u, "CREATE OR REPLACE FUNCTION ")).toBe(forward);
  }
  const importDefinitions = definitions.filter(statement => /^CREATE FUNCTION public\.(?:client_import_retained_row|subscription_cycle_import_retained_row)\(/u.test(statement));
  expect(importDefinitions).toHaveLength(2);
  for (const statement of importDefinitions) {
    expect(statement).toContain("SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp");
    expect(statement).not.toMatch(/\b(?:INSERT INTO|FROM) (?!public\.)[a-z_][a-z_0-9]*/u);
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
  ["pull_request", false, QUALIFIED_BASELINE_FILE], ["pull_request", true, QUALIFIED_BASELINE_FILE],
  ["merge_group", false, QUALIFIED_BASELINE_FILE], ["merge_group", true, QUALIFIED_BASELINE_FILE],
  ["pull_request", false, QUALIFIED_RUNTIME_COMPLETION_FILE], ["pull_request", true, QUALIFIED_RUNTIME_COMPLETION_FILE],
  ["merge_group", false, QUALIFIED_RUNTIME_COMPLETION_FILE], ["merge_group", true, QUALIFIED_RUNTIME_COMPLETION_FILE],
  ["pull_request", false, ADMIN_BASELINE_FILE], ["pull_request", true, ADMIN_BASELINE_FILE],
  ["merge_group", false, ADMIN_IMPORT_FILE], ["merge_group", true, ADMIN_IMPORT_FILE],
] as const)("trusted %s admission checks unchanged qualified pins with machinery change=%s for %s", async (eventName, changesMachinery, path) => {
  const f = fixture();
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const control = f.commit("approve exact qualified bytes before feature");
  f.put(path, bodies[paths.indexOf(path)]!);
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

it("requires prior exact approval for the sixth completion unit and refuses later repinning", () => {
  const f = fixture();
  const path = QUALIFIED_RUNTIME_COMPLETION_FILE, bytes = bodies[5]!;
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  f.put(path, bytes);
  const coLocated = f.commit("co-located completion pin and SQL");
  expect(() => assertCoLocatedForwardApproval(f.root, f.base, coLocated)).toThrow("separate exact approval");
  // Rebuild the same synthetic fixture with a genuinely separate approval commit.
  const separate = fixture();
  separate.put(REVIEWED_FORWARD_PATH, encode(separate.approved));
  const control = separate.commit("approve completion bytes first");
  separate.put(path, bytes);
  const feature = separate.commit("introduce exact approved completion");
  expect(() => assertAdmittedPlatformForward(separate.root, control, feature, path, bytes)).not.toThrow();
  expect(() => assertReviewedPlatformForward(separate.root, separate.base, feature, path, bytes, true)).not.toThrow();
  expect(() => assertReviewedPlatformForward(separate.root, control, feature, path, Buffer.concat([bytes, Buffer.from(" ")]))).toThrow("exact approved bytes");
  const repinned = structuredClone(separate.approved);
  repinned.qualifiedInstallations[5]!.sha256 = "a".repeat(64);
  separate.put(REVIEWED_FORWARD_PATH, encode(repinned));
  const later = separate.commit("attempt issued completion repin");
  expect(() => assertCoLocatedForwardApproval(separate.root, feature, later)).toThrow("issued qualified installation approvals are immutable");
});

it("does not let a later exact pin repair an unapproved SQL introduction", () => {
  const f = fixture();
  f.put(paths[0]!, bodies[0]!);
  f.commit("unapproved qualified introduction");
  f.put(REVIEWED_FORWARD_PATH, encode(f.approved));
  const later = f.commit("late attempted approval");
  expect(() => assertReviewedPlatformForward(f.root, f.base, later, paths[0]!, bodies[0]!, true)).toThrow("approved separately");
});

it("refuses control-only changes to issued pins, including unintroduced bytes", () => {
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
  const preparation = f.commit("attempt repin of still-unintroduced actor bytes");
  expect(() => assertCoLocatedForwardApproval(f.root, feature, preparation)).toThrow("issued qualified installation approvals are immutable");
  expect(() => assertCoLocatedForwardApproval(f.root, f.base, control)).not.toThrow();
});
