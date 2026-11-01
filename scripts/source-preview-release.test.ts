import { isChangelogFragment } from "./packages/changelog-fragments.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, createPublicPublicationCatalog, packageExecutionDigest } from "./oss-publication-policy.ts";
import { CANONICAL_ACTIVATION_REPOSITORY, CANONICAL_ACTIVATION_SECURITY_ROUTE, assertAdmittedPlatformForward, assertDescendantSourceRelease, assertNoOverdueRemovals, createSourceReleaseContract, deriveSourceReleaseContract, isExpandOnlyPlatformForward, overdueRemovals, removalMarkerLines, removalScanBlobs, splitRemovalScanBatch, type SourceReleaseContractInput } from "./oss-source-release-contract.ts";
import { annotatedTag, assertDraft, assertNextPreview, checkDraft, preparePreview, previewInputs, previousPreview, verifyPublished, type GithubFetch } from "./source-preview-release.ts";
import { MANAGED_ALIGNMENT_FORWARD, readManagedForward } from "./public-reference/subscription-alignment.mjs";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { assertManagedInvoicingStatements, assertPortableCreationStatements, MANAGED_BASELINE, REVIEWED_FORWARD_PATH, readReviewedForwardRegistry, reviewedFunctionDefinitions, reviewedPolicyDefinitions, sqlSha256, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";

const target = "a".repeat(40), previousCommit = "d".repeat(40), tag = "openlup-source-preview/2", oldTag = "openlup-source-preview/1", root = "https://api.github.com/repos/openlup/openlup";
const previousTagObject = "6".repeat(40), targetTagObject = "c".repeat(40);
type Overrides = { releases?: object[]; previous?: Record<string, unknown>; published?: Record<string, unknown>; previousRef?: Record<string, unknown>; previousTag?: Record<string, unknown>; targetRef?: Record<string, unknown> | null; targetTag?: Record<string, unknown> };

/** Models the read-only GitHub API for a published preview/1 and, once tagged, preview/2. */
function github(options: Overrides & { previousTarget?: string; releaseTarget?: string } = {}): GithubFetch {
  const previousTarget = options.previousTarget ?? previousCommit, releaseTarget = options.releaseTarget ?? target;
  return async (input) => {
    const url = String(input);
    const page = /^.*\/releases\?per_page=100&page=([1-9][0-9]*)$/u.exec(url);
    if (page) return Response.json(page[1] === "1" ? options.releases ?? [{ tag_name: oldTag, immutable: true, prerelease: true, draft: false }] : []);
    if (url === `${root}/releases/tags/${encodeURIComponent(oldTag)}`) return Response.json({ tag_name: oldTag, immutable: true, prerelease: true, draft: false, body: "previous note", assets: [], ...options.previous });
    if (url === `${root}/releases/tags/${encodeURIComponent(tag)}` && options.published) return Response.json({ id: 123, tag_name: tag, immutable: true, prerelease: true, draft: false, body: "release note", assets: [], ...options.published });
    if (url === `${root}/git/ref/tags/${encodeURIComponent(oldTag)}`) return Response.json({ ref: `refs/tags/${oldTag}`, object: { type: "tag", sha: previousTagObject }, ...options.previousRef });
    if (url === `${root}/git/tags/${previousTagObject}`) return Response.json({ sha: previousTagObject, tag: oldTag, message: "OpenLup source preview 1.\n", object: { type: "commit", sha: previousTarget }, ...options.previousTag });
    if (url === `${root}/git/ref/tags/${encodeURIComponent(tag)}` && options.targetRef !== undefined && options.targetRef !== null) return Response.json({ ref: `refs/tags/${tag}`, object: { type: "tag", sha: targetTagObject }, ...options.targetRef });
    if (url === `${root}/git/tags/${targetTagObject}`) return Response.json({ sha: targetTagObject, tag, message: "OpenLup source preview 2.\n", object: { type: "commit", sha: releaseTarget }, ...options.targetTag });
    return new Response(null, { status: 404 });
  };
}

describe("source preview workflow preparation", () => {

  it("refuses refs, shell fragments and noncanonical preview numbers while retaining exact note bytes", () => {
    const note = "Reviewed upgrade action.\n\n";
    expect(previewInputs(target, "7", note)).toEqual({ target, number: 7, tag: "openlup-source-preview/7", message: "OpenLup source preview 7.", note });
    for (const value of ["main", "a".repeat(12), "A".repeat(40), `${target}; echo bad`]) expect(() => previewInputs(value, "7", note)).toThrow(/full lowercase/);
    for (const value of ["1", "0", "07", "7.0", "7\n", "9007199254740992"]) expect(() => previewInputs(target, value, note)).toThrow(/preview_number/);
    expect(() => previewInputs(target, "7", " \n")).toThrow(/release_notes/);
  });

  it("reads the previous preview's immutable release and the commit its annotated tag names", async () => {
    await expect(previousPreview(2, undefined, github())).resolves.toEqual({ tag: oldTag, commit: previousCommit });
    await expect(annotatedTag(oldTag, undefined, github())).resolves.toEqual({ commit: previousCommit, message: "OpenLup source preview 1.\n" });
    for (const previous of [{ immutable: false }, { prerelease: false }, { draft: true }, { tag_name: tag }]) await expect(previousPreview(2, undefined, github({ previous }))).rejects.toThrow(/not an immutable published preview/u);
    await expect(previousPreview(2, undefined, github({ previousRef: { object: { type: "commit", sha: previousCommit } } }))).rejects.toThrow(/must be an annotated tag/u);
    await expect(previousPreview(2, undefined, github({ previousRef: { ref: `refs/tags/${oldTag}0` } }))).rejects.toThrow(/must be an annotated tag/u);
    for (const previousTag of [{ tag: tag }, { sha: targetTagObject }, { object: { type: "tree", sha: previousCommit } }, { object: { type: "commit", sha: "D".repeat(40) } }, { message: null }]) await expect(previousPreview(2, undefined, github({ previousTag }))).rejects.toThrow(/annotated tag identity is malformed/u);
    await expect(previousPreview(3, undefined, github())).rejects.toThrow(/HTTP 404/u);
  });

  it("refuses stale ordinals, abandoned drafts, existing tags and API failures", async () => {
    const fetcher = (changes: { draft?: boolean; refStatus?: number; inventoryStatus?: number } = {}): GithubFetch => async (url) => {
      if (url.includes("/releases?")) return Response.json([{ tag_name: "openlup-source-preview/6", immutable: true, prerelease: true, draft: changes.draft ?? false }], { status: changes.inventoryStatus ?? 200 });
      return new Response(null, { status: changes.refStatus ?? 404 });
    };
    await expect(assertNextPreview(7, undefined, fetcher())).resolves.toBeUndefined();
    await expect(assertNextPreview(6, undefined, fetcher())).rejects.toThrow(/newest/);
    await expect(assertNextPreview(8, undefined, fetcher())).rejects.toThrow(/newest/);
    await expect(assertNextPreview(7, undefined, fetcher({ draft: true }))).rejects.toThrow(/unfinished/);
    await expect(assertNextPreview(7, undefined, fetcher({ refStatus: 200 }))).rejects.toThrow(/never retag/);
    await expect(assertNextPreview(7, undefined, fetcher({ refStatus: 403 }))).rejects.toThrow(/unavailable/);
    await expect(assertNextPreview(7, undefined, fetcher({ inventoryStatus: 503 }))).rejects.toThrow(/HTTP 503/);
  });

  // Removal markers are built at run time, so this file carries none of its own.
  const marker = (preview: number | string, prefix = "") => `${prefix}// openlup-remove-before: openlup-source-preview/${preview}\nexport {};\n`;
  function markerRepository(files: Record<string, string | Buffer>) {
    const repo = mkdtempSync(join(tmpdir(), "openlup-removal-markers-")), run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    run(["init", "--quiet"]); run(["config", "user.name", "Release Test"]); run(["config", "user.email", "release@example.com"]);
    for (const [path, contents] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); }
    run(["add", "--all"]); run(["commit", "--quiet", "-m", "markers"]);
    return { repo, run, head: run(["rev-parse", "HEAD"]), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
  }

  it("refuses a preview while a file tracked at the target is marked for removal by it", () => {
    const sample = markerRepository({ "src/shim.ts": marker(9), "src/other.ts": marker(9, "  "), "src/later.ts": marker(10), "NOTES.md": "The re-exports are removed in openlup-source-preview/9.\n" });
    try {
      expect(() => assertNoOverdueRemovals(8, sample.head, sample.repo)).not.toThrow();
      expect(() => assertNoOverdueRemovals(9, sample.head, sample.repo)).toThrow(/^openlup-source-preview\/9 refuses files marked for removal by it: src\/other\.ts, src\/shim\.ts$/u);
      expect(() => assertNoOverdueRemovals(10, sample.head, sample.repo)).toThrow(/^openlup-source-preview\/10 refuses files marked for removal by it: src\/later\.ts, src\/other\.ts, src\/shim\.ts$/u);
      sample.run(["rm", "--quiet", "src/shim.ts", "src/other.ts"]); sample.run(["commit", "--quiet", "-m", "remove"]);
      // Only the target commit's tree counts, not the working tree.
      writeFileSync(join(sample.repo, "src/uncommitted.ts"), marker(2));
      expect(() => assertNoOverdueRemovals(9, sample.run(["rev-parse", "HEAD"]), sample.repo)).not.toThrow();
    } finally { sample.cleanup(); }
  });

  it("counts only whole marker comment lines in code files and refuses a marker line that does not parse", () => {
    const quoted = markerRepository({
      "docs/notes.md": `Each shim carries a removal marker in its header:\n\n${marker(2)}`,
      "docs/example.md": "```ts\n// openlup-remove-before: openlup-source-preview/2\n```\n",
      "src/inline.ts": "export {}; // openlup-remove-before: openlup-source-preview/2\n",
      "src/block.ts": "/* openlup-remove-before: openlup-source-preview/2 */\nexport {};\n",
      "src/prose.ts": "export const text = \"openlup-remove-before: openlup-source-preview/2\";\n",
      "src/beforehand.ts": "// openlup-remove-beforehand: not a removal marker\nexport {};\n",
      "src/launch.ts": "// openlup-remove-before-launch: not a removal marker either\nexport {};\n",
      "src/colonless.ts": "// openlup-remove-before openlup-source-preview/2\nexport {};\n",
    });
    try { expect(() => assertNoOverdueRemovals(9, quoted.head, quoted.repo)).not.toThrow(); } finally { quoted.cleanup(); }
    for (const line of ["//openlup-remove-before: openlup-source-preview/9", "// openlup-remove-before: openlup-source-preview/09", "// openlup-remove-before: openlup-source-preview/9 later", "  // openlup-remove-before: preview 9", "// openlup-remove-before:"]) {
      const malformed = markerRepository({ "src/shim.mts": `${line}\nexport {};\n` });
      try { expect(() => assertNoOverdueRemovals(1, malformed.head, malformed.repo)).toThrow(/^src\/shim\.mts: malformed removal marker: /u); } finally { malformed.cleanup(); }
    }
  });

  it("finds a marker whatever the attributes, git settings, pathspec environment, byte order mark or working directory", () => {
    const sample = markerRepository({
      "src/deep/shim.ts": marker(9),
      "src/view.tsx": marker(9),
      "src/attributed.ts": marker(9),
      ".gitattributes": "src/attributed.ts -diff\n",
      "src/bom.cts": `\uFEFF${marker(9)}`,
      "src/late-nul.js": Buffer.concat([Buffer.from(marker(9)), Buffer.alloc(8000, 0x20), Buffer.from([0])]),
      "assets/early-nul.ts": Buffer.concat([Buffer.from(marker(2)), Buffer.from([0, 1, 2])]),
    });
    const all = /^openlup-source-preview\/9 refuses files marked for removal by it: src\/attributed\.ts, src\/bom\.cts, src\/deep\/shim\.ts, src\/late-nul\.js, src\/view\.tsx$/u;
    try {
      writeFileSync(join(sample.repo, ".git/info/attributes"), "*.ts binary\n*.js binary\n*.cts binary\n");
      writeFileSync(join(sample.repo, "binary-attributes"), "* binary\n"); writeFileSync(join(sample.repo, "opaque-attributes"), "* diff=opaque\n");
      const pathspecEnvironment = ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"].map((name) => ({ [name]: "1" }));
      const gitSettings = [[["grep.lineNumber", "true"], ["grep.column", "true"], ["color.grep", "always"], ["color.ui", "always"], ["core.quotePath", "true"]], [["core.attributesFile", join(sample.repo, "binary-attributes")]], [["core.attributesFile", join(sample.repo, "opaque-attributes")], ["diff.opaque.binary", "true"]]]
        .map((settings) => Object.fromEntries([["GIT_CONFIG_COUNT", String(settings.length)], ...settings.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])]));
      for (const environment of [{}, ...pathspecEnvironment, ...gitSettings]) {
        for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
        expect(() => assertNoOverdueRemovals(8, sample.head, sample.repo)).not.toThrow();
        expect(() => assertNoOverdueRemovals(9, sample.head, sample.repo)).toThrow(all);
        expect(() => assertNoOverdueRemovals(9, sample.head, join(sample.repo, "src/deep"))).toThrow(all);
        vi.unstubAllEnvs();
      }
    } finally { vi.unstubAllEnvs(); sample.cleanup(); }
  });

  it("reads the target's own objects despite replacement refs and an inherited GIT_DIR", () => {
    const sample = markerRepository({ "src/shim.ts": marker(9) }), decoy = markerRepository({ "src/other.ts": "export {};\n" });
    try {
      const markedBlob = sample.run(["rev-parse", "HEAD:src/shim.ts"]);
      const cleanBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: sample.repo, input: "export {};\n", encoding: "utf8" }).trim();
      sample.run(["replace", markedBlob, cleanBlob]);
      expect(sample.run(["cat-file", "blob", markedBlob])).toBe("export {};");
      expect(() => assertNoOverdueRemovals(9, sample.head, sample.repo)).toThrow(/by it: src\/shim\.ts$/u);
      vi.stubEnv("GIT_DIR", join(decoy.repo, ".git")); vi.stubEnv("GIT_WORK_TREE", decoy.repo);
      expect(() => assertNoOverdueRemovals(9, sample.head, sample.repo)).toThrow(/by it: src\/shim\.ts$/u);
    } finally { vi.unstubAllEnvs(); sample.cleanup(); decoy.cleanup(); }
  });

  it("refuses an unknown target and scan output it cannot read", () => {
    const sample = markerRepository({ "src/shim.ts": marker(9) });
    try { expect(() => assertNoOverdueRemovals(8, "f".repeat(40), sample.repo)).toThrow(); } finally { sample.cleanup(); }
    for (const preview of [0, -1, 1.5, Number.NaN]) expect(() => assertNoOverdueRemovals(preview, target)).toThrow(/positive integer preview number/u);
    const blob = "1".repeat(40), other = "2".repeat(40);
    expect(removalScanBlobs(`100644 blob ${blob}\tsrc/shim.ts\x00100755 blob ${other}\tbin/tool.mjs\x00100644 blob ${other}\tREADME.md\x00120000 blob ${other}\tsrc/link.ts\x00160000 commit ${other}\tvendor/module.ts\x00`))
      .toEqual([{ path: "src/shim.ts", oid: blob }, { path: "bin/tool.mjs", oid: other }]);
    for (const listing of [`100644 blob ${blob} src/shim.ts\x00`, `100644 blob ${blob}\tsrc/shim.ts\n`, `100644 file ${blob}\tsrc/shim.ts\x00`, `100644 blob ${blob.slice(1)}\tsrc/shim.ts\x00`, `100644 blob ${blob}\t\x00`]) {
      expect(() => removalScanBlobs(listing), listing).toThrow(/^removal marker scan output is malformed$/u);
    }
    expect(splitRemovalScanBatch(Buffer.from(`${blob} blob 3\nabc\n${other} blob 0\n\n`), [blob, other])).toEqual([Buffer.from("abc"), Buffer.alloc(0)]);
    for (const batch of [`${blob} missing\n`, `${other} blob 3\nabc\n`, `${blob} blob 4\nabc\n`, `${blob} blob 3\nabc\nextra`, `${blob} tree 3\nabc\n`, `${blob} blob 03\nabc\n`]) {
      expect(() => splitRemovalScanBatch(Buffer.from(batch), [blob]), batch).toThrow(/^removal marker scan output is malformed$/u);
    }
    expect(removalMarkerLines(Buffer.from(`\uFEFF${marker(9)}`))).toEqual(["// openlup-remove-before: openlup-source-preview/9"]);
    expect(overdueRemovals(9, [{ path: "src/a.ts", line: "// openlup-remove-before: openlup-source-preview/10" }])).toEqual([]);
    expect(() => overdueRemovals(9, [{ path: "src/a.ts", line: "// openlup-remove-before: soon" }])).toThrow(/^src\/a\.ts: malformed removal marker: /u);
  });

  it("finds no overdue or malformed removal marker in this repository at the current lockstep preview", () => {
    const { version } = JSON.parse(readFileSync(join(process.cwd(), "packages/core/package.json"), "utf8")) as { version: string };
    const [, major, minor] = /^(\d+)\.(\d+)\./u.exec(version) ?? [];
    expect(minor, `packages/core/package.json version ${version} is not a lockstep version`).toBeDefined();
    expect(() => assertNoOverdueRemovals(Number(major) > 0 ? Number.MAX_SAFE_INTEGER : Number(minor), "HEAD", process.cwd())).not.toThrow();
  });

  it("runs the removal scan in prepare, after the ordinal check and before any previous-release read", async () => {
    const fetcher: GithubFetch = async (url) => url.includes("/releases?")
      ? Response.json([{ tag_name: "openlup-source-preview/6", immutable: true, prerelease: true, draft: false }])
      : new Response(null, { status: 404 });
    for (const [preview, expected] of [[7, /^openlup-source-preview\/7 refuses files marked for removal by it: src\/shim\.ts$/u], [8, /source preview API refused \/releases\/tags\//u]] as const) {
      const sample = markerRepository({ "src/shim.ts": marker(preview) }), out = mkdtempSync(join(tmpdir(), "openlup-prepare-out-"));
      try {
        await expect(preparePreview(previewInputs(sample.head, "7", "note"), sample.repo, out, undefined, fetcher)).rejects.toThrow(expected);
        expect(existsSync(join(out, "notes.md"))).toBe(false);
      } finally { sample.cleanup(); rmSync(out, { recursive: true, force: true }); }
    }
  });

  it("checks the exact draft note and refuses any release asset before publication", () => {
    const release = { id: 123, tag_name: tag, draft: true, prerelease: true, body: "release note", assets: [] };
    expect(() => assertDraft(release, 123, tag, "release note")).not.toThrow();
    for (const change of [{ id: 124 }, { id: "123" }, { draft: false }, { prerelease: false }, { tag_name: oldTag }]) expect(() => assertDraft({ ...release, ...change }, 123, tag, "release note")).toThrow(/identity differs/u);
    for (const change of [{ body: "release note\n" }, { body: undefined }]) expect(() => assertDraft({ ...release, ...change }, 123, tag, "release note")).toThrow(/body differs/u);
    for (const change of [{ assets: [{ name: "any-asset.json", digest: `sha256:${"0".repeat(64)}` }] }, { assets: undefined }]) expect(() => assertDraft({ ...release, ...change }, 123, tag, "release note")).toThrow(/must carry no asset/u);
    expect(() => assertDraft(release, 123, tag, "other note")).toThrow(/body differs/u);
  });

  it("reads only the created draft ID and retries temporary invisibility without retrying permanent rejection", async () => {
    const draft = { id: 123, tag_name: tag, draft: true, prerelease: true, body: "release note", assets: [] };
    const lookup = (statuses: number[], release: object = draft) => {
      const paths: string[] = [];
      const fetcher: GithubFetch = async (url) => {
        paths.push(url);
        if (url !== `${root}/releases/123`) throw new Error(`unexpected release lookup: ${url}`);
        const status = statuses.shift() ?? 200;
        return status === 200 ? Response.json(release) : new Response(null, { status });
      };
      return { fetcher, paths };
    };
    const direct = lookup([200]);
    await expect(checkDraft("123", tag, "release note", undefined, direct.fetcher)).resolves.toBeUndefined();
    expect(direct.paths).toEqual([`${root}/releases/123`]);
    vi.useFakeTimers();
    try {
      const delayed = lookup([404, 404, 200]);
      const eventual = expect(checkDraft("123", tag, "release note", undefined, delayed.fetcher)).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await eventual;
      expect(delayed.paths).toEqual(Array(3).fill(`${root}/releases/123`));

      const missing = lookup([404, 404, 404]);
      const exhausted = expect(checkDraft("123", tag, "release note", undefined, missing.fetcher)).rejects.toThrow(/HTTP 404/u);
      await vi.runAllTimersAsync();
      await exhausted;
      expect(missing.paths).toEqual(Array(3).fill(`${root}/releases/123`));
    } finally { vi.useRealTimers(); }

    const denied = lookup([403]);
    await expect(checkDraft("123", tag, "release note", undefined, denied.fetcher)).rejects.toThrow(/HTTP 403/u);
    expect(denied.paths).toEqual([`${root}/releases/123`]);
    for (const invalid of ["", "0", "0123", "123x", "9007199254740992"]) {
      const unused = lookup([200]);
      await expect(checkDraft(invalid, tag, "release note", undefined, unused.fetcher)).rejects.toThrow(/RELEASE_ID/u);
      expect(unused.paths).toEqual([]);
    }
    for (const changed of [{ id: 124 }, { tag_name: oldTag }, { draft: false }, { prerelease: false }, { body: "changed" }, { assets: [{ id: 1 }] }]) {
      const mismatch = lookup([200], { ...draft, ...changed });
      await expect(checkDraft("123", tag, "release note", undefined, mismatch.fetcher)).rejects.toThrow(/identity differs|body differs|no asset/u);
      expect(mismatch.paths).toEqual([`${root}/releases/123`]);
    }
  });

  it("verifies the published immutable release, its exact note and its annotated tag at the target", async () => {
    const input = previewInputs(target, "2", "release note");
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: {}, targetRef: {} }))).resolves.toBeUndefined();
    for (const published of [{ id: 124 }, { immutable: false }, { prerelease: false }, { draft: true }, { tag_name: oldTag }]) await expect(verifyPublished(input, "release note", "123", undefined, github({ published, targetRef: {} }))).rejects.toThrow(/not the created immutable published preview/u);
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: { body: "edited note" }, targetRef: {} }))).rejects.toThrow(/body differs/u);
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: { assets: [{ name: "any-asset.json" }] }, targetRef: {} }))).rejects.toThrow(/no asset/u);
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: {}, targetRef: {}, releaseTarget: "b".repeat(40) }))).rejects.toThrow(/prepared target or message/u);
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: {}, targetRef: {}, targetTag: { message: "OpenLup source preview 2.\n\nExtra text\n" } }))).rejects.toThrow(/prepared target or message/u);
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: {}, targetRef: { object: { type: "commit", sha: target } } }))).rejects.toThrow(/annotated tag/u);
    await expect(verifyPublished(input, "release note", "123", undefined, github({ published: {} }))).rejects.toThrow(/HTTP 404/u);
  });
});


