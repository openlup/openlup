import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { env as processEnvironment } from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { dependencyRange, reviewDependencies } from "./public-ci-dependencies.mjs";

const base = "a".repeat(40), head = "b".repeat(40);
const input = { repository: "owner/repo", base, head, token: "synthetic-token" };
const advisory = { advisory_ghsa_id: "GHSA-aaaa-bbbb-cccc", severity: "high" };
const dependency = (extra: Record<string, unknown> = {}) => ({ change_type: "added", manifest: "package-lock.json", name: "fixture", version: "1.0.0", scope: "runtime", vulnerabilities: [], ...extra });
const page = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { headers });

describe("dependency admission", () => {
  it("binds PR, group and main-push comparisons to their event SHAs", () => {
    for (const [eventName, event] of [
      ["pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }],
      ["merge_group", { merge_group: { base_sha: base, head_sha: head } }],
      ["push", { before: base, after: head }],
    ] as const) expect(dependencyRange(eventName, event)).toEqual({ base, head });
    for (const [eventName, event] of [["unknown", {}], ["push", { before: "main", after: head }], ["push", { before: base, after: base }], ["push", { before: "0".repeat(40), after: head }]] as const) {
      expect(() => dependencyRange(eventName, event)).toThrow(/event's distinct full/u);
    }
  });

  it("permits an unchanged graph, removals and a safe lock update without auditing inherited findings", async () => {
    for (const changes of [[], [dependency()], [dependency({ change_type: "removed", vulnerabilities: [advisory] }), dependency({ version: "2.0.0" })]]) {
      await expect(reviewDependencies({ ...input, fetch: async () => page(changes) })).resolves.toContain(`${base}...${head}`);
    }
  });

  it("blocks newly selected vulnerable direct/transitive versions at every admitted severity and unknown scope", async () => {
    for (const scope of ["runtime", "unknown", undefined]) for (const severity of ["low", "moderate", "high", "critical"]) {
      await expect(reviewDependencies({ ...input, fetch: async () => page([dependency({ scope, vulnerabilities: [{ ...advisory, severity }] })]) })).rejects.toThrow(/new vulnerable production dependencies/u);
    }
    await expect(reviewDependencies({ ...input, fetch: async () => page([dependency({ scope: "development", vulnerabilities: [advisory] })]) })).resolves.toContain("passed");
    // Removing one finding cannot cancel a different newly added vulnerable dependency.
    await expect(reviewDependencies({ ...input, fetch: async () => page([
      dependency({ change_type: "removed", vulnerabilities: [advisory] }),
      dependency({ name: "different", vulnerabilities: [{ ...advisory, advisory_ghsa_id: "GHSA-dddd-eeee-ffff" }] }),
    ]) })).rejects.toThrow(/different@1.0.0 GHSA-dddd-eeee-ffff/u);
  });

  it("inspects later pages and refuses warning-only, malformed or unavailable data", async () => {
    const next = `https://api.github.com/repos/owner/repo/dependency-graph/compare/${base}...${head}?page=2`;
    let calls = 0;
    await expect(reviewDependencies({ ...input, fetch: async () => ++calls === 1 ? page([], { link: `<${next}>; rel="next"` }) : page([dependency({ vulnerabilities: [advisory] })]) })).rejects.toThrow(/new vulnerable/u);
    expect(calls).toBe(2);
    calls = 0;
    await expect(reviewDependencies({ ...input, fetch: async () => ++calls === 1 ? page([], { link: `<${next}>; rel="next"` }) : page([], { "x-github-dependency-graph-snapshot-warnings": "cGFydGlhbA==" }) })).rejects.toThrow(/incomplete snapshots/u);
    for (const response of [
      page({}), page([dependency({ vulnerabilities: undefined })]), page([dependency({ scope: "new-scope" })]),
      page([dependency({ vulnerabilities: [{}] })]), page([], { link: "malformed" }),
      new Response("registry down", { status: 503 }), new Response("not json"),
    ]) await expect(reviewDependencies({ ...input, fetch: async () => response })).rejects.toThrow();
  });

  it("never sends the token to a pagination redirect or accepts a pagination loop", async () => {
    for (const next of ["https://untrusted.invalid/collect", `https://api.github.com/repos/owner/repo/dependency-graph/compare/${base}...${head}?per_page=100`]) {
      let calls = 0;
      await expect(reviewDependencies({ ...input, fetch: async () => { calls++; return page([], { link: `<${next}>; rel="next"` }); } })).rejects.toThrow(/invalid pagination/u);
      expect(calls).toBe(1);
    }
  });

  it("executes the actual CLI failure path without a network request", () => {
    const directory = mkdtempSync(join(tmpdir(), "dependency-admission-"));
    try {
      const event = join(directory, "event.json"), stub = join(directory, "fetch.mjs");
      writeFileSync(event, JSON.stringify({ merge_group: { base_sha: base, head_sha: head } }));
      writeFileSync(stub, `globalThis.fetch = async () => Response.json(${JSON.stringify([dependency({ vulnerabilities: [advisory] })])});`);
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, resolve("scripts/public-ci-dependencies.mjs")], {
        encoding: "utf8", env: { ...processEnvironment, GITHUB_EVENT_NAME: "merge_group", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: input.repository, GH_TOKEN: input.token },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("GHSA-aaaa-bbbb-cccc");
      expect(result.stderr).not.toContain(input.token);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

it("keeps dependency admission inside install-proof before builds and preserves source/group/push execution", () => {
  const workflow = readFileSync(".github/workflows/published-tree-ci.yml", "utf8").split("\n  install-proof:\n")[1]!.split("\n  test-full-shard:\n")[0]!;
  expect(workflow.indexOf("run: node scripts/public-ci-dependencies.mjs")).toBeLessThan(workflow.indexOf("run: npm run build"));
  expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
  const step = workflow.split("      - name: Refuse newly introduced vulnerable dependencies\n")[1]!.split("      - ")[0]!;
  expect(step).toContain("if: steps.reused.outputs.reuse != 'true'");
  expect(step).not.toContain("continue-on-error");
  // Compiles the real CLI too, without importing a test-only implementation.
  expect(() => execFileSync(process.execPath, ["--check", "scripts/public-ci-dependencies.mjs"])).not.toThrow();
});
