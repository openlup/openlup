import { createSourceReleaseContract } from "./oss-source-release-contract.ts";
import { execFileSync, spawnSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_EXECUTION_ENTRYPOINTS } from "./oss-publication-contract.ts";
import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, createPublicPublicationCatalog } from "./oss-publication-policy.ts";
import { readDocumentationState, type DocumentationSurface } from "./documentation-routing.ts";
import { renderDocumentationSourceMap } from "./documentation-navigation.ts";
import { resolveDocumentationBase } from "./documentation-git.ts";

const fetchMock = vi.hoisted(() => ({ source: "", calls: [] as { args: string[]; options: ExecFileSyncOptions }[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (command: string, args: string[], options: ExecFileSyncOptions) => {
    if (command === "git" && args.includes("fetch") && args.includes("https://github.com/openlup/openlup.git")) {
      fetchMock.calls.push({ args, options });
      if (!fetchMock.source) throw new Error("simulated public base fetch failure");
      // The test transport alone admits the synthetic file repository; production admits HTTPS only.
      return actual.execFileSync(command, ["-c", "protocol.file.allow=always", ...args.map((arg) => arg === "https://github.com/openlup/openlup.git" ? `file://${fetchMock.source}` : arg)], options);
    }
    return actual.execFileSync(command, args, options);
  } };
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = "scripts/oss-published-tree-check.ts";
const localEnvironment = { ...process.env, GITHUB_ACTIONS: "false" };
const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
function write(root: string, path: string, bytes: string | Buffer): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
function commit(root: string): string {
  git(root, ["add", "."]); git(root, ["-c", "user.name=CLI Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function copyRuntimeClosure(root: string, path: string, seen = new Set<string>()): void {
  if (seen.has(path)) return;
  seen.add(path);
  const contents = readFileSync(join(ROOT, path), "utf8"); write(root, path, contents);
  for (const match of contents.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu)) {
    const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
    copyRuntimeClosure(root, target, seen);
  }
}

/** Deliberately has neither an install nor the application's files. */
function seed(root: string): string {
  git(root, ["init", "-q", "-b", "main"]);
  for (const path of PUBLIC_EXECUTION_ENTRYPOINTS) write(root, path, "public fixture\n");
  for (const { path } of PUBLIC_PACKAGE_EXECUTION_SURFACES) {
    write(root, path, path === "package.json" ? JSON.stringify({ type: "module", workspaces: ["packages/core"], scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }) : readFileSync(join(ROOT, path)));
  }
  copyRuntimeClosure(root, ENTRYPOINT);
  write(root, "README.md", "# Fixture\n\n## Contract\n\nThe demo preserves replay safety.\n\n## Other\n\nSeparate guidance.\n");
  write(root, "docs/platform/DOCUMENTATION.md", "# Documentation\n");
  write(root, "docs/platform/SUBSCRIPTION_WORKFLOWS.md", "# Workflows\n");
  write(root, "docs/platform/adopter-kit/dependabot.template.yml", 'groups:\n  openlup:\n    patterns:\n      - "@openlup/*"\n');
  write(root, "src/lib/coreDomains.ts", 'export const CORE_DOMAINS = Object.freeze(["communications", "demo"] as const);\n');
  write(root, "src/domains/demo/main.ts", "export const value = 1;\n");
  write(root, "src/domains/demo/README.md", "# Demo\n");
  write(root, "config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: true }], unreleased: [] }));
  write(root, "packages/core/release-gates.json", JSON.stringify({ packageSurface: { "./demo": { snapshot: "api/demo.api.md" } } }));
  write(root, "packages/core/api/demo.api.md", "# ./demo API declaration snapshot\n\n## dist/demo.d.ts\n\n```ts\nexport declare const a: number;\nexport declare const b: number;\n```\n");
  write(root, "packages/core/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- A change.\n");
  const portable = "db/platform/migrations/00000000000000_platform_baseline.sql", sql = "select 1;\n";
  write(root, portable, sql);
  write(root, "supabase/migrations/00000000000000_platform_schema_baseline.sql", sql);
  write(root, "config/platform-migration-manifest.json", JSON.stringify({ schemaVersion: 1, baseline: { file: portable, sha256: createHash("sha256").update(sql).digest("hex") }, forward: [], objectInventorySha256: "0".repeat(64) }));
  const surfaces = [
    { id: "repository", when: "Public fixture contract", paths: ["*", "scripts/**", "config/**", "packages/**", "examples/**", "deploy/**", "src/**", "server/**", "docs/**", "db/**", "supabase/**", "tests/**"], doc: "README.md", anchor: "#contract" },
    { id: "domain-demo", when: "Demo replay contract", paths: ["src/domains/demo/**"], doc: "README.md", anchor: "#contract" },
    { id: "domain-communications", when: "Communications fixture contract", paths: ["src/domains/communications/**"], doc: "README.md", anchor: "#contract" },
  ];
  write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
  write(root, "config/openlup-policy-registry.json", JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }));
  write(root, "docs/platform/SOURCE_MAP.md", renderDocumentationSourceMap(readDocumentationState(root)));
  const zero = `sha256-${"0".repeat(64)}`;
  write(root, "config/openlup-source-release-contract.json", createSourceReleaseContract({ inventoryDigest: zero, classDigest: zero, packageDigest: zero, rootLockDigest: zero, coreLockDigest: zero, migrationManifestDigest: zero, databaseTypesDigest: zero, policyRegistryDigest: zero, publicationCatalogDigest: zero }).contents);
  for (const path of ["package-lock.json", "packages/core/package-lock.json", "src/integrations/supabase/types.ts"]) write(root, path, "{}\n");
  write(root, "config/openlup-publication-catalog.json", "{}");
  git(root, ["add", "."]);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  write(root, "config/openlup-publication-catalog.json", createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []).contents);
  return commit(root);
}

describe("documentation CLI on the bare public runtime", () => {
  it("regenerates stale navigation after an owner heading rename and still checks authored links", () => {
    const temporary = mkdtempSync(join(tmpdir(), "documentation-rename-cli-"));
    try {
      const base = seed(temporary);
      write(temporary, "README.md", readFileSync(join(temporary, "README.md"), "utf8").replace("## Contract", "## Renamed contract"));
      write(temporary, "config/doc-routing.json", readFileSync(join(temporary, "config/doc-routing.json"), "utf8").replaceAll("#contract", "#renamed-contract"));
      const execute = () => spawnSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT, "--policy", "--docs-update", "--docs-base", base], {
        cwd: temporary, encoding: "utf8", env: localEnvironment, timeout: 30_000,
      });
      const regenerated = execute();
      expect(regenerated.stderr).toBe("");
      expect(readFileSync(join(temporary, "docs/platform/SOURCE_MAP.md"), "utf8")).not.toContain("README.md#contract");
      write(temporary, "README.md", `${readFileSync(join(temporary, "README.md"), "utf8")}\n[Broken](#missing)\n`);
      const broken = execute();
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain("missing local fragment");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
  it.each(["exact", "main-moved", "wrong-head", "unrelated-base"])("validates a pull-request merge with %s attribution on the bare runtime", (scenario) => {
    const temporary = mkdtempSync(join(tmpdir(), "documentation-pr-cli-"));
    try {
      const checkout = join(temporary, "checkout"); mkdirSync(checkout); const fork = seed(checkout);
      write(checkout, "src/domains/demo/main.ts", "export const value = 2;\n");
      write(checkout, "README.md", readFileSync(join(checkout, "README.md"), "utf8").replace("preserves replay safety", "preserves replay safety and refuses reordered events"));
      const source = commit(checkout);
      git(checkout, ["checkout", "-q", "--detach", fork]);
      if (scenario !== "exact") {
        write(checkout, "supabase/migrations/00000000000000_platform_schema_baseline.sql", "select 2;\n");
        commit(checkout); // Already on main: comparing against the fork would wrongly refuse this historical edit.
      }
      const firstParent = git(checkout, ["rev-parse", "HEAD"]);
      git(checkout, ["-c", "user.name=CLI Fixture", "-c", "user.email=fixture@example.invalid", "merge", "-q", "--no-ff", "-m", "PR merge", source]);
      const head = git(checkout, ["rev-parse", "HEAD"]);
      const unrelated = scenario === "unrelated-base"
        ? git(checkout, ["-c", "user.name=CLI Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", `${fork}^{tree}`, "-m", "Unrelated root"]) : fork;
      const event = join(temporary, "event.json");
      writeFileSync(event, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false },
        pull_request: { base: { sha: unrelated }, head: { sha: scenario === "wrong-head" ? fork : source } } }));
      const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT, "--policy"], {
        cwd: checkout, encoding: "utf8", timeout: 30_000,
        env: { ...localEnvironment, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: head, GITHUB_EVENT_PATH: event },
      });
      if (scenario === "exact" || scenario === "main-moved") {
        expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout).toContain(`${firstParent} (pull-request)`);
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(scenario === "wrong-head" ? "pull-request checkout is not the event's base/head merge" : "pull-request event base is not an observed ancestor");
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
  it("checks a merge group's event range on the bare runtime and refuses stale event refs", () => {
    const temporary = mkdtempSync(join(tmpdir(), "documentation-queue-cli-"));
    try {
      const checkout = join(temporary, "checkout"); mkdirSync(checkout); const base = seed(checkout);
      write(checkout, "src/domains/demo/main.ts", "export const value = 2;\n");
      write(checkout, "README.md", readFileSync(join(checkout, "README.md"), "utf8").replace("preserves replay safety", "preserves replay safety and refuses reordered events"));
      const head = commit(checkout); const ref = "refs/heads/gh-readonly-queue/main/pr-1-fixture"; const event = join(temporary, "event.json");
      writeFileSync(event, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, action: "checks_requested",
        merge_group: { base_sha: base, base_ref: "refs/heads/main", head_sha: head, head_ref: ref,
          head_commit: { id: head, tree_id: git(checkout, ["rev-parse", "HEAD^{tree}"]) } } }));
      const env = { ...localEnvironment, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: ref, GITHUB_SHA: head, GITHUB_EVENT_PATH: event };
      const execute = (patch = {}) => spawnSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT, "--policy", "--docs-base", head], {
        cwd: checkout, encoding: "utf8", env: { ...env, ...patch }, timeout: 30_000,
      });
      expect(existsSync(join(checkout, "node_modules"))).toBe(false);
      const valid = execute(); expect(valid.status).toBe(0); expect(valid.stderr).toBe(""); expect(valid.stdout).toContain(`${base} (merge-group)`);
      const stale = execute({ GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-2-fixture" });
      expect(stale.status).toBe(1); expect(stale.stderr).toContain("merge-group checkout");
      write(checkout, "supabase/migrations/00000000000000_platform_schema_baseline.sql", "select 2;\n");
      const changed = commit(checkout);
      writeFileSync(event, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, action: "checks_requested",
        merge_group: { base_sha: base, base_ref: "refs/heads/main", head_sha: changed, head_ref: ref,
          head_commit: { id: changed, tree_id: git(checkout, ["rev-parse", "HEAD^{tree}"]) } } }));
      const rejected = execute({ GITHUB_SHA: changed });
      expect(rejected.status).toBe(1); expect(rejected.stderr).toContain("migration history refuses an edit");
      write(checkout, "packages/core/api/demo.api.md", readFileSync(join(checkout, "packages/core/api/demo.api.md"), "utf8").replace("export declare const b: number;\n", ""));
      write(checkout, "README.md", readFileSync(join(checkout, "README.md"), "utf8").replace("preserves replay safety", "preserves replay safety and its published API"));
      const unmigrated = commit(checkout);
      writeFileSync(event, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, action: "checks_requested",
        merge_group: { base_sha: changed, base_ref: "refs/heads/main", head_sha: unmigrated, head_ref: ref,
          head_commit: { id: unmigrated, tree_id: git(checkout, ["rev-parse", "HEAD^{tree}"]) } } }));
      const unmigratedApi = execute({ GITHUB_SHA: unmigrated });
      expect(unmigratedApi.status).toBe(1); expect(unmigratedApi.stderr).toContain("migration-block @openlup/core: packages/core/api/demo.api.md removes or changes a declaration line");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
  it("runs in a shallow checkout without node_modules, checks navigation and trusts hosted attribution", () => {
    const temporary = mkdtempSync(join(tmpdir(), "documentation-cli-"));
    try {
      const source = join(temporary, "source"); mkdirSync(source); const base = seed(source);
      write(source, "README.md", `${readFileSync(join(source, "README.md"), "utf8")}\nCurrent contribution guidance.\n`); commit(source);
      const checkout = join(temporary, "shallow"); git(temporary, ["clone", "-q", "--depth=1", `file://${source}`, checkout]);
      const head = git(checkout, ["rev-parse", "HEAD"]);
      expect(git(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("true");
      expect(existsSync(join(checkout, "node_modules"))).toBe(false);
      const execute = (args: string[], hosted?: Record<string, string>) => spawnSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT, "--policy", ...args], {
        cwd: checkout, encoding: "utf8", env: { ...localEnvironment, ...hosted }, timeout: 30_000,
      });
      expect(execute(["--docs-base", base]).status).toBe(1); // Missing object is not an empty diff.
      git(checkout, ["fetch", "-q", "--no-tags", "--depth=2", "origin", "main"]);
      const event = join(temporary, "event.json");
      writeFileSync(event, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, before: base, after: head }));
      const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: "push", GITHUB_SHA: head, GITHUB_EVENT_PATH: event };
      const clean = execute(["--docs-base", head], env);
      expect(clean.stderr).toBe(""); expect(clean.status).toBe(0); expect(clean.stdout).toContain(`${base} (push)`);
      const decoy = join(temporary, "decoy"); mkdirSync(decoy); git(decoy, ["init", "-q"]);
      write(decoy, "different.txt", "Different repository inventory.\n"); commit(decoy);
      const redirected = execute(["--docs-base", head], { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, ".git/index") });
      expect(redirected.stderr).toBe(""); expect(redirected.status).toBe(0); expect(redirected.stdout).toContain(`${head} (explicit)`);
      write(checkout, "src/domains/demo/main.ts", "export const value = 2;\n");
      // Source edits no longer need an owner-section answer.
      expect(execute([], env).status).toBe(0);
      write(checkout, "docs/platform/SOURCE_MAP.md", "stale navigation\n");
      const staleMap = execute([], env);
      expect(staleMap.status).toBe(1); expect(staleMap.stderr).toContain("documentation source map is stale");
      expect(execute(["--docs-update"], env).status).toBe(0);
      const mismatch = execute([], { ...env, GITHUB_SHA: base });
      expect(mismatch.status).toBe(1); expect(mismatch.stderr).toContain("checkout identity");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 30_000);
});