// The descendant check's fixtures are a synthetic public tree built in a temporary Git repository;
// they never read this checkout, so they run unchanged in any clone.
const CATALOG = "config/openlup-publication-catalog.json", CONTRACT = "config/openlup-source-release-contract.json", OWNER = { name: "Owner", email: "owner@openlup.test" };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
// `PUBLIC_PACKAGE_EXECUTION_SURFACES` pins these workspace scripts by digest; the first test names a drift.
const CORE_SCRIPTS = {
  build: "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsc -p tsconfig.build.json",
  "api:check": "node --experimental-strip-types ./scripts/api-contract.ts",
  "api:update": "npm run build && node --experimental-strip-types ./scripts/api-contract.ts --update",
  ci: "npm run test:coverage && npm run typecheck:smoke && npm run api:check && npm run docs:check && npm run release:check && npm run test:consumer",
  "ci:required": "npm run test:coverage && npm run typecheck:smoke && npm run docs:check && npm run release:admission && npm run test:consumer",
  "docs:check": "node --experimental-strip-types ./scripts/documentation-contract.ts",
  prepack: "npm run build",
  prepublishOnly: "node --experimental-strip-types ./scripts/refuse-publish.ts",
  "release:admission": "npm run build && node --experimental-strip-types ./scripts/release-check.ts admission",
  "release:audit": "node --experimental-strip-types ./scripts/release-check.ts audit",
  "release:bundle": "node --experimental-strip-types ./scripts/release-bundle.ts",
  "release:check": "npm run build && node --experimental-strip-types ./scripts/release-check.ts all",
  "release:licenses": "node --experimental-strip-types ./scripts/release-check.ts licenses",
  "release:lock": "node --experimental-strip-types ./scripts/release-check.ts lock",
  "release:pack": "node --experimental-strip-types ./scripts/release-check.ts pack",
  "release:publish-block": "node --experimental-strip-types ./scripts/release-check.ts publish",
  "release:sbom": "node --experimental-strip-types ./scripts/release-check.ts sbom",
  "test:consumer": "node --experimental-strip-types ./scripts/core-package-consumer-smoke.ts",
  "test:coverage": "npm run build && npm run test:runtime-import && vitest run --config vitest.config.ts --coverage && node --experimental-strip-types ./test/assertNoZeroCoverage.ts",
  "test:runtime-import": "node -e \"const p=require('./package.json'); Promise.all(Object.keys(p.exports).map((s)=>import(s==='.'?p.name:p.name+'/'+s.slice(2)))).then((m)=>console.log('core runtime import ok', m.length))\"",
  "test:smoke": "npm run build && npm run test:runtime-import && vitest run --config vitest.config.ts",
  "typecheck:smoke": "tsc -p tsconfig.smoke.json --noEmit",
};
const OUTBOX_SCRIPTS = {
  build: "tsc -p tsconfig.build.json",
  prepack: "npm run build",
  test: "vitest run test",
  prepublishOnly: "node -e \"throw new Error('OUTBOX_DIRECTORY_PUBLISH_REFUSED')\"",
  "api:check": "node --experimental-strip-types ./scripts/api-contract.ts",
  "api:update": "npm run build && node --experimental-strip-types ./scripts/api-contract.ts --update",
  ci: "npm run build && npm run test && npm run api:check",
  "ci:required": "npm run test:consumer",
  "test:consumer": "node --experimental-strip-types ./scripts/consumer-proof.ts",
};
const PLATFORM_SCRIPTS = {
  build: "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsc -p tsconfig.build.json",
  test: "vitest run test",
  ci: "npm run build && npm run test && npm run api:check",
  "api:check": "node --experimental-strip-types ./scripts/api-contract.ts",
  "test:consumer": "node --experimental-strip-types ./scripts/consumer-proof.ts",
  "ci:required": "npm run test:consumer",
  prepack: "npm run build",
  prepublishOnly: "node -e \"throw new Error('PLATFORM_DIRECTORY_PUBLISH_REFUSED')\"",
  "api:update": "npm run build && node --experimental-strip-types ./scripts/api-contract.ts --update",
};
const UI_SCRIPTS = { build: CORE_SCRIPTS.build, typecheck: "tsc -p tsconfig.json --noEmit", "test:neutrality": "node --experimental-strip-types smoke/neutrality.ts" };
const compatibility = (diagnostics: number) => ({ typecheck: { projects: ["tsconfig.synthetic.json"], signedPreviewDebt: { unresolvedEdges: { mode: "exact-ratchet", pairs: 0, importers: 0, targets: 0, digest: "sha256-e3b0c44298fc1c149afbf4c8996fb924", pairHashes: [] }, inferenceCascades: { mode: "ceiling-ratchet", diagnostics } } } });
const SYNTHETIC_TREE: Record<string, string> = {
  "README.md": "public root\n",
  "docs/guide.md": "synthetic guide\n",
  "config/openlup-policy-registry.json": json({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "synthetic-readme", owners: ["README.md"] }] }),
  "config/platform-migration-manifest.json": json({ schemaVersion: 1, baseline: { file: "db/platform/migrations/00000000000000_platform_baseline.sql", sha256: createHash("sha256").update("select 1;\n").digest("hex") }, forward: [], objectInventorySha256: "0".repeat(64) }),
  "db/platform/migrations/00000000000000_platform_baseline.sql": "select 1;\n",
  "src/integrations/supabase/types.ts": "export type SyntheticDatabase = never;\n",
  "package.json": json({ name: "synthetic-root", private: true, scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }),
  "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3 }),
  "packages/core/package.json": json({ name: "synthetic-core", scripts: CORE_SCRIPTS, bin: { "openlup-context": "./src/openlup-context.js" } }),
  "packages/core/package-lock.json": json({ name: "synthetic-core", lockfileVersion: 3 }),
  "packages/outbox/package.json": json({ name: "synthetic-outbox", scripts: OUTBOX_SCRIPTS }),
  "packages/platform/package.json": json({ name: "synthetic-platform", scripts: PLATFORM_SCRIPTS }),
  "packages/ui/package.json": json({ name: "synthetic-ui", scripts: UI_SCRIPTS }),
  [CONTRACT]: createSourceReleaseContract({ ...Object.fromEntries(["inventoryDigest", "classDigest", "packageDigest", "rootLockDigest", "coreLockDigest", "migrationManifestDigest", "databaseTypesDigest", "policyRegistryDigest", "publicationCatalogDigest"].map((name) => [name, `sha256-${"0".repeat(64)}`])) as unknown as SourceReleaseContractInput, compatibility: compatibility(0) as SourceReleaseContractInput["compatibility"] }, { evidenceClass: "activation-candidate", coordinate: CANONICAL_ACTIVATION_REPOSITORY, securityRoute: CANONICAL_ACTIVATION_SECURITY_ROUTE, owner: OWNER }).contents,
};
type TreeChange = Record<string, string | null> | ((repo: string) => void);
type Seal = { regenerate?: boolean; classes?: Record<string, string>; omitFromCatalog?: string[] };

/** A synthetic previous preview as a root commit, plus a helper that commits and checks one descendant. */
function syntheticRelease(options: { extraFiles?: Record<string, string | Buffer>; seed?: { repo: string; rootCommit: string } } = {}) {
  const repo = mkdtempSync(join(realpathSync(tmpdir()), "openlup-descendant-release-"));
  const run = (args: string[]) => execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const read = (path: string) => existsSync(join(repo, path)) ? readFileSync(join(repo, path)) : undefined;
  const apply = (change: TreeChange) => {
    if (typeof change === "function") return change(repo);
    for (const [path, contents] of Object.entries(change)) { if (contents === null) { rmSync(join(repo, path)); continue; } mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); }
  };
  const commit = (message: string, { regenerate = true, classes = {}, omitFromCatalog = [] }: Seal = {}) => {
    run(["add", "--all"]);
    const paths = [...new Set([...run(["ls-files"]).split("\n").filter(Boolean), CATALOG])].filter((path) => !omitFromCatalog.includes(path)).sort();
    writeFileSync(join(repo, CATALOG), createPublicPublicationCatalog(paths.filter((path) => !isChangelogFragment(path)).map((path) => ({ path, class: classes[path] ?? "public-output" })), []).contents);
    if (regenerate) writeFileSync(join(repo, CONTRACT), deriveSourceReleaseContract(read, paths.map((path) => ({ path, mode: lstatSync(join(repo, path)).mode & 0o111 ? "100755" : "100644" }))).contents);
    run(["add", "--all"]); run(["commit", "--quiet", "--allow-empty", "-m", `${message}\n\nSigned-off-by: ${OWNER.name} <${OWNER.email}>`]);
    return run(["rev-parse", "HEAD"]);
  };
  if (options.seed) cpSync(options.seed.repo, repo, { recursive: true });
  else {
    run(["init", "--quiet"]); run(["config", "user.name", OWNER.name]); run(["config", "user.email", OWNER.email]);
    apply({ ...SYNTHETIC_TREE, ...options.extraFiles });
  }
  const rootCommit = options.seed?.rootCommit ?? commit("Initial public source release.");
  /** Commits one change and checks it as the descendant of the synthetic previous preview; returns the commit. */
  const release = (change: TreeChange, seal: Seal = {}) => { apply(change); const head = commit("Public descendant", seal); assertDescendantSourceRelease(repo, rootCommit, head); return head; };
  return { repo, run, read, apply, commit, rootCommit, release, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}
const editContract = (edit: (contract: { compatibility?: unknown; repository: { owner: { name: string } } }) => void) => (repo: string) => { const contract = JSON.parse(readFileSync(join(repo, CONTRACT), "utf8")); edit(contract); writeFileSync(join(repo, CONTRACT), json(contract)); };

