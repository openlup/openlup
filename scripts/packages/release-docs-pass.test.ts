import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleUpgradePage, formatReleaseDocumentation, listReleaseDocumentation, previousCoreTag, summarizeApiDiff, upgradePagePath } from "./release-docs-pass.ts";
import { isGuidePage, validateGuidePage } from "../oss-publication-policy.ts";

const report = (source: string) => `# API report\n\n\`\`\`ts\n${source}\`\`\`\n`;
const declarationFile = (name: string, source: string) => `## dist/${name}.d.ts\n\n${report(source)}`;
const emptyDeclarations = "No top-level declarations changed.";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const api = "packages/core/api/core.api.md", peer = "packages/core/api/peer.api.md", catalog = "config/openlup-publication-catalog.json";
const guide = "packages/core/docs/guide/how-to/change.md", routed = "packages/core/docs/guide/reference/api.md";

function fixture(reports = { [api]: report("// API\nexport declare const oldName: string;\nexport declare const kept: string;\n") }) {
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
  for (const [path, source] of Object.entries(reports)) write(path, source);
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
    expect(page.text).not.toContain(emptyDeclarations); expect(page.text).not.toContain("No API reports changed"); expect(page.violations).toEqual([]);
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

  const overload = (type: string) => `export declare function moved(\n    value: ${type},\n): void;`;
  it.each([false, true])("compares moved copies and shows the complete removed overload (removal: %s)", (remove) => {
    const kept = overload("string"), removed = remove ? overload("number") : "";
    const moved = (overloads: string) => declarationFile("moved", overloads);
    const shared = declarationFile("shared", "export declare const shared: string;\n");
    const f = fixture({ [api]: moved(`${kept}\n${removed}\n`) + shared, [peer]: shared });
    f.write(api, report("")); f.write(peer, moved(`${kept}\n`) + shared); f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    if (removed) expect(text).toContain(`### \`${api}\`\n\nRemoved declarations:\n\n\`\`\`ts nocheck\n// API report diff: not compiled.\n${removed}\n`);
    else expect(text).toContain(emptyDeclarations);
    expect(text).not.toContain(kept); expect(text).not.toContain("shared: string"); expect(text).not.toContain(peer);
  });

  it("lists a changed signature once under the bytewise-first new carrier", () => {
    const declaration = (type: string) => declarationFile("core", `export declare const oldName: ${type};\n`);
    const independent = declarationFile("peer", "export declare const oldName: string;\n");
    const f = fixture({ [api]: declaration("string"), [peer]: independent });
    f.write(api, report(""));
    f.write(peer, independent + declaration("number"));
    f.write("packages/core/api/z.api.md", declaration("number"));
    f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(text).toContain(`### \`${peer}\`\n\nChanged declarations:`);
    expect(text.match(/export declare const oldName: number;/gu)).toHaveLength(1);
    expect(text).not.toContain("Removed declarations:");
  });

  it.each([false, true])("names declared subpaths with existing declarations (removal: %s)", (remove) => {
    const gates = "packages/core/release-gates.json";
    const surface = (subpath?: string) => JSON.stringify({ packageSurface: {
      "./peer": { snapshot: "api/peer.api.md" }, ...(subpath ? { [subpath]: { snapshot: "api/core.api.md" } } : {}),
    } });
    const shared = declarationFile("shared", "export declare const shared: string;\n");
    const f = fixture({ [api]: shared, [peer]: shared, [gates]: surface(remove ? "./old" : undefined) });
    f.write(gates, surface("./new")); f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(text).toContain("Added package subpath `./new`.");
    expect(text.includes("Removed package subpath `./old`.")).toBe(remove);
    expect(text).toContain(emptyDeclarations);
    expect(text).not.toContain("shared: string");
  });

  it.each([false, true])("pairs headingless reports through Git (rename: %s)", (rename) => {
    const declaration = report("export declare const shared: string;\n");
    const f = rename ? fixture({ [peer]: "# ./peer API declaration snapshot\n" + declaration }) : fixture({ [api]: declaration, [peer]: report("") });
    if (rename) f.git("mv", peer, "packages/core/api/renamed.api.md"); else f.write(peer, declaration);
    f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(text).toContain(rename ? emptyDeclarations : `### \`${peer}\`\n\nAdded declarations:`);
    expect(text.includes("export declare const shared: string;")).toBe(!rename);
  });

  it("reads all declaration files when report titles repeat", () => {
    const snapshot = (name: string, type: string) => "# ./shared API declaration snapshot\n" + declarationFile(name, `export type ${name} = ${type};\n`);
    const f = fixture({ [api]: snapshot("First", "string"), [peer]: snapshot("Second", "string") });
    f.write(api, snapshot("First", "number")); f.write(peer, snapshot("Second", "boolean")); f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(text).toContain(`### \`${api}\`\n\nChanged declarations:\n\n\`\`\`ts nocheck\n// API report diff: not compiled.\nexport type First = number;`);
    expect(text).toContain(`### \`${peer}\`\n\nChanged declarations:\n\n\`\`\`ts nocheck\n// API report diff: not compiled.\nexport type Second = boolean;`);
  });

  it("places a deletion from a Git-paired headingless rename under the old report", () => {
    const renamed = "packages/core/api/renamed.api.md", removed = "export type Gone = number;\n";
    const kept = "export type PreservedAcrossTheRename = string;\nexport type ASecondDeclarationKeepsGitSimilarityHigh = boolean;\n";
    const f = fixture({ [api]: report(kept + removed) });
    f.git("mv", api, renamed); f.write(renamed, report(kept)); f.commit();
    expect(f.git("diff", "--name-status", "--find-renames", "openlup-core-v0.4.0", "HEAD")).toMatch(/^R\d+/u);
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(text).toContain(`### \`${api}\`\n\nRemoved declarations:`);
    expect(text).toContain(removed);
    expect(text).not.toMatch(/PreservedAcrossTheRename|Added declarations:/u);
  });

  it.each([false, true])("keeps identical declarations in independent files distinct (remove both: %s)", (both) => {
    const declaration = "export type Id = string;", second = declarationFile("second", `${declaration}\n`);
    const f = fixture({ [api]: declarationFile("first", `${declaration}\n`) + second });
    f.write(api, both ? report("") : second); f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(text).toContain("Removed declarations:");
    expect(text.match(/export type Id = string;/gu)).toHaveLength(both ? 2 : 1);
    if (both) {
      expect(text).toContain(`// dist/first.d.ts\n${declaration}`);
      expect(text).toContain(`// dist/second.d.ts\n${declaration}`);
    }
  });

  it("refuses conflicting copies of a declaration file at one revision", () => {
    const first = declarationFile("shared", "export type Value = string;\n");
    const f = fixture({ [api]: first });
    f.write(peer, declarationFile("shared", "export type Value = number;\n")); f.commit();
    expect(() => assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] })).toThrow(
      `packages/core: ${api} and ${peer} have conflicting bodies for dist/shared.d.ts at HEAD; regenerate the API snapshots (npm run api:update) and rerun`,
    );
  });

  it("refuses indistinguishable rows after showing complete declaration blocks", () => {
    const f = fixture({ [api]: report("") });
    f.write(api, declarationFile("shared", "export interface Item { value: string; }\n".repeat(2))); f.commit();
    expect(() => assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] })).toThrow(
      `packages/core: indistinguishable declaration rows in ${api} for dist/shared.d.ts; regenerate the API snapshots (npm run api:update) and rerun`,
    );
  });

  it("lists an interface gaining an optional member as changed and pairs old and new overload signatures", () => {
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
      removed: ["export type Removed = string;", "export declare function overload(value: number): void;", "export { previous };"],
      changed: ["export interface Updated {", "export declare function overload(value: boolean): void;"],
    });
    expect(summarizeApiDiff(before, before)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("retains individual block occurrences", () => {
    const block = "export interface Repeated {\n    field: string;\n}";
    const source = report(`${block}\n`);
    expect(summarizeApiDiff("", source + source)).toEqual({ added: [block, block], removed: [], changed: [] });
    expect(summarizeApiDiff(source + source, "")).toEqual({ added: [], removed: [block, block], changed: [] });
    expect(summarizeApiDiff(source, source + source)).toEqual({ added: [], removed: [], changed: [block] });
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
    const first = name === "Configuration" ? "type Configuration = {" : "type Fact<K extends string, D> = Readonly<{";
    expect(result).toEqual({ added: [], removed: [], changed: [first] });
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
