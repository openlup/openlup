import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubFetch } from "../source-preview-release.ts";
import { RELEASE_APP, assertRegistryReady, assertReleaseCandidate, assertTagAbsent, assertVersionUnpublished, checkPackageDraft, packageReleaseInputs, preflightPackageRelease, preparePackageRelease, readPackument, verifyPackageRelease } from "./package-release.ts";

const target = "a".repeat(40), tagObject = "c".repeat(40), api = "https://api.github.com/repos/openlup/openlup", registry = "https://registry.npmjs.org/@openlup%2fcore";
const input = packageReleaseInputs("core", "0.11.0", target, "Reviewed release note.\n");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** Answers each URL from a table; anything else is a 404, as GitHub and npm answer an absent object. */
const routes = (table: Record<string, Response | (() => Response)>): GithubFetch & { calls: string[] } => {
  const calls: string[] = [];
  const fetcher = async (url: string) => { calls.push(url); const answer = table[url]; return typeof answer === "function" ? answer() : answer?.clone() ?? new Response(null, { status: 404 }); };
  return Object.assign(fetcher, { calls });
};
const packument = (versions: string[], times: string[] = versions) => Response.json({ name: "@openlup/core", versions: Object.fromEntries(versions.map((version) => [version, {}])), time: { created: "2026-08-24T00:00:00Z", modified: "2026-10-01T00:00:00Z", ...Object.fromEntries(times.map((version) => [version, "2026-09-01T00:00:00Z"])) } });

describe("package release inputs", () => {
  it("derives the tag, title and message and keeps the exact note bytes", () => {
    expect(input).toEqual({ directory: "packages/core", name: "@openlup/core", version: "0.11.0", target, tag: "openlup-core-v0.11.0", title: "@openlup/core 0.11.0", message: "OpenLup package @openlup/core 0.11.0.", note: "Reviewed release note.\n" });
  });
  it("refuses anything but one canonical value per input", () => {
    for (const value of ["Core", "../core", "", "core v", "-core", "core/x"]) expect(() => packageReleaseInputs(value, "0.11.0", target, "note"), value).toThrow(/package must be/u);
    for (const value of ["0.11", "0.11.0-rc.1", "v0.11.0", "01.0.0", "0.11.0\n", ""]) expect(() => packageReleaseInputs("core", value, target, "note"), value).toThrow(/version must be/u);
    for (const value of ["main", "a".repeat(12), "A".repeat(40), `${target}; echo bad`]) expect(() => packageReleaseInputs("core", "0.11.0", value, "note"), value).toThrow(/full lowercase/u);
    for (const value of [" \n", "", "note\0"]) expect(() => packageReleaseInputs("core", "0.11.0", target, value)).toThrow(/notes must/u);
  });
});

