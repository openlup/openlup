import { execFileSync, spawnSync } from "node:child_process";
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
  write(root, "src/lib/coreDomains.ts", 'export const CORE_DOMAINS = Object.freeze(["demo"] as const);\n');
  write(root, "src/domains/demo/main.ts", "export const value = 1;\n");
  write(root, "src/domains/demo/README.md", "# Demo\n");
  const surfaces = [
    { id: "repository", when: "Public fixture contract", paths: ["*", "scripts/**", "config/**", "packages/**", "src/**", "server/**", "docs/**"], doc: "README.md", anchor: "#contract" },
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