describe("strict documentation base attribution", () => {
  const directories: string[] = [];
  let fixtureSeed: { root: string; base: string } | undefined;
  afterEach(() => { vi.unstubAllEnvs(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); fetchMock.source = ""; fetchMock.calls.length = 0; });
  afterAll(() => { if (fixtureSeed) rmSync(fixtureSeed.root, { recursive: true, force: true }); });
  function temporary(): string { const path = mkdtempSync(join(tmpdir(), "documentation-guard-")); directories.push(path); return path; }
  function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  function write(root: string, path: string, text: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  function commit(root: string): string {
    git(root, "add", "."); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "-qm", "fixture"); return git(root, "rev-parse", "HEAD");
  }
  const OWNER = "docs/owner.md";
  const SOURCE = "src/domains/demo/main.ts";
  const ownerText = "# Owner\n\n## Canonical\n\nThe contract preserves replay safety.\n\nUpdated: 2026-09-26\n\n## Other\n\nSeparate guidance.\n";
  function fixture(): { root: string; base: string; surfaces: DocumentationSurface[] } {
    const root = temporary();
    const surfaces: DocumentationSurface[] = [
      { id: "repository", when: "Repository contracts and configuration", paths: ["*", "config/**", "src/lib/**"], doc: OWNER, anchor: "#canonical" },
      { id: "domain-demo", when: "The demo domain contract", paths: ["src/domains/demo/**"], doc: OWNER, anchor: "#canonical" },
      { id: "documentation", when: "Public documentation authoring", paths: ["docs/**"], doc: OWNER, anchor: "" },
    ];
    if (fixtureSeed) {
      // Reuse only immutable setup bytes; every case owns its complete tree and .git.
      cpSync(fixtureSeed.root, root, { recursive: true });
      return { root, base: fixtureSeed.base, surfaces };
    }
    git(root, "init", "-q");
    write(root, "README.md", `[Owner](${OWNER})\n`); write(root, OWNER, ownerText);
    write(root, "src/lib/coreDomains.ts", 'export const CORE_DOMAINS = Object.freeze(["demo"] as const);\n');
    write(root, SOURCE, "export const value = 1;\n"); write(root, "src/domains/demo/other.ts", "export const other = 1;\n");
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const base = commit(root); git(root, "update-ref", "refs/remotes/origin/main", base);
    fixtureSeed = { root: mkdtempSync(join(tmpdir(), "documentation-guard-seed-")), base };
    cpSync(root, fixtureSeed.root, { recursive: true });
    return { root, base, surfaces };
  }
  function hostedEvent(root: string, base: string, eventName = "push", extra: Record<string, unknown> = {}): NodeJS.ProcessEnv {
    const head = git(root, "rev-parse", "HEAD"); const eventPath = join(temporary(), "event.json");
    writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, before: base, after: head, ...extra }));
    return { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: head, PATH: localEnvironment.PATH };
  }
  function mergeGroupEvent(root: string, base: string, patch: Record<string, unknown> = {}): NodeJS.ProcessEnv {
    const head = git(root, "rev-parse", "HEAD"); const ref = "refs/heads/gh-readonly-queue/main/pr-1-fixture";
    return { ...hostedEvent(root, base, "merge_group", { action: "checks_requested", merge_group: {
      base_sha: base, base_ref: "refs/heads/main", head_sha: head, head_ref: ref,
      head_commit: { id: head, tree_id: git(root, "rev-parse", "HEAD^{tree}") }, ...patch,
    } }), GITHUB_REF: ref };
  }

  it.each(["rewrite", "header", "included-header", "remote-alias"])("refuses effective %s configuration before public fallback transport", (setting) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=1", `file://${root}`, shallow);
    if (setting === "rewrite") git(shallow, "config", `url.file://${root}.insteadOf`, "https://github.com/openlup/openlup.git");
    else if (setting === "header") git(shallow, "config", "http.https://github.com/openlup/.extraHeader", "Authorization: SyntheticDocumentationFixture");
    else if (setting === "remote-alias") git(shallow, "config", "remote.https://github.com/openlup/openlup.git.url", `file://${root}`);
    else {
      const included = join(temporary(), "transport.gitconfig");
      writeFileSync(included, '[http "https://github.com/openlup/"]\n extraHeader = Authorization: SyntheticDocumentationFixture\n');
      git(shallow, "config", "include.path", included);
    }
    fetchMock.source = root;
    expect(() => resolveDocumentationBase(shallow, { env: hostedEvent(shallow, base) })).toThrow(/transport or credential configuration/);
    expect(fetchMock.calls).toHaveLength(0);
  });
  it("uses a local merge base, refuses unknown/nonancestor bases and never silently skips", () => {
    const { root, base } = fixture(); expect(resolveDocumentationBase(root, { env: {} }).base).toBe(base);
    expect(() => resolveDocumentationBase(root, { base: "HEAD", env: {} })).toThrow(/full commit SHA/);
    expect(() => resolveDocumentationBase(root, { base: "f".repeat(40), env: {} })).toThrow();
    git(root, "checkout", "--orphan", "unrelated"); git(root, "rm", "-rf", "."); write(root, "unrelated.txt", "unrelated\n"); const other = commit(root);
    git(root, "checkout", "-q", "--detach", base);
    expect(() => resolveDocumentationBase(root, { base: other, env: {} })).toThrow(/not an ancestor/);
    git(root, "update-ref", "-d", "refs/remotes/origin/main"); expect(() => resolveDocumentationBase(root, { env: {} })).toThrow();
  });
  it("prioritizes valid public hosted events over a caller override and rejects identity drift", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const env = hostedEvent(root, base);
    expect(resolveDocumentationBase(root, { base: "f".repeat(40), env }).provenance).toBe("push");
    for (const patch of [{ GITHUB_REPOSITORY: "foreign/repository" }, { GITHUB_SHA: base }, { GITHUB_EVENT_NAME: "workflow_dispatch" }])
      expect(() => resolveDocumentationBase(root, { env: { ...env, ...patch } })).toThrow(/identity|event/);
    const privateEnv = hostedEvent(root, base, "push", { repository: { full_name: "openlup/openlup", private: true } });
    expect(() => resolveDocumentationBase(root, { env: privateEnv })).toThrow(/public OpenLup/);
  });
  it("validates the actual PR merge parents", () => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); const source = commit(root);
    git(root, "checkout", "-qb", "merge", base); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "-qm", "merge fixture", "topic");
    const env = hostedEvent(root, base, "pull_request", { pull_request: { base: { sha: base }, head: { sha: source }, merge_commit_sha: git(root, "rev-parse", "HEAD") } });
    expect(resolveDocumentationBase(root, { env }).provenance).toBe("pull-request");
    git(root, "checkout", "-q", "--detach", source); env.GITHUB_SHA = source;
    expect(() => resolveDocumentationBase(root, { env })).toThrow(/base\/head merge/);
  });
  describe("the pull-request identity fence", () => {
    function merged() {
      const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); const source = commit(root);
      git(root, "checkout", "-qb", "merge", base); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "-qm", "merge fixture", "topic");
      return { root, base, source, merge: git(root, "rev-parse", "HEAD") };
    }
    const pullRequest = (root: string, base: string, source: string, mergeCommit: string) => hostedEvent(root, base, "pull_request", { pull_request: { base: { sha: base }, head: { sha: source }, merge_commit_sha: mergeCommit } });
    it("F1 accepts exact parents when the payload's merge_commit_sha lags", () => {
      const { root, base, source } = merged(); expect(resolveDocumentationBase(root, { env: pullRequest(root, base, source, base) }).provenance).toBe("pull-request");
    });
    it("F2 refuses swapped parents", () => {
      const { root, base, source } = merged(); const swapped = git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit-tree", git(root, "rev-parse", "HEAD^{tree}"), "-p", source, "-p", base, "-m", "swapped");
      git(root, "checkout", "-q", "--detach", swapped); expect(() => resolveDocumentationBase(root, { env: pullRequest(root, base, source, swapped) })).toThrow(/base\/head merge/);
    });
    it("F3 refuses a one-parent checkout", () => {
      const { root, base, source } = merged(); git(root, "checkout", "-q", "--detach", source); expect(() => resolveDocumentationBase(root, { env: pullRequest(root, base, source, source) })).toThrow(/base\/head merge/);
    });
    it("F4 refuses an event base that is not an ancestor of the first parent", () => {
      const { root, source, merge } = merged(); expect(() => resolveDocumentationBase(root, { env: pullRequest(root, source, source, merge) })).toThrow(/not an observed ancestor/);
    });
    it("F5 refuses a checkout other than GITHUB_SHA", () => {
      const { root, base, source, merge } = merged(); const env = pullRequest(root, base, source, merge); env.GITHUB_SHA = source;
      expect(() => resolveDocumentationBase(root, { env })).toThrow(/hosted checkout identity/);
    });
  });
  it("attributes a complete merge batch to its exact event base, head, ref and checkout", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    write(root, "src/domains/demo/other.ts", "export const other = 2;\n"); const head = commit(root);
    const env = mergeGroupEvent(root, base);
    expect(resolveDocumentationBase(root, { base: head, env })).toEqual({ base, head, provenance: "merge-group" });
    expect(fetchMock.calls).toEqual([]);
    write(root, SOURCE, "export const value = 3;\n"); commit(root);
    expect(() => resolveDocumentationBase(root, { env })).toThrow(/checkout identity/);
  });
  it.each([
    { base_sha: undefined }, { base_sha: "invalid" }, { base_sha: "0".repeat(40) },
    { base_ref: undefined }, { base_ref: "refs/heads/other" },
    { head_sha: undefined }, { head_sha: "f".repeat(40) },
    { head_ref: undefined }, { head_ref: "refs/heads/main" },
    { head_commit: undefined }, { head_commit: { id: "f".repeat(40), tree_id: "a".repeat(40) } },
  ])("refuses missing or malformed merge-group attribution %j before transport", (patch) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    expect(() => resolveDocumentationBase(root, { env: mergeGroupEvent(root, base, patch) })).toThrow(/merge-group checkout/);
    expect(fetchMock.calls).toEqual([]);
  });
  it("refuses missing group/action/ref, wrong tree, empty range and unrelated base", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); const head = commit(root);
    const env = mergeGroupEvent(root, base);
    const original = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
    for (const patch of [{ action: undefined }, { action: "destroyed" }, { merge_group: undefined }]) {
      writeFileSync(env.GITHUB_EVENT_PATH!, JSON.stringify({ ...original, ...patch }));
      expect(() => resolveDocumentationBase(root, { env })).toThrow(/merge-group checkout/);
    }
    writeFileSync(env.GITHUB_EVENT_PATH!, JSON.stringify(original));
    for (const patch of [{ GITHUB_REF: undefined }, { GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-2-fixture" }])
      expect(() => resolveDocumentationBase(root, { env: { ...env, ...patch } })).toThrow(/merge-group checkout/);
    const wrongTree = mergeGroupEvent(root, base, { head_commit: { id: head, tree_id: "f".repeat(40) } });
    expect(() => resolveDocumentationBase(root, { env: wrongTree })).toThrow(/merge-group checkout/);
    expect(() => resolveDocumentationBase(root, { env: mergeGroupEvent(root, head) })).toThrow(/merge-group checkout/);
    const badRef = "refs/heads/gh-readonly-queue/main/../fixture";
    expect(() => resolveDocumentationBase(root, { env: { ...mergeGroupEvent(root, base, { head_ref: badRef }), GITHUB_REF: badRef } })).toThrow(/ref is malformed/);
    git(root, "checkout", "--orphan", "unrelated"); git(root, "rm", "-rf", "."); write(root, "other.txt", "other\n"); const other = commit(root);
    git(root, "checkout", "-q", "--detach", head);
    expect(() => resolveDocumentationBase(root, { env: mergeGroupEvent(root, other) })).toThrow(/not an observed ancestor/);
    expect(fetchMock.calls).toEqual([]);
  });
  it("fetches a missing shallow CI base with no credentials, refs or FETCH_HEAD; failure refuses", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=1", `file://${root}`, shallow);
    expect(() => resolveDocumentationBase(shallow, { base, env: {} })).toThrow();
    const env = hostedEvent(shallow, base); env.DEMONSTRATION_TOKEN = "synthetic";
    expect(() => resolveDocumentationBase(shallow, { env })).toThrow(/simulated public base fetch failure/);
    fetchMock.source = root; expect(resolveDocumentationBase(shallow, { env }).base).toBe(base);
    const call = fetchMock.calls.at(-1)!;
    expect(call.args).toContain("--no-write-fetch-head"); expect(call.args).toContain("credential.helper="); expect(call.args).toContain("core.askPass=");
    for (const flag of ["--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=", "--no-auto-maintenance", "--no-write-commit-graph"])
      expect(call.args).toContain(flag);
    expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe("0"); expect(call.options.env?.DEMONSTRATION_TOKEN).toBeUndefined();
    expect(existsSync(join(shallow, ".git/FETCH_HEAD"))).toBe(false);
  });
});