describe("the npm version check", () => {
  it("admits a version npm never held and that is above every held version", () => {
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", undefined)).not.toThrow();
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", { name: "@openlup/core", versions: { "0.0.0": {}, "0.9.0": {}, "0.10.0": {}, "0.11.0-rc.1": {} }, time: { created: "x", modified: "y", "0.9.0": "z" } })).not.toThrow();
  });
  it("refuses a held, a since-unpublished and a lower version, and an unreadable registry document", () => {
    const held = { name: "@openlup/core", versions: { "0.10.0": {} }, time: { "0.10.0": "x", "0.11.0": "unpublished later" } };
    expect(() => assertVersionUnpublished("@openlup/core", "0.10.0", held)).toThrow(/^@openlup\/core@0\.10\.0 is or was on npm; a version is never republished$/u);
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", held)).toThrow(/is or was on npm/u);
    expect(() => assertVersionUnpublished("@openlup/core", "0.9.9", held)).toThrow(/^@openlup\/core@0\.9\.9 is not above @openlup\/core@0\.10\.0 on npm; latest only moves forward$/u);
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", { versions: { "0.12.0-rc.1": {} } })).toThrow(/not above/u);
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", { versions: { "not-a-version": {} } })).toThrow(/not a semver version/u);
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", { versions: ["0.10.0"] })).toThrow(/npm versions is malformed/u);
    expect(() => assertVersionUnpublished("@openlup/core", "0.11.0", { time: "x" })).toThrow(/npm time is malformed/u);
  });
  it("reads the full registry document and treats only 404 as a name npm never held", async () => {
    const fetcher = vi.fn<GithubFetch>(async () => packument(["0.10.0"]));
    await expect(readPackument("@openlup/core", fetcher)).resolves.toMatchObject({ name: "@openlup/core" });
    expect(fetcher).toHaveBeenCalledWith(registry, { headers: { Accept: "application/json" } });
    await expect(readPackument("@openlup/core", routes({}))).resolves.toBeUndefined();
    await expect(readPackument("@openlup/core", routes({ [registry]: new Response(null, { status: 503 }) }))).rejects.toThrow(/HTTP 503/u);
    await expect(readPackument("@openlup/core", routes({ [registry]: Response.json({ name: "@openlup/other" }) }))).rejects.toThrow(/answered @openlup\/other/u);
    await expect(readPackument("@openlup/core", routes({ [registry]: Response.json([]) }))).rejects.toThrow(/malformed/u);
  });
  it("checks a published release tag against npm, and refuses any other tag", async () => {
    await expect(assertRegistryReady("openlup-core-v0.11.0", routes({ [registry]: packument(["0.10.0"]) }))).resolves.toBeUndefined();
    await expect(assertRegistryReady("openlup-core-v0.11.0", routes({ [registry]: packument(["0.11.0"]) }))).rejects.toThrow(/is or was on npm/u);
    for (const tag of ["openlup-source-preview/11", "x-openlup-core-v0.11.0", "openlup-core-v0.11.0-rc.1"]) await expect(assertRegistryReady(tag, routes({}))).rejects.toThrow(/not a package release tag/u);
  });
});

