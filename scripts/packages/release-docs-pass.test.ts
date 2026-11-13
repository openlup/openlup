import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleUpgradePage, formatReleaseDocumentation, listReleaseDocumentation, previousCoreTag, summarizeApiDiff, upgradePagePath } from "./release-docs-pass.ts";
import { isGuidePage, validateGuidePage } from "../oss-publication-policy.ts";

const report = (source: string) => `# API report\n\n\`\`\`ts\n${source}\`\`\`\n`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const api = "packages/core/api/core.api.md", catalog = "config/openlup-publication-catalog.json";
const guide = "packages/core/docs/guide/how-to/change.md", routed = "packages/core/docs/guide/reference/api.md";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-docs-pass-")); roots.push(root);
  const write = (path: string, source: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); };
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: ["core", "outbox"].map((name) => ({ name: `@openlup/${name}`, directory: `packages/${name}`, publish: true })), unreleased: [] }));
  write("config/documentation-guide-allowlist.json", JSON.stringify({ schemaVersion: 1, terms: ["B2B"] }));
  write("config/doc-routing.json", JSON.stringify({ version: 2, surfaces: [
    { id: "api", when: "API declarations", paths: ["packages/*/api/*.api.md", routed], doc: "docs/platform/API.md", anchor: "#api" },
    { id: "catalog", when: "Catalogue", paths: [catalog], doc: "docs/platform/DISTRIBUTION.md", anchor: "" },
    { id: "docs", when: "Other documentation", paths: ["**"], doc: "docs/platform/DOCUMENTATION.md", anchor: "" },
  ] }));
  write(api, report("// API\nexport declare const oldName: string;\nexport declare const kept: string;\n"));
  write(catalog, "{}\n");
  write("docs/platform/API.md", "# API\n\n## API\n");
  write("docs/platform/old.md", "# Previous page\n");
  write("docs/platform/deleted.md", "# Deleted page\n");
  write("docs/platform/unchanged.md", "# Unchanged page\n");
  write("docs/platform/plans/plan.md", "# Historical plan\n");
  write(guide, `# Change\n\n[API][api]\n\n[api]: https://github.com/openlup/openlup/blob/openlup-core-v0.4.0/${api}\n`);
  write(routed, "# API\n");
  git("init", "-q"); commit(); git("tag", "openlup-core-v0.4.0");
  return { root, write, git, commit };
}

