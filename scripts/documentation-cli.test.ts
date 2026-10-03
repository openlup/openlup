import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_EXECUTION_ENTRYPOINTS } from "./oss-publication-contract.ts";
import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, createPublicPublicationCatalog } from "./oss-publication-policy.ts";
import { readDocumentationState } from "./documentation-routing.ts";
import { renderDocumentationSourceMap } from "./documentation-navigation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = "scripts/oss-published-tree-check.ts";
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
  write(root, "src/lib/coreDomains.ts", 'export const CORE_DOMAINS = Object.freeze(["demo"] as const);\n');
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
    { id: "repository", when: "Public fixture contract", paths: ["*", "scripts/**", "config/**", "packages/**", "src/**", "server/**", "docs/**", "db/**", "supabase/**"], doc: "README.md", anchor: "#contract" },
    { id: "domain-demo", when: "Demo replay contract", paths: ["src/domains/demo/**"], doc: "README.md", anchor: "#contract" },
  ];
  write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
  write(root, "config/openlup-policy-registry.json", JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "entrypoint", owners: ["README.md"] }] }));
  write(root, "docs/platform/SOURCE_MAP.md", renderDocumentationSourceMap(readDocumentationState(root)));
  write(root, "config/openlup-publication-catalog.json", "{}");
  git(root, ["add", "."]);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  write(root, "config/openlup-publication-catalog.json", createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []).contents);
  return commit(root);
}

describe("documentation CLI on the bare public runtime", () => {
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
      const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: ref, GITHUB_SHA: head, GITHUB_EVENT_PATH: event };
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
  it("runs in a shallow checkout without node_modules, enforces source impact and trusts hosted attribution", () => {
    const temporary = mkdtempSync(join(tmpdir(), "documentation-cli-"));
    try {
      const source = join(temporary, "source"); mkdirSync(source); const base = seed(source);
      write(source, "README.md", `${readFileSync(join(source, "README.md"), "utf8")}\nCurrent contribution guidance.\n`); commit(source);
      const checkout = join(temporary, "shallow"); git(temporary, ["clone", "-q", "--depth=1", `file://${source}`, checkout]);
      const head = git(checkout, ["rev-parse", "HEAD"]);
      expect(git(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("true");
      expect(existsSync(join(checkout, "node_modules"))).toBe(false);
      const execute = (args: string[], hosted?: Record<string, string>) => spawnSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT, "--policy", ...args], {
        cwd: checkout, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", ...hosted }, timeout: 30_000,
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
      const original = readFileSync(join(checkout, "README.md"), "utf8");
      write(checkout, "README.md", original.replace("## Other", `<!-- openlup-doc-impact {"unit":"domain-demo","digest":"sha256-${"0".repeat(64)}","reason":"An invalid fingerprint is not an update."} -->\n\n## Other`));
      const refused = execute([], env);
      expect(refused.status).toBe(1); expect(refused.stdout).toContain("needs a substantive section update");
      write(checkout, "README.md", original.replace("preserves replay safety", "preserves replay safety and now refuses reordered events"));
      expect(execute([], env).status).toBe(0);
      const mismatch = execute([], { ...env, GITHUB_SHA: base });
      expect(mismatch.status).toBe(1); expect(mismatch.stderr).toContain("checkout identity");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
