import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UPGRADE_PAGE_MAX_BYTES, assembleUpgradePage, assertReleaseNotePackagedContent, assertSimulatedUpgradePage, formatReleaseDocumentation, listReleaseDocumentation, previousCoreTag, renderUpgradePage, summarizeApiDiff, upgradePagePath } from "./release-docs-pass.ts";
import { addReleaseSection } from "./release-bump.ts";
import { isGuidePage, validateGuidePage } from "../oss-publication-policy.ts";
// eslint-disable-next-line no-restricted-imports -- witness Core's installed docs:check path on the same rendered fixture
import { assertDocumentationContract } from "../../packages/core/scripts/documentation-contract.ts";

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
  write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "0.4.0" }));
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
  it("uses publishable fragments in bump order, summarizes additions, and lists removed and changed exports", () => {
    const f = fixture();
    f.write("packages/core/docs/guide/upgrade/README.md", "# Upgrade procedure\n");
    f.write(api, report([
      "// Updated comment",
      "export declare const nextName: string;",
      "export type NextValue = number;",
      "export declare function createValue(): NextValue;",
      "export declare const kept: number;",
      "",
    ].join("\n"))); f.commit();
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
    expect(result.text.slice(result.text.indexOf("## API changes"))).toBe([
      "## API changes",
      `### \`${api}\``,
      `Added declarations: 3; see \`${api}\`.`,
      "Removed declarations:",
      "```ts nocheck\n// API report diff: not compiled.\nexport declare const oldName: string;\n```",
      "Changed declarations:",
      "```ts nocheck\n// API report diff: not compiled.\nexport declare const kept: number;\n```\n",
    ].join("\n\n"));
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
    const outbox = "packages/outbox/api/outbox.api.md";
    const f = fixture(); f.git("rm", api); f.write(outbox, report("export declare const send: () => void;\n")); f.commit();
    const { text } = assembleUpgradePage({ root: f.root, version: "0.5.0", since: "openlup-core-v0.4.0", fragments: [] });
    expect(text).toContain(`### \`${api}\``); expect(text).toContain("export declare const oldName");
    expect(text).toContain(`### \`${outbox}\`\n\nAdded declarations: 1; see \`${outbox}\`.`);
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
    expect(text).toContain(rename ? emptyDeclarations : `### \`${peer}\`\n\nAdded declarations: 1; see \`${peer}\`.`);
    expect(text).not.toContain("export declare const shared: string;");
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
    const gates = "packages/core/release-gates.json", stale = "packages/core/api/z-stale.api.md";
    const peerSurface = { "./peer": { snapshot: "api/peer.api.md" } };
    const f = fixture({ [api]: first, [gates]: JSON.stringify({ packageSurface: { ".": { snapshot: "api/core.api.md" }, ...peerSurface } }) });
    f.write(peer, declarationFile("shared", "export type Value = number;\n")); f.commit();
    const assemble = () => assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] });
    expect(assemble).toThrow(
      `packages/core: ${api} and ${peer} have conflicting bodies for dist/shared.d.ts at HEAD; regenerate the API snapshots: run \`npm run api:update -w packages/core\`, commit the snapshot changes, then rerun release:bump.`,
    );
    f.write(gates, JSON.stringify({ packageSurface: peerSurface }));
    f.write(stale, first); f.commit();
    expect(assemble).toThrow(
      `packages/core: ${api} and ${peer} and ${stale} have conflicting bodies for dist/shared.d.ts at HEAD; ` +
      `${api} is not a configured snapshot of @openlup/core: delete it, run \`npm run api:update -w packages/core\`, commit the snapshot changes, then rerun release:bump. ` +
      `${stale} is not a configured snapshot of @openlup/core: delete it, run \`npm run api:update -w packages/core\`, commit the snapshot changes, then rerun release:bump.`,
    );
  });

  it("refuses indistinguishable added rows before reporting their count", () => {
    const f = fixture({ [api]: report("") });
    f.write(api, declarationFile("shared", "export interface Item { value: string; }\n".repeat(2))); f.commit();
    expect(() => assembleUpgradePage({ root: f.root, version: "0.5.0", since: previousCoreTag(f.root), fragments: [] })).toThrow(
      `packages/core: indistinguishable declaration rows in ${api} for dist/shared.d.ts; regenerate the API snapshots: run \`npm run api:update -w packages/core\`, commit the snapshot changes, then rerun release:bump.`,
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

describe("shift-left simulated upgrade-page audit", () => {
  const providerName = ["st", "ri", "pe"].join("");
  const allowlistedSubpath = `\`@openlup/platform/payments/${providerName}\``;

  it("names the source fragment when a link fails the rendered guide contract", () => {
    const f = fixture();
    const fragment = "packages/core/changes/upgrade-link.md";
    f.write(fragment, "- See the [upgrade guide](../how-to/missing.md).\n");
    f.commit();

    expect(() => assertSimulatedUpgradePage(f.root)).toThrow(
      /packages\/core\/changes\/upgrade-link\.md: dangling local link \.\.\/how-to\/missing\.md/u,
    );

    f.write(fragment, "- See the [upgrade guide](../how-to/change.md).\n");
    expect(() => assertSimulatedUpgradePage(f.root)).not.toThrow();

    f.write(fragment, "- Follow milestone M19.\n");
    expect(() => assertSimulatedUpgradePage(f.root)).toThrow(
      /packages\/core\/changes\/upgrade-link\.md: repository-internal language \(task or milestone ID\): M19/u,
    );
  });

  const fixtureFragment = "packages/outbox/changes/guide.md";
  const fixturePage = "docs/guide/upgrade/v0-5-0.md";
  const fixtureTag = "openlup-core-v0.5.0";
  const guideReadme = "packages/core/docs/guide/README.md";
  const guideAsset = "docs/guide/how-to/extend/catalogue.json";
  const packedFixtureFiles = [fixturePage, "docs/guide/how-to/change.md", "docs/guide/README.md", guideAsset, "AGENTS.md"];

  function checkRenderedFixture(f: ReturnType<typeof fixture>, contents: string): string {
    const sample = "export const example = true;\n";
    f.write("packages/core/package.json", JSON.stringify({
      name: "@openlup/core", version: "0.5.0", files: packedFixtureFiles,
    }));
    f.write(guide, "# Change\n");
    f.write("packages/core/release-gates.json", '{"kind":"kernel"}');
    f.write("packages/core/.gitignore", "/coverage/\n/dist/\n/node_modules/\n/release/\n");
    f.write("packages/core/CHANGELOG.md", "## Unreleased\n");
    f.write("packages/core/README.md", "# Core\n\n```ts\n" + sample + "```\n\n## Package Surface Maturity\n\n");
    f.write("packages/core/AGENTS.md", [
      "# Agents", "## Purpose and kind", "Kind: `kernel`.", "## Subpath maturity", " ",
      "## Wiring example", "```ts", sample + "```", "## Sources and declarations", "Sources.",
      "## Readiness codes", "None.", "## Using this package in an application", "See the guide.", "",
    ].join("\n"));
    f.write("packages/core/smoke/readmeExample.ts", sample);
    f.write("packages/core/smoke/agentsWiringExample.ts", sample);
    const rendered = renderUpgradePage({
      root: f.root, version: "0.5.0", since: "openlup-core-v0.4.0",
      fragments: [{ path: fixtureFragment, contents }],
    });
    f.write(`packages/core/${fixturePage}`, rendered);
    assertDocumentationContract(join(f.root, "packages/core"));
    return rendered;
  }

  function parityFixture(contents: string) {
    const f = fixture();
    f.write("packages/core/package.json", JSON.stringify({
      name: "@openlup/core", version: "0.4.0", files: packedFixtureFiles,
    }));
    mkdirSync(join(f.root, "packages/core/docs/guide/upgrade"), { recursive: true });
    f.write("packages/core/docs/guide/how-to/checkout-only.md", "# Checkout only\n");
    f.write(fixtureFragment, contents);
    return f;
  }

  it.each([
    { source: "../how-to/checkout-only.md" },
    { source: "../how-to/" },
    { source: "./" },
  ])("rejects an unpacked local target $source on both paths", ({ source }) => {
    const contents = `- See the [guide](${source}).\n`;
    const f = parityFixture(contents);
    const diagnostic = `local link ${source} targets a file missing from npm pack`;
    // Run the audit before writing the page and bumping the fixture manifest.
    expect(() => assertSimulatedUpgradePage(f.root)).toThrow(`${fixtureFragment}: ${diagnostic}`);
    expect(() => checkRenderedFixture(f, contents)).toThrow(`${fixturePage}: ${diagnostic}`);
  });

  it.each([
    { contents: "<!-- generated:not-a-region -->\n<!-- /generated:not-a-region -->\n", docs: "unknown generated region not-a-region", audit: "generated regions are forbidden in upgrade pages" },
    { contents: "- Run `npm run ug143-reviewer-missing-script`.\n", docs: "unknown npm script ug143-reviewer-missing-script" },
    { contents: "```ts nocheck\nconst value = 1;\n```\n", docs: "a ts nocheck fence must open with a // reason line" },
  ])("shares the page diagnostic for $docs", ({ contents, docs, audit = docs }) => {
    const f = parityFixture(contents);
    const auditError = () => assertSimulatedUpgradePage(f.root);
    expect(auditError).toThrow(fixtureFragment);
    expect(auditError).toThrow(audit);
    if (audit !== docs) expect(auditError).toThrow(`Fix: remove the generated-region marker and its matching closer from ${fixtureFragment}`);
    const docsError = () => checkRenderedFixture(f, contents);
    expect(docsError).toThrow(fixturePage);
    expect(docsError).toThrow(docs);
  });

  it("refuses a known generated-region marker without rendering it", () => {
    const f = parityFixture("<!-- generated:maturity:core -->\n<!-- /generated:maturity:core -->\n");
    expect(() => assertSimulatedUpgradePage(f.root)).toThrow(`${fixtureFragment}: generated regions are forbidden in upgrade pages`);
  });

  it("accepts a guide link to a packed file on both paths", () => {
    const contents = "- See the [guide](../how-to/change.md).\n";
    const f = parityFixture(contents);
    expect(() => assertSimulatedUpgradePage(f.root)).not.toThrow();
    expect(() => checkRenderedFixture(f, contents)).not.toThrow();
  });

  function linkFixture(contents: string, rootReadme = false) {
    const f = parityFixture(contents);
    f.write(guideReadme, "# Reader guide\n\nGuide-specific instructions.\n");
    f.write(`packages/core/${guideAsset}`, "{}\n");
    f.write("docs/platform/API.md", "# API reference\n\n## API\n\n## API_\n");
    if (rootReadme) f.write("README.md", "# Repository home\n\nRepository overview.\n");
    return f;
  }

  function emittedFixes(f: ReturnType<typeof fixture>): string[] {
    let message = "";
    try { assertSimulatedUpgradePage(f.root); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Observed:");
    return message.match(/^Fix: .+$/gm) ?? [];
  }

  function emittedFix(f: ReturnType<typeof fixture>): string {
    const fixes = emittedFixes(f);
    expect(fixes).toHaveLength(1);
    return fixes[0]!;
  }

  function linkFromAdvice(fix: string, target: string): string {
    const template = fix.match(/`(https:[^`]+\/<repository-relative-path>)`/)?.[1];
    expect(template).toBe(`https://github.com/openlup/openlup/blob/${fixtureTag}/<repository-relative-path>`);
    expect(fix).toContain("keep any section anchor");
    return template!.replace("<repository-relative-path>", target);
  }

  function useGuideTitle(fix: string, f: ReturnType<typeof fixture>, contents: string, url: string): string {
    expect(fix).toContain("use the guide page title in plain text, without a link");
    const title = readFileSync(join(f.root, guideReadme), "utf8").match(/^# (.+)$/m)?.[1];
    expect(title).toBeDefined();
    return contents.replace(`[Guide](${url})`, title!);
  }

  function checkLinkOutcome(contents: string, rootReadme = false): string {
    const { text } = assertSimulatedUpgradePage(linkFixture(contents, rootReadme).root)!;
    expect(checkRenderedFixture(linkFixture(contents, rootReadme), contents)).toBe(text);
    return text;
  }

  function expectUnpinnedFix(fix: string, url: string): void {
    expect(fix).toContain(fixtureFragment);
    expect(fix).toContain(`\`${url}\``);
    expect(fix).toContain("If the intended destination is an existing file other than a guide Markdown page");
    expect(fix).toContain("If the intended destination is a guide Markdown page, use the guide page title in plain text, without a link");
    expect(fix).toMatch(/Then rerun `npm run preflight -- --fast`\.?$/);
  }

  it.each(["main", "release-preview", "openlup-core-vpreview", "feature/documentation"])("offers both fragment forms for an unpinned link under %s", (ref) => {
    const url = `https://github.com/openlup/openlup/blob/${ref}/docs/platform/API.md`;
    const contents = `- See [Guide](${url}).\n`;
    const f = linkFixture(contents);
    const fix = emittedFix(f);
    expectUnpinnedFix(fix, url);
    linkFromAdvice(fix, "docs/platform/API.md");
    expect(() => assertSimulatedUpgradePage(f.root)).not.toThrow("docs:check -- --write");
    expect(() => checkRenderedFixture(linkFixture(contents), contents)).toThrow(`${fixturePage}: repository link ${url} must pin ${fixtureTag}; run docs:check -- --write`);
  });

  const collisionUrl = `https://github.com/openlup/openlup/blob/main/${guideReadme}`;
  const collisionFragment = `- See [Guide](${collisionUrl}).\n`;

  it("keeps the README advice independent of a root README collision", () => {
    const fix = emittedFix(linkFixture(collisionFragment, true));
    expectUnpinnedFix(fix, collisionUrl);
    expect(fix.replace(`\`${collisionUrl}\``, "")).not.toMatch(/main\/packages\/core\/docs\/guide|README\.md/);
    expect(emittedFix(linkFixture(collisionFragment))).toBe(fix);
  });

  it.each([true, false])("applies both README fixes with root README present = %s", (rootReadme) => {
    const f = linkFixture(collisionFragment, rootReadme);
    const fix = emittedFix(f);
    const plain = useGuideTitle(fix, f, collisionFragment, collisionUrl);
    expect(checkLinkOutcome(plain, rootReadme)).toContain("- See Reader guide.");
    const destination = linkFromAdvice(fix, "docs/platform/API.md#api");
    const linked = collisionFragment.replace(collisionUrl, destination);
    const changelog = addReleaseSection("packages/outbox/CHANGELOG.md", "## [Unreleased]\n\n", "0.5.0", "openlup-outbox-v0.5.0",
      [{ path: fixtureFragment, contents: linked }]);
    const expected = `[Guide](https://github.com/openlup/openlup/blob/${fixtureTag}/docs/platform/API.md#api)`;
    expect(checkLinkOutcome(linked, rootReadme)).toContain(expected);
    expect(changelog).toContain(expected);
  });

  it("repairs both the ref and the missing target behind it", () => {
    const url = "https://github.com/openlup/openlup/blob/feature/documentation/docs/platform/absent.md";
    const original = `- See [Guide](${url}).\n`;
    const fix = emittedFix(linkFixture(original));
    expectUnpinnedFix(fix, url);
    const target = "docs/platform/API.md#api";
    const pathOnly = original.replace("docs/platform/absent.md", target);
    expect(() => assertSimulatedUpgradePage(linkFixture(pathOnly).root)).toThrow(`must pin ${fixtureTag}`);
    expect(() => checkRenderedFixture(linkFixture(pathOnly), pathOnly)).toThrow(`must pin ${fixtureTag}; run docs:check -- --write`);
    const linked = original.replace(url, linkFromAdvice(fix, target));
    expect(checkLinkOutcome(linked)).toContain(`[Guide](https://github.com/openlup/openlup/blob/${fixtureTag}/${target})`);
  });

  it("pins a guide asset at the destination offered by the audit", () => {
    const target = `packages/core/${guideAsset}`;
    const url = `https://github.com/openlup/openlup/blob/main/${target}`;
    const contents = `- See [catalogue](${url}).\n`;
    const fix = emittedFix(linkFixture(contents));
    expectUnpinnedFix(fix, url);
    expect(fix).toContain("including non-Markdown assets inside the guide");
    const edited = contents.replace(url, linkFromAdvice(fix, target));
    expect(checkLinkOutcome(edited)).toContain(`[catalogue](https://github.com/openlup/openlup/blob/${fixtureTag}/${target})`);
  });

  it("quotes an explicit URL once and keeps its full anchor when applying the Fix", () => {
    const target = "docs/platform/API.md#api_";
    const url = `https://github.com/openlup/openlup/blob/main/${target}`;
    const contents = `- See [API](${url}).\n`;
    const fix = emittedFix(linkFixture(contents));
    expectUnpinnedFix(fix, url);
    const edited = contents.replace(url, linkFromAdvice(fix, target));
    expect(checkLinkOutcome(edited)).toContain(`[API](https://github.com/openlup/openlup/blob/${fixtureTag}/${target})`);
  });

  it("keeps distinct bare and explicit URL fixes even when their anchors differ only by a trailing underscore", () => {
    const bare = "https://github.com/openlup/openlup/blob/main/docs/platform/API.md#api";
    const explicit = bare + "_";
    const contents = `- See ${bare}.\n- See [API](${explicit}).\n`;
    const fixes = emittedFixes(linkFixture(contents));
    expect(fixes).toHaveLength(2);
    let edited = contents;
    for (const [url, anchor] of [[bare, "#api"], [explicit, "#api_"]] as const) {
      const fix = fixes.find((fix) => fix.includes(`\`${url}\``))!;
      expect(fix).toBeDefined();
      edited = edited.replace(url, linkFromAdvice(fix, `docs/platform/API.md${anchor}`));
    }
    const rendered = checkLinkOutcome(edited);
    expect(rendered).toContain(`/blob/${fixtureTag}/docs/platform/API.md#api.\n`);
    expect(rendered).toContain(`[API](https://github.com/openlup/openlup/blob/${fixtureTag}/docs/platform/API.md#api_)`);
  });

  it("directs a fragment's already-pinned guide link to a plain-text title", () => {
    const url = `https://github.com/openlup/openlup/blob/${fixtureTag}/${guideReadme}`;
    const original = `- See [Guide](${url}).\n`;
    const f = linkFixture(original);
    const fix = emittedFix(f);
    expect(fix).toContain(fixtureFragment);
    expect(fix).not.toContain("relative guide link");
    expect(checkLinkOutcome(useGuideTitle(fix, f, original, url))).toContain("- See Reader guide.");
  });

  it("keeps target-path advice for a pinned missing file", () => {
    const contents = `- See [API](https://github.com/openlup/openlup/blob/${fixtureTag}/docs/platform/absent.md).\n`;
    expect(emittedFix(linkFixture(contents))).toContain(`correct the repository link's target path in ${fixtureFragment}`);
  });

  it.each([
    {
      mode: "simulated",
      version: "0.4.0",
      fix: "include the linked file in the Core npm packlist by correcting `files` in packages/core/package.json, or correct the link emitted by scripts/packages/release-docs-pass.ts",
    },
    {
      mode: "prepared",
      version: "0.5.0",
      fix: `correct the reported guide content in packages/core/${fixturePage}`,
    },
  ])("points an unpacked upgrade procedure link at the correct $mode input", ({ mode, version, fix }) => {
    const f = fixture();
    f.write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version, files: [fixturePage] }));
    f.write("packages/core/docs/guide/upgrade/README.md", "# Upgrade procedure\n");
    if (mode === "prepared") f.write(`packages/core/${fixturePage}`, "# Upgrading\n\n[Upgrade procedure](README.md)\n");
    const audit = () => assertSimulatedUpgradePage(f.root);
    expect(audit).toThrow(`${fixturePage}: local link README.md targets a file missing from npm pack`);
    expect(audit).toThrow(`Fix: ${fix}\nRecheck: npm run preflight -- --fast`);
  });

  it.each([
    { name: "missing", source: undefined },
    { name: "invalid schema", source: '{"schemaVersion":2,"terms":[]}' },
    { name: "invalid JSON", source: "{" },
  ])("points the $name reader-language allow-list at its own input", ({ source }) => {
    const f = fixture();
    const path = "config/documentation-guide-allowlist.json";
    if (source === undefined) rmSync(join(f.root, path));
    else f.write(path, source);
    expect(() => assertSimulatedUpgradePage(f.root)).toThrow(`Fix: correct ${path}\nRecheck: npm run preflight -- --fast`);
  });

  it("exposes a 128 KiB default byte cap and accepts a valid simulated upgrade page without writing files", () => {
    expect(UPGRADE_PAGE_MAX_BYTES).toBe(128 * 1024);
    const f = fixture();
    f.write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "0.4.0" }));
    f.write("packages/core/changes/allowlisted.md", `- Documented ${allowlistedSubpath} contract update.\n`);
    f.write(api, report("export declare const nextName: string;\nexport declare const kept: string;\n"));
    f.commit();

    const audit = assertSimulatedUpgradePage(f.root);
    expect(audit).not.toBeNull();
    expect(audit).toMatchObject({
      version: "0.5.0",
      since: "openlup-core-v0.4.0",
      path: "packages/core/docs/guide/upgrade/v0-5-0.md",
      maxBytes: UPGRADE_PAGE_MAX_BYTES,
      prepared: false,
    });
    expect(audit!.bytes).toBe(Buffer.byteLength(audit!.text, "utf8"));
    expect(audit!.text).toContain(allowlistedSubpath);
    expect(audit!.text).toBe(renderUpgradePage({
      root: f.root,
      version: "0.5.0",
      since: "openlup-core-v0.4.0",
      fragments: [{ path: "packages/core/changes/allowlisted.md", contents: `- Documented ${allowlistedSubpath} contract update.\n` }],
    }));

    // Untracked scratch files in changes/ are ignored when trackedPaths is supplied.
    f.write("packages/core/changes/.DS_Store", "junk\0bytes");
    const tracked = f.git("ls-files", "-z").split("\0").filter(Boolean);
    expect(assertSimulatedUpgradePage(f.root, { trackedPaths: tracked })?.text).toBe(audit!.text);
    rmSync(join(f.root, "packages/core/changes/.DS_Store"));
    expect(f.git("status", "--porcelain")).toBe("");
  });

  it("refuses a simulated upgrade page exceeding the byte cap with actual bytes and limit", () => {
    const f = fixture();
    f.write("packages/core/changes/huge.md", `- ${"x".repeat(2048)}\n`);
    f.commit();
    expect(() => assertSimulatedUpgradePage(f.root, { maxBytes: 512 })).toThrow(
      /simulated upgrade page packages\/core\/docs\/guide\/upgrade\/v0-5-0\.md \(in-memory since openlup-core-v0\.4\.0\) is \d+ bytes, exceeding the 512-byte cap/u,
    );
  });

  it("admits an exact addition summary for an approved adapter report", () => {
    const f = fixture();
    const adapterReport = `packages/platform/api/tax-${providerName}.api.md`;
    const summary = `Added declarations: 1; see \`${adapterReport}\`.`;
    f.write(adapterReport, report("export declare const factory: unknown;\n"));
    f.commit();

    const audit = assertSimulatedUpgradePage(f.root)!;
    expect(audit.text).toContain(summary);
    expect(() => assertReleaseNotePackagedContent(audit.path, `See \`${adapterReport}\`.`)).toThrow(/downstream provider dependency/u);
  });

  it("refuses forbidden packaged content in fragments and API diffs with section attribution and concrete remedy", () => {
    expect(() => assertReleaseNotePackagedContent("packages/core/changes/ok.md", `- Uses ${allowlistedSubpath}.\n`)).not.toThrow();
    expect(() => assertReleaseNotePackagedContent("packages/core/changes/bad.md", `- Mentions bare ${providerName}.\n`)).toThrow(
      /downstream provider dependency/u,
    );

    const f = fixture();
    f.write("packages/core/changes/leak.md", `- Mentions bare ${providerName} outside inline subpath code.\n`);
    f.commit();
    let fragmentError = "";
    try { assertSimulatedUpgradePage(f.root); } catch (error) { fragmentError = (error as Error).message; }
    expect(fragmentError).toContain("simulated upgrade page packages/core/docs/guide/upgrade/v0-5-0.md (in-memory since openlup-core-v0.4.0)");
    expect(fragmentError).toContain("downstream provider dependency");
    expect(fragmentError).toContain("offending fragment(s): packages/core/changes/leak.md");
    expect(fragmentError).toContain("offending section(s): ## @openlup/core");
    expect(fragmentError).toContain("Fix: wrap approved adapter subpaths in inline code");

    f.git("rm", "packages/core/changes/leak.md");
    f.write(api, report(`export declare const kept: "${providerName}";\n`));
    f.commit();
    let apiError = "";
    try { assertSimulatedUpgradePage(f.root); } catch (error) { apiError = (error as Error).message; }
    expect(apiError).toContain("simulated upgrade page packages/core/docs/guide/upgrade/v0-5-0.md (in-memory since openlup-core-v0.4.0)");
    expect(apiError).toContain("downstream provider dependency");
    expect(apiError).toContain(`offending section(s): ### \`${api}\``);
    expect(apiError).toContain("Fix: wrap approved adapter subpaths in inline code");
  });

  it("audits the prepared upgrade page on disk for release-prep PRs whose manifest is already bumped above the tag", () => {
    const f = fixture();
    f.write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "1.3.0" }));
    f.commit();
    f.git("tag", "openlup-core-v1.3.0");
    f.write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "1.4.0" }));
    const fragment = "packages/core/changes/upgrade-link.md";
    const previousPin = "https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/docs/platform/API.md";
    f.write(fragment, `- See the [API](${previousPin}).\n`);
    f.commit();

    // Before upgrade/v1-4-0.md exists on disk, simulate 1.4.0 directly (not 1.5.0).
    const prePrepared = assertSimulatedUpgradePage(f.root);
    expect(prePrepared).toMatchObject({
      version: "1.4.0",
      since: "openlup-core-v1.3.0",
      path: "packages/core/docs/guide/upgrade/v1-4-0.md",
      prepared: false,
    });

    // Once release:bump writes upgrade/v1-4-0.md (and consumes fragments), audit the prepared file on disk.
    const preparedPath = "packages/core/docs/guide/upgrade/v1-4-0.md";
    const cleanPrepared = `# Upgrading to 1.4.0\n\n## Highlights\n\n- Updated ${allowlistedSubpath} contract.\n- See the [API](${previousPin.replace("v1.3.0", "v1.4.0")}).\n`;
    f.git("rm", fragment);
    f.write(preparedPath, cleanPrepared);
    f.commit();
    const cleanAudit = assertSimulatedUpgradePage(f.root);
    expect(cleanAudit).toMatchObject({
      version: "1.4.0",
      since: "openlup-core-v1.3.0",
      path: preparedPath,
      bytes: Buffer.byteLength(cleanPrepared, "utf8"),
      prepared: true,
    });

    f.write(preparedPath, cleanPrepared.replace("v1.4.0", "v1.3.0"));
    expect(() => assertSimulatedUpgradePage(f.root)).toThrow(
      /docs\/guide\/upgrade\/v1-4-0\.md: repository link .* must pin openlup-core-v1\.4\.0/u,
    );

    f.write(preparedPath, cleanPrepared + "- See [the guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/change.md).\n");
    expect(emittedFix(f)).toContain(`replace the pinned link into the guide with a relative guide link in ${preparedPath}`);

    // Refuses prepared upgrade page exceeding byte cap.
    f.write(preparedPath, `# Upgrading to 1.4.0\n\n- ${"x".repeat(1024)}\n`);
    expect(() => assertSimulatedUpgradePage(f.root, { maxBytes: 256 })).toThrow(
      /prepared upgrade page packages\/core\/docs\/guide\/upgrade\/v1-4-0\.md \(since openlup-core-v1\.3\.0\) is \d+ bytes, exceeding the 256-byte cap/u,
    );

    // Refuses prepared upgrade page with unmasked vendor text and attributes the offending section.
    f.write(preparedPath, `# Upgrading to 1.4.0\n\n### Highlights\n\n- Mentions bare ${providerName}.\n`);
    let preparedError = "";
    try { assertSimulatedUpgradePage(f.root); } catch (error) { preparedError = (error as Error).message; }
    expect(preparedError).toContain("prepared upgrade page packages/core/docs/guide/upgrade/v1-4-0.md (since openlup-core-v1.3.0)");
    expect(preparedError).toContain("downstream provider dependency");
    expect(preparedError).toContain("offending section(s): ### Highlights");
    expect(preparedError).toContain("Fix: wrap approved adapter subpaths in inline code");
  });

  it("returns null when no ancestor core release tag exists", () => {
    const f = fixture();
    f.git("tag", "-d", "openlup-core-v0.4.0");
    expect(assertSimulatedUpgradePage(f.root)).toBeNull();
  });
});