describe("release documentation listing", () => {
  it("lists the committed API, catalogue and maintainer diff with owners, linked/routed guide pages and affected website references", () => {
    const f = fixture();
    f.write(api, "// API\nexport declare const nextName: string;\nexport declare const kept: string;\n");
    f.write(catalog, '{"updated":true}\n');
    f.git("mv", "docs/platform/old.md", "docs/platform/renamed.md");
    f.git("rm", "docs/platform/deleted.md");
    f.write("docs/platform/plans/plan.md", "# Changed history\n");
    f.write(".github/POLICY.md", "# Policy\n"); f.write("packages/outbox/AGENTS.md", "# Agents\n");
    f.write("server/adapters/README.md", "# Adapters\n"); f.write("src/domain/README.md", "# Domain\n"); f.write("deploy/neutral-store/README.md", "# Deploy\n");
    f.write("src/domain/notes.md", "# Not a maintainer page\n");
    f.commit();
    f.write("README.md", "# Uncommitted\n");
    const website = mkdtempSync(join(tmpdir(), "release-docs-site-")); roots.push(website);
    const claims = "docs/claims/api.json", content = "src/content/pages/proof.mdx";
    mkdirSync(dirname(join(website, claims)), { recursive: true }); mkdirSync(dirname(join(website, content)), { recursive: true });
    const claimText = `{"sources":["oss:${api}:12-14","oss:${catalog}"]}\n`;
    const contentText = "oss:docs/platform/deleted.md\noss:docs/platform/old.md:L2-L3 oss:docs/platform/renamed.md\noss:docs/platform/unchanged.md\n";
    writeFileSync(join(website, claims), claimText); writeFileSync(join(website, content), contentText);
    writeFileSync(join(website, "src/content/binary.bin"), Buffer.from([0, 255]));
    const listing = listReleaseDocumentation({ root: f.root, website });
    expect(listing.since).toBe("openlup-core-v0.4.0"); expect(listing.warnings).toEqual([]);
    expect(listing.changes.find(({ path }) => path === api)).toMatchObject({ status: "M", owner: { doc: "docs/platform/API.md", anchor: "#api" }, guidePages: [guide, routed] });
    expect(listing.changes.find(({ path }) => path === catalog)?.owner?.doc).toBe("docs/platform/DISTRIBUTION.md");
    expect(listing.changes.map(({ path }) => path)).toEqual(expect.arrayContaining([".github/POLICY.md", "packages/outbox/AGENTS.md", "server/adapters/README.md", "src/domain/README.md", "deploy/neutral-store/README.md"]));
    expect(listing.changes.some(({ path }) => path === "src/domain/notes.md")).toBe(false);
    expect(listing.changes.some(({ path }) => path === "README.md" || path.includes("/plans/"))).toBe(false);
    expect(listing.websiteReferences).toEqual([
      { file: claims, line: 1, reference: `oss:${api}:12-14`, status: "M" },
      { file: claims, line: 1, reference: `oss:${catalog}`, status: "M" },
      { file: content, line: 1, reference: "oss:docs/platform/deleted.md", status: "D" },
      { file: content, line: 2, reference: "oss:docs/platform/old.md:L2-L3", status: "R100" },
      { file: content, line: 2, reference: "oss:docs/platform/renamed.md", status: "R100" },
    ]);
    expect(formatReleaseDocumentation(listing)).toContain(`${content}:1 oss:docs/platform/deleted.md (D)`);
    expect(readFileSync(join(website, claims), "utf8")).toBe(claimText); expect(readFileSync(join(website, content), "utf8")).toBe(contentText);
    expect(f.git("diff", "--cached", "--name-status")).toBe("");
  });

  it("selects an ancestor tag, ignoring a newer tag on another branch", () => {
    const f = fixture(), head = f.git("rev-parse", "HEAD");
    f.git("checkout", "-qb", "other"); f.write("other.txt", "other\n"); f.commit(); f.git("tag", "openlup-core-v9.0.0"); f.git("checkout", "-q", head);
    expect(previousCoreTag(f.root)).toBe("openlup-core-v0.4.0");
  });

  it("keeps missing routing and website evidence advisory, and reports usage and git errors", () => {
    const f = fixture(), script = resolve("scripts/packages/release-docs-pass.ts");
    f.write(api, "export declare const changed: string;\n"); f.commit(); rmSync(join(f.root, "config/doc-routing.json"));
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: f.root, encoding: "utf8" });
    const plain = run(); expect(plain.status).toBe(0); expect(plain.stdout).toContain("Website claims were not checked."); expect(plain.stdout).toContain("owner: unresolved");
    const json = run("--since", "openlup-core-v0.4.0", "--website", join(f.root, "missing"), "--json");
    expect(json.status).toBe(0); expect(JSON.parse(json.stdout)).toMatchObject({ websiteChecked: false, changes: [{ path: api, owner: null }] });
    expect(run("--json").stderr).toContain("Website claims were not checked.");
    expect(run("--since").status).toBe(2); expect(run("--wat").status).toBe(2); expect(run("--json", "--json").status).toBe(2);
    expect(run("--since", "missing-tag").status).toBe(1);
    f.git("tag", "-d", "openlup-core-v0.4.0");
    const untagged = run();
    expect(untagged.status).toBe(0); expect(untagged.stdout).toContain("The previous release could not be determined");
    expect(JSON.parse(run("--json").stdout)).toMatchObject({ since: null, changes: [] });
    rmSync(join(f.root, ".git"), { recursive: true }); expect(run().status).toBe(1);
  });

  it("reports an unknown previous release when every core tag is on another branch", () => {
    const f = fixture(); f.git("tag", "-d", "openlup-core-v0.4.0");
    const head = f.git("rev-parse", "HEAD");
    f.git("checkout", "-qb", "other"); f.write("other.txt", "other\n"); f.commit();
    f.git("tag", "openlup-core-v9.0.0"); f.git("checkout", "-q", head);
    expect(previousCoreTag(f.root)).toBeUndefined();
    const listing = listReleaseDocumentation({ root: f.root });
    expect(listing.since).toBeNull(); expect(listing.changes).toEqual([]);
    expect(formatReleaseDocumentation(listing)).toContain("The previous release could not be determined");
    const page = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(page.text).toContain("## API changes\n\nThe previous release could not be determined");
    expect(page.text).not.toContain("No API reports changed"); expect(page.violations).toEqual([]);
  });
});

