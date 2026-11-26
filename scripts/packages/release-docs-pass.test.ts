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
    const fragment = "packages/outbox/changes/upgrade-link.md";
    f.write(fragment, "- See the [upgrade guide](../how-to/missing.md).\n");
    f.commit();

    expectFragmentRefusal(f, [`${fragment}: dangling local link ../how-to/missing.md`], fragment);

    f.write(fragment, "- See the [upgrade guide](../how-to/change.md).\n");
    expect(() => assertSimulatedUpgradePage(f.root)).not.toThrow();

    f.write(fragment, "- Follow milestone M19.\n");
    expectFragmentRefusal(f, [`${fragment}: repository-internal language (task or milestone ID): M19`], fragment);
    f.write(fragment, "- Follow the migration.\n");
    expect(assertSimulatedUpgradePage(f.root)?.text).toContain("- Follow the migration.");
  });

  const fixtureFragment = "packages/outbox/changes/guide.md";
  const coreFragment = "packages/core/changes/guide.md";
  const platformFragment = "packages/platform/changes/guide.md";
  const fixturePage = "docs/guide/upgrade/v0-5-0.md";
  const fixtureTag = "openlup-core-v0.5.0";
  const guideReadme = "packages/core/docs/guide/README.md";
  const guideAsset = "docs/guide/how-to/extend/catalogue.json";
  const punctuationFiles = ["docs/guide/how-to/a&b.md", "docs/guide/how-to/rate%.md"];
  const packedFixtureFiles = [
    fixturePage, "docs/guide/how-to/change.md", "docs/guide/README.md", guideAsset, "AGENTS.md", ...punctuationFiles,
  ];

  function checkRenderedFixture(f: ReturnType<typeof fixture>, contents: string, fragment = fixtureFragment): string {
    const sample = "export const example = true;\n";
    const manifest = JSON.parse(readFileSync(join(f.root, "packages/core/package.json"), "utf8"));
    f.write("packages/core/package.json", JSON.stringify({ ...manifest, version: "0.5.0" }));
    f.write(guide, "# Change\n");
    f.write("packages/core/release-gates.json", '{"kind":"kernel"}');
    f.write("packages/core/.gitignore", "/coverage/\n/dist/\n/node_modules/\n/release/\n");
    f.write("packages/core/CHANGELOG.md", addReleaseSection("packages/core/CHANGELOG.md", "## [Unreleased]\n\n", "0.5.0", fixtureTag,
      fragment === coreFragment ? [{ path: fragment, contents }] : []));
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
      fragments: [{ path: fragment, contents }],
    });
    f.write(`packages/core/${fixturePage}`, rendered);
    assertDocumentationContract(join(f.root, "packages/core"));
    return rendered;
  }

  function parityFixture(contents: string, fragment = fixtureFragment) {
    const f = fixture();
    f.write("packages/core/package.json", JSON.stringify({
      name: "@openlup/core", version: "0.4.0", files: packedFixtureFiles, scripts: { check: "node --check fixture.js" },
    }));
    mkdirSync(join(f.root, "packages/core/docs/guide/upgrade"), { recursive: true });
    f.write("packages/core/docs/guide/how-to/checkout-only.md", "# Checkout only\n");
    if (fragment === platformFragment) {
      const path = "config/openlup-packages.json";
      const config = JSON.parse(readFileSync(join(f.root, path), "utf8"));
      config.packages.push({ name: "@openlup/platform", directory: "packages/platform", publish: true });
      f.write(path, JSON.stringify(config));
    }
    f.write(fragment, contents);
    return f;
  }

  it.each(["../how-to/checkout-only.md", "../how-to/", "./"])("attributes an unpacked local target %s", (source) => {
    const contents = `- See the [guide](${source}).\n`;
    const diagnostic = `local link ${source} targets a file missing from npm pack`;
    expectFragmentRefusal(parityFixture(contents), [`${fixtureFragment}: ${diagnostic}`]);
    expect(() => checkRenderedFixture(parityFixture(contents), contents)).toThrow(`${fixturePage}: ${diagnostic}`);
  });

  it("packs the named checkout-only link target and keeps the destination", () => {
    const path = "docs/guide/how-to/checkout-only.md";
    const contents = "- See [Checkout only](../how-to/checkout-only.md).\n";
    const packTarget = () => {
      const f = parityFixture(contents);
      const manifestPath = "packages/core/package.json";
      const manifest = JSON.parse(readFileSync(join(f.root, manifestPath), "utf8"));
      f.write(manifestPath, JSON.stringify({ ...manifest, files: [...manifest.files, path] }));
      return f;
    };
    const diagnostic = "local link ../how-to/checkout-only.md targets a file missing from npm pack";
    expectFragmentRefusal(parityFixture(contents), [`${fixtureFragment}: ${diagnostic}`]);
    const { text } = assertSimulatedUpgradePage(packTarget().root)!;
    expect(checkRenderedFixture(packTarget(), contents)).toBe(text);
    expect(text).toContain(contents.trimEnd());
  });

  it.each([
    { contents: "<!-- generated:not-a-region -->\n<!-- /generated:not-a-region -->\n- Follow the guide.\n",
      docs: "unknown generated region not-a-region", audit: "generated regions are forbidden in upgrade pages", edited: "- Follow the guide.\n" },
    { contents: "- Run `npm run chek`.\n", docs: "unknown npm script chek", edited: "- Run `npm run check`.\n" },
    { contents: "```ts nocheck\nconst value = 1;\n```\n", docs: "a ts nocheck fence must open with a // reason line", line: 2,
      edited: "```ts nocheck\n// reason: Illustrative code.\nconst value = 1;\n```\n" },
  ])("corrects $docs using the Cause", ({ contents, docs, audit = docs, line, edited }) => {
    const label = line ? `${fixtureFragment}:${line}` : fixtureFragment;
    expectFragmentRefusal(parityFixture(contents), [`${label}: ${audit}`]);
    expect(() => checkRenderedFixture(parityFixture(contents), contents)).toThrow(docs);
    expect(checkLinkOutcome(edited)).toContain(edited.trimEnd());
  });

  it("refuses a known generated-region marker without rendering it", () => {
    const f = parityFixture("<!-- generated:maturity:core -->\n<!-- /generated:maturity:core -->\n");
    expectFragmentRefusal(f, [`${fixtureFragment}: generated regions are forbidden in upgrade pages`]);
  });

  it("accepts a guide link to a packed file on both paths", () => {
    const contents = "- See the [guide](../how-to/change.md).\n";
    const f = parityFixture(contents);
    expect(() => assertSimulatedUpgradePage(f.root)).not.toThrow();
    expect(() => checkRenderedFixture(f, contents)).not.toThrow();
  });

  function linkFixture(contents: string, rootReadme = false, fragment = fixtureFragment) {
    const f = parityFixture(contents, fragment);
    f.write(guideReadme, "# Reader guide\n\nGuide-specific instructions.\n");
    f.write(`packages/core/${guideAsset}`, "{}\n");
    for (const path of punctuationFiles) f.write(`packages/core/${path}`, "# Change\n");
    f.write("docs/platform/API.md", "# API reference\n\n## API\n\n## API_\n");
    f.write("docs/platform/DATA_AND_MIGRATIONS.md", "# Data and migrations\n\n## Native activation EXECUTE grants\n");
    if (rootReadme) f.write("README.md", "# Repository home\n\nRepository overview.\n");
    return f;
  }

  function auditRefusal(f: ReturnType<typeof fixture>): string {
    let message = "";
    try { assertSimulatedUpgradePage(f.root); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Observed:");
    return message;
  }

  function emittedFixes(f: ReturnType<typeof fixture>): string[] {
    return auditRefusal(f).match(/^Fix: .+$/gm) ?? [];
  }

  function emittedFix(f: ReturnType<typeof fixture>): string {
    const fixes = emittedFixes(f);
    expect(fixes).toHaveLength(1);
    return fixes[0]!;
  }

  function expectFragmentRefusal(f: ReturnType<typeof fixture>, causes: readonly string[], fragment = fixtureFragment): string {
    const refusal = auditRefusal(f);
    for (const cause of causes) expect(refusal.split("\n")).toContain(cause);
    expect(refusal.match(/^Fix: .+$/gm)).toEqual([`Fix: correct the reported content in ${fragment}`]);
    return refusal;
  }

  function checkLinkOutcome(contents: string, rootReadme = false, fragment = fixtureFragment): string {
    const { text } = assertSimulatedUpgradePage(linkFixture(contents, rootReadme, fragment).root)!;
    expect(checkRenderedFixture(linkFixture(contents, rootReadme, fragment), contents, fragment)).toBe(text);
    return text;
  }

  const blob = "https://github.com/openlup/openlup/blob";
  const apiFile = "docs/platform/API.md";
  const migrationFile = "docs/platform/DATA_AND_MIGRATIONS.md";
  const migrationAnchor = "#native-activation-execute-grants";

  it.each(["main", "release-preview", "openlup-core-vpreview", "feature/documentation"])("follows the missing pin Cause for %s", (ref) => {
    const url = `${blob}/${ref}/${apiFile}`;
    const contents = `- See [Guide](${url}).\n`;
    const cause = `repository link ${url} must pin ${fixtureTag}`;
    const refusal = expectFragmentRefusal(linkFixture(contents), [`${fixtureFragment}: ${cause}`]);
    expect(refusal).not.toContain("docs:check -- --write");
    expect(() => checkRenderedFixture(linkFixture(contents), contents)).toThrow(`${fixturePage}: repository link ${url} must pin ${fixtureTag}; run docs:check -- --write`);
    const tag = refusal.match(/must pin (\S+)$/m)?.[1];
    expect(tag).toBe(fixtureTag);
    expect(checkLinkOutcome(contents.replace(`/blob/${ref}/`, `/blob/${tag}/`))).toContain(`[Guide](${blob}/${fixtureTag}/${apiFile})`);
  });

  it.each([
    { representation: "Markdown", wrap: (url: string) => `[API](${url})` },
    { representation: "HTML image", wrap: (url: string) => `<img src="${url}" alt="API">` },
    { representation: "HTML link", wrap: (url: string) => `<a href="${url}">API</a>` },
  ])("pins a $representation destination without changing its query or anchor", ({ wrap }) => {
    const target = `${apiFile}?a=1&amp;b=2#api_`;
    const original = `- See ${wrap(`${blob}/feature/documentation/${target}`)}.\n`;
    const refusal = expectFragmentRefusal(linkFixture(original), [
      `${fixtureFragment}: repository link ${blob}/feature/documentation/${apiFile} must pin ${fixtureTag}`,
    ]);
    const tag = refusal.match(/must pin (\S+)$/m)?.[1];
    const edited = original.replace("/blob/feature/documentation/", `/blob/${tag}/`);
    const expected = wrap(`${blob}/${fixtureTag}/${target}`);
    expect(checkLinkOutcome(edited)).toContain(expected);
    const changelog = addReleaseSection("packages/outbox/CHANGELOG.md", "## [Unreleased]\n\n", "0.5.0", "openlup-outbox-v0.5.0",
      [{ path: fixtureFragment, contents: edited }]);
    expect(changelog).toContain(expected);
  });

  it.each([
    { defect: "dot segments", original: `${blob}/main/docs/platform/../platform/DATA_AND_MIGRATIONS.md${migrationAnchor}`,
      canonical: `${blob}/main/${migrationFile}${migrationAnchor}`, needsPin: true },
    { defect: "a query apostrophe", original: `${blob}/${fixtureTag}/${migrationFile}?name=owner's${migrationAnchor}`,
      canonical: `${blob}/${fixtureTag}/${migrationFile}?name=owner%27s${migrationAnchor}`, needsPin: false },
  ])("follows the exact canonical spelling for $defect", ({ original, canonical, needsPin }) => {
    const contents = `- See [Data and migrations](${original}).\n`;
    const cause = `non-canonical repository link ${original}; canonical form is ${canonical}`;
    const causes = [`${platformFragment}: ${cause}`];
    if (needsPin) causes.push(`${platformFragment}: repository link ${original.split("#")[0]} must pin ${fixtureTag}`);
    const refusal = expectFragmentRefusal(linkFixture(contents, false, platformFragment), causes, platformFragment);
    expect(() => checkRenderedFixture(linkFixture(contents, false, platformFragment), contents, platformFragment))
      .toThrow(`${fixturePage}: ${cause}`);

    const statedForm = refusal.match(/; canonical form is (\S+)$/m)?.[1];
    expect(statedForm).toBe(canonical);
    const statedPin = refusal.match(/must pin (\S+)$/m)?.[1];
    const editedUrl = needsPin ? statedForm!.replace("/blob/main/", `/blob/${statedPin}/`) : statedForm!;
    const rendered = checkLinkOutcome(contents.replace(original, editedUrl), false, platformFragment);
    const expected = canonical.replace("/blob/main/", `/blob/${fixtureTag}/`);
    expect(rendered).toContain(`[Data and migrations](${expected})`);
    expect(new URL(editedUrl).searchParams.get("name")).toBe(new URL(original).searchParams.get("name"));
    expect(new URL(editedUrl).hash).toBe(migrationAnchor);
  });

  it.each([true, false])("names the pinned guide target with a competing repository README = %s", (rootReadme) => {
    const url = `${blob}/${fixtureTag}/${guideReadme}`;
    const link = `[Guide](${url})`;
    const contents = `- See ${link}.\n`;
    const f = linkFixture(contents, rootReadme);
    expectFragmentRefusal(f, [`${fixtureFragment}: repository link ${url} points into the guide; use a relative link`]);
    // The changelog copies the fragment verbatim, so identify the same guide page by title.
    const title = readFileSync(join(f.root, guideReadme), "utf8").match(/^# (.+)$/m)?.[1];
    expect(title).toBe("Reader guide");
    expect(checkLinkOutcome(contents.replace(link, title!), rootReadme)).toContain("- See Reader guide.");
  });

  it("corrects a missing pinned target and keeps its section", () => {
    const missing = `${blob}/${fixtureTag}/docs/platform/absent.md`;
    const contents = `- See [API reference](${missing}#api_).\n`;
    expectFragmentRefusal(linkFixture(contents), [`${fixtureFragment}: repository link ${missing} targets a path missing from the repository`]);
    expect(() => checkRenderedFixture(linkFixture(contents), contents)).toThrow("targets a path missing from the repository");
    expect(checkLinkOutcome(contents.replace("docs/platform/absent.md", apiFile)))
      .toContain(`[API reference](${blob}/${fixtureTag}/${apiFile}#api_)`);
  });

  it("pins the same repository file for a link that leaves the guide and package", () => {
    const target = `../../../../../${apiFile}#api`;
    const contents = `- See [API](${target}).\n`;
    expectFragmentRefusal(linkFixture(contents), [
      `${fixtureFragment}: link ${target} leaves the guide; use ${blob}/${fixtureTag}/<path>`,
      `${fixtureFragment}: local link escapes package ${target}`,
    ]);
    expect(checkLinkOutcome(contents.replace(target, `${blob}/${fixtureTag}/${apiFile}#api`)))
      .toContain(`[API](${blob}/${fixtureTag}/${apiFile}#api)`);
  });

  it("escapes an authored query ampersand without changing its destination", () => {
    const url = `${blob}/${fixtureTag}/${apiFile}?a=1&b=2#api`;
    const contents = `- See [API](${url}).\n`;
    expectFragmentRefusal(linkFixture(contents), [
      `${fixtureFragment}: link destination ${url} uses a character reference or a bare &; write the characters literally and an ampersand as &amp;`,
    ]);
    expect(checkLinkOutcome(contents.replace("&b=", "&amp;b="))).toContain(`[API](${url.replace("&b=", "&amp;b=")})`);
  });

  it.each([
    { name: "destination boundary", before: "[Change](<../how-to/change.md)", after: "[Change](<../how-to/change.md>)",
      cause: "unsupported Markdown link destination boundary; use a balanced destination or an angle-delimited path" },
    { name: "literal punctuation", before: "[Change](../how-to/a&b.md)", after: "[Change](../how-to/a%26b.md)",
      cause: "unsupported local link destination ../how-to/a&b.md; use literal punctuation or percent encoding, and ASCII title separators" },
    { name: "percent encoding", before: "[Change](../how-to/rate%.md)", after: "[Change](../how-to/rate%25.md)",
      cause: "malformed percent encoding in local link ../how-to/rate%.md" },
  ])("repairs the local link's $name while keeping the target", ({ before, after, cause }) => {
    const contents = `- See ${before}.\n`;
    expectFragmentRefusal(linkFixture(contents), [`${fixtureFragment}: ${cause}`]);
    expect(checkLinkOutcome(contents.replace(before, after))).toContain(`- See ${after}.`);
  });

  it("renders one Core fragment link from both the changelog and the upgrade page", () => {
    const note = "- See [Change](../docs/guide/how-to/change.md).\n";
    expect(checkLinkOutcome(note, false, coreFragment)).toContain("- See [Change](../how-to/change.md).");
  });

  it("reports the Core CHANGELOG command in the first refusal and after a pin-only edit", () => {
    const source = "./" + "veli";
    const original = `- See [API](${blob}/main/${apiFile}?source=${source}#api).\n`;
    const reason = "downstream repository command";
    const cause = `${coreFragment} (Core CHANGELOG.md): ${reason}`;
    const refusal = expectFragmentRefusal(linkFixture(original, false, coreFragment), [
      `${coreFragment}: repository link ${blob}/main/${apiFile} must pin ${fixtureTag}`, cause,
    ], coreFragment);
    const tag = refusal.match(/must pin (\S+)$/m)?.[1];
    const pinned = original.replace("/blob/main/", `/blob/${tag}/`);
    expectFragmentRefusal(linkFixture(pinned, false, coreFragment), [cause], coreFragment);
    expect(() => checkRenderedFixture(linkFixture(pinned, false, coreFragment), pinned, coreFragment)).toThrow(`CHANGELOG.md: ${reason}`);

    const corrected = pinned.replace(source, "guide");
    expect(checkLinkOutcome(corrected, false, coreFragment)).toContain(`/blob/${fixtureTag}/${apiFile}?source=guide#api`);
    expect(checkLinkOutcome("- See API reference.\n", false, coreFragment)).toContain("- See API reference.");
  });

  it.each([
    { link: `[catalogue](${blob}/${fixtureTag}/packages/core/${guideAsset})`,
      cause: "monorepo package path", description: "static JSON sample" },
    { link: "[guide](../how-to/change.md)", cause: "local link escapes package ../how-to/change.md", description: "Change" },
  ])("repairs a Core CHANGELOG fragment with $cause even when the guide accepts it", ({ link, cause, description }) => {
    const original = `- See ${link}.\n`;
    expectFragmentRefusal(linkFixture(original, false, coreFragment), [`${coreFragment} (Core CHANGELOG.md): ${cause}`], coreFragment);
    expect(() => checkRenderedFixture(linkFixture(original, false, coreFragment), original, coreFragment)).toThrow(`CHANGELOG.md: ${cause}`);
    expect(checkLinkOutcome(original.replace(link, description), false, coreFragment)).toContain(`- See ${description}.`);
  });

  it("gives one generic Fix to each of two fragments", () => {
    const first = "- Follow milestone M19.\n";
    const second = "- See [Change](../how-to/typo.md).\n";
    const other = "packages/outbox/changes/other.md";
    const f = linkFixture(first);
    f.write(other, second);
    const refusal = auditRefusal(f);
    expect(refusal.split("\n")).toContain(`${fixtureFragment}: repository-internal language (task or milestone ID): M19`);
    expect(refusal.split("\n")).toContain(`${other}: dangling local link ../how-to/typo.md`);
    expect(refusal.match(/^Fix: .+$/gm)).toEqual([
      `Fix: correct the reported content in ${fixtureFragment}`,
      `Fix: correct the reported content in ${other}`,
    ]);
    f.write(fixtureFragment, first.replace("milestone M19", "the migration"));
    f.write(other, second.replace("typo.md", "change.md"));
    const { text } = assertSimulatedUpgradePage(f.root)!;
    expect(text).toContain("- Follow the migration.");
    expect(text).toContain("[Change](../how-to/change.md)");
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

  it("gives both owners' Fixes for a fragment and generated packlist failure", () => {
    const original = "- Follow milestone M19.\n";
    const procedure = "docs/guide/upgrade/README.md";
    const make = (contents: string, packed: boolean) => {
      const f = parityFixture(contents);
      f.write(`packages/core/${procedure}`, "# Upgrade procedure\n");
      const files = packed ? [...packedFixtureFiles, procedure] : packedFixtureFiles;
      f.write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "0.4.0", files }));
      return f;
    };
    const refusal = auditRefusal(make(original, false));
    expect(refusal).toContain(`${fixturePage}: local link README.md targets a file missing from npm pack`);
    expect(refusal).toContain(`${fixtureFragment}: repository-internal language (task or milestone ID): M19`);
    const fixes = refusal.match(/^Fix: .+$/gm) ?? [];
    expect(fixes).toHaveLength(2);
    expect(fixes[0]).toBe(`Fix: correct the reported content in ${fixtureFragment}`);
    expect(fixes.find((fix) => fix.includes("Core npm packlist"))).toContain("`files` in packages/core/package.json");
    const edited = original.replace("milestone M19", "the migration");
    const audit = assertSimulatedUpgradePage(make(edited, true).root)!;
    expect(checkRenderedFixture(make(edited, true), edited)).toBe(audit.text);
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

  it("exposes a 160 KiB default byte cap and accepts a valid simulated upgrade page without writing files", () => {
    expect(UPGRADE_PAGE_MAX_BYTES).toBe(160 * 1024);
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