describe("exact reviewed replacement admission in both gates", () => {
  // Only the immutable roots are reused; every case owns its complete working tree and .git.
  let ordinarySeed: ReturnType<typeof syntheticRelease> | undefined, runtimeSeed: ReturnType<typeof syntheticRelease> | undefined;
  afterAll(() => { ordinarySeed?.cleanup(); runtimeSeed?.cleanup(); });
  const functions = [
    "public.commerce_offer_policy_v2_readiness()",
    "public.subscription_create_provisional_for_checkout(p_order_id uuid, p_client_id uuid, p_pet_id uuid, p_shipping_address_id uuid, p_quote_snapshot jsonb)",
    "public.subscription_apply_starter_graduation(p_subscription_id uuid, p_idempotency_key text, p_mode text DEFAULT 'full'::text)",
  ];
  const definition = (signature: string, value: number, replace = false) => `CREATE ${replace ? "OR REPLACE " : ""}FUNCTION ${signature} RETURNS jsonb LANGUAGE sql AS $$ SELECT '${value}'::jsonb; $$;`;
  const baseline = functions.map((signature) => definition(signature, 1)).join("\n");
  const paths = ["supabase/migrations/20261001000001_readiness.sql", "supabase/migrations/20261001000002_price_setup.sql", "supabase/migrations/20261001000003_starter.sql"];
  const sql = [definition(functions[0]!, 2, true), definition("public.catalog_price_setup_preview(p_list uuid, p_variant uuid, p_amount integer)", 2) + "\n" + definition("public.catalog_price_setup_apply(p_command text, p_fingerprint text)", 2), functions.slice(1).map((signature) => definition(signature, 2, true)).join("\n")];
  const identityPath = "supabase/migrations/20261018160000_identity_service_role_capabilities.sql";
  const identityPrivileges = ["GRANT INSERT (email, auth_user_id, acquisition_source, lifecycle_stage) ON public.clients TO service_role;", "GRANT UPDATE (auth_user_id) ON public.clients TO service_role;", "GRANT INSERT (id, email, role, membership_state, membership_provenance, membership_accepted_at) ON public.admin_users TO service_role;", "GRANT SELECT (email) ON public.admin_users TO service_role;"];
  const identitySql = `-- Managed identity capabilities. Baseline and prior forwards remain immutable.
-- Exact security admission must precede this forward. Column grants are service-only.

-- Reconcile creation writes exactly these columns; every other column keeps its default.
${identityPrivileges[0]}
-- Reconcile and checkout soft-account links set only a still-unset principal reference.
${identityPrivileges[1]}
-- Operator activation inserts exactly these membership columns; is_machine_actor keeps its false default.
${identityPrivileges[2]}
-- Invitation eligibility and conflict checks read the operator address.
${identityPrivileges[3]}
`;
  const addIdentity = (registry: ReviewedForwardRegistry, bytes: string[]) => {
    bytes[4] = identitySql;
    registry.runtimeForwards!.push({ path: identityPath, sha256: sqlSha256(identitySql), functions: [], privileges: [...identityPrivileges] });
  };
  function fixture(edit?: (registry: ReviewedForwardRegistry, bytes: string[]) => void, history: "baseline" | "forward" | null = null, runtime = false, retirePolicies = false, extraFiles: Record<string, string> = {}) {
    const existing = definition("public.catalog_price_setup_preview(p_list uuid, p_variant uuid, p_amount integer)", 1);
    const runtimeFunctions = ["public.admin_clients_search_v3(p_query text, p_page integer, p_page_size integer, p_stage text)", "public.subscription_list_due_for_renewal(p_limit integer, p_as_of timestamp with time zone DEFAULT now())", "public.customer_support_absorb_lead_v1(p_operator uuid, p_customer uuid, p_lead uuid, p_expected text, p_key text, p_now timestamp with time zone)", "public.marketing_rehome_client_lead_v1(p_client uuid, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)", "public.customer_support_correct_subject_email_v1(p_operator uuid, p_subject uuid, p_expected text, p_new text, p_key text, p_now timestamp with time zone)"];
    const policyTables = ["address_canon_localities", "address_canon_postal_localities", "address_canon_streets", "addresses", "clients", "customer_account_events", "customer_orderer_profiles", "pets"];
    const policySql = retirePolicies ? policyTables.map((table) => `CREATE POLICY admin_all_${table} ON public.${table} TO authenticated USING (true) WITH CHECK (true);`).join("\n") : "";
    const runtimeBaseline = runtime ? runtimeFunctions.map((signature) => definition(signature, 1)).join("\n") + (retirePolicies ? `\n${policySql}` : "") : "";
    const selectedBaseline = (history === "baseline" ? `${baseline}\n${existing}` : baseline) + (runtime ? `\n${runtimeBaseline}` : "");
    const options = { extraFiles: { [MANAGED_BASELINE]: selectedBaseline, ...(history === "forward" ? { "supabase/migrations/20261001000000_existing_function.sql": existing } : {}), ...extraFiles } };
    let sample: ReturnType<typeof syntheticRelease>;
    if (history === null && !retirePolicies && Object.keys(extraFiles).length === 0) {
      const seed = runtime ? runtimeSeed ??= syntheticRelease(options) : ordinarySeed ??= syntheticRelease(options);
      sample = syntheticRelease({ seed });
    } else sample = syntheticRelease(options);
    const prior = reviewedFunctionDefinitions(Buffer.from(`${baseline}\n${runtimeBaseline}`)), bytes = [...sql];
    const forwards = paths.map((path, index) => ({ path, sha256: sqlSha256(bytes[index]!), functions: [...reviewedFunctionDefinitions(Buffer.from(bytes[index]!))].map(([signature, afterSha256]) => ({ signature, afterSha256, beforeSha256: prior.get(signature) ?? null })) }));
    const registry: ReviewedForwardRegistry = { schemaVersion: 1, baselineSha256: sqlSha256(selectedBaseline), replacementForwards: [forwards[0]!, forwards[2]!], creationForwards: [forwards[1]!] };
    const runtimePath = "supabase/migrations/20261001000004_runtime_readers.sql";
    if (runtime) {
      const privilege = "GRANT SELECT (id,membership_state,role) ON public.admin_users TO service_role;";
      bytes.push("-- Managed runtime capabilities. Baseline and prior forwards remain immutable.\n" + runtimeFunctions.map((signature) => definition(signature, 2, true)).join("\n") + `\n${privilege}`);
      registry.runtimeForwards = [{ path: runtimePath, sha256: sqlSha256(bytes[3]!), functions: [...reviewedFunctionDefinitions(Buffer.from(bytes[3]!))].map(([signature, afterSha256]) => ({ signature, afterSha256, beforeSha256: prior.get(signature)! })), privileges: [privilege] }];
    }
    if (retirePolicies) {
      const forward = registry.runtimeForwards![0]!;
      const definitions = reviewedPolicyDefinitions(Buffer.from(policySql));
      forward.retiredPolicies = policyTables.map((table) => ({ table, name: `admin_all_${table}`, beforeSha256: definitions.get(`${table}.admin_all_${table}`)! }));
      bytes[3] = policyTables.map((table) => `DROP POLICY admin_all_${table} ON public.${table};`).join("\n") + `\n${bytes[3]}`;
      forward.sha256 = sqlSha256(bytes[3]!);
    }
    edit?.(registry, bytes);
    sample.apply({ [REVIEWED_FORWARD_PATH]: json(registry) });
    const approval = sample.commit("Separate reviewed control");
    const change = Object.fromEntries(paths.map((path, index) => [path, bytes[index]!]));
    if (runtime) change[runtimePath] = bytes[3]!;
    if (bytes[4] !== undefined) change[identityPath] = bytes[4];
    return { ...sample, approval, registry, change };
  }
  const gates = (sample: ReturnType<typeof fixture>, head: string) => [
    () => assertAppendOnlyMigrationHistory(sample.repo, sample.approval, head),
    () => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head),
  ];
  describe("M09 exact seven-forward admission", () => {
    const approved = readReviewedForwardRegistry(readFileSync(new URL(`../${REVIEWED_FORWARD_PATH}`, import.meta.url)));
    const entries = [...approved.portableCreationForwards!.filter(entry => entry.path.includes("invoicing")),
      ...approved.portableReplacementForwards!.filter(entry => entry.path.includes("invoicing")), ...approved.managedInvoicingForwards!];
    function readActual(root: string) {
      return entries.map(entry => {
        const fixture = join(root, "scripts/fixtures", entry.path.split("/").at(-1)!);
        const landed = join(root, entry.path);
        const source = existsSync(landed) ? landed : fixture;
        const bytes = readFileSync(source);
        expect(bytes.equals(readFileSync(fixture)), `Reviewed forward release bytes differ from fixture: ${entry.path}`).toBe(true);
        return { ...entry, source, bytes: bytes.toString("utf8") };
      });
    }
    const actual = readActual(fileURLToPath(new URL("../", import.meta.url)));
    it("selects landed bytes, falls back before introduction and refuses landed byte drift", () => {
      const root = mkdtempSync(join(tmpdir(), "openlup-m09-release-bytes-"));
      try {
        mkdirSync(join(root, "scripts/fixtures"), { recursive: true });
        for (const entry of entries) {
          const name = entry.path.split("/").at(-1)!;
          cpSync(new URL(`./fixtures/${name}`, import.meta.url), join(root, "scripts/fixtures", name));
        }
        const entry = entries[0]!;
        expect(readActual(root)[0]!.source).toBe(join(root, "scripts/fixtures", entry.path.split("/").at(-1)!));
        const landed = join(root, entry.path);
        mkdirSync(dirname(landed), { recursive: true });
        cpSync(join(root, "scripts/fixtures", entry.path.split("/").at(-1)!), landed);
        expect(readActual(root)[0]!.source).toBe(landed);
        writeFileSync(landed, Buffer.concat([readFileSync(landed), Buffer.from(" ")]));
        expect(() => readActual(root)).toThrow(`Reviewed forward release bytes differ from fixture: ${entry.path}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it("admits every final file through both gates and refuses byte, browser grant, definer and unpinned replacement plants", () => {
      // Keep exact preimages, rather than replaying an unrelated multi-megabyte
      // managed graph in every process plant. Real PostgreSQL owns graph proof.
      const managedSource = readFileSync(new URL(`../${MANAGED_BASELINE}`, import.meta.url), "utf8");
      const extract = (source:string,name:string) => { const start=source.indexOf(`CREATE FUNCTION public.${name}(`); const end=source.indexOf("\n$$;",start); if(start<0||end<0)throw new Error("Missing exact preimage");return source.slice(start,end+4); };
      const managedBaseline = ["accounting_invoice_correction_outbox_claim","accounting_invoice_correction_outbox_fail","accounting_invoice_correction_outbox_succeed"].map(name=>extract(managedSource,name)).join("\n");
      const nativeBaseline = extract(readFileSync(new URL("../db/platform/migrations/20260815150000_payment_truth_reconciliation.sql",import.meta.url),"utf8"),"payment_truth_apply_terminal");
      const replacement=actual.find(entry=>entry.path.includes("payment_decoupling"))!.bytes;
      const oldStart=nativeBaseline.indexOf("    SELECT COALESCE(jsonb_agg(");
      const oldEnd=nativeBaseline.indexOf("    IF v_order.subscription_cycle_id",oldStart);
      const newStart=replacement.indexOf("    -- Capture owed work only;");
      const newEnd=replacement.indexOf("    IF v_order.subscription_cycle_id",newStart);
      expect(replacement.slice(0,newStart)).toBe(nativeBaseline.slice(0,oldStart).replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION"));
      expect(replacement.slice(newEnd)).toBe(nativeBaseline.slice(oldEnd)+"\n");
      const native = { ...JSON.parse(SYNTHETIC_TREE["config/platform-migration-manifest.json"]!), forward:[] };
      native.baseline.sha256=sqlSha256(nativeBaseline);
      const extra:Record<string,string> = { [MANAGED_BASELINE]:managedBaseline, [native.baseline.file]:nativeBaseline, "config/platform-migration-manifest.json":json(native) };
      const sample = fixture(registry => {
        registry.baselineSha256 = sqlSha256(managedBaseline);
        registry.portableCreationForwards = structuredClone(approved.portableCreationForwards);
        registry.portableReplacementForwards = structuredClone(approved.portableReplacementForwards);
        registry.managedInvoicingForwards = structuredClone(approved.managedInvoicingForwards);
      }, null, false, false, extra);
      const append = (plant?: { path:string; bytes:string }) => {
        const manifest = structuredClone(native);
        const change: Record<string,string> = {};
        for (const entry of actual) {
          const bytes = plant?.path === entry.path ? plant.bytes : entry.bytes;
          change[entry.path] = bytes;
          if (entry.path.startsWith("db/")) manifest.forward.push({ file:entry.path, sha256:sqlSha256(bytes) });
        }
        manifest.forward.sort((a: {file:string},b: {file:string}) => a.file.localeCompare(b.file));
        change["config/platform-migration-manifest.json"] = json(manifest);
        sample.apply(change);
      };
      try {
        append();
        const head = sample.commit("Exact M09 final files");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
        for (const entry of actual) {
          expect(entry.path.split("/").at(-1)!.slice(0,14) > "20261022185100").toBe(true);
          expect(sqlSha256(entry.bytes)).toBe(entry.sha256);
          const nativeTriggerPlants: string[] = [];
          if (approved.portableCreationForwards!.some(item => item.path === entry.path)) {
            const table = /^CREATE TABLE (public\.[a-z_]+)/mu.exec(entry.bytes)![1]!;
            const bytes = entry.bytes + `\nCREATE FUNCTION public.zz_trigger() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END; $$;\nCREATE TRIGGER injected AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.zz_trigger();`;
            // An in-file trigger function passes structural classification;
            // M09's whole-file pin, rather than that classifier, excludes it.
            expect(() => assertPortableCreationStatements(Buffer.from(bytes), [])).not.toThrow();
            nativeTriggerPlants.push(bytes);
          }
          for (const bytes of [entry.bytes + " ", entry.bytes + "\nGRANT EXECUTE ON FUNCTION public.existing() TO anon;\n",
            entry.bytes.replace(/LANGUAGE (?:plpgsql|sql)/u, "LANGUAGE plpgsql SECURITY DEFINER"),
            entry.bytes + "\nCREATE OR REPLACE FUNCTION public.unpinned() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;\n", ...nativeTriggerPlants]) {
            expect(() => assertAdmittedPlatformForward(sample.repo,sample.approval,head,entry.path,Buffer.from(bytes))).toThrow(`non-expand-only forward differs from reviewed replacement path or bytes: ${entry.path}`);
            expect(() => assertAdmittedPlatformForward(sample.repo,sample.rootCommit,head,entry.path,Buffer.from(bytes),true)).toThrow(`non-expand-only forward differs from reviewed replacement path or bytes: ${entry.path}`);
          }
        }
        sample.run(["checkout","--detach",sample.rootCommit]);
        sample.apply({[REVIEWED_FORWARD_PATH]:json(sample.registry)});
        append();
        const selfApproved=sample.commit("M09 SQL and its own approval together");
        for(const entry of actual) {
          expect(()=>assertAdmittedPlatformForward(sample.repo,sample.rootCommit,selfApproved,entry.path,Buffer.from(entry.bytes))).toThrow(/approved separately/u);
          expect(()=>assertAdmittedPlatformForward(sample.repo,sample.rootCommit,selfApproved,entry.path,Buffer.from(entry.bytes),true)).toThrow(/approved separately/u);
        }
        // These approval commits deliberately repin malicious bytes: semantic
        // refusals must run after the whole-file and function hashes pass.
        for (const entry of actual) {
          for (const kind of ["attributes","statement", ...(entry.path.startsWith("supabase/") ? ["search-path"] : []), ...(entry.path.includes("durable_duties") ? ["view-options"] : [])]) {
            sample.run(["checkout","--detach",sample.approval]);
            const bytes=kind === "attributes"
              ? entry.path.includes("payment_decoupling") ? entry.bytes.replace("LANGUAGE plpgsql\nSET", "LANGUAGE plpgsql\nSECURITY DEFINER\nSET") : entry.bytes.replace(/SECURITY (?:INVOKER|DEFINER)/u,entry.path.startsWith("supabase/") ? "SECURITY INVOKER" : "SECURITY DEFINER")
              : kind === "search-path" ? entry.bytes.replace(/SET search_path = public, pg_catalog/gu, "SET search_path = public")
              : kind === "view-options" ? entry.bytes.replace("WITH (security_invoker=true)", "WITH (security_invoker=false)")
              : entry.bytes+"\nGRANT SELECT ON public.invoicing_duties TO anon;\n";
            expect(bytes, `${entry.path}: ${kind} plant must change actual bytes`).not.toBe(entry.bytes);
            const repinned=structuredClone(sample.registry);
            const binding=[...repinned.portableCreationForwards!,...repinned.portableReplacementForwards!,...repinned.managedInvoicingForwards!].find(item=>item.path===entry.path)!;
            binding.sha256=sqlSha256(bytes);
            if ("functions" in binding) {
              const definitions=reviewedFunctionDefinitions(Buffer.from(bytes));
              for (const fn of binding.functions) fn.afterSha256=definitions.get(fn.signature)!;
            }
            sample.apply({[REVIEWED_FORWARD_PATH]:json(repinned)});
            const control=sample.commit("Repinned semantic plant control");
            append({path:entry.path,bytes});
            const planted=sample.commit("Repinned semantic plant feature");
            expect(() => assertAdmittedPlatformForward(sample.repo,control,planted,entry.path,Buffer.from(bytes)),`${entry.path}: ${kind}`).toThrow(/attributes|statement|privilege|unsupported|only one/u);
            expect(() => assertAdmittedPlatformForward(sample.repo,sample.rootCommit,planted,entry.path,Buffer.from(bytes),true)).toThrow(/attributes|statement|privilege|unsupported|only one/u);
          }
        }
        sample.run(["checkout","--detach",sample.approval]);
        append(); sample.commit("Managed entries introduced");
        const modified=structuredClone(sample.registry);modified.managedInvoicingForwards![2]!.sha256="a".repeat(64);
        sample.apply({[REVIEWED_FORWARD_PATH]:json(modified)});
        const changed=sample.commit("Managed approval modified after introduction");
        expect(() => assertAdmittedPlatformForward(sample.repo,sample.rootCommit,changed,actual.at(-1)!.path,Buffer.from(actual.at(-1)!.bytes),true)).toThrow(/approved separately/u);
      } finally { sample.cleanup(); }
    }, 120_000);
    it("keeps structural managed and native refusals even with otherwise repinned malicious bytes", () => {
      for (const entry of actual) {
        const creation = approved.portableCreationForwards!.some(item => item.path === entry.path);
        const managed = entry.path.startsWith("supabase/");
        if (!creation && !managed) continue;
        const check = (bytes:string) => managed ? assertManagedInvoicingStatements(Buffer.from(bytes),entry.path) : assertPortableCreationStatements(Buffer.from(bytes),[]);
        expect(() => check(entry.bytes)).not.toThrow();
        const plants: [string, string, RegExp][] = [
          ["browser grant", entry.bytes + "\nGRANT SELECT ON public.invoicing_duties TO anon;", /reviewed/u],
          ["unpinned replacement", entry.bytes + "\nCREATE OR REPLACE FUNCTION public.unpinned() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;", /reviewed/u],
          ["security attribute", managed ? entry.bytes.replace("SECURITY DEFINER", "SECURITY INVOKER") : entry.bytes.replace("SECURITY INVOKER", "SECURITY DEFINER"), /reviewed/u],
          ["escape string", entry.bytes + "\nCREATE VIEW public.zz AS SELECT E'escape';", /reviewed/u],
        ];
        if (managed) {
          plants.push(
            ["browser execute grant", entry.bytes.replace("TO service_role", "TO authenticated"), /^reviewed managed invoicing refuses statement or donor attribute drift$/u],
            ["missing GRANT", entry.bytes.replace(/^GRANT EXECUTE[^\n]*\n/mu, ""), /^reviewed managed invoicing has missing definitions or service-only ACLs$/u],
            ["missing REVOKE", entry.bytes.replace(/^REVOKE ALL ON FUNCTION[^\n]*\n/mu, ""), /^reviewed managed invoicing has missing definitions or service-only ACLs$/u],
            ...["public, pg_temp", "pg_catalog, public"].map((path): [string, string, RegExp] =>
              [`search_path = ${path}`, entry.bytes.replace("SET search_path = public, pg_catalog", `SET search_path = ${path}`), /^reviewed managed invoicing refuses statement or donor attribute drift$/u]),
          );
          if (!entry.path.includes("compatibility")) plants.push(
            ["CREATE OR REPLACE in creation file", entry.bytes.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"), /^reviewed managed invoicing definition or attributes drifted$/u],
          );
        } else {
          // The target is created in this file: the missing in-file trigger
          // function, rather than an unknown table, causes this refusal.
          const table = /^CREATE TABLE (public\.[a-z_]+)/mu.exec(entry.bytes)![1]!;
          plants.push(
            ["trigger function not defined in file", entry.bytes + `\nCREATE TRIGGER injected AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.existing();`, /^reviewed portable creation refuses an unsupported statement, pre-existing target or function attributes: CREATE TRIGGER injected /u],
            ["unsupported view WITH option", entry.bytes + "\nCREATE VIEW public.zz WITH (security_barrier=true) AS SELECT 1;", /^reviewed portable creation refuses an unsupported statement, pre-existing target or function attributes: CREATE VIEW public\.zz WITH \(security_barrier=true\) AS SELECT 1;$/u],
          );
        }
        for (const [name, bytes, refusal] of plants) {
          expect(bytes, `${entry.path}: ${name} must change the source`).not.toBe(entry.bytes);
          expect(() => check(bytes), `${entry.path}: ${name}`).toThrow(refusal);
        }
      }
      const cutover=actual.find(entry=>entry.path.includes("durable_duties"))!.bytes;
      const cutoverSeed = /^INSERT INTO public\.invoicing_cutover\([\s\S]*?;/mu.exec(cutover)![0];
      for(const bytes of [cutover.replace("SELECT 'paid',id", "SELECT 'paid',gen_random_uuid()"),
        cutover.replace("FROM public.commerce_settlement_transitions\n  UNION", "FROM public.commerce_orders\n  UNION"),
        cutover.replace("ON CONFLICT DO NOTHING;", "ON CONFLICT DO UPDATE SET source_kind='paid';"),
        cutover+"\n"+cutoverSeed]) {
        expect(()=>assertPortableCreationStatements(Buffer.from(bytes),[])).toThrow(/^reviewed portable creation refuses an unsupported statement, pre-existing target or function attributes: INSERT INTO public\.invoicing_cutover/u);
      }
      for (const index of [0,1,2]) for (const probe of ["path","missing","replacement class","extra signature","extra key","swapped"] as const) {
        const registry = structuredClone(approved);
        const entry = registry.managedInvoicingForwards![index]!;
        if (probe === "path") entry.path += ".extra";
        if (probe === "missing") registry.managedInvoicingForwards!.pop();
        if (probe === "replacement class") entry.functions[0]!.beforeSha256 = index===1 ? null : "0".repeat(64);
        if (probe === "extra signature") entry.functions[0]!.signature = "public.unpinned()";
        if (probe === "extra key") Object.assign(entry,{extra:true});
        if (probe === "swapped") [registry.managedInvoicingForwards![0],registry.managedInvoicingForwards![1]]=[registry.managedInvoicingForwards![1]!,registry.managedInvoicingForwards![0]!];
        expect(() => readReviewedForwardRegistry(Buffer.from(json(registry)))).toThrow(/managed invoicing/u);
      }
      for (const probe of ["path","signature","timestamp","dunning","null hash","swapped","duplicate","extra key","binding key"] as const) {
        const registry=structuredClone(approved), entry=registry.portableReplacementForwards![1]!;
        if(probe==="extra key")Object.assign(entry,{extra:true});
        if(probe==="binding key")Object.assign(entry.functions[0]!,{extra:true});
        if(probe==="path")entry.path=entry.path.replace("192000","192001");
        if(probe==="signature")entry.functions[0]!.signature="public.unpinned()";
        if(probe==="timestamp")entry.functions[0]!.signature=entry.functions[0]!.signature.replace("timestamptz","timestamp with time zone");
        if(probe==="dunning")entry.functions[0]!.signature=registry.portableReplacementForwards![0]!.functions[0]!.signature;
        if(probe==="null hash")Object.assign(entry.functions[0]!,{beforeSha256:null});
        if(probe==="swapped")registry.portableReplacementForwards!.reverse();
        if(probe==="duplicate")entry.path=registry.portableReplacementForwards![0]!.path;
        expect(()=>readReviewedForwardRegistry(Buffer.from(json(registry)))).toThrow(/portable replacement/u);
      }
      for(const length of [3,4,6]) {
        const registry=structuredClone(approved);
        registry.portableCreationForwards=Array.from({length},(_,i)=>structuredClone(approved.portableCreationForwards![i%5]!));
        expect(()=>readReviewedForwardRegistry(Buffer.from(json(registry)))).toThrow(/portable creation/u);
      }
    });
  });
  describe("portable reviewed creation", () => {
    const manifestPath = "config/platform-migration-manifest.json";
    const portableBaseline = "db/platform/migrations/00000000000000_platform_baseline.sql";
    const approved = readReviewedForwardRegistry(readFileSync(new URL(`../${REVIEWED_FORWARD_PATH}`, import.meta.url)));
    const bindings = approved.portableCreationForwards!.slice(0, 2);
    // Immutable snapshots let the control PR test the exact future SQL without
    // introducing it into either installation chain or depending on Git history.
    const exact = bindings.map(({ path }) => readFileSync(new URL(`./fixtures/${path.split("/").at(-1)}`, import.meta.url), "utf8"));
    const prior = "CREATE TABLE public.fulfillment_shipments (id uuid);\nCREATE TABLE public.commerce_order_holds (id uuid);\nCREATE TABLE public.subscription_cycles (id uuid);";
    function creationFixture(contents = exact, repin = false, history = "", historyInForward = false) {
      const manifest = JSON.parse(SYNTHETIC_TREE[manifestPath]!);
      const baseline = prior + (historyInForward ? "" : history);
      manifest.baseline.sha256 = sqlSha256(baseline);
      const priorPath = "db/platform/migrations/20261022070000_existing.sql";
      if (historyInForward) manifest.forward.push({ file: priorPath, sha256: sqlSha256(history) });
      const sample = fixture(undefined, null, false, false, { [portableBaseline]: baseline, [manifestPath]: json(manifest), ...(historyInForward ? { [priorPath]: history } : {}) });
      sample.registry.portableCreationForwards = structuredClone(bindings);
      if (repin) sample.registry.portableCreationForwards.forEach((entry, index) => { entry.sha256 = sqlSha256(contents[index]!); });
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      sample.approval = sample.commit("Separate portable creation approval");
      const append = (paths = bindings.map(({ path }) => path)) => {
        const next = structuredClone(manifest);
        paths.forEach((path, index) => { next.forward.push({ file: path, sha256: sqlSha256(contents[index]!) }); });
        sample.apply({ ...Object.fromEntries(paths.map((path, index) => [path, contents[index]!])), [manifestPath]: json(next) });
      };
      return { ...sample, append };
    }
    it("admits both exact P4 files through CI and release admission, with their actual hashes", () => {
      const sample = creationFixture();
      try {
        exact.forEach((sql, index) => { expect(sqlSha256(sql)).toBe(bindings[index]!.sha256); expect(isExpandOnlyPlatformForward(sql)).toBe(false); });
        sample.append(); const head = sample.commit("Exact portable creations");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it("admits transaction boundaries and comments only on newly created objects", () => {
      const contents = [exact[0]! + `
BEGIN;
COMMENT ON FUNCTION public.commerce_fulfillment_provider_command_guard() IS 'Guard';
COMMENT ON INDEX public.idx_fulfillment_provider_commands_claim IS 'Claim index';
COMMENT ON TRIGGER commerce_fulfillment_provider_command_guard ON public.commerce_fulfillment_provider_commands IS 'Guard trigger';
COMMIT;
`, exact[1]!];
      const sample = creationFixture(contents, true);
      try {
        sample.append([bindings[0]!.path]); const head = sample.commit("Creation comments and transaction");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it.each(["byte", "path", "version"])("refuses an unpinned portable creation %s in both gates", (probe) => {
      const contents = [...exact];
      if (probe === "byte") contents[0] += " ";
      const sample = creationFixture(contents);
      try {
        const paths = bindings.map(({ path }) => path);
        if (probe !== "byte") paths[0] = paths[0]!.replace(probe === "path" ? "fulfillment_command_ledger" : "20261022080000", probe === "path" ? "unlisted" : "20261022080001");
        sample.append(paths); const head = sample.commit("Unpinned portable creation");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement path or bytes/u);
      } finally { sample.cleanup(); }
    });
    it("admits doubled standard quotes and backslashes or escape strings inside a dollar body", () => {
      const contents = [exact[0]! + `
CREATE TABLE public.zz_quotes (c text DEFAULT 'it''s', "double""quote" text);
CREATE VIEW public.zz_quotes_view AS SELECT 'it''s';
CREATE FUNCTION public.zz_body() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $$ SELECT E'a\\b'; $$;
`, exact[1]!];
      const sample = creationFixture(contents, true);
      try {
        sample.append(); const head = sample.commit("Standard creation quotes and dollar body");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it.each([
      ...["PUBLIC", "anon", "authenticated", "service_role"].map((role) => `GRANT SELECT ON public.fulfillment_provider_attempts TO ${role};`),
      "CREATE OR REPLACE FUNCTION public.existing() RETURNS text LANGUAGE sql AS $$ SELECT 'changed'; $$;",
      "CREATE OR REPLACE VIEW public.existing AS SELECT 1;",
      "CREATE OR REPLACE TRIGGER existing BEFORE INSERT ON public.subscription_cycles FOR EACH ROW EXECUTE FUNCTION public.commerce_fulfillment_provider_command_guard();",
      "ALTER TABLE public.subscription_cycles ADD COLUMN extra text;",
      "DROP TABLE public.subscription_cycles;",
      "CREATE TABLE public.zz_t (c text DEFAULT 'a\\'); DROP TABLE public.subscriptions; -- '\nCREATE TABLE public.zz_following (id text);",
      "CREATE VIEW public.zz_v AS SELECT 'a\\'; GRANT SELECT ON public.subscriptions TO anon; -- '\nCREATE TABLE public.zz_following (id text);",
      'CREATE VIEW public.zz_v AS SELECT 1 AS "a\\"; GRANT SELECT ON public.subscriptions TO anon; -- "\nCREATE TABLE public.zz_following (id text);',
      "CREATE VIEW public.zz_v AS SELECT E'one';",
      "/* outer /* inner */ CREATE VIEW public.zz_v AS SELECT 1; */ GRANT SELECT ON public.subscriptions TO anon;",
      "CREATE VIEW public.zz_v AS SELECT U&'plain';",
      'CREATE VIEW public.zz_v AS SELECT 1 AS U&"plain";',
      'CREATE VIEW public.zz_v AS SELECT 1 AS "a;b";',
      'CREATE VIEW public.zz_v AS SELECT 1 AS "a$b";',
      "CREATE VIEW public.zz_v AS SELECT 1 AS x$$; GRANT SELECT ON public.subscriptions TO anon; SELECT 1 AS y$$;",
      "CREATE VIEW public.zz_v AS SELECT 1 AS x$$; DROP TABLE public.subscriptions; CREATE VIEW public.zz_w AS SELECT 1 AS y$$;",
      ...["x$1", "x$$", "_$$", "x0$$", "é$$", "é", '"é"', "1\u00a0", "1\ufeff"].map((alias) => `CREATE VIEW public.zz_v AS SELECT 1 AS ${alias};`),
      "CREATE VIEW public.zz_v AS SELECT $$one$$;",
      "CREATE VIEW public.zz_v AS SELECT $1;",
      "CREATE VIEW public.zz_v AS SELECT 'unterminated;",
      'CREATE VIEW public.zz_v AS SELECT 1 AS "unterminated;',
      "CREATE VIEW public.zz_v AS SELECT 1",
      "CREATE VIEW public.zz_v AS SELECT 1; GRANT SELECT ON public.subscriptions TO anon;",
      "CREATE FUNCTION public.zz_named() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $fn$ SELECT 'one'; $fn$;",
      "CREATE FUNCTION public.zz_different() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $fn$ SELECT $$one$$; $fn$; GRANT SELECT ON public.subscriptions TO anon;",
      "CREATE VIEW public.zz_v AS SELECT -- 'misleading opening\n'line one\nline two'; GRANT SELECT ON public.subscriptions TO anon;",
      'CREATE VIEW public.zz_v AS SELECT 1 AS -- "misleading opening\n"line one\nline two"; GRANT SELECT ON public.subscriptions TO anon;',
      "CREATE TABLE public.zz_t (id text) INHERITS (public.commerce_settings);",
      "CREATE TABLE public.zz_t (id integer DEFAULT (SELECT 1));",
      "CREATE TABLE public.zz_t (id integer); DELETE FROM public.subscriptions;",
      "CREATE INDEX zz_idx ON public.fulfillment_provider_attempts (id) INCLUDE (id) TABLESPACE app;",
      "CREATE FUNCTION public.bad() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 'bad'; $$;",
      "CREATE FUNCTION public.bad() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $$ SELECT 'bad'; $$ SECURITY DEFINER;",
      "CREATE FUNCTION public.bad() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $$ select 1 $$ SECURITY DEFINER SET statement_timeout = $$0$$;",
      "CREATE FUNCTION public.bad() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $body$ select 1 $body$ SECURITY DEFINER SET statement_timeout = $body$0$body$;",
      "CREATE TRIGGER bad BEFORE INSERT ON public.subscription_cycles FOR EACH ROW EXECUTE FUNCTION public.existing();",
      "CREATE TRIGGER bad BEFORE INSERT ON app.existing FOR EACH ROW EXECUTE FUNCTION public.commerce_fulfillment_provider_command_guard();",
      "CREATE INDEX bad ON public.subscription_cycles (id);",
      "CREATE TABLE app.bad (id uuid);",
      "CREATE TABLE public.subscription_cycles (id uuid);",
      "REVOKE ALL ON public.subscription_cycles FROM PUBLIC, anon, authenticated;",
      "REVOKE ALL ON FUNCTION public.existing() FROM PUBLIC;",
      "REVOKE ALL ON public.fulfillment_provider_attempts FROM service_role;",
      "COMMENT ON TABLE public.subscription_cycles IS 'unrelated';",
      "COMMENT ON FUNCTION public.existing() IS 'unrelated';",
      "INSERT INTO public.subscription_cycles (id) VALUES ('existing') ON CONFLICT DO NOTHING;",
      "INSERT INTO public.fulfillment_provider_attempts (id) SELECT id FROM public.subscription_cycles ON CONFLICT DO NOTHING;",
      "INSERT INTO public.fulfillment_provider_attempts (id) VALUES ('new') ON CONFLICT (id) DO UPDATE SET id = 'changed';",
      "DELETE FROM public.fulfillment_provider_attempts;",
      "DO $$ BEGIN NULL; END $$;",
      "CREATE SCHEMA extra;",
      "BEGIN;\r\nCOMMIT;",
      "-- control\u0001\n",
      "/* unterminated",
      "CREATE FUNCTION public.bad() RETURNS text LANGUAGE sql AS $$ unterminated",
    ])("refuses independently repinned creation statements in both gates: %s", (addition) => {
      const contents = [exact[0]! + "\n" + addition, exact[1]!];
      const sample = creationFixture(contents, true);
      try {
        sample.append(); const head = sample.commit("Repinned unsupported creation");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed portable creation|reviewed replacement|control characters/u);
      } finally { sample.cleanup(); }
    });
    it.each([false, true].flatMap((inForward) => [
      "CREATE FUNCTION public.commerce_fulfillment_provider_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
      "CREATE TABLE public.fulfillment_provider_attempts (id uuid);",
      "CREATE TRIGGER commerce_fulfillment_provider_command_guard BEFORE UPDATE ON public.fulfillment_shipments FOR EACH ROW EXECUTE FUNCTION public.existing();",
    ].map((history) => [inForward, "\n" + history] as const)))("refuses existing objects from the preceding chain (forward: %s): %s", (inForward, history) => {
      const sample = creationFixture(exact, false, history, inForward);
      try {
        sample.append(); const head = sample.commit("Existing portable function name");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/pre-existing or duplicate object/u);
      } finally { sample.cleanup(); }
    });
    it.each(["simultaneous", "late", "changed"])("checks introduction-time portable creation approval: %s", (timing) => {
      const sample = creationFixture();
      try {
        if (timing !== "changed") {
          sample.apply({ [REVIEWED_FORWARD_PATH]: json({ ...sample.registry, portableCreationForwards: undefined }) });
          sample.approval = sample.commit("Before creation approval");
        }
        sample.append();
        if (timing === "simultaneous") sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
        let head = sample.commit("Creation introduction");
        if (timing !== "simultaneous") {
          if (timing === "changed") sample.registry.portableCreationForwards![0]!.sha256 = "1".repeat(64);
          sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
          head = sample.commit("Creation approval after introduction");
        }
        const [ci, release] = gates(sample, head);
        if (timing === "simultaneous") { expect(ci).not.toThrow(); expect(release).not.toThrow(); }
        else if (timing === "late") {
          // One PR range may bind its new SQL, but release cannot repair a bad mainline introduction.
          expect(ci).not.toThrow(); expect(release).toThrow(/approved separately/u);
        } else {
          expect(ci).toThrow(/path or bytes/u); expect(release).toThrow(/approved separately/u);
        }
      } finally { sample.cleanup(); }
    });
    it.each(["missing", "extra", "duplicate", "path", "hash", "fields", "replacement overlap"])("refuses malformed portable creation registry: %s", (probe) => {
      const registry = structuredClone(approved), entries = registry.portableCreationForwards!;
      if (probe === "missing") entries.pop();
      else if (probe === "extra") entries.push(structuredClone(entries[0]!));
      else if (probe === "duplicate") entries[1] = structuredClone(entries[0]!);
      else if (probe === "path") entries[0]!.path = "db/platform/migrations/20261022080000_unlisted.sql";
      else if (probe === "hash") entries[0]!.sha256 = "invalid";
      else if (probe === "fields") Object.assign(entries[0]!, { functions: [] });
      else registry.portableReplacementForwards![0]!.path = entries[0]!.path;
      expect(() => readReviewedForwardRegistry(Buffer.from(json(registry)))).toThrow(/reviewed portable creation/u);
    });
  });
  describe("portable reviewed replacement", () => {
    const path = "db/platform/migrations/20261021120000_dunning_lifecycle_active_repair.sql";
    const priorPath = "db/platform/migrations/20260815090000_dunning_lifecycle_state.sql";
    const portableBaseline = "db/platform/migrations/00000000000000_platform_baseline.sql";
    const manifestPath = "config/platform-migration-manifest.json";
    const signature = "public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text)";
    // Exact proposed bytes: keep active subscriptions active on dunning exhaustion (invariant repair).
    const exactSql = String.raw`-- Keep the portable subscription active when the canonical retry cadence ends.
-- The same open case and pending order remain repairable through the existing
-- checkout token and captured settlement rail. Preserve the terminal automatic
-- retry verdict and final notice; do not create a pause window or a second PSP.
-- migration:allow-function: forward replacement of the existing invoker routine;
-- its fixed search path and revoked browser/PUBLIC privileges remain unchanged.

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_handle_failure(
  p_case_id uuid,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_template_slug text,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_notification_id uuid;
  v_event_id uuid;
  v_at timestamptz := COALESCE(p_occurred_at, now());
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;
  IF v_case.status <> 'open' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'paused', false, 'terminal', true
    );
  END IF;

  IF p_next_retry_at IS NOT NULL THEN
    UPDATE public.subscription_dunning_cases
    SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt + 1), 1),
        next_retry_at = p_next_retry_at,
        failure_class = COALESCE(p_failure_class, failure_class),
        failure_reason = COALESCE(p_failure_reason, failure_reason),
        updated_at = v_at
    WHERE id = v_case.id
    RETURNING * INTO v_case;

    v_notification_id := public.dunning_lifecycle_queue_notice(
      v_case.id, 'payment_failed', p_template_slug, v_case.retry_attempt, p_recovery_url_path
    );
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
      'retryAttempt', v_case.retry_attempt, 'paused', false, 'terminal', false
    );
  END IF;

  UPDATE public.subscription_dunning_cases
  SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt), v_case.retry_attempt),
      next_retry_at = NULL,
      failure_class = COALESCE(p_failure_class, failure_class),
      failure_reason = COALESCE(p_failure_reason, failure_reason),
      updated_at = v_at
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  v_notification_id := public.dunning_lifecycle_queue_notice(
    v_case.id, 'payment_expired', p_template_slug, 0, p_recovery_url_path
  );

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_case.subscription_id, 'dunning_ladder_exhausted',
    'dunning-exhausted:' || v_case.id::text,
    jsonb_build_object('caseId', v_case.id, 'retryAttempt', v_case.retry_attempt),
    v_at
  )
  ON CONFLICT ON CONSTRAINT subscription_events_subscription_id_idempotency_key_key DO NOTHING
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
    'retryAttempt', v_case.retry_attempt, 'paused', false,
    'pauseWindowId', NULL, 'terminal', true
  );
END;
$$;
`;
    const approved = JSON.parse(readFileSync(new URL("../config/reviewed-platform-forwards.json", import.meta.url), "utf8")) as ReviewedForwardRegistry;
    const migration = readFileSync(new URL(`../${priorPath}`, import.meta.url), "utf8");
    const priorSql = migration.slice(migration.indexOf("CREATE FUNCTION public.dunning_lifecycle_handle_failure("), migration.indexOf("$$;", migration.indexOf("CREATE FUNCTION public.dunning_lifecycle_handle_failure(")) + 3);
    function portableFixture(edit?: (registry: ReviewedForwardRegistry) => void, prior = priorSql, inBaseline = false) {
      const manifest = JSON.parse(SYNTHETIC_TREE[manifestPath]!);
      const history = inBaseline ? { [portableBaseline]: prior } : { [priorPath]: prior };
      if (inBaseline) manifest.baseline.sha256 = sqlSha256(prior);
      else manifest.forward.push({ file: priorPath, sha256: sqlSha256(prior) });
      // Prior SQL belongs to the synthetic released root, before the separate control.
      const sample = fixture(undefined, null, false, false, { ...history, [manifestPath]: json(manifest) });
      sample.registry.portableReplacementForwards = structuredClone(approved.portableReplacementForwards!);
      edit?.(sample.registry);
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      sample.approval = sample.commit("Separate portable approval and prior chain");
      const append = (sql = exactSql, targetPath = path) => {
        const next = structuredClone(manifest);
        next.forward.push({ file: targetPath, sha256: sqlSha256(sql) });
        sample.apply({ [targetPath]: sql, [manifestPath]: json(next) });
      };
      return { ...sample, append };
    }
    it.each([false, true])("admits the exact portable bytes in both gates (prior in baseline: %s)", (inBaseline) => {
      const sample = portableFixture(undefined, priorSql, inBaseline);
      try {
        const binding = sample.registry.portableReplacementForwards![0]!;
        expect(sqlSha256(exactSql)).toBe(binding.sha256);
        expect(reviewedFunctionDefinitions(Buffer.from(priorSql)).get(signature)).toBe(binding.functions[0]!.beforeSha256);
        expect(reviewedFunctionDefinitions(Buffer.from(exactSql)).get(signature)).toBe(binding.functions[0]!.afterSha256);
        expect(isExpandOnlyPlatformForward(exactSql)).toBe(false);
        sample.append(); const head = sample.commit("Exact portable feature");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it.each(["different function", "body byte", "body byte with file repinned", "body byte with definition repinned", "unlisted version", "unlisted path"])("refuses portable %s in both gates", (probe) => {
      const changed = exactSql.replace("'terminal', true", "'terminal', truE");
      const sample = portableFixture((registry) => {
        if (probe === "body byte with file repinned") registry.portableReplacementForwards![0]!.sha256 = sqlSha256(changed);
        if (probe === "body byte with definition repinned") registry.portableReplacementForwards![0]!.functions[0]!.afterSha256 = reviewedFunctionDefinitions(Buffer.from(changed)).get(signature)!;
      });
      try {
        const sql = probe === "different function" ? exactSql.replace("public.dunning_lifecycle_handle_failure(", "public.unrelated(") : probe.startsWith("body byte") ? changed : exactSql;
        const targetPath = probe === "unlisted version" ? path.replace("20261021120000", "20261021120001") : probe === "unlisted path" ? path.replace("active_repair", "unlisted") : path;
        sample.append(sql, targetPath); const head = sample.commit("Refused portable feature");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement|reviewed portable/u);
      } finally { sample.cleanup(); }
    });
    it.each(["other signature", "second entry", "third managed replacement", "invalid path", "null before hash"])("refuses registry repin: %s", (probe) => {
      const registry = structuredClone(approved);
      const forward = registry.portableReplacementForwards![0]!;
      if (probe === "other signature") forward.functions[0]!.signature = "public.unrelated(uuid,timestamptz,text,text,integer,timestamptz,text,text)";
      else if (probe === "second entry") registry.portableReplacementForwards!.push(structuredClone(forward));
      else if (probe === "third managed replacement") registry.replacementForwards.push(structuredClone(registry.replacementForwards[0]!));
      else if (probe === "invalid path") forward.path = "supabase/migrations/20261021120000_unlisted.sql";
      else forward.functions[0]!.beforeSha256 = null;
      expect(() => readReviewedForwardRegistry(Buffer.from(json(registry)))).toThrow(probe === "third managed replacement" ? /two replacement forwards/u : /reviewed portable replacement/u);
    });
    it.each(["GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text) TO service_role;", "REVOKE ALL ON FUNCTION public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text) FROM PUBLIC;", "second CREATE OR REPLACE", "BEGIN;", "header drift", "trailing SECURITY DEFINER"])("refuses independently repinned portable SQL: %s", (probe) => {
      const sql = probe === "second CREATE OR REPLACE" ? exactSql + exactSql : probe === "header drift" ? exactSql.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER") : probe === "trailing SECURITY DEFINER" ? exactSql.replace("$$;", () => "$$ SECURITY DEFINER;") : `${exactSql}\n${probe}`;
      const sample = portableFixture((registry) => {
        const forward = registry.portableReplacementForwards![0]!;
        forward.sha256 = sqlSha256(sql);
        // Duplicate definitions refuse before their hashes can be collected.
        if (probe !== "second CREATE OR REPLACE") forward.functions[0]!.afterSha256 = reviewedFunctionDefinitions(Buffer.from(sql)).get(signature)!;
      });
      try {
        sample.append(sql); const head = sample.commit("Repinned unsupported portable SQL");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement|reviewed portable/u);
      } finally { sample.cleanup(); }
    });
    it.each([false, true])("refuses portable before-hash drift (prior in baseline: %s)", (inBaseline) => {
      const sample = portableFixture(undefined, priorSql.replace("v_pause_window_id uuid;", "v_pause_window_id uuid; -- drift"), inBaseline);
      try {
        sample.append(); const head = sample.commit("Portable prior drift");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/definition drifted/u);
      } finally { sample.cleanup(); }
    });
    it("admits portable SQL and its repin with the matching manifest in the same feature", () => {
      const sample = portableFixture();
      try {
        sample.append(exactSql + "\n");
        sample.registry.portableReplacementForwards![0]!.sha256 = sqlSha256(exactSql + "\n");
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
        const head = sample.commit("Co-located portable feature");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it("refuses adding unrelated future portable pins alongside one SQL introduction", () => {
      const sample = portableFixture((registry) => { delete registry.portableReplacementForwards; });
      try {
        sample.append();
        sample.registry.portableReplacementForwards = structuredClone(approved.portableReplacementForwards!);
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("Portable feature approves itself");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/approved separately/u);
      } finally { sample.cleanup(); }
    });
    it("releases an earlier managed feature after a later portable control approval", () => {
      const sample = fixture();
      try {
        sample.apply(sample.change); sample.commit("Managed feature before portable control");
        sample.registry.portableReplacementForwards = structuredClone(approved.portableReplacementForwards!);
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("Later portable control");
        expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it("binds the portable approval through later release controls", () => {
      const sample = portableFixture();
      try {
        sample.append(); sample.commit("Portable feature before changed approval");
        sample.registry.portableReplacementForwards![0]!.functions[0]!.afterSha256 = "f".repeat(64);
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("Altered portable approval");
        expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
      } finally { sample.cleanup(); }
    });
  });
  describe("M08 stock-evidence replacement admission", () => {
    const path = "db/platform/migrations/20261022165000_fulfillment_stock_evidence_replay_reopen.sql";
    const priorPath = "db/platform/migrations/20260814000000_fulfillment_stock_evidence.sql";
    const portableBaseline = "db/platform/migrations/00000000000000_platform_baseline.sql";
    const manifestPath = "config/platform-migration-manifest.json";
    const signature = "public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)";
    // Exact future forward, including its single trailing LF; this control adds no SQL file.
    const exactSql = `CREATE OR REPLACE FUNCTION public.fulfillment_record_stock_evidence(
  p_source_key text, p_idempotency_key text, p_fingerprint text, p_sku text,
  p_threshold_kind text, p_severity text, p_provider_for_sale integer,
  p_local_available integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_existing public.fulfillment_stock_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.fulfillment_stock_evidence
   WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operation_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_stock_evidence_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    UPDATE public.fulfillment_stock_evidence SET
      status = 'open', severity = p_severity,
      provider_for_sale_quantity = p_provider_for_sale,
      local_available_quantity = p_local_available,
      last_seen_at = clock_timestamp(), resolved_at = NULL
     WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('replayed', true);
  END IF;
  INSERT INTO public.fulfillment_stock_evidence(
    idempotency_key, operation_fingerprint, source_key, sku, threshold_kind,
    severity, provider_for_sale_quantity, local_available_quantity
  ) VALUES (
    p_idempotency_key, p_fingerprint, p_source_key, p_sku, p_threshold_kind,
    p_severity, p_provider_for_sale, p_local_available
  );
  RETURN jsonb_build_object('replayed', false);
END $$;
`;
    const approved = readReviewedForwardRegistry(readFileSync(new URL("../config/reviewed-platform-forwards.json", import.meta.url)));
    // This fixture models introduction of the named stock slot, before later approvals.
    const stockSlot = approved.portableReplacementForwards!.findIndex(pin => pin.path === path);
    expect(stockSlot).toBe(2);
    approved.portableReplacementForwards = approved.portableReplacementForwards!.slice(0, stockSlot + 1);
    const migration = readFileSync(new URL(`../${priorPath}`, import.meta.url), "utf8");
    const start = migration.indexOf("CREATE FUNCTION public.fulfillment_record_stock_evidence(");
    const priorSql = migration.slice(start, migration.indexOf("$$;", start) + 3);
    function stockFixture(edit?: (registry: ReviewedForwardRegistry) => void, prior = priorSql, inBaseline = false) {
      const manifest = JSON.parse(SYNTHETIC_TREE[manifestPath]!);
      const history = inBaseline ? { [portableBaseline]: prior } : { [priorPath]: prior };
      if (inBaseline) manifest.baseline.sha256 = sqlSha256(prior);
      else manifest.forward.push({ file: priorPath, sha256: sqlSha256(prior) });
      const sample = fixture(undefined, null, false, false, { ...history, [manifestPath]: json(manifest) });
      // Carry existing M09 and M10 approvals unchanged, including absent future SQL.
      for (const key of ["portableReplacementForwards", "portableCreationForwards", "managedInvoicingForwards", "batchedForwards"] as const) {
        Object.assign(sample.registry, { [key]: structuredClone(approved[key]) });
      }
      edit?.(sample.registry);
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      sample.approval = sample.commit("Separate stock-evidence control approval");
      const append = (sql = exactSql, targetPath = path) => {
        const next = structuredClone(manifest);
        next.forward.push({ file: targetPath, sha256: sqlSha256(sql) });
        sample.apply({ [targetPath]: sql, [manifestPath]: json(next) });
      };
      return { ...sample, append };
    }
    it.each([false, true])("admits exact stock bytes with portable prior in baseline: %s", inBaseline => {
      const sample = stockFixture(undefined, priorSql, inBaseline);
      try {
        const pin = sample.registry.portableReplacementForwards![2]!;
        expect(pin.path).toBe(path);
        expect(pin.sha256).toBe(sqlSha256(exactSql));
        expect(pin.functions).toEqual([{ signature,
          beforeSha256: reviewedFunctionDefinitions(Buffer.from(priorSql)).get(signature),
          afterSha256: reviewedFunctionDefinitions(Buffer.from(exactSql)).get(signature),
        }]);
        expect(isExpandOnlyPlatformForward(exactSql)).toBe(false);
        sample.append(); const head = sample.commit("Exact stock-evidence feature");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it.each(["body", "file repin", "definition repin", "file byte", "other function", "other version", "other path"])("refuses stock %s in both gates", probe => {
      const changed = exactSql.replace("status = 'open'", "status = 'resolved'");
      const sample = stockFixture(registry => {
        const pin = registry.portableReplacementForwards![2]!;
        if (probe === "file repin") pin.sha256 = sqlSha256(changed);
        if (probe === "definition repin") pin.functions[0]!.afterSha256 = reviewedFunctionDefinitions(Buffer.from(changed)).get(signature)!;
      });
      try {
        const sql = probe === "other function" ? exactSql.replace("public.fulfillment_record_stock_evidence(", "public.unrelated(")
          : probe === "file byte" ? exactSql + "\n" : probe.endsWith("repin") || probe === "body" ? changed : exactSql;
        const targetPath = probe === "other version" ? path.replace("20261022165000", "20261022165001")
          : probe === "other path" ? path.replace("replay_reopen", "unlisted") : path;
        sample.append(sql, targetPath); const head = sample.commit("Refused stock-evidence feature");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement|reviewed portable/u);
      } finally { sample.cleanup(); }
    });
    it.each(["path repin", "signature repin", "duplicate entry", "fourth entry", "wrong index", "missing function", "duplicate function", "null preimage"])("refuses stock registry %s", probe => {
      const registry = structuredClone(approved);
      const pins = registry.portableReplacementForwards!, pin = pins[2]!;
      if (probe === "path repin") pin.path = path.replace("20261022165000", "20261022165001");
      if (probe === "signature repin") pin.functions[0]!.signature = "public.unrelated(text,text,text,text,text,text,integer,integer)";
      if (probe === "duplicate entry") pins[2] = structuredClone(pins[1]!);
      if (probe === "fourth entry") pins.push(structuredClone(pin));
      if (probe === "wrong index") [pins[1], pins[2]] = [pins[2]!, pins[1]!];
      if (probe === "missing function") pin.functions = [];
      if (probe === "duplicate function") pin.functions.push(structuredClone(pin.functions[0]!));
      if (probe === "null preimage") pin.functions[0]!.beforeSha256 = null;
      expect(() => readReviewedForwardRegistry(Buffer.from(json(registry)))).toThrow(/reviewed portable replacement/u);
    });
    it.each(["header", "trailing attribute", "grant", "revoke", "transaction", "extra statement", "extra function", "duplicate function"])("refuses independently repinned stock %s in both gates", probe => {
      const sql = probe === "header" ? exactSql.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER")
        : probe === "trailing attribute" ? exactSql.replace("$$;", () => "$$ SECURITY DEFINER;")
        : probe === "grant" ? exactSql + `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`
        : probe === "revoke" ? exactSql + `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`
        : probe === "transaction" ? exactSql + "BEGIN;"
        : probe === "extra statement" ? exactSql + "SELECT 1;"
        : probe === "extra function" ? exactSql + definition("public.unpinned()", 1, true) : exactSql + exactSql;
      const sample = stockFixture(registry => {
        const pin = registry.portableReplacementForwards![2]!;
        pin.sha256 = sqlSha256(sql);
        if (probe !== "duplicate function") pin.functions[0]!.afterSha256 = reviewedFunctionDefinitions(Buffer.from(sql)).get(signature)!;
      });
      try {
        sample.append(sql); const head = sample.commit("Repinned unsupported stock SQL");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement|reviewed portable/u);
      } finally { sample.cleanup(); }
    });
    it.each([false, true])("refuses stock preimage drift with prior in baseline: %s", inBaseline => {
      const sample = stockFixture(undefined, priorSql.replace("RETURN jsonb_build_object('replayed', true)", "RETURN jsonb_build_object('replayed', false)"), inBaseline);
      try {
        sample.append(); const head = sample.commit("Stock preimage drift");
        for (const gate of gates(sample, head)) expect(gate).toThrow(/definition drifted/u);
      } finally { sample.cleanup(); }
    });
    it.each(["new approval", "changed approval"])("admits co-located stock approval under the existing class: %s", probe => {
      const sample = stockFixture(probe === "new approval" ? registry => { registry.portableReplacementForwards = registry.portableReplacementForwards!.slice(0, stockSlot); } : undefined);
      try {
        const sql = probe === "changed approval" ? exactSql + "\n" : exactSql;
        sample.append(sql);
        sample.registry.portableReplacementForwards = structuredClone(approved.portableReplacementForwards!);
        sample.registry.portableReplacementForwards[2]!.sha256 = sqlSha256(sql);
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
        const head = sample.commit("Stock feature carries its own exact pins");
        for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it.each(["M09", "M10"])("freezes existing %s controls in self-check while release binds the stock entry", programme => {
      const sample = stockFixture();
      try {
        sample.append();
        const pin = programme === "M09" ? sample.registry.portableReplacementForwards![1]! : sample.registry.batchedForwards![0]!;
        pin.sha256 = "f".repeat(64);
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
        const head = sample.commit("Feature changes existing control");
        // Self-check freezes the whole registry; release binds the introduced forward's entry.
        expect(gates(sample, head)[0]).toThrow(/approved separately/u);
        expect(gates(sample, head)[1]).not.toThrow();
      } finally { sample.cleanup(); }
    });
    it("binds the stock approval through later release controls", () => {
      const sample = stockFixture();
      try {
        sample.append(); sample.commit("Stock feature before altered approval");
        sample.registry.portableReplacementForwards![2]!.functions[0]!.afterSha256 = "f".repeat(64);
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
        const head = sample.commit("Altered stock control");
        expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
      } finally { sample.cleanup(); }
    });
  });
  it.each(["managed", "runtime", "identity"])("admits same-feature pins within the established %s class", kind => {
    const sample = fixture(kind === "identity" ? addIdentity : undefined, null, kind !== "managed");
    try {
      if (kind === "identity") {
        sample.run(["reset", "--hard", sample.rootCommit]);
        const prior = { ...sample.registry, runtimeForwards: sample.registry.runtimeForwards!.slice(0, 1) };
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(prior) }); sample.approval = sample.commit("Established class before identity introduction");
      } else {
        const forward = kind === "managed" ? sample.registry.replacementForwards[0]! : sample.registry.runtimeForwards![0]!;
        sample.change[forward.path] += "\n";
        forward.sha256 = sqlSha256(sample.change[forward.path]!);
      }
      sample.apply({ ...sample.change, [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("SQL and exact pins in one feature");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  });
  it("admits exact bytes after a separate control commit, including new signatures in the pinned file", () => {
    const sample = fixture();
    try {
      sample.apply(sample.change); const head = sample.commit("Feature");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
      for (const bytes of sql) expect(isExpandOnlyPlatformForward(bytes)).toBe(false);
    } finally { sample.cleanup(); }
  });
  it("admits a feature merged as a merge commit after its separately merged control, although it branched before it", () => {
    const sample = fixture();
    try {
      sample.run(["checkout", "-b", "feature", sample.rootCommit]);
      sample.apply(sample.change); sample.commit("Feature");
      sample.run(["checkout", "--detach", sample.approval]);
      // Resolve generated metadata on the main side; commit() regenerates it for the merged tree.
      sample.run(["merge", "--no-ff", "--no-commit", "-X", "ours", "feature"]);
      const head = sample.commit("Merge feature after separate control");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  });
  it("refuses a feature merged before its control even with merge commits", () => {
    const sample = fixture();
    try {
      sample.run(["checkout", "-b", "feature", sample.rootCommit]);
      sample.apply(sample.change); sample.commit("Feature");
      sample.run(["checkout", "--detach", sample.rootCommit]);
      sample.run(["merge", "--no-ff", "--no-commit", "feature"]);
      sample.commit("Merge feature before control");
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      const head = sample.commit("Late reviewed control");
      // Required CI compares against the mainline base before the feature was merged.
      for (const gate of gates({ ...sample, approval: sample.rootCommit }, head)) expect(gate).toThrow(/reviewed replacement/u);
    } finally { sample.cleanup(); }
  });
  it("refuses a merged branch whose own earlier commit carries its control", () => {
    const sample = fixture();
    try {
      sample.run(["checkout", "-b", "feature", sample.rootCommit]);
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); sample.commit("Branch-local control");
      sample.apply(sample.change); sample.commit("Feature on its own control");
      sample.run(["checkout", "--detach", sample.rootCommit]);
      sample.run(["merge", "--no-ff", "--no-commit", "feature"]);
      const head = sample.commit("Merge self-approving branch");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
    } finally { sample.cleanup(); }
  });
  it("refuses a merged feature that carries its own control", () => {
    const sample = fixture();
    try {
      sample.run(["checkout", "-b", "feature", sample.rootCommit]);
      sample.apply({ ...sample.change, [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      sample.commit("Self-authorized feature");
      sample.run(["checkout", "--detach", sample.rootCommit]);
      sample.run(["merge", "--no-ff", "--no-commit", "feature"]);
      const head = sample.commit("Merge self-authorized feature");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
    } finally { sample.cleanup(); }
  });
  it.each(["one byte", "another path", "additional SQL", "old definition", "missing signature", "duplicate signature"])("refuses %s in required CI and release prepare", (probe) => {
    const sample = fixture((registry, bytes) => {
      if (probe === "old definition") registry.replacementForwards[0]!.functions[0]!.beforeSha256 = "0".repeat(64);
      if (probe === "missing signature" || probe === "duplicate signature") {
        bytes[2] = probe === "missing signature" ? definition(functions[1]!, 2, true) : `${bytes[2]}\n${definition(functions[1]!, 2, true)}`;
        registry.replacementForwards[1]!.sha256 = sqlSha256(bytes[2]!);
      }
    });
    try {
      if (probe === "one byte") sample.change[paths[0]!] += "\n";
      if (probe === "additional SQL") sample.change[paths[0]!] += "\nDROP TABLE public.existing;";
      if (probe === "another path") { sample.change["supabase/migrations/20261001000004_other.sql"] = sample.change[paths[0]!]!; delete sample.change[paths[0]!]; }
      sample.apply(sample.change); const head = sample.commit("Refused feature");
      for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement/u);
    } finally { sample.cleanup(); }
  });
  it("refuses a control introduced with its SQL even when release spans multiple later commits", () => {
    const sample = fixture();
    try {
      sample.run(["reset", "--hard", sample.rootCommit]);
      sample.apply({ ...sample.change, [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      sample.commit("Self-authorized feature"); const head = sample.commit("Later unrelated commit");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
      expect(() => assertAppendOnlyMigrationHistory(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
    } finally { sample.cleanup(); }
  });
  it.each([
    "SELECT 1;",
    "DO $$ BEGIN NULL; END; $$;",
    "GRANT ALL ON FUNCTION public.commerce_offer_policy_v2_readiness() TO PUBLIC;",
    "GRANT EXECUTE ON FUNCTION public.commerce_offer_policy_v2_readiness() TO anon;",
    "GRANT EXECUTE ON FUNCTION public.unrelated() TO authenticated;",
    "CREATE FUNCTION app.unrelated() RETURNS jsonb LANGUAGE sql AS $$ SELECT '1'::jsonb; $$;",
    "CREATE FUNCTION public.unrelated() RETURNS jsonb LANGUAGE sql AS $open$ SELECT '1'::jsonb;",
  ])("refuses unsupported SQL even with a separately pinned whole-file hash: %s", (addition) => {
    const sample = fixture((registry, bytes) => { bytes[0] += `\n${addition}`; registry.replacementForwards[0]!.sha256 = sqlSha256(bytes[0]!); });
    try {
      sample.apply(sample.change); const head = sample.commit("Unsupported statement");
      for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement/u);
    } finally { sample.cleanup(); }
  });
  it("admits the one exact runtime capability forward after separate approval in both gates", () => {
    const sample = fixture((registry, bytes) => {
      const forward = registry.runtimeForwards![0]!;
      const privileges = [
        "GRANT EXECUTE ON FUNCTION public.record_admin_audit_event(uuid,text,text,text,text,jsonb,jsonb,text,text,uuid,text) TO service_role;",
        "GRANT EXECUTE ON FUNCTION public.subscription_current_template_snapshot(uuid) TO service_role;",
        "GRANT SELECT (principal_id, active) ON public.platform_communication_operators TO service_role;",
        "GRANT SELECT (status, template_slug) ON public.email_sends TO service_role;",
        "GRANT SELECT (event_type) ON public.email_events TO service_role;",
        "GRANT SELECT (id, email, first_name, last_name, phone, identity_kind, lifecycle_stage, created_at, updated_at, acquisition_source, auth_user_id, metadata, marketing_contact_id) ON public.clients TO service_role;",
        "GRANT SELECT (id, client_id, order_number, status, created_at, updated_at) ON public.commerce_orders TO service_role;",
        "GRANT SELECT (id, client_id, updated_at, cadence_days, template_version, currency, region_code, payment_method_kind, status, next_cycle_at) ON public.subscriptions TO service_role;",
        "GRANT SELECT (subscription_id, status, next_retry_at, scheduled_at, renewal_quarantined_until) ON public.subscription_cycles TO service_role;",
        "GRANT SELECT (subscription_id, provider_kind, provider_customer_ref, provider_method_ref, method_kind, status, active, expires_at, client_id, updated_at, created_at) ON public.commerce_payment_method_refs TO service_role;",
        "GRANT SELECT (id, slug, status, name, description, ingredients, allergens, marketing_content, primary_sku_id) ON public.catalog_products TO service_role;",
        "GRANT SELECT (id, product_id, sku, title, pet_type, status, net_weight_g, format_code, unit_form_code, is_addon, sellable_standalone, sellable_in_subscription, requires_pet_profile, min_order_qty) ON public.catalog_skus TO service_role;",
        "GRANT SELECT (subscription_id, event_type, occurred_at) ON public.subscription_events TO service_role;",
        "GRANT UPDATE (email, identity_kind, marketing_contact_id, metadata, updated_at) ON public.clients TO service_role;",
        "GRANT SELECT (client_id) ON public.commerce_carts TO service_role;",
        "GRANT SELECT (client_id) ON public.commerce_checkout_sessions TO service_role;",
        "GRANT SELECT (client_id) ON public.customer_delivery_preferences TO service_role;",
        "GRANT SELECT (client_id) ON public.customer_external_refs TO service_role;",
        "GRANT SELECT (client_id) ON public.customer_orderer_profiles TO service_role;",
        "GRANT SELECT (client_id) ON public.customer_payment_preferences TO service_role;",
        "GRANT SELECT (client_id) ON public.pets TO service_role;",
        "GRANT SELECT (client_id) ON public.promotion_code_claims TO service_role;",
        "GRANT SELECT (client_id) ON public.promotion_redemptions TO service_role;",
        "GRANT SELECT (client_id, consent_type, captured_at) ON public.client_consents TO service_role;",
        "GRANT SELECT (client_id) ON public.client_source_links TO service_role;",
        "GRANT SELECT (client_id) ON public.customer_personalization TO service_role;",
        "GRANT UPDATE (client_id) ON public.client_consents TO service_role;",
        "GRANT UPDATE (client_id) ON public.client_source_links TO service_role;",
        "GRANT UPDATE (client_id) ON public.customer_personalization TO service_role;",
        "GRANT UPDATE (updated_at) ON public.subscriptions TO service_role;",
        "GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_text(text) TO service_role;",
        "GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_digits(text) TO service_role;",
        "GRANT SELECT (id, auth_user_id, email, first_name, last_name, phone, lifecycle_stage) ON public.clients TO authenticated;",
        "GRANT SELECT (id, role, membership_state, email, is_machine_actor, created_at) ON public.admin_users TO authenticated;",
        "GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_text(text) TO authenticated;",
        "GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_digits(text) TO authenticated;",

      ];
      bytes[3] += `\n${privileges.join("\n")}`;
      forward.privileges.push(...privileges);
      forward.sha256 = sqlSha256(bytes[3]!);
    }, null, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Runtime reader feature");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  });
  it("admits the identity capabilities forward next to the runtime forward after separate approval in both gates", () => {
    const sample = fixture(addIdentity, null, true);
    try {
      expect(sqlSha256(identitySql)).toBe("65aca3641460d0a911b11e40c16ae209c3ae3be827ad4ceca2ee56cf5f718126");
      sample.apply(sample.change); const head = sample.commit("Identity capabilities feature");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  }, 30_000);
  it.each([
    ["identity", "CRLF"], ["identity", "bare CR"], ["identity", "comment CR"],
    ["runtime", "CRLF"], ["runtime", "bare CR"], ["runtime", "comment CR"],
  ] as const)("refuse carriage returns in reviewed SQL forwards (parser parity): %s %s in both gates even when independently repinned", (entry, shape) => {
    const sample = fixture((registry, bytes) => {
      if (entry === "identity") addIdentity(registry, bytes);
      const index = entry === "identity" ? 4 : 3;
      if (shape === "CRLF") bytes[index] = bytes[index]!.replace(/\n/gu, "\r\n");
      else if (shape === "bare CR") bytes[index] = bytes[index]!.replace(";\n", ";\r");
      else bytes[index] = bytes[index]!.replace("-- Managed ", "-- Managed\r ");
      registry.runtimeForwards![entry === "identity" ? 1 : 0]!.sha256 = sqlSha256(bytes[index]!);
    }, null, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Parser parity fixture");
      // Both gates refuse these bytes at the shared admission function before the reviewed route.
      for (const gate of gates(sample, head)) expect.soft(gate).toThrow(/migration SQL refuses control characters/u);
    } finally { sample.cleanup(); }
  }, 30_000);
  it.each([
    ["identity", "NUL", 0x00], ["identity", "vertical tab", 0x0b], ["identity", "form feed", 0x0c], ["identity", "ESC", 0x1b], ["identity", "DEL", 0x7f],
    ["runtime", "NUL", 0x00], ["runtime", "vertical tab", 0x0b], ["runtime", "form feed", 0x0c], ["runtime", "ESC", 0x1b], ["runtime", "DEL", 0x7f],
  ] as const)("refuse control characters in reviewed SQL forwards (parser parity): %s %s in a comment in both gates even when independently repinned", (entry, _label, byte) => {
    const sample = fixture((registry, bytes) => {
      if (entry === "identity") addIdentity(registry, bytes);
      const index = entry === "identity" ? 4 : 3;
      bytes[index] = bytes[index]!.replace("-- Managed ", `-- Managed${String.fromCharCode(byte)} `);
      registry.runtimeForwards![entry === "identity" ? 1 : 0]!.sha256 = sqlSha256(bytes[index]!);
    }, null, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Parser parity fixture");
      for (const gate of gates(sample, head)) expect.soft(gate).toThrow(/migration SQL refuses control characters/u);
    } finally { sample.cleanup(); }
  }, 30_000);
  it("admits a pinned identity forward with a tab in a comment in both gates (parser parity)", () => {
    const sample = fixture((registry, bytes) => {
      addIdentity(registry, bytes);
      bytes[4] = bytes[4]!.replace("-- Managed ", "-- Managed\t ");
      registry.runtimeForwards![1]!.sha256 = sqlSha256(bytes[4]!);
    }, null, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Parser parity fixture");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  }, 30_000);
  it.each([
    "GRANT INSERT ON public.clients TO service_role;",
    "GRANT INSERT (metadata) ON public.clients TO service_role;",
    "GRANT INSERT (identity_kind) ON public.clients TO service_role;",
    "GRANT INSERT (id) ON public.clients TO service_role;",
    "GRANT INSERT (first_name) ON public.clients TO service_role;",
    "GRANT UPDATE (email) ON public.clients TO service_role;",
    "GRANT SELECT (id) ON public.clients TO service_role;",
    "GRANT INSERT (email) ON public.clients TO authenticated;",
    "GRANT INSERT (email) ON public.clients TO anon;",
    "GRANT INSERT (email) ON public.clients TO PUBLIC;",
    "GRANT INSERT ON public.admin_users TO service_role;",
    "GRANT INSERT (is_machine_actor) ON public.admin_users TO service_role;",
    "GRANT INSERT (id, email, role, is_machine_actor, membership_state, membership_provenance, membership_accepted_at) ON public.admin_users TO service_role;",
    "GRANT INSERT (membership_revoked_by) ON public.admin_users TO service_role;",
    "GRANT INSERT (created_at) ON public.admin_users TO service_role;",
    "GRANT UPDATE (role) ON public.admin_users TO service_role;",
    "GRANT SELECT (membership_revoked_at) ON public.admin_users TO service_role;",
    "GRANT DELETE ON public.admin_users TO service_role;",
    "GRANT INSERT (email) ON public.admin_users TO authenticated;",
    "GRANT INSERT (email) ON public.admin_users TO anon;",
    "GRANT INSERT (email) ON public.admin_users TO PUBLIC;",
    "GRANT EXECUTE ON FUNCTION public.admin_revoke_admin_user(uuid,text) TO service_role;",
    "GRANT INSERT (client_id) ON public.client_consents TO service_role;",
    "GRANT DELETE ON public.clients TO service_role;",
    "GRANT TRUNCATE ON public.clients TO service_role;",
    "GRANT ALL ON public.clients TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_text(text) TO service_role;",
    definition("public.admin_clients_search_v3(p_query text, p_page integer, p_page_size integer, p_stage text)", 2, true),
    "DROP POLICY admin_all_pets ON public.pets;",
    "REVOKE INSERT (email) ON public.clients FROM service_role;",
    "SELECT 1;",
    "duplicate statement", "duplicate capability", "duplicate column", "missing privilege pin", "empty privileges", "non-empty functions", "present retiredPolicies", "third runtime forward", "duplicate path", "invalid path", "privilege order",
  ])("refuses identity admission %s in both gates even when independently repinned", (probe) => {
    const sample = fixture((registry, bytes) => {
      addIdentity(registry, bytes);
      const forward = registry.runtimeForwards![1]!;
      if (probe === "duplicate statement") { bytes[4] += `${identityPrivileges[0]}\n`; forward.privileges.push(identityPrivileges[0]!); }
      else if (probe === "duplicate capability") { const grant = "GRANT INSERT (email) ON public.clients TO service_role;"; bytes[4] += `${grant}\n`; forward.privileges.push(grant); }
      else if (probe === "duplicate column") { const grant = "GRANT INSERT (email, email) ON public.clients TO service_role;"; bytes[4] = grant; forward.privileges = [grant]; }
      else if (probe === "missing privilege pin") forward.privileges.pop();
      else if (probe === "empty privileges") forward.privileges = [];
      else if (probe === "non-empty functions") forward.functions = [{ ...registry.runtimeForwards![0]!.functions[0]! }];
      else if (probe === "present retiredPolicies") forward.retiredPolicies = [];
      else if (probe === "third runtime forward") registry.runtimeForwards!.push({ ...forward, path: "supabase/migrations/20261018160001_extra.sql" });
      else if (probe === "duplicate path") forward.path = registry.runtimeForwards![0]!.path;
      else if (probe === "invalid path") forward.path = "supabase/migrations/invalid.sql";
      else if (probe === "privilege order") forward.privileges.reverse();
      else if (probe.includes("is_machine_actor")) { bytes[4] = probe; forward.privileges = [probe]; }
      else if (probe.includes(";")) { bytes[4] += `${probe}\n`; if (probe.startsWith("GRANT")) forward.privileges.push(probe); }
      forward.sha256 = sqlSha256(bytes[4]!);
    }, null, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Refused identity feature");
      for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement/u);
    } finally { sample.cleanup(); }
  }, 30_000);
  it("releases an earlier unreleased runtime forward after a later control appends identity approval", () => {
    const sample = fixture(undefined, null, true);
    try {
      sample.apply(sample.change); sample.commit("Runtime feature before later control");
      addIdentity(sample.registry, []);
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const control = sample.commit("Later identity control");
      sample.apply({ [identityPath]: identitySql }); const head = sample.commit("Later identity feature");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).not.toThrow();
      expect(() => assertAppendOnlyMigrationHistory(sample.repo, control, head)).not.toThrow();
    } finally { sample.cleanup(); }
  }, 30_000);
  it.each(["privileges", "sha256", "functions", "path"] as const)("refuses release when a runtime forward's own %s changed after introduction", (probe) => {
    const sample = fixture(undefined, null, true);
    try {
      sample.apply(sample.change); sample.commit("Runtime feature before altered control");
      const forward = sample.registry.runtimeForwards![0]!;
      if (probe === "privileges") forward.privileges.push("GRANT SELECT (id) ON public.clients TO service_role;");
      else if (probe === "sha256") forward.sha256 = "f".repeat(64);
      else if (probe === "functions") forward.functions[0]!.afterSha256 = "f".repeat(64);
      else forward.path = forward.path.replace("runtime_readers", "renamed_runtime_readers");
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("Altered runtime control");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(probe === "path" ? /differs from reviewed replacement path or bytes/u : /approved separately/u);
    } finally { sample.cleanup(); }
  }, 30_000);
  it("refuses release when a runtime forward's own entry is removed after introduction", () => {
    const sample = fixture(undefined, null, true);
    try {
      sample.apply(sample.change); sample.commit("Runtime feature before removed approval");
      delete sample.registry.runtimeForwards;
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("Removed runtime control");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/differs from reviewed replacement path or bytes/u);
    } finally { sample.cleanup(); }
  }, 30_000);
  it.each(["baselineSha256", "releasePolicy"] as const)("refuses release when shared registry %s changed after introduction", (probe) => {
    const sample = fixture(undefined, null, true);
    try {
      sample.apply(sample.change); sample.commit("Runtime feature before altered shared control");
      if (probe === "baselineSha256") sample.registry.baselineSha256 = "e".repeat(64);
      else Object.assign(sample.registry, { releasePolicy: "relaxed" });
      sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); const head = sample.commit("Altered shared registry control");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
    } finally { sample.cleanup(); }
  }, 30_000);
  it("accepts registry formatting changes while preserving every semantic binding", () => {
    const sample = fixture(addIdentity, null, true);
    try {
      sample.apply({ ...sample.change, [REVIEWED_FORWARD_PATH]: json(sample.registry) + "\n" }); const head = sample.commit("Feature with registry whitespace");
      expect(() => assertAppendOnlyMigrationHistory(sample.repo, sample.approval, head)).not.toThrow();
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).not.toThrow();
    } finally { sample.cleanup(); }
  }, 30_000);
  it("admits exactly eight pinned browser policy retirements before runtime grants in both gates", () => {
    const sample = fixture(undefined, null, true, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Pinned policy contraction");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  });
  it.each(["wrong table", "wrong name", "wrong preimage", "missing binding", "duplicate binding", "extra binding", "missing statement", "duplicate statement", "unlisted statement", "alter policy", "create policy", "if exists", "after grant", "prior policy drift"])("refuses independently repinned policy retirement: %s", (probe) => {
    const sample = fixture(undefined, null, true, true);
    try {
      const forward = sample.registry.runtimeForwards![0]!;
      const path = forward.path;
      if (probe === "wrong table") forward.retiredPolicies![0]!.table = "admin_users";
      else if (probe === "wrong name") forward.retiredPolicies![0]!.name = "customer_own";
      else if (probe === "wrong preimage") forward.retiredPolicies![0]!.beforeSha256 = "f".repeat(64);
      else if (probe === "missing binding") forward.retiredPolicies!.pop();
      else if (probe === "duplicate binding") forward.retiredPolicies![1] = { ...forward.retiredPolicies![0]! };
      else if (probe === "extra binding") forward.retiredPolicies!.push({ ...forward.retiredPolicies![0]! });
      else if (probe === "missing statement") sample.change[path] = sample.change[path]!.replace("DROP POLICY admin_all_pets ON public.pets;", "");
      else if (probe === "duplicate statement") sample.change[path] = `DROP POLICY admin_all_pets ON public.pets;\n${sample.change[path]}`;
      else if (probe === "unlisted statement") sample.change[path] = `DROP POLICY customer_own ON public.clients;\n${sample.change[path]}`;
      else if (probe === "alter policy") sample.change[path] = sample.change[path]!.replace("DROP POLICY admin_all_pets ON public.pets;", "ALTER POLICY admin_all_pets ON public.pets USING (true);");
      else if (probe === "create policy") sample.change[path] += "\nCREATE POLICY allow_all ON public.clients USING (true);";
      else if (probe === "if exists") sample.change[path] = sample.change[path]!.replace("DROP POLICY admin_all_pets", "DROP POLICY IF EXISTS admin_all_pets");
      else if (probe === "after grant") sample.change[path] = sample.change[path]!.replace("DROP POLICY admin_all_pets ON public.pets;", "") + "\nDROP POLICY admin_all_pets ON public.pets;";
      else if (probe === "prior policy drift") {
        sample.apply({ "supabase/migrations/20261001000000_policy_drift.sql": "ALTER POLICY admin_all_pets ON public.pets USING (false);" }); sample.commit("Earlier policy drift");
      }
      forward.sha256 = sqlSha256(sample.change[path]!);
      if (probe === "same feature approval") {
        sample.run(["reset", "--hard", sample.rootCommit]);
        sample.apply({ ...sample.change, [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      } else {
        sample.apply({ [REVIEWED_FORWARD_PATH]: json(sample.registry) }); sample.approval = sample.commit("Independent repin"); sample.apply(sample.change);
      }
      const head = sample.commit("Refused policy contraction");
      for (const gate of gates(sample, head)) expect(gate).toThrow();
    } finally { sample.cleanup(); }
  });
  it("refuses runtime control introduced with SQL across a later release commit", () => {
    const sample = fixture(undefined, null, true);
    try {
      sample.run(["reset", "--hard", sample.rootCommit]);
      sample.apply({ ...sample.change, [REVIEWED_FORWARD_PATH]: json(sample.registry) });
      sample.commit("Self-authorized runtime feature"); const head = sample.commit("Later unrelated runtime commit");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
      expect(() => assertAppendOnlyMigrationHistory(sample.repo, sample.rootCommit, head)).toThrow(/approved separately/u);
    } finally { sample.cleanup(); }
  });
  it("allows a tagged runtime body mentioning attribute keywords without treating them as attributes", () => {
    const sample = fixture((registry, bytes) => {
      bytes[3] = bytes[3]!.replace(/SELECT '2'::jsonb;/gu, "SELECT jsonb_build_object('note', 'SECURITY DEFINER SET search_path STABLE');").replace(/\$\$/gu, "$reader$");
      const forward = registry.runtimeForwards![0]!;
      forward.sha256 = sqlSha256(bytes[3]!);
      const definitions = reviewedFunctionDefinitions(Buffer.from(bytes[3]!));
      for (const binding of forward.functions) binding.afterSha256 = definitions.get(binding.signature)!;
    }, null, true);
    try {
      sample.apply(sample.change); const head = sample.commit("Runtime body literals");
      for (const gate of gates(sample, head)) expect(gate).not.toThrow();
    } finally { sample.cleanup(); }
  });
  it.each([
    "byte drift", "prior function drift", "header drift", "trailing SECURITY DEFINER", "trailing SET search_path", "trailing STABLE", "tagged trailing SECURITY DEFINER", "duplicate runtime forward", "duplicate privilege", "duplicate update capability", "wrong runtime function", "unknown column", "missing privilege pin", "null prior definition", "duplicate runtime signature",
    "GRANT SELECT (id) ON public.unrelated TO service_role;",
    "GRANT SELECT ON public.admin_users TO service_role;",
    "GRANT SELECT (membership_provenance) ON public.admin_users TO authenticated;",
    "GRANT SELECT (id) ON public.admin_users TO anon;",
    "GRANT SELECT (id) ON public.admin_users TO PUBLIC;",
    "GRANT UPDATE (id) ON public.subscriptions TO service_role;",
    "GRANT INSERT ON public.admin_users TO service_role;",
    "GRANT INSERT (email) ON public.clients TO service_role;",
    "GRANT ALL ON public.admin_users TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.admin_clients_search_v3(text,integer,integer,text) TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.unrelated() TO service_role;",
    "UPDATE public.admin_users SET role = 'admin';",
    "CREATE TABLE public.unrelated (id integer);",
    "CREATE POLICY unrelated ON public.admin_users USING (true);",
    "REVOKE SELECT (id) ON public.admin_users FROM service_role;",
    "GRANT SELECT (id,id) ON public.admin_users TO service_role;",
    "GRANT SELECT (id) ON public.admin_users TO service_role;",
    "GRANT SELECT (current_document_revision_id) ON public.catalog_products TO service_role;",
    "GRANT SELECT (kcal_per_unit) ON public.catalog_skus TO service_role;",
    "GRANT SELECT (payload) ON public.subscription_events TO service_role;",
    "GRANT SELECT (country) ON public.clients TO service_role;",
    "GRANT UPDATE (auth_user_id) ON public.clients TO service_role;",
    "GRANT UPDATE (status) ON public.subscriptions TO service_role;",
    "GRANT UPDATE (next_cycle_at) ON public.subscriptions TO service_role;",
    "GRANT UPDATE (updated_at) ON public.subscriptions TO authenticated;",
    "GRANT UPDATE ON public.subscriptions TO service_role;",
    "GRANT UPDATE (email) ON public.client_consents TO service_role;",
    "GRANT UPDATE (client_id) ON public.commerce_carts TO service_role;",
    "GRANT UPDATE (client_id) ON public.client_source_links TO authenticated;",
    "GRANT UPDATE (client_id) ON public.client_source_links TO PUBLIC;",
    "GRANT UPDATE ON public.clients TO service_role;",
    "GRANT SELECT (metadata) ON public.clients TO authenticated;",
    "GRANT SELECT (membership_revoked_by) ON public.admin_users TO authenticated;",
    "GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_alnum(text) TO authenticated;",

    "GRANT SELECT ON public.catalog_products TO service_role;",
    "GRANT INSERT (client_id) ON public.client_consents TO service_role;",
    "GRANT DELETE ON public.clients TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamp with time zone) TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.admin_set_subscription_band_percent(numeric) TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.subscription_current_template_snapshot(uuid) TO authenticated;",
    "SELECT 1;",
  ])("refuses runtime admission %s in both gates even when independently repinned", (probe) => {
    const sample = fixture((registry, bytes) => {
      const forward = registry.runtimeForwards![0]!;
      if (probe === "prior function drift") forward.functions[0]!.beforeSha256 = "0".repeat(64);
      else if (probe === "null prior definition") forward.functions[0]!.beforeSha256 = null;
      else if (probe === "duplicate runtime signature") forward.functions[1] = { ...forward.functions[0]! };
      else if (probe === "duplicate runtime forward") registry.runtimeForwards!.push(forward);
      else if (probe === "duplicate privilege") { bytes[3] += `\n${forward.privileges[0]}`; forward.privileges.push(forward.privileges[0]!); }
      else if (probe === "duplicate update capability") {
        const grants = ["GRANT UPDATE (email,metadata) ON public.clients TO service_role;", "GRANT UPDATE (metadata) ON public.clients TO service_role;"];
        bytes[3] += `\n${grants.join("\n")}`; forward.privileges.push(...grants);
      }
      else if (probe === "wrong runtime function") {
        bytes[3] = bytes[3]!.replace(/public\.admin_clients_search_v3/gu, "public.unrelated_reader_v1");
        forward.functions[0]!.signature = "public.unrelated_reader_v1(text,integer,integer,text)";
      }
      else if (probe === "header drift") { bytes[3] = bytes[3]!.replace("LANGUAGE sql", "LANGUAGE sql SECURITY DEFINER"); }
      else if (probe.startsWith("trailing ") || probe === "tagged trailing SECURITY DEFINER") {
        const attribute = probe.endsWith("SET search_path") ? "SET search_path TO public" : probe.endsWith("STABLE") ? "STABLE" : "SECURITY DEFINER";
        bytes[3] = bytes[3]!.replace("$$;", () => `$$ ${attribute};`);
        if (probe.startsWith("tagged ")) bytes[3] = bytes[3]!.replace(/\$\$/gu, "$reader$");
      }
      else if (probe === "unknown column") { bytes[3] += "\nGRANT SELECT (secret) ON public.admin_users TO service_role;"; forward.privileges.push("GRANT SELECT (secret) ON public.admin_users TO service_role;"); }
      else if (probe === "missing privilege pin") forward.privileges.push("GRANT SELECT (id) ON public.clients TO service_role;");
      else if (probe.includes(";")) { bytes[3] += `\n${probe}`; forward.privileges.push(probe); }
      forward.sha256 = sqlSha256(bytes[3]!);
      const definitions = reviewedFunctionDefinitions(Buffer.from(bytes[3]!));
      for (const binding of forward.functions) binding.afterSha256 = definitions.get(binding.signature)!;
    }, null, true);
    try {
      const path = sample.registry.runtimeForwards![0]!.path;
      if (probe === "byte drift") sample.change[path] += "\n";
      sample.apply(sample.change); const head = sample.commit("Refused runtime feature");
      for (const gate of gates(sample, head)) expect(gate).toThrow(/reviewed replacement/u);
    } finally { sample.cleanup(); }
  });
  it.each(["baseline", "forward"] as const)("refuses creation when its signature exists in the preceding %s", (history) => {
    const sample = fixture(undefined, history);
    try {
      sample.apply(sample.change); const head = sample.commit("Creation collides with history");
      for (const gate of gates(sample, head)) expect(gate).toThrow(/definition drifted/u);
    } finally { sample.cleanup(); }
  });
});

describe("PR-base migration history", () => {
  const managed = "supabase/migrations/20260926000000_existing.sql";
  const old = { "supabase/migrations/00000000000000_platform_schema_baseline.sql": "select 1;\n", [managed]: "CREATE TABLE public.existing (id int);\n" };
  const check = (change: TreeChange, extra: Record<string, string> = old) => {
    const sample = syntheticRelease({ extraFiles: extra });
    try { sample.apply(change); const head = sample.commit("Candidate"); assertAppendOnlyMigrationHistory(sample.repo, sample.rootCommit, head); }
    finally { sample.cleanup(); }
  };

  it("accepts an expand-only managed append and a manifest-bound portable append", () => {
    check({ "supabase/migrations/20260927000000_added.sql": "CREATE TABLE public.added (id int);\n" });
    const path = "db/platform/migrations/20260927000000_added.sql", sql = "CREATE TABLE public.added (id int);\n";
    const manifest = JSON.parse(SYNTHETIC_TREE["config/platform-migration-manifest.json"]!);
    manifest.forward.push({ file: path, sha256: createHash("sha256").update(sql).digest("hex") });
    check({ [path]: sql, "config/platform-migration-manifest.json": json(manifest) });
  });

  it.each([
    ["editing a prior forward", { [managed]: "CREATE TABLE public.changed (id int);\n" }, /edit, deletion/u],
    ["deleting a prior forward", { [managed]: null }, /edit, deletion/u],
    ["backdating", { "supabase/migrations/20260925000000_earlier.sql": "CREATE TABLE public.earlier (id int);" }, /non-increasing/u],
    ["duplicate version", { "supabase/migrations/20260926000000_other.sql": "CREATE TABLE public.other (id int);" }, /non-increasing/u],
    ["destructive SQL", { "supabase/migrations/20260927000000_bad.sql": "DROP TABLE public.existing;" }, /non-expand-only/u],
    ["manifest tampering", { "config/platform-migration-manifest.json": json({ ...JSON.parse(SYNTHETIC_TREE["config/platform-migration-manifest.json"]!), objectInventorySha256: "1".repeat(64) }) }, /cannot change without/u],
  ] as const)("refuses %s", (_label, change, expected) => expect(() => check(change)).toThrow(expected));

  it("freezes a prior portable forward and its manifest prefix", () => {
    const path = "db/platform/migrations/20260926000000_existing.sql", sql = "CREATE TABLE public.existing (id int);\n";
    const manifest = JSON.parse(SYNTHETIC_TREE["config/platform-migration-manifest.json"]!);
    manifest.forward.push({ file: path, sha256: createHash("sha256").update(sql).digest("hex") });
    const extra = { ...old, [path]: sql, "config/platform-migration-manifest.json": json(manifest) };
    expect(() => check({ [path]: "CREATE TABLE public.changed (id int);\n" }, extra)).toThrow(/edit, deletion/u);
    expect(() => check({ [path]: null }, extra)).toThrow(/edit, deletion/u);
    const changed = { ...manifest, forward: [{ ...manifest.forward[0], sha256: "1".repeat(64) }] };
    expect(() => check({ "config/platform-migration-manifest.json": json(changed) }, extra)).toThrow(/SHA-256 mismatch|previous prefix/u);
  });

});

describe("descendant source release check", () => {
  it("builds its synthetic workspace manifests with the pinned public execution surfaces", () => {
    expect(PUBLIC_PACKAGE_EXECUTION_SURFACES.map(({ path, digest: pinned }) => [path, packageExecutionDigest(JSON.parse(SYNTHETIC_TREE[path]!)) === pinned])).toEqual(PUBLIC_PACKAGE_EXECUTION_SURFACES.map(({ path }) => [path, true]));
  });

  it("reads both commits as Git objects, never the working tree, and needs full distinct commits", () => {
    const sample = syntheticRelease();
    try {
      const head = sample.release({ "README.md": "public descendant\n" });
      writeFileSync(join(sample.repo, CATALOG), "{}\n"); writeFileSync(join(sample.repo, "src/uncommitted.ts"), "export {};\n");
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, head)).not.toThrow();
      expect(() => assertDescendantSourceRelease(sample.repo, head, head)).toThrow(/must advance/u);
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit.slice(0, 12), head)).toThrow(/full commit SHAs/u);
      expect(() => assertDescendantSourceRelease(sample.repo, sample.rootCommit, "HEAD")).toThrow(/full commit SHAs/u);
    } finally { sample.cleanup(); }
  });

  it.each([
    ["an added path", { "src/synthetic/added.ts": "export const added = 1;\n" }],
    ["a deleted path", { "docs/guide.md": null }],
    ["a pattern-admitted fragment with a fresh contract", { "packages/platform/changes/carry-one.md": "- Pending source notes.\n" }],
    ["a package change with a regenerated contract", { "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: { "": { name: "synthetic-root" } } }) }],
    ["a changed public file", { "README.md": "changed public readme\n" }],
    ["a valid compatibility change", editContract((contract) => { contract.compatibility = compatibility(2); })],
    ["a file under a new directory", { "local/measurement.json": "{}\n" }],
  ] as const)("accepts %s when the tree describes itself", (_label, change) => {
    const sample = syntheticRelease();
    try { expect(() => sample.release(change)).not.toThrow(); } finally { sample.cleanup(); }
  });

  it.each([
    ["a package change with a stale contract", { "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: {} }) }, { regenerate: false }, /does not describe its tree; run scripts\/source-release-preparation\.ts --write at release prep.*packages\.rootLockDigest/u],
    ["a stale class digest", {}, { regenerate: false, classes: { "docs/guide.md": "platform-documentation" } }, /does not describe its tree.*inventory\.classDigest/u],
    ["a changed fixed contract field", editContract((contract) => { contract.repository.owner.name = "Second Owner"; }), {}, /previous release's repository\.owner\.name/u],
    ["a migration manifest change", { "config/platform-migration-manifest.json": json({ synthetic: "changed" }) }, {}, /platform migration manifest/u],
    ["a database types change", { "src/integrations/supabase/types.ts": "export type SyntheticDatabase = unknown;\n" }, {}, /schema-bearing.*supabase\/types\.ts/u],
    ["a policy registry change", { "config/openlup-policy-registry.json": json({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "synthetic-readme-renamed", owners: ["README.md"] }] }) }, {}, /schema-bearing.*openlup-policy-registry/u],
    ["an added platform migration", { "db/platform/migrations/0002_synthetic.sql": "select 2;\n" }, {}, /schema-bearing.*0002_synthetic/u],
    ["an added schema migration", { "supabase/migrations/0001_synthetic.sql": "select 1;\n" }, {}, /schema-bearing.*supabase\/migrations/u],
    ["an added bootstrap script", { "db/bootstrap/synthetic/00_synthetic.sql": "select 1;\n" }, {}, /schema-bearing.*db\/bootstrap/u],
    ["an added upper-case bootstrap script", { "db/bootstrap/synthetic/01_SYNTHETIC.SQL": "select 1;\n" }, {}, /schema-bearing.*01_SYNTHETIC\.SQL/u],
    ["a catalogue that omits a tracked path", {}, { omitFromCatalog: ["docs/guide.md"] }, /catalogue differs from the Git inventory/u],
    ["a deleted policy active path", { "README.md": null }, {}, /policy path is absent from the Git inventory: README\.md/u],
    ["a changed package execution surface", { "packages/ui/package.json": json({ name: "synthetic-ui", scripts: { ...UI_SCRIPTS, postinstall: "node install.js" } }) }, {}, /package execution surface differs from the catalogue: packages\/ui\/package\.json/u],
    ["an uncatalogued package manifest", { "packages/extra/package.json": json({ name: "synthetic-extra", scripts: { postinstall: "node install.js" } }) }, {}, /package manifests differ from the catalogued package execution surfaces/u],
    ["a migration mode change", (repo: string) => chmodSync(join(repo, "db/platform/migrations/00000000000000_platform_baseline.sql"), 0o755), {}, /schema-bearing.*platform_baseline/u],
    ["an unregistered direct execution entrypoint", { "scripts/synthetic-tool.mjs": "#!/usr/bin/env node\n" }, {}, /unregistered direct execution entrypoint/u],
  ] as const)("refuses %s", (_label, change, seal, expected) => {
    const sample = syntheticRelease();
    try { expect(() => sample.release(change, seal)).toThrow(expected); } finally { sample.cleanup(); }
  });

  it.each([
    ["alignment", MANAGED_ALIGNMENT_FORWARD],
    ["required policy data", "supabase/migrations/20261003110000_required_platform_policy_data.sql"],
  ])("admits the real managed %s forward", (_label, path) => {
    const sql = readManagedForward(fileURLToPath(new URL("..", import.meta.url)), path);
    expect(isExpandOnlyPlatformForward(sql)).toBe(true);
    expect(isExpandOnlyPlatformForward(`${sql}\nUPDATE public.platform_job_controls SET enabled = true;`)).toBe(false);
    const sample = syntheticRelease({ extraFiles: { "supabase/migrations/00000000000000_platform_schema_baseline.sql": "select 1;\n" } });
    try { expect(() => sample.release({ [path]: sql })).not.toThrow(); } finally { sample.cleanup(); }
  });

  it.each(["managed", "portable"] as const)("admits an appended %s forward", (rail) => {
    const sample = syntheticRelease({ extraFiles: { "supabase/migrations/00000000000000_platform_schema_baseline.sql": "select 1;\n" } });
    const path = rail === "managed" ? "supabase/migrations/20260927000000_add_control.sql" : "db/platform/migrations/20260927000000_add_control.sql";
    const sql = "CREATE TABLE public.synthetic_control (singleton boolean primary key, mode text);\nINSERT INTO public.synthetic_control (singleton, mode) VALUES (true, 'auto_align') ON CONFLICT (singleton) DO NOTHING;\n";
    const change: Record<string, string> = { [path]: sql };
    if (rail === "portable") {
      const manifest = JSON.parse(sample.read("config/platform-migration-manifest.json")!.toString());
      manifest.forward.push({ file: path, sha256: createHash("sha256").update(sql).digest("hex") });
      change["config/platform-migration-manifest.json"] = json(manifest);
    }
    try { expect(() => sample.release(change)).not.toThrow(); } finally { sample.cleanup(); }
  });

  it("keeps an appended portable manifest bound to the source contract", () => {
    const sample = syntheticRelease();
    const path = "db/platform/migrations/20260927000000_added.sql", sql = "CREATE TABLE public.added (id int);\n";
    const manifest = JSON.parse(sample.read("config/platform-migration-manifest.json")!.toString());
    manifest.forward.push({ file: path, sha256: createHash("sha256").update(sql).digest("hex") });
    try {
      expect(() => sample.release({ [path]: sql, "config/platform-migration-manifest.json": json(manifest) }, { regenerate: false })).toThrow(/source contract does not describe its tree/u);
    } finally { sample.cleanup(); }
  });


  it.each([
    ["editing history", { "db/platform/migrations/00000000000000_platform_baseline.sql": "select 2;\n" }, /schema-bearing/u],
    ["deleting history", { "db/platform/migrations/00000000000000_platform_baseline.sql": null }, /schema-bearing/u],
    ["editing the managed baseline", { "supabase/migrations/00000000000000_platform_schema_baseline.sql": "select 2;\n" }, /schema-bearing/u],
    ["deleting a managed forward", { "supabase/migrations/20260926000000_existing.sql": null }, /schema-bearing/u],
    ["editing a managed forward", { "supabase/migrations/20260926000000_existing.sql": "CREATE TABLE changed (id int);" }, /schema-bearing/u],
    ["a non-increasing version", { "supabase/migrations/20260925000000_earlier.sql": "CREATE TABLE added (id int);" }, /non-increasing/u],
    ["a duplicate version", { "supabase/migrations/20260926000000_duplicate.sql": "CREATE TABLE added (id int);" }, /non-increasing/u],
    ...["DROP TABLE public.existing;", "DROP SCHEMA public;", "DROP VIEW public.existing;", "DROP TYPE public.existing;", "ALTER TABLE public.existing DROP COLUMN extra;", "TRUNCATE public.existing;", "ALTER TABLE public.existing RENAME TO other;", "ALTER TABLE public.existing SET SCHEMA other;", "ALTER TABLE public.existing OWNER TO other;"].map((sql) => [sql, { "supabase/migrations/20260927000000_refused.sql": sql }, /non-expand-only/u] as const),
    ["destructive SQL", { "supabase/migrations/20260927000000_drop.sql": "DROP TABLE public.existing;" }, /non-expand-only/u],
    ["adopter schema", { "supabase/migrations/20260927000000_app.sql": "CREATE TABLE app.extension (id int);" }, /non-expand-only/u],
  ] as const)("refuses %s in the descendant check", (_label, change, expected) => {
    const sample = syntheticRelease({ extraFiles: { "supabase/migrations/00000000000000_platform_schema_baseline.sql": "select 1;\n", "supabase/migrations/20260926000000_existing.sql": "CREATE TABLE existing (id int);" } });
    try { expect(() => sample.release(change)).toThrow(expected); } finally { sample.cleanup(); }
  });

  it("refuses a reordered portable manifest even when every file digest is valid", () => {
    const a = "db/platform/migrations/20260925000000_first.sql", b = "db/platform/migrations/20260926000000_second.sql", sql = "CREATE TABLE added (id int);";
    const manifest = JSON.parse(SYNTHETIC_TREE["config/platform-migration-manifest.json"]!);
    manifest.forward = [a, b].map((file) => ({ file, sha256: createHash("sha256").update(sql).digest("hex") }));
    const sample = syntheticRelease({ extraFiles: { [a]: sql, [b]: sql, "config/platform-migration-manifest.json": json(manifest) } });
    manifest.forward.reverse();
    try { expect(() => sample.release({ "config/platform-migration-manifest.json": json(manifest) })).toThrow(/strict filename order|previous prefix/u); } finally { sample.cleanup(); }
  });

  it("refuses a removed portable prefix entry and an unmanifested append", () => {
    const path = "db/platform/migrations/20260925000000_existing.sql", sql = "CREATE TABLE added (id int);";
    const manifest = JSON.parse(SYNTHETIC_TREE["config/platform-migration-manifest.json"]!);
    manifest.forward = [{ file: path, sha256: createHash("sha256").update(sql).digest("hex") }];
    const sample = syntheticRelease({ extraFiles: { [path]: sql, "config/platform-migration-manifest.json": json(manifest) } });
    try { expect(() => sample.release({ "config/platform-migration-manifest.json": SYNTHETIC_TREE["config/platform-migration-manifest.json"]! })).toThrow(/manifest/u); } finally { sample.cleanup(); }
    const missing = syntheticRelease();
    try { expect(() => missing.release({ "db/platform/migrations/20260927000000_unbound.sql": sql })).toThrow(/unmanifested/u); } finally { missing.cleanup(); }
  });

  it("prepares only a target that descends from the previous preview and describes itself", async () => {
    const sample = syntheticRelease(), outputs: string[] = [];
    const prepare = (head: string, previousTarget = sample.rootCommit) => { const out = mkdtempSync(join(tmpdir(), "openlup-prepare-out-")); outputs.push(out); return { out, run: preparePreview(previewInputs(head, "2", "release note\n"), sample.repo, out, undefined, github({ previousTarget }), () => undefined) }; };
    try {
      const head = sample.release({ "README.md": "public descendant\n" });
      const admitted = prepare(head);
      await expect(admitted.run).resolves.toBeUndefined();
      expect(readFileSync(join(admitted.out, "notes.md"), "utf8")).toBe("release note\n");
      const same = prepare(head, head);
      await expect(same.run).rejects.toThrow(/must advance the previous preview/u);
      sample.run(["checkout", "--quiet", "--detach", sample.rootCommit]); sample.apply({ "docs/guide.md": "sibling guide\n" });
      const sibling = sample.commit("Sibling of the descendant");
      const foreign = prepare(head, sibling);
      await expect(foreign.run).rejects.toThrow();
      sample.apply({ "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: {} }) });
      const stale = sample.commit("Stale contract", { regenerate: false });
      const refused = prepare(stale);
      await expect(refused.run).rejects.toThrow(/does not describe its tree/u);
      for (const out of [same.out, foreign.out, refused.out]) expect(existsSync(join(out, "notes.md"))).toBe(false);
    } finally { sample.cleanup(); for (const out of outputs) rmSync(out, { recursive: true, force: true }); }
  });
});

describe("expand-only platform SQL admission", () => {
  it("preserves the admitted set over every real portable forward", () => {
    const directory = fileURLToPath(new URL("../db/platform/migrations/", import.meta.url));
    expect(readdirSync(directory).sort().filter((file) => isExpandOnlyPlatformForward(readFileSync(join(directory, file), "utf8")))).toEqual([
      "20261018120000_identity_operator_invitations.sql",
      "20261018180000_identity_operator_challenges.sql",
      "20261018190000_identity_privacy_erasures.sql",
      "20261019200000_communications_native_operations.sql",
      "20261021200000_shipping_flat_rate_seed.sql",
    ]);
  });
  it.each([
    ["DEFAULT identifier boundary at 63 bytes with NBSP", `CREATE TABLE public.example (id int, value text DEFAULT ${"a".repeat(63)}\u00a0now()); INSERT INTO public.example (id) VALUES (1) ON CONFLICT DO NOTHING;`],
    ["NBSP separator", "CREATE\u00a0TABLE public.example (id int);"],
    ["non-ASCII unquoted identifier", "CREATE TABLE public.examplé (id int);"],
    ["non-ASCII quoted identifier", 'CREATE TYPE public."examplé" AS ENUM (\'x\');'],
    ["INSERT TABLE union before VALUES", "INSERT INTO public.example (value) TABLE public.existing UNION ALL VALUES ('next') ON CONFLICT DO NOTHING;"],
    ["INSERT parenthesized TABLE with LIMIT call", "INSERT INTO public.example (value) (TABLE public.existing LIMIT pg_catalog.setval('public.app_sequence', 42)) UNION VALUES ('next') ON CONFLICT DO NOTHING;"],
    ["INSERT overriding clause", "INSERT INTO public.example (value) OVERRIDING SYSTEM VALUE VALUES (1) ON CONFLICT DO NOTHING;"],
    ["INSERT default values", "INSERT INTO public.example (value) DEFAULT VALUES ON CONFLICT DO NOTHING;"],
    ["INSERT column expression", "INSERT INTO public.example (value + 1) VALUES (1) ON CONFLICT DO NOTHING;"],
    ["INSERT quoted on typed literal", 'INSERT INTO public.example VALUES ("on" \'x\', pg_catalog.setval(\'public.app_sequence\', 42)) ON CONFLICT DO NOTHING;'],
    ["INSERT quoted true call", 'INSERT INTO public.example VALUES ("true"(1)) ON CONFLICT DO NOTHING;'],
    ["INSERT quoted null", 'INSERT INTO public.example VALUES ("null") ON CONFLICT DO NOTHING;'],
    ["INSERT quoted values column", 'INSERT INTO public.example ("values") VALUES (1) ON CONFLICT DO NOTHING;'],
    ["INSERT quoted values target", 'INSERT INTO public."values" VALUES (1) ON CONFLICT DO NOTHING;'],
    ["quoted statement delimiter column", 'CREATE TABLE public.example (";" int);'],
    ["schema named alter", "CREATE SCHEMA alter;"],
    ["schema IF NOT EXISTS alter", "CREATE SCHEMA IF NOT EXISTS alter;"],
    ["schema quoted create", 'CREATE SCHEMA "create";'],
    ["INSERT quoted conflict keywords", 'INSERT INTO t VALUES (1) ON CONFLICT "do" "nothing";'],
    ["INSERT quoted constraint keyword", 'INSERT INTO t VALUES (1) ON CONFLICT ON "constraint" c DO NOTHING;'],
    ["INSERT quoted column punctuation", 'INSERT INTO t "(" a ")" VALUES (1) ON CONFLICT DO NOTHING;'],
    ["ARRAY domain call with seed", "CREATE TABLE public.example (id int, a boolean[] DEFAULT ARRAY[true, NOT public.app_domain 't']); INSERT INTO public.example (id) VALUES (1) ON CONFLICT DO NOTHING;"],
    ["ARRAY CASE typed literal", "CREATE TABLE public.example (id int, a text[] DEFAULT ARRAY['x', CASE public.app_text 'x' WHEN 'x' THEN 'y' END]);"],
    ...["varchar(1)", "pg_catalog.varchar(1)"].map((call) => [`ARRAY CASE ${call}`, `CREATE TABLE public.example (a text[] DEFAULT ARRAY['x', CASE ${call} WHEN 'x' THEN 'y' END]);`]),
    ...[
      "CREATE INDEX example_value ON public.existing ((ARRAY[1, 2]));",
      "ALTER TABLE public.existing ADD a boolean[] DEFAULT ARRAY[true, NOT public.app_domain 't'];",
      "CREATE TABLE public.example AS VALUES (ARRAY[1, 2]);",
      "CREATE TABLE public.example (a numeric(ARRAY[1, 2]));",
      "CREATE TABLE public.example (a text DEFAULT CAST(ARRAY['x', 'y'] AS text[]));",
      "CREATE TABLE public.example (a int DEFAULT value[]);",
      "CREATE SEQUENCE public.example START WITH ARRAY[1, 2];",
      "CREATE TYPE public.example AS (a int[]);",
      "CREATE TABLE public.example (a int[);",
      "CREATE TABLE public.example (a int]);",
      "CREATE TABLE public.example (a int DEFAULT ARRAY[(1, 2)]);",
      "CREATE INDEX example_value ON public.existing (a) WITH (fillfactor = ARRAY[1, 2]);",
    ].map((sql) => ["brackets outside empty type suffix", sql]),
    ["CREATE SCHEMA GRANT element", "CREATE SCHEMA example GRANT ALL ON public.existing TO PUBLIC;"],
    ["CREATE SCHEMA TABLE element", "CREATE SCHEMA example CREATE TABLE added (id int);"],
    ["sequence column ownership", "CREATE SEQUENCE public.example OWNED BY public.existing.value;"],
    ["ownership outside sequence", "CREATE TABLE public.example (value int) OWNED BY public.existing.value;"],
    ...["if", "add"].flatMap((column) => ["public.now()", "extensions.gen_random_uuid()", "public.app_num '1'", "- public.now()"].flatMap((expression) => [
      [`CREATE ${column} column DEFAULT ${expression}`, `CREATE TABLE public.example (id int, ${column} double precision DEFAULT ${expression});`],
      [`ALTER ${column} column DEFAULT ${expression}`, `ALTER TABLE public.existing ADD COLUMN ${column} double precision DEFAULT ${expression};`],
      [`ALTER ${column} without COLUMN DEFAULT ${expression}`, `ALTER TABLE public.existing ADD ${column} double precision DEFAULT ${expression};`],
    ])),
    ["CREATE if integer column DEFAULT", "CREATE TABLE public.example (if int DEFAULT - public.now());"],
    ["index named if unqualified target expression", "CREATE INDEX if ON existing (public.now());"],
    ["index named if expression", "CREATE INDEX if ON public.existing (public.now());"],
    ["table named if expression", "CREATE TABLE if (value double precision DEFAULT public.now());"],
    ["ALTER table named add expression", "ALTER TABLE add ADD if double precision DEFAULT public.now();"],
    ["ALTER table named add", "ALTER TABLE add ADD if numeric(10, 2);"],
    ["ALTER quoted table named add", 'ALTER TABLE "add" ADD COLUMN x int;'],
    ["ALTER quoted closing parenthesis column", 'ALTER TABLE public.existing ADD COLUMN ")" int;'],
    ["ALTER quoted comma column", 'ALTER TABLE public.existing ADD COLUMN "," int;'],
    ["DEFAULT call with seed INSERT", "CREATE TABLE public.example (id int, value text DEFAULT public.app_record_call()); INSERT INTO public.example (id) VALUES (1) ON CONFLICT DO NOTHING;"],
    ["CHECK call with seed INSERT", "CREATE TABLE public.example (value text CHECK (public.app_record_call() = 'recorded')); INSERT INTO public.example (value) VALUES ('recorded') ON CONFLICT DO NOTHING;"],
    ["CTAS VALUES call", "CREATE TABLE public.example AS VALUES (public.app_record_call());"],
    ["CTAS VALUES sequence call", "CREATE TABLE public.example AS VALUES (pg_catalog.setval('public.app_sequence', 42));"],
    ["CTAS VALUES setting call", "CREATE TABLE public.example AS VALUES (pg_catalog.set_config('app.admission', 'changed', true));"],
    ["CTAS parenthesized VALUES", "CREATE TABLE public.example AS (VALUES (1));"],
    ["CTAS TABLE copy", "CREATE TABLE public.example AS TABLE public.existing;"],
    ["CTAS parenthesized TABLE copy", "CREATE TABLE public.example AS (TABLE public.existing);"],
    ["CTAS SELECT", "CREATE TABLE public.example AS SELECT 1;"],
    ["CTAS named columns with unqualified TABLE", "CREATE TABLE public.example (value) AS TABLE existing;"],
    ["CTAS named columns", "CREATE TABLE public.example (value) AS VALUES (1);"],
    ["index key expression call", "CREATE INDEX example_value ON public.existing (public.app_record_call());"],
    ["parenthesized index expression call", "CREATE INDEX example_value ON public.existing ((public.app_record_call()));"],
    ["index WHERE call", "CREATE INDEX example_value ON public.existing (value) WHERE public.app_record_call() = 'recorded';"],
    ["generated column call", "CREATE TABLE public.example (value text GENERATED ALWAYS AS (public.app_record_call()) STORED);"],
    ["ALTER ADD COLUMN DEFAULT call", "ALTER TABLE public.existing ADD COLUMN value text DEFAULT public.app_record_call();"],
    ["ALTER ADD DEFAULT call without COLUMN", "ALTER TABLE public.existing ADD value text DEFAULT public.app_record_call();"],
    ["ALTER ADD CONSTRAINT CHECK call", "ALTER TABLE public.existing ADD CONSTRAINT example_check CHECK (public.app_record_call() = 'recorded');"],
    ["ALTER ADD CHECK call", "ALTER TABLE public.existing ADD CHECK (public.app_record_call() = 'recorded');"],
    ["ALTER SET DEFAULT", "ALTER TABLE public.existing ALTER COLUMN value SET DEFAULT now();"],
    ["PARTITION OF", "CREATE TABLE public.example PARTITION OF public.existing FOR VALUES IN (1);"],
    ["LIKE element", "CREATE TABLE public.example (LIKE public.existing INCLUDING ALL);"],
    ["LIKE operator", "CREATE TABLE public.example (value text CHECK (value LIKE 'a%'));"],
    ["OPERATOR reference", "CREATE TABLE public.example (value integer CHECK (value OPERATOR(public.+) 1 = 2));"],
    ["OPERATOR outside table expressions", "CREATE SEQUENCE public.example OPERATOR;"],
    ["CAST to public type", "CREATE TABLE public.example (value text DEFAULT CAST('x' AS public.app_text));"],
    ["CAST to three-part type", "CREATE TABLE public.example (value text DEFAULT CAST('x' AS db.pg_catalog.text));"],
    ["quoted call name", 'CREATE TABLE public.example (value text DEFAULT "now"());'],
    ["public-qualified allowlisted name", "CREATE TABLE public.example (value text DEFAULT public.now());"],
    ["three-part call name", "CREATE TABLE public.example (value text DEFAULT db.pg_catalog.now());"],
    ["quoted qualifier", 'CREATE TABLE public.example (value text DEFAULT "pg_catalog".now());'],
    ["qualified quoted call name", 'CREATE TABLE public.example (value text DEFAULT pg_catalog."now"());'],
    ["non-pg_catalog operator class", "CREATE INDEX example_value ON public.existing (value public.text_ops);"],
    ["unqualified operator class", "CREATE INDEX example_value ON public.existing (value text_ops);"],
    ["index collation", 'CREATE INDEX example_value ON public.existing (value COLLATE public."C");'],
    ["typed literal of a public type", "CREATE TABLE public.example (value text DEFAULT public.app_text 'x');"],
    ["qualified column in CHECK", "CREATE TABLE public.example (value text CHECK (public.value = 'x'));"],
    ["keyword contents call", "CREATE TABLE public.example (value text DEFAULT COALESCE(app_record_call(), 'x'));"],
    ["nested unlisted call", "CREATE TABLE public.example (value text DEFAULT lower(app_record_call()));"],
    ["nonliteral type modifier", "CREATE TABLE public.example (value numeric(length('x')));"],
    ["unbalanced expression", "CREATE TABLE public.example (value text DEFAULT lower('x');"],
    ["unaccounted parenthesis in type position", "CREATE TABLE public.example (value custom_type(1));"],
    ["qualified call in type position", "CREATE TABLE public.t (a public.lower(1));"],
    ["allowlisted call in type position", "CREATE TABLE public.t (a lower(1));"],
    ["type modifier name in expression position", "CREATE TABLE public.example (value text DEFAULT varchar(1));"],
  ])("refuses expression form: %s", (_label, sql) => { expect(isExpandOnlyPlatformForward(sql)).toBe(false); });
  it.each([
    ...["btrim", "gen_random_uuid", "jsonb_typeof", "length", "lower", "now", "translate", "char_length", "clock_timestamp", "octet_length"].flatMap((name) => [name, `pg_catalog.${name}`].flatMap((call) => [
      [call + " DEFAULT", `CREATE TABLE public.example (value text DEFAULT ${call}());`],
      [call + " CHECK", `CREATE TABLE public.example (value text CHECK (${call}(value) = value));`],
      [call + " index key", `CREATE INDEX example_value ON public.existing (${call}(value));`],
      [call + " index WHERE", `CREATE INDEX example_value ON public.existing (value) WHERE ${call}(value) = value;`],
    ])),
    ...["example", "public.example"].flatMap((target) => ["", " (id, value)"].flatMap((columns) => ["", " (id)", " ON CONSTRAINT example_key"].map((conflict) => [
      `literal seed ${target}${columns}${conflict}`, `INSERT INTO ${target}${columns} VALUES (1, 'first'), (2, 'next') ON CONFLICT${conflict} DO NOTHING;`,
    ]))),
    ["schema name", "CREATE SCHEMA example;"],
    ["schema IF NOT EXISTS", "CREATE SCHEMA IF NOT EXISTS example;"],
    ["schema named if", "CREATE SCHEMA if;"],
    ["sequence without ownership", "CREATE SEQUENCE public.example START WITH 1;"],
    ["non-ASCII literal", "CREATE TABLE public.example (value text DEFAULT 'café\u00a0text');"],
    ["non-ASCII line comment", "-- café\u00a0text\nCREATE TABLE public.example (id int);"],
    ["non-ASCII block comment", "CREATE /* café\u00a0text */ TABLE public.example (id int);"],
    ["ownership words in a literal", "INSERT INTO public.example VALUES ('owned by') ON CONFLICT DO NOTHING;"],
    ...["if", "add", "key", "identity", "include", "nulls", "first", "last", '"asc"', '"desc"', '"using"', "generated"].flatMap((column) => [
      [`CREATE keyword column ${column}`, `CREATE TABLE public.example (${column} numeric(10, 2) DEFAULT pg_catalog.now());`],
      [`ALTER keyword column ${column}`, `ALTER TABLE public.existing ADD COLUMN ${column} numeric(10, 2) DEFAULT pg_catalog.now();`],
    ]),
    ["index named if", "CREATE INDEX if ON public.existing (value);"],
    ["index named if unqualified target", "CREATE INDEX if ON existing (value);"],
    ["index IF NOT EXISTS", "CREATE INDEX IF NOT EXISTS example_value ON public.existing (value);"],
    ["table named if", "CREATE TABLE if (value numeric(10, 2));"],
    ["table IF NOT EXISTS", "CREATE TABLE IF NOT EXISTS public.example (value numeric(10, 2));"],
    ["ALTER column IF NOT EXISTS", "ALTER TABLE public.existing ADD COLUMN IF NOT EXISTS value numeric(10, 2);"],
    ["ALTER if column IF NOT EXISTS", "ALTER TABLE public.existing ADD IF NOT EXISTS if numeric(10, 2);"],
    ["nested calls", "CREATE UNIQUE INDEX example_value ON public.existing (lower(btrim(email)));"],
    ["keyword constructs", "CREATE TABLE public.example (value text CHECK (NOT (value IN ('a', 'b')) OR (COALESCE(NULLIF(value, ''), 'x') = 'x') AND (value IS NOT NULL)));"],
    ["builtin casts", "CREATE TABLE public.example (value text DEFAULT CAST('x' AS pg_catalog.text), amount numeric(10, 2) DEFAULT CAST(1 AS numeric(10, 2)));"],
    ["generated expression", "CREATE TABLE public.example (value text, normalized text GENERATED ALWAYS AS (lower(value)) STORED);"],
    ["generated identity", "CREATE TABLE public.example (id bigint GENERATED ALWAYS AS IDENTITY);"],
    ["identity options", "CREATE TABLE public.example (id bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 1));"],
    ["ALTER DEFAULT", "ALTER TABLE public.existing ADD COLUMN value text DEFAULT lower('x'), ADD extra varchar(20);"],
    ["ALTER CHECK", "ALTER TABLE public.existing ADD CONSTRAINT example_check CHECK (length(value) = 1);"],
    ["structural column lists", "CREATE TABLE public.example (id int, parent int REFERENCES public.existing(id), PRIMARY KEY (id), UNIQUE (parent), FOREIGN KEY (parent) REFERENCES public.existing(id));"],
    ["index ordering", "CREATE INDEX example_value ON public.existing ((lower(value)) DESC NULLS LAST);"],
    ["index method and INCLUDE", "CREATE INDEX example_value ON public.existing USING btree (value ASC NULLS FIRST) INCLUDE (id) WITH (fillfactor = 90);"],
    ["qualified object names", "CREATE INDEX public.example_value ON public.existing (value);"],
    ["empty array type suffixes", "CREATE TABLE public.example (a int[], b varchar(20)[][] DEFAULT CAST(NULL AS pg_catalog.text[]));"],
    ["ALTER empty array type suffix", "ALTER TABLE public.example ADD a text[];"],
    ["quoted column", 'CREATE TABLE public.example ("value" text DEFAULT now());'],
  ])("admits expression form: %s", (_label, sql) => { expect(isExpandOnlyPlatformForward(sql)).toBe(true); });
  const controlCharacters = [
    ["NUL inside a comment", "CREATE TABLE public.first (id int);\n-- example\0\n"],
    ["VT 0x0B", "CREATE TABLE public.first (id int);\n-- example\x0b\n"],
    ["FF 0x0C", "CREATE TABLE public.first (id int);\n-- example\x0c\n"],
    ["ESC 0x1B", "CREATE TABLE public.first (id int);\n-- example\x1b\n"],
    ["DEL 0x7F", "CREATE TABLE public.first (id int);\n-- example\x7f\n"],
    ["CRLF", "CREATE TABLE public.first (id int);\r\n-- example\r\nCREATE TABLE public.example (id int);\r\n"],
    ["bare CR", "CREATE TABLE public.first (id int);\r"],
    ["CR in a comment", "CREATE TABLE public.first (id int);\n-- example\rCREATE TABLE public.example (id int);\n"],
    ["CR between statements", "CREATE TABLE public.example (id int);\rCREATE TABLE public.other (id int);\n"],
    ["CR in a string literal", "CREATE TABLE public.example (value text DEFAULT 'a\rb');\n"],
  ] as const;
  it.each(controlCharacters)("refuse control characters in migration SQL (parser parity with PostgreSQL): predicate, %s", (_label, sql) => {
    expect(isExpandOnlyPlatformForward(sql)).toBe(false);
  });
  it.each(controlCharacters)("refuse control characters in migration SQL (parser parity with PostgreSQL): admission, %s", (_label, sql) => {
    expect(() => assertAdmittedPlatformForward("/absent", "base", "head", "example.sql", Buffer.from(sql))).toThrow(/migration SQL refuses control characters/u);
  });
  it.each([
    ["a clean LF file", "-- example\nCREATE TABLE public.example (id int);\n"],
    ["TAB inside a comment and between tokens", "-- example\tcomment\nCREATE\tTABLE public.example (id int);\n"],
  ])("admits %s without Git access", (_label, sql) => {
    expect(isExpandOnlyPlatformForward(sql)).toBe(true);
    expect(() => assertAdmittedPlatformForward("/absent", "base", "head", "example.sql", Buffer.from(sql))).not.toThrow();
  });
  for (const [label, sql] of [controlCharacters[0], controlCharacters[7]]) {
    it.each(["PR-base", "descendant release"] as const)(`refuse control characters in migration SQL (parser parity with PostgreSQL): %s gate, ${label}`, (gate) => {
      const old = { "supabase/migrations/00000000000000_platform_schema_baseline.sql": "select 1;\n", "supabase/migrations/20260926000000_existing.sql": "CREATE TABLE public.existing (id int);\n" };
      const sample = syntheticRelease({ extraFiles: old });
      const change = { "supabase/migrations/20260927000000_example.sql": sql };
      try {
        if (gate === "PR-base") {
          sample.apply(change); const head = sample.commit("Candidate");
          expect(() => assertAppendOnlyMigrationHistory(sample.repo, sample.rootCommit, head)).toThrow(/migration SQL refuses control characters/u);
        } else expect(() => sample.release(change)).toThrow(/migration SQL refuses control characters/u);
      } finally { sample.cleanup(); }
    });
  }
  it("refuse control characters in migration SQL (parser parity with PostgreSQL): tracked migration rails", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = execFileSync("git", ["ls-files", "--stage", "-z", "--", "db/platform/migrations/", "supabase/migrations/", "db/bootstrap/"], { cwd: root, encoding: "utf8" }).split("\0").filter((entry) => /\.sql$/iu.test(entry)).map((entry) => {
      const match = /^\d{6} ([a-f0-9]{40}) 0\t(.+)$/su.exec(entry);
      expect(match, entry).not.toBeNull();
      return { oid: match![1]!, path: match![2]! };
    });
    expect(files.length).toBeGreaterThan(0);
    // Read the same stage-zero index blobs together instead of starting Git per file.
    const oids = files.map(({ oid }) => oid);
    const blobs = splitRemovalScanBatch(execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: oids.join("\n") + "\n", maxBuffer: 256 * 1024 * 1024 }), oids);
    for (const [index, { path }] of files.entries()) expect(blobs[index]!.some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f), path).toBe(false);
  });
  it.each([
    "CREATE TABLE public.example (id bigint PRIMARY KEY);",
    "ALTER TABLE public.example ADD COLUMN extra text;",
    "CREATE UNIQUE INDEX example_id ON public.example (id);",
    "CREATE TYPE public.example_mode AS ENUM ('off', 'auto_align');",
    "BEGIN; INSERT INTO public.example (id, extra) VALUES (1, 'DROP TABLE app.x;'), (2, 'it''s safe') ON CONFLICT (id) DO NOTHING; COMMIT;",
    "/* outer /* nested */ comment */ ALTER TABLE public.example ADD /* comment */ COLUMN extra text; -- end",
  ])("admits %s", (sql) => { expect(isExpandOnlyPlatformForward(sql)).toBe(true); });
  it.each([
    ...["TABLE", "SCHEMA", "VIEW", "TYPE"].map((kind) => `DROP ${kind} public.example;`),
    "ALTER TABLE public.example DROP COLUMN extra;", "TRUNCATE public.example;",
    "ALTER TABLE public.example RENAME TO other;", "ALTER TABLE public.example SET SCHEMA other;",
    "ALTER TABLE public.example OWNER TO other;", "dRoP/**/TABLE public.example;",
    'CREATE TABLE public."DO" (id int);', 'CREATE TABLE public."ALTER" (id int);',
    "CREATE TABLE app.example (id int);", 'CREATE TABLE "app".example (id int);',
    "CREATE TABLE public.example (id int) INHERITS (public.commerce_settings);",
    "CREATE TABLE public.example (id int CHECK (id > 0));",
    "CREATE TABLE public.example (id uuid REFERENCES public.commerce_settings(id) ON DELETE SET NULL);",
    "DO $$ BEGIN EXECUTE 'DROP TABLE public.example'; END $$;",
    "CREATE OR REPLACE FUNCTION public.example() RETURNS void AS $$ DROP TABLE public.example; $$ LANGUAGE sql;",
    "INSERT INTO public.example (id) SELECT destructive_function() ON CONFLICT DO NOTHING;",
    "INSERT INTO public.example (id) VALUES (destructive_function()) ON CONFLICT DO NOTHING;",
    "INSERT INTO public.example (id) VALUES (1) ON CONFLICT (id) WHERE destructive_function() DO NOTHING;",
    "INSERT INTO public.example (id) VALUES (1) ON CONFLICT DO UPDATE SET id = 2;",
    "UPDATE public.example SET id = 2;", "ALTER TABLE public.example ALTER COLUMN id TYPE text;",
    "ALTER TABLE public.example ADD COLUMN extra text, DETACH PARTITION child;",
    "ALTER TABLE public.example ADD COLUMN extra text, NO FORCE ROW LEVEL SECURITY;",
    "CREATE TABLE public.example (id int); /* unterminated", "INSERT INTO public.example VALUES ('unterminated);",
    "", "-- comment only",
  ])("refuses %s", (sql) => { expect(isExpandOnlyPlatformForward(sql)).toBe(false); });
});