describe("upgrade page assembly", () => {
  it.each(["0.40.0", "0.40.0-rc.1", "0.40.0-rc.1+build.2"])("uses a publication-safe filename and real heading for %s", (version) => {
    const f = fixture(), path = upgradePagePath(version);
    expect(path).toBe(`packages/core/docs/guide/upgrade/v${version.replace(/[^A-Za-z0-9]/gu, "-")}.md`);
    expect(isGuidePage(path)).toBe(true);
    const result = assembleUpgradePage({ root: f.root, version, since: previousCoreTag(f.root), fragments: [] });
    expect(result.text).toContain(`# Upgrading to ${version}\n`); expect(result.violations).toEqual([]);
  });
  it("uses publishable fragments in bump order, and includes added and removed exports with exempt fences", () => {
    const f = fixture();
    f.write("packages/core/docs/guide/upgrade/README.md", "# Upgrade procedure\n");
    f.write(api, report("// Updated comment\nexport declare const nextName: string;\nexport declare const kept: string;\n")); f.commit();
    const fragments = [
      { path: "packages/outbox/changes/one.md", contents: "- Outbox body.\n" },
      { path: "packages/core/changes/z-last.md", contents: "- Last body.\n" },
      { path: "packages/core/changes/a-first.md", contents: "### Added\n\n- First body.\n" },
      { path: "packages/private/changes/one.md", contents: "- Private body.\n" },
    ];
    const result = assembleUpgradePage({ root: f.root, version: "0.5.0", since: "openlup-core-v0.4.0", fragments });
    expect(result.violations).toEqual([]);
    expect(result.text).toContain("# Upgrading to 0.5.0\n"); expect(result.text).toContain("[upgrade procedure](README.md)");
    expect(result.text.indexOf("## @openlup/core")).toBeLessThan(result.text.indexOf("## @openlup/outbox"));
    expect(result.text.indexOf("First body.")).toBeLessThan(result.text.indexOf("Last body.")); expect(result.text).not.toContain("Private body.");
    expect(result.text).toContain("Added declarations:\n\n```ts nocheck\n// API report diff: not compiled.\nexport declare const nextName: string;\n```");
    expect(result.text).toContain("Removed declarations:\n\n```ts nocheck\n// API report diff: not compiled.\nexport declare const oldName: string;\n```");
    expect(result.text).not.toContain("export declare const kept"); expect(result.text).not.toContain("Updated comment");
    expect(validateGuidePage(upgradePagePath("0.5.0"), result.text, "100644")).toBe(result.text);
    expect(f.git("status", "--porcelain")).toBe("");
  });

  it("reports reader-language and link violations using the existing contract, and omits a missing procedure link", () => {
    const f = fixture();
    const result = assembleUpgradePage({ root: f.root, version: "0.5.0", since: "openlup-core-v0.4.0", fragments: [
      { path: "packages/core/changes/one.md", contents: "- B2B support.\n- W99 task.\n- [Owner](../../../../../../CONTRIBUTING.md).\n" },
    ] });
    expect(result.text).not.toContain("[upgrade procedure]"); expect(result.text).toContain("No API reports changed since the previous release.");
    expect(result.violations).toEqual([expect.stringContaining("task or milestone ID): W99"), expect.stringContaining("leaves the guide")]);
  });

  it("reports both deleted and newly added API reports", () => {
    const f = fixture(); f.git("rm", api); f.write("packages/outbox/api/outbox.api.md", report("export declare const send: () => void;\n")); f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: "openlup-core-v0.4.0", fragments: [] });
    expect(text).toContain(`### \`${api}\``); expect(text).toContain("export declare const oldName"); expect(text).toContain("export declare const send");
  });

  it("compares added, removed, changed and unchanged declaration blocks across fences", () => {
    const before = report([
      "export interface Updated {", "    old: string;", "}",
      "export type Removed = string;",
      "declare class Kept {", "    method(): void;", "}",
      "export declare function overload(value: string): void;",
      "export declare function overload(value: number): void;",
      "export { previous };", "",
    ].join("\n"));
    const after = "export type OutsideFence = never;\n" + report([
      "export interface Updated {", "    old: string;", "    events?: {};", "}",
      "export type Added = string;",
      "declare class Kept {", "    method(): void;  ", "}",
      "export declare function overload(value: string): void;",
      "export declare function overload(value: boolean): void;",
      "export { next };", "",
    ].join("\r\n"));
    expect(summarizeApiDiff(before, after)).toEqual({
      added: ["export type Added = string;", "export { next };"],
      removed: ["export type Removed = string;", "export { previous };"],
      changed: ["export interface Updated {", "export declare function overload(value: string): void;", "export declare function overload(value: boolean): void;"],
    });
    expect(summarizeApiDiff(before, before)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("treats an absent report as entirely added or removed and deduplicates first lines", () => {
    const source = report("export interface Repeated {\n    field: string;\n}\n") + report("export interface Repeated {\n    field: string;\n}\n");
    expect(summarizeApiDiff("", source)).toEqual({ added: ["export interface Repeated {"], removed: [], changed: [] });
    expect(summarizeApiDiff(source, "")).toEqual({ added: [], removed: ["export interface Repeated {"], changed: [] });
    expect(summarizeApiDiff(source, source + source)).toEqual({ added: [], removed: [], changed: [] });
    const changed = source.replaceAll("field: string", "field: number");
    expect(summarizeApiDiff(source, changed)).toEqual({ added: [], removed: [], changed: ["export interface Repeated {"] });
    expect(summarizeApiDiff(report("declare const internal: string;\n"), report("declare const internal: number;\n"))).toEqual({ added: [], removed: [], changed: ["declare const internal: number;"] });
  });

  it.each([
    ["const value: string;", "const value: number;"],
    ["let value: string;", "let value: number;"],
    ["var value: string;", "var value: number;"],
    ["function value(): string;", "function value(): number;"],
    ["class Value { field: string; }", "class Value { field: number; }"],
    ["interface Value { field: string; }", "interface Value { field: number; }"],
    ["type Value = string;", "type Value = number;"],
    ["enum Value { First }", "enum Value { Second }"],
    ["const enum Value { First }", "const enum Value { Second }"],
    ["namespace Value { type Field = string; }", "namespace Value { type Field = number; }"],
    ['module "value" { type Field = string; }', 'module "value" { type Field = number; }'],
    ["export declare abstract class Value { field: string; }", "export declare abstract class Value { field: number; }"],
    ["export default class Value { field: string; }", "export default class Value { field: number; }"],
    ["async function value(): Promise<string>;", "async function value(): Promise<number>;"],
  ])("starts a block at a top-level declaration: %s", (before, after) => {
    expect(summarizeApiDiff(report(`${before}\n`), report(`${after}\n`))).toEqual({ added: [], removed: [], changed: [after] });
  });

  it("keeps comments with the following declaration and reports declaration first lines", () => {
    const before = report("// Standalone comment\n\nexport type Kept = string;\n/** Previous description.\n * More detail.\n */\n// Detail\ntype Updated = string;\n");
    const after = before.replace("Previous description", "Updated description").replace("More detail", "New detail").replace("// Detail", "// New detail");
    expect(summarizeApiDiff(before, after)).toEqual({ added: [], removed: [], changed: ["type Updated = string;"] });
    expect(summarizeApiDiff("", report("// Comment\n/** Description */\n"))).toEqual({ added: [], removed: [], changed: [] });
  });

  it("compares export lists and star exports", () => {
    const source = report('export * from "./values.js";\nexport { value };\nexport type * from "./types.js";\n');
    expect(summarizeApiDiff("", source)).toEqual({
      added: ['export * from "./values.js";', "export { value };", 'export type * from "./types.js";'], removed: [], changed: [],
    });
  });

  it.each([
    ["Configuration", "maxRequestBytes?: number;", "maxRequestBytes?: string;"],
    ["Fact", "sourceId: string;", "sourceId: number;"],
  ])("detects a member change in the real unexported %s alias", (name, before, after) => {
    const source = execFileSync("git", ["show", "openlup-core-v0.40.0:packages/platform/api/communications-klaviyo.api.md"], { encoding: "utf8" });
    expect(source).toContain(before);
    const result = summarizeApiDiff(source, source.replace(before, after));
    expect(result).toEqual({ added: [], removed: [], changed: [name === "Configuration" ? "type Configuration = {" : "type Fact<K extends string, D> = Readonly<{"] });
  });

  it("ignores import-line changes in the real report and between declarations", () => {
    const source = execFileSync("git", ["show", "openlup-core-v0.40.0:packages/platform/api/communications-klaviyo.api.md"], { encoding: "utf8" });
    const before = source + report('type Kept = string;\nimport type { Value } from "./before.js";\nexport type Next = number;\n');
    const after = before.replace("'./marketingSync.js'", "'./renamed.js'").replace('"./before.js"', '"./after.js"');
    expect(after).not.toBe(before);
    expect(summarizeApiDiff(before, after)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("lists the existing adapter declaration changed between the real release tags", (context) => {
    const repository = resolve("."), since = "openlup-core-v0.39.0", target = "openlup-core-v0.40.0";
    const tags = execFileSync("git", ["tag", "--list", since, target], { cwd: repository, encoding: "utf8" }).split("\n");
    for (const tag of [since, target]) if (!tags.includes(tag)) context.skip(`Real release comparison requires the missing local tag ${tag}`);
    const root = mkdtempSync(join(tmpdir(), "release-docs-tags-"));
    execFileSync("git", ["worktree", "add", "--detach", root, target], { cwd: repository, stdio: "pipe" });
    try {
      const { text } = assembleUpgradePage({ root, version: "0.40.0", since, fragments: [] });
      const section = text.split("### `packages/platform/api/communications-klaviyo.api.md`\n")[1]!.split("\n### ")[0]!;
      const changed = section.split("Changed declarations:\n")[1];
      expect(changed).toContain("```ts nocheck\n// API report diff: not compiled.\n");
      expect(changed).toContain("\nexport declare function createKlaviyoMarketingAdapter(input: Configuration): MarketingSyncProvider & MarketingAutomationProviderPort & {\n");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", root], { cwd: repository, stdio: "pipe" });
    }
  }, 30_000);

  it("keeps publication refusals for invalid version paths, modes and upgrade-page contents", () => {
    for (const path of ["upgrade/0.5.0.md", "upgrade/00.5.0.md", "upgrade/0.5.md", "upgrade/0.5.0-rc.1.md", "reference/0.5.0.md", "Upgrade/0.5.0.md", "upgrade/nested/0.5.0.md"]) {
      expect(() => validateGuidePage(`packages/core/docs/guide/${path}`, "# Upgrade\n", "100644")).toThrow(/guide pages must/u);
    }
    for (const mode of ["100755", "120000"]) expect(() => validateGuidePage(upgradePagePath("0.5.0"), "# Upgrade\n", mode)).toThrow(/guide pages must/u);
    for (const source of ["", "bad\0bytes", "<<<<<<< conflict\n"]) expect(() => validateGuidePage(upgradePagePath("0.5.0"), source, "100644")).toThrow(/empty or malformed|conflict markers/u);
  });
});