describe("the tag and draft checks", () => {
  it("requires the release tag to be absent", async () => {
    const ref = `${api}/git/ref/tags/openlup-core-v0.11.0`;
    await expect(assertTagAbsent(input.tag, undefined, routes({}))).resolves.toBeUndefined();
    await expect(assertTagAbsent(input.tag, undefined, routes({ [ref]: Response.json({}) }))).rejects.toThrow(/present or unavailable \(HTTP 200\); never retag/u);
    await expect(assertTagAbsent(input.tag, undefined, routes({ [ref]: new Response(null, { status: 403 }) }))).rejects.toThrow(/HTTP 403/u);
  });

  const draft = { id: 77, tag_name: input.tag, name: input.title, draft: true, prerelease: false, body: input.note, assets: [] };
  it("reads only the created draft, waiting out two 404 answers", async () => {
    let answers = 0;
    const pause = vi.fn(async () => undefined);
    const fetcher = routes({ [`${api}/releases/77`]: () => (++answers < 3 ? new Response(null, { status: 404 }) : Response.json(draft)) });
    await expect(checkPackageDraft("77", input, undefined, fetcher, pause)).resolves.toBeUndefined();
    expect(pause).toHaveBeenCalledTimes(2);
    expect(fetcher.calls).toEqual(Array(3).fill(`${api}/releases/77`));
    await expect(checkPackageDraft("77", input, undefined, routes({}), pause)).rejects.toThrow(/HTTP 404/u);
    for (const id of ["0", "x", "-1", "077", "9007199254740993"]) await expect(checkPackageDraft(id, input, undefined, routes({}), pause), id).rejects.toThrow(/RELEASE_ID/u);
  });
  it("refuses a draft that differs from the prepared release in any field", async () => {
    const pause = async () => undefined;
    for (const change of [{ id: 78 }, { tag_name: "openlup-core-v0.12.0" }, { name: "@openlup/core 0.12.0" }, { draft: false }, { prerelease: true }]) {
      await expect(checkPackageDraft("77", input, undefined, routes({ [`${api}/releases/77`]: Response.json({ ...draft, ...change }) }), pause), JSON.stringify(change)).rejects.toThrow(/identity differs/u);
    }
    await expect(checkPackageDraft("77", input, undefined, routes({ [`${api}/releases/77`]: Response.json({ ...draft, body: `${input.note}\n` }) }), pause)).rejects.toThrow(/body differs/u);
    await expect(checkPackageDraft("77", input, undefined, routes({ [`${api}/releases/77`]: Response.json({ ...draft, assets: [{ name: "x" }] }) }), pause)).rejects.toThrow(/no asset/u);
  });

  const published = { ...draft, draft: false, immutable: true, author: { id: RELEASE_APP.id, login: RELEASE_APP.login } };
  const githubRelease = (release: object, ref: object = {}, tag: object = {}) => routes({
    [`${api}/releases/tags/openlup-core-v0.11.0`]: Response.json(release),
    [`${api}/git/ref/tags/openlup-core-v0.11.0`]: Response.json({ ref: "refs/tags/openlup-core-v0.11.0", object: { type: "tag", sha: tagObject }, ...ref }),
    [`${api}/git/tags/${tagObject}`]: Response.json({ sha: tagObject, tag: "openlup-core-v0.11.0", message: "OpenLup package @openlup/core 0.11.0.\n", object: { type: "commit", sha: target }, ...tag }),
  });
  it("verifies the created immutable release, its App author, its note and its annotated tag at the target", async () => {
    await expect(verifyPackageRelease("77", input, undefined, githubRelease(published))).resolves.toBeUndefined();
    for (const change of [{ id: 78 }, { immutable: false }, { prerelease: true }, { draft: true }, { tag_name: "openlup-core-v0.12.0" }]) await expect(verifyPackageRelease("77", input, undefined, githubRelease({ ...published, ...change })), JSON.stringify(change)).rejects.toThrow(/not the created immutable published release/u);
    for (const author of [{ id: 43, login: RELEASE_APP.login }, { id: RELEASE_APP.id, login: "someone" }]) await expect(verifyPackageRelease("77", input, undefined, githubRelease({ ...published, author }))).rejects.toThrow(/not authored by the release App/u);
    await expect(verifyPackageRelease("77", input, undefined, githubRelease({ ...published, author: undefined }))).rejects.toThrow(/release author is malformed/u);
    await expect(verifyPackageRelease("77", input, undefined, githubRelease({ ...published, body: "edited" }))).rejects.toThrow(/body differs/u);
    await expect(verifyPackageRelease("77", input, undefined, githubRelease({ ...published, assets: [{ name: "x" }] }))).rejects.toThrow(/no asset/u);
    await expect(verifyPackageRelease("77", input, undefined, githubRelease(published, {}, { object: { type: "commit", sha: "b".repeat(40) } }))).rejects.toThrow(/prepared target or message/u);
    await expect(verifyPackageRelease("77", input, undefined, githubRelease(published, {}, { message: "OpenLup package @openlup/core 0.11.0.\n\nExtra\n" }))).rejects.toThrow(/prepared target or message/u);
    await expect(verifyPackageRelease("77", input, undefined, githubRelease(published, { object: { type: "commit", sha: target } }))).rejects.toThrow(/annotated tag/u);
  });
});

