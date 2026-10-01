import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, createPublicPublicationCatalog, packageExecutionDigest } from "./oss-publication-policy.ts";
import { CANONICAL_ACTIVATION_REPOSITORY, CANONICAL_ACTIVATION_SECURITY_ROUTE, assertDescendantSourceRelease, assertNoOverdueRemovals, createSourceReleaseContract, deriveSourceReleaseContract, isExpandOnlyPlatformForward, overdueRemovals, removalMarkerLines, removalScanBlobs, splitRemovalScanBatch, type SourceReleaseContractInput } from "./oss-source-release-contract.ts";
import { annotatedTag, assertDraft, assertNextPreview, assertReleasablePackages, checkDraft, preparePreview, previewInputs, previousPreview, verifyPublished, type GithubFetch } from "./source-preview-release.ts";
import { PUBLIC_REPOSITORY_URL } from "./packages/package-manifest-policy.ts";
import { MANAGED_ALIGNMENT_FORWARD, readManagedForward } from "./public-reference/subscription-alignment.mjs";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";

const target = "a".repeat(40), previousCommit = "d".repeat(40), tag = "openlup-source-preview/2", oldTag = "openlup-source-preview/1", root = "https://api.github.com/repos/openlup/openlup";
const previousTagObject = "6".repeat(40), targetTagObject = "c".repeat(40);
const packageProducer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github/workflows/publish-packages.yml"), "utf8");
type Overrides = { releases?: object[]; previous?: Record<string, unknown>; published?: Record<string, unknown>; previousRef?: Record<string, unknown>; previousTag?: Record<string, unknown>; targetRef?: Record<string, unknown> | null; targetTag?: Record<string, unknown> };