describe("the release candidate at the target commit", () => {
  function repository(version = "0.11.0", publish = true) {
    const repo = mkdtempSync(join(tmpdir(), "openlup-package-release-"));
    const out = mkdtempSync(join(tmpdir(), "openlup-package-release-out-"));
    cleanups.push(() => { rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" }).trim();
    const write = (path: string, contents: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); };
    write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish }], unreleased: [] }));
    write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version }));
    git("init", "--quiet"); git("add", "--all"); git("commit", "--quiet", "-m", "fixture");
    const head = git("rev-parse", "HEAD");
    return { repo, out, head, write, input: packageReleaseInputs("core", "0.11.0", head, "note\n") };
  }

  it("requires the clean target, a publishable package and exactly the requested manifest version", () => {
    const ready = repository();
    expect(() => assertReleaseCandidate(ready.repo, ready.input)).not.toThrow();
    expect(() => assertReleaseCandidate(ready.repo, { ...ready.input, target })).toThrow(/target commit without tracked changes/u);
    ready.write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "0.11.0", extra: true }));
    expect(() => assertReleaseCandidate(ready.repo, ready.input)).toThrow(/target commit without tracked changes/u);
    const skewed = repository("0.10.0");
    expect(() => assertReleaseCandidate(skewed.repo, skewed.input)).toThrow(/^packages\/core\/package\.json is at 0\.10\.0, not 0\.11\.0; merge its release:bump first$/u);
    const unpublishable = repository("0.11.0", false);
    expect(() => assertReleaseCandidate(unpublishable.repo, unpublishable.input)).toThrow(/is not a publishable package/u);
    const other = repository();
    expect(() => assertReleaseCandidate(other.repo, packageReleaseInputs("ui", "0.11.0", other.head, "note\n"))).toThrow(/packages\/ui is not a publishable package/u);
  });

  it("refuses before any network read when the candidate is wrong, and writes the note only after every refusal", async () => {
    const skewed = repository("0.10.0");
    const untouched = routes({});
    await expect(preflightPackageRelease(skewed.repo, skewed.input, undefined, untouched)).rejects.toThrow(/merge its release:bump first/u);
    expect(untouched.calls).toEqual([]);
    const ready = repository();
    const ref = `${api}/git/ref/tags/openlup-core-v0.11.0`;
    await expect(preparePackageRelease(ready.repo, ready.input, ready.out, undefined, routes({ [ref]: Response.json({}) }))).rejects.toThrow(/never retag/u);
    await expect(preparePackageRelease(ready.repo, ready.input, ready.out, undefined, routes({ [registry]: packument(["0.11.0"]) }))).rejects.toThrow(/is or was on npm/u);
    await expect(preparePackageRelease(ready.repo, ready.input, ready.out, undefined, routes({ [registry]: packument(["1.0.0"]) }))).rejects.toThrow(/not above/u);
    expect(existsSync(join(ready.out, "notes.md"))).toBe(false);
    await expect(preparePackageRelease(ready.repo, ready.input, ready.out, undefined, routes({ [registry]: packument(["0.10.0"]) }))).resolves.toBeUndefined();
    expect(readFileSync(join(ready.out, "notes.md"), "utf8")).toBe("note\n");
    await expect(preparePackageRelease(ready.repo, ready.input, ready.out, undefined, routes({ [registry]: packument(["0.10.0"]) }))).rejects.toThrow(/EEXIST/u);
  });
});

describe("the command line", () => {
  const script = fileURLToPath(new URL("./package-release.ts", import.meta.url));
  const run = (args: string[], env: Record<string, string>) => {
    const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
    return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { encoding: "utf8", env: { ...inherited, PACKAGE: "", VERSION: "", TARGET_COMMIT: "", RELEASE_NOTES: "", RELEASE_TAG: "", ...env }, timeout: 20_000 });
  };
  it("refuses a missing or unknown phase and malformed inputs before any read", () => {
    for (const args of [[], ["publish"], ["preflight", "extra"]]) expect(run(args, { PACKAGE: "core", VERSION: "0.11.0", TARGET_COMMIT: target, RELEASE_NOTES: "note" }), args.join(" ")).toMatchObject({ status: 1, stderr: expect.stringContaining("expected one phase") });
    expect(run(["preflight"], { PACKAGE: "../core", VERSION: "0.11.0", TARGET_COMMIT: target, RELEASE_NOTES: "note" })).toMatchObject({ status: 1, stderr: expect.stringContaining("package must be") });
    expect(run(["registry"], { RELEASE_TAG: "openlup-source-preview/11" })).toMatchObject({ status: 1, stderr: expect.stringContaining("not a package release tag") });
  });
});