describe("direct npm package producer", () => {
  it("rejects forged release events and a changed live release before checkout", () => {
    const step = packageProducer.split("      - name: Require the release App event and the live immutable prerelease\n")[1]?.split("      - uses:")[0];
    const run = step?.split("        run: |\n")[1]?.replace(/^ {10}/gmu, "");
    expect(run).toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), "openlup-release-event-"));
    const eventFile = join(directory, "event.json"), liveFile = join(directory, "live.json");
    const gh = join(directory, "gh");
    writeFileSync(gh, "#!/bin/sh\n[ \"$1\" = api ] || exit 1\ncat \"$LIVE_RELEASE\"\n");
    chmodSync(gh, 0o755);
    const bot = { id: 334697227, login: "openlup-release[bot]" };
    const event = { action: "published", repository: { full_name: "openlup/openlup" }, sender: { ...bot, type: "Bot" }, release: { id: 123, tag_name: "openlup-source-preview/9", prerelease: true, draft: false, author: bot, assets: [] } };
    const live = { id: 123, tag_name: "openlup-source-preview/9", prerelease: true, draft: false, immutable: true, published_at: "2026-09-30T00:00:00Z", author: bot, assets: [] };
    const inheritedEnv = Reflect.get(process, "env") as NodeJS.ProcessEnv;
    const check = (changedEvent = event, changedLive = live) => {
      writeFileSync(eventFile, JSON.stringify(changedEvent));
      writeFileSync(liveFile, JSON.stringify(changedLive));
      return spawnSync("bash", ["-e", "-o", "pipefail", "-c", run!], {
        env: { ...inheritedEnv, PATH: `${directory}:${inheritedEnv.PATH}`, LIVE_RELEASE: liveFile, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "openlup/openlup", RELEASE_TAG: "openlup-source-preview/9" },
        encoding: "utf8", timeout: 5000,
      }).status;
    };
    try {
      expect(check()).toBe(0);
      for (const changed of [
        { sender: { ...bot, type: "Bot", id: 43 } }, { sender: { ...bot, type: "User" } },
        { sender: { ...bot, type: "Bot", login: "another-release[bot]" } },
        { action: "edited" }, { repository: { full_name: "someone/else" } },
        { release: { ...event.release, author: { ...bot, id: 43 } } },
        { release: { ...event.release, draft: true } }, { release: { ...event.release, assets: [{ id: 1 }] } },
      ]) expect(check({ ...event, ...changed })).not.toBe(0);
      for (const changed of [{ immutable: false }, { prerelease: false }, { id: 124 }, { tag_name: "openlup-source-preview/8" }, { author: { ...bot, id: 43 } }, { assets: [{ id: 1 }] }]) {
        expect(check(event, { ...live, ...changed })).not.toBe(0);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("verifies release provenance before packing and publishes only checked tarballs through OIDC", () => {
    const pack = packageProducer.split("  pack:\n")[1]?.split("\n  publish:\n")[0] ?? "";
    const publish = packageProducer.split("\n  publish:\n")[1] ?? "";
    const ordered = [
      "Require the release App event", "actions/checkout@", "Verify the annotated tag and GitHub release attestation",
      "gh release verify", "The release commit is on main", "npm run packages:check", "Scan the unpacked tarballs", "actions/upload-artifact@",
    ];
    const positions = ordered.map((item) => pack.indexOf(item));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(pack).toContain("attestations: read");
    expect(pack).not.toContain("id-token: write");
    expect(publish).toContain("needs: pack");
    expect(publish).toContain("environment: npm-stage");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("if (actual !== sha256)");
    expect(publish).toContain('npm publish "./packs/$filename" --tag preview --provenance --access public --ignore-scripts');
    expect(publish).not.toMatch(/npm stage publish|npm stage approve|actions\/checkout@|npm ci/u);
  });
});

/** Models the read-only GitHub API for a published preview/1 and, once tagged, preview/2. */
function github(options: Overrides & { previousTarget?: string; releaseTarget?: string } = {}): GithubFetch {
  const previousTarget = options.previousTarget ?? previousCommit, releaseTarget = options.releaseTarget ?? target;
  return async (input) => {
    const url = String(input);
    const page = /^.*\/releases\?per_page=100&page=([1-9][0-9]*)$/u.exec(url);
    if (page) return Response.json(page[1] === "1" ? options.releases ?? [{ tag_name: oldTag, immutable: true, prerelease: true, draft: false }] : []);
    if (url === `${root}/releases/tags/${encodeURIComponent(oldTag)}`) return Response.json({ tag_name: oldTag, immutable: true, prerelease: true, draft: false, body: "previous note", assets: [], ...options.previous });
    if (url === `${root}/releases/tags/${encodeURIComponent(tag)}` && options.published) return Response.json({ tag_name: tag, immutable: true, prerelease: true, draft: false, body: "release note", assets: [], ...options.published });
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
    const release = { tag_name: tag, draft: true, prerelease: true, body: "release note", assets: [] };
    expect(() => assertDraft(release, tag, "release note")).not.toThrow();
    for (const change of [{ draft: false }, { prerelease: false }, { tag_name: oldTag }]) expect(() => assertDraft({ ...release, ...change }, tag, "release note")).toThrow(/identity differs/u);
    for (const change of [{ body: "release note\n" }, { body: undefined }]) expect(() => assertDraft({ ...release, ...change }, tag, "release note")).toThrow(/body differs/u);
    for (const change of [{ assets: [{ name: "any-asset.json", digest: `sha256:${"0".repeat(64)}` }] }, { assets: undefined }]) expect(() => assertDraft({ ...release, ...change }, tag, "release note")).toThrow(/must carry no asset/u);
    expect(() => assertDraft(release, tag, "other note")).toThrow(/body differs/u);
  });

  it("finds the draft in the release list, because the lookup by tag never returns a draft", async () => {
    const draft = { tag_name: tag, draft: true, prerelease: true, body: "release note", assets: [] };
    const published = { ...draft, draft: false, immutable: true };
    const other = { ...draft, tag_name: oldTag };
    // Models the GitHub API: the tag lookup answers only for a published release, and the list
    // includes drafts in pages of 100.
    const list = (releases: object[]): GithubFetch => async (url) => {
      if (url === `${root}/releases/tags/${encodeURIComponent(tag)}`) {
        const match = releases.find((release) => (release as typeof draft).tag_name === tag && (release as typeof draft).draft === false);
        return match ? Response.json(match) : new Response(null, { status: 404 });
      }
      const page = /^.*\/releases\?per_page=100&page=([1-9][0-9]*)$/u.exec(url);
      if (page) return Response.json(releases.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100));
      return new Response(null, { status: 500 });
    };
    await expect(checkDraft(tag, "release note", undefined, list([other, draft]))).resolves.toBeUndefined();
    await expect(checkDraft(tag, "release note", undefined, list([...Array.from({ length: 100 }, () => other), draft]))).resolves.toBeUndefined();
    await expect(checkDraft(tag, "release note", undefined, list([draft, draft]))).rejects.toThrow(/exactly one draft release for openlup-source-preview\/2, found 2/);
    await expect(checkDraft(tag, "release note", undefined, list([other]))).rejects.toThrow(/found 0/);
    await expect(checkDraft(tag, "release note", undefined, list([published]))).rejects.toThrow(/found 0/);
    await expect(checkDraft(tag, "other note", undefined, list([draft]))).rejects.toThrow(/body differs/);
    await expect(checkDraft(tag, "release note", undefined, list([{ ...draft, assets: [{ name: "any-asset.json" }] }]))).rejects.toThrow(/no asset/);
  });

  it("verifies the published immutable release, its exact note and its annotated tag at the target", async () => {
    const input = previewInputs(target, "2", "release note");
    await expect(verifyPublished(input, "release note", undefined, github({ published: {}, targetRef: {} }))).resolves.toBeUndefined();
    for (const published of [{ immutable: false }, { prerelease: false }, { draft: true }, { tag_name: oldTag }]) await expect(verifyPublished(input, "release note", undefined, github({ published, targetRef: {} }))).rejects.toThrow(/not an immutable published preview/u);
    await expect(verifyPublished(input, "release note", undefined, github({ published: { body: "edited note" }, targetRef: {} }))).rejects.toThrow(/body differs/u);
    await expect(verifyPublished(input, "release note", undefined, github({ published: { assets: [{ name: "any-asset.json" }] }, targetRef: {} }))).rejects.toThrow(/no asset/u);
    await expect(verifyPublished(input, "release note", undefined, github({ published: {}, targetRef: {}, releaseTarget: "b".repeat(40) }))).rejects.toThrow(/prepared target or message/u);
    await expect(verifyPublished(input, "release note", undefined, github({ published: {}, targetRef: {}, targetTag: { message: "OpenLup source preview 2.\n\nExtra text\n" } }))).rejects.toThrow(/prepared target or message/u);
    await expect(verifyPublished(input, "release note", undefined, github({ published: {}, targetRef: { object: { type: "commit", sha: target } } }))).rejects.toThrow(/annotated tag/u);
    await expect(verifyPublished(input, "release note", undefined, github({ published: {} }))).rejects.toThrow(/HTTP 404/u);
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
  "docs:check": "node --experimental-strip-types ./scripts/documentation-contract.ts",
  prepack: "npm run build",
  prepublishOnly: "node --experimental-strip-types ./scripts/refuse-publish.ts",
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
  "packages/core/package.json": json({ name: "synthetic-core", scripts: CORE_SCRIPTS }),
  "packages/core/package-lock.json": json({ name: "synthetic-core", lockfileVersion: 3 }),
  "packages/ui/package.json": json({ name: "synthetic-ui", scripts: UI_SCRIPTS }),
  [CONTRACT]: createSourceReleaseContract({ ...Object.fromEntries(["inventoryDigest", "classDigest", "packageDigest", "rootLockDigest", "coreLockDigest", "migrationManifestDigest", "databaseTypesDigest", "policyRegistryDigest", "publicationCatalogDigest"].map((name) => [name, `sha256-${"0".repeat(64)}`])) as unknown as SourceReleaseContractInput, compatibility: compatibility(0) as SourceReleaseContractInput["compatibility"] }, { evidenceClass: "activation-candidate", coordinate: CANONICAL_ACTIVATION_REPOSITORY, securityRoute: CANONICAL_ACTIVATION_SECURITY_ROUTE, owner: OWNER }).contents,
};
type TreeChange = Record<string, string | null> | ((repo: string) => void);
type Seal = { regenerate?: boolean; classes?: Record<string, string>; omitFromCatalog?: string[] };

/** A synthetic previous preview as a root commit, plus a helper that commits and checks one descendant. */
function syntheticRelease(options: { extraFiles?: Record<string, string | Buffer> } = {}) {
  const repo = mkdtempSync(join(realpathSync(tmpdir()), "openlup-descendant-release-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const read = (path: string) => existsSync(join(repo, path)) ? readFileSync(join(repo, path)) : undefined;
  const apply = (change: TreeChange) => {
    if (typeof change === "function") return change(repo);
    for (const [path, contents] of Object.entries(change)) { if (contents === null) { rmSync(join(repo, path)); continue; } mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); }
  };
  const commit = (message: string, { regenerate = true, classes = {}, omitFromCatalog = [] }: Seal = {}) => {
    run(["add", "--all"]);
    const paths = [...new Set([...run(["ls-files"]).split("\n").filter(Boolean), CATALOG])].filter((path) => !omitFromCatalog.includes(path)).sort();
    writeFileSync(join(repo, CATALOG), createPublicPublicationCatalog(paths.map((path) => ({ path, class: classes[path] ?? "public-output" })), []).contents);
    if (regenerate) writeFileSync(join(repo, CONTRACT), deriveSourceReleaseContract(read).contents);
    run(["add", "--all"]); run(["commit", "--quiet", "--allow-empty", "-m", `${message}\n\nSigned-off-by: ${OWNER.name} <${OWNER.email}>`]);
    return run(["rev-parse", "HEAD"]);
  };
  run(["init", "--quiet"]); run(["config", "user.name", OWNER.name]); run(["config", "user.email", OWNER.email]);
  apply({ ...SYNTHETIC_TREE, ...options.extraFiles });
  const rootCommit = commit("Initial public source release.");
  /** Commits one change and checks it as the descendant of the synthetic previous preview; returns the commit. */
  const release = (change: TreeChange, seal: Seal = {}) => { apply(change); const head = commit("Public descendant", seal); assertDescendantSourceRelease(repo, rootCommit, head); return head; };
  return { repo, run, read, apply, commit, rootCommit, release, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}
const editContract = (edit: (contract: { compatibility?: unknown; repository: { owner: { name: string } } }) => void) => (repo: string) => { const contract = JSON.parse(readFileSync(join(repo, CONTRACT), "utf8")); edit(contract); writeFileSync(join(repo, CONTRACT), json(contract)); };

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
    ["a package change with a regenerated contract", { "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: { "": { name: "synthetic-root" } } }) }],
    ["a changed public file", { "README.md": "changed public readme\n" }],
    ["a valid compatibility change", editContract((contract) => { contract.compatibility = compatibility(2); })],
    ["a file under a new directory", { "local/measurement.json": "{}\n" }],
  ] as const)("accepts %s when the tree describes itself", (_label, change) => {
    const sample = syntheticRelease();
    try { expect(() => sample.release(change)).not.toThrow(); } finally { sample.cleanup(); }
  });

  it.each([
    ["a package change with a stale contract", { "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: {} }) }, { regenerate: false }, /does not describe its tree; regenerate it with the snippet in CONTRIBUTING\.md.*packages\.rootLockDigest/u],
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

  it("admits the real managed alignment seed forward", () => {
    const path = MANAGED_ALIGNMENT_FORWARD;
    const sql = readManagedForward(fileURLToPath(new URL("..", import.meta.url)), path);
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


describe("publishable package preflight", () => {
  const fixture = (version: string) => {
    const repo = mkdtempSync(join(tmpdir(), "openlup-package-preflight-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const write = (path: string, contents: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); };
    run("init", "--quiet"); run("config", "user.name", "Release Test"); run("config", "user.email", "release@example.com");
    write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 1, version, packages: [{ name: "@openlup/pub", directory: "packages/pub", publish: true }], unreleased: [] }));
    write("packages/pub/package.json", JSON.stringify({ name: "@openlup/pub", version, license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/pub" }, exports: { ".": "./dist/a.js" } }, null, 2));
    write("packages/pub/src/a.ts", "export const a = 1;\n");
    write("packages/pub/dist/a.js", "export const a = 1;\n");
    const commit = () => { run("add", "--all"); run("commit", "--quiet", "-m", "fixture"); return run("rev-parse", "HEAD"); };
    return { repo, write, commit, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
  };

  it("refuses a mismatched or dirty version before writing a release note", () => {
    const sample = fixture("0.9.0");
    try {
      const head = sample.commit();
      expect(() => assertReleasablePackages(sample.repo, head, "openlup-source-preview/10")).toThrow(/packages:check .* refused the target/);
      sample.write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 1, version: "0.10.0", packages: [{ name: "@openlup/pub", directory: "packages/pub", publish: true }], unreleased: [] }));
      expect(() => assertReleasablePackages(sample.repo, head, "openlup-source-preview/10")).toThrow(/without tracked changes/);
      sample.write("packages/pub/package.json", JSON.stringify({ name: "@openlup/pub", version: "0.10.0", license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/pub" }, exports: { ".": "./dist/a.js" } }, null, 2));
      const bumped = sample.commit();
      expect(() => assertReleasablePackages(sample.repo, bumped, "openlup-source-preview/10")).not.toThrow();
    } finally { sample.cleanup(); }
  });

  it("runs the package check before writing notes in release prepare", async () => {
    const sample = syntheticRelease(), out = mkdtempSync(join(tmpdir(), "openlup-prepare-package-check-"));
    try {
      const head = sample.release({ "README.md": "package-gated descendant\n" });
      const check = vi.fn((_root: string, _target: string, _tag: string) => {
        expect(existsSync(join(out, "notes.md"))).toBe(false);
        throw new Error("package scan refused");
      });
      await expect(preparePreview(previewInputs(head, "2", "release note\n"), sample.repo, out, undefined, github({ previousTarget: sample.rootCommit }), check))
        .rejects.toThrow("package scan refused");
      expect(check).toHaveBeenCalledExactlyOnceWith(sample.repo, head, "openlup-source-preview/2");
      expect(existsSync(join(out, "notes.md"))).toBe(false);
    } finally { sample.cleanup(); rmSync(out, { recursive: true, force: true }); }
  });

  it("packs through the same CLI phase used by the unprivileged workflow", () => {
    const sample = fixture("0.9.0"), output = join(mkdtempSync(join(tmpdir(), "openlup-preflight-packs-")), "packs");
    try {
      const old = sample.commit();
      const phase = (head: string, preview: string) => {
        vi.stubEnv("TARGET_COMMIT", head); vi.stubEnv("PREVIEW_NUMBER", preview); vi.stubEnv("RELEASE_NOTES", "release note");
        return spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./source-preview-release.ts", import.meta.url)), "packages", output], { cwd: sample.repo, encoding: "utf8" });
      };
      expect(phase(old, "10").status).toBe(1);
      expect(existsSync(output)).toBe(false);
      const packed = phase(old, "9");
      expect(packed.status, packed.stderr).toBe(0);
      expect(packed.stdout).toContain(`${old} packs a publishable package for openlup-source-preview/9`);
      expect(readFileSync(join(output, "packages-manifest.json"), "utf8")).toContain(old);
      expect(existsSync(join(output, "openlup-pub-0.9.0.tgz"))).toBe(true);
    } finally { vi.unstubAllEnvs(); sample.cleanup(); rmSync(dirname(output), { recursive: true, force: true }); }
  }, 60_000);
});

describe("expand-only platform SQL admission", () => {
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
    "CREATE TABLE app.example (id int);", 'CREATE TABLE "app".example (id int);',
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
