// Seeded falsifiers for set releases: below 1.0 every publishable package ships at one set
// version 0.N.P from one commit. Each control is a behaviour of a committed module, checked
// against real Git fixtures and a recorded GitHub and npm API. Each planted defect edits that
// module's source, loads the edited copy with its relative imports bound to the committed
// modules, and must turn its control red.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GithubFetch } from "../source-preview-release.ts";
import * as policy from "./package-manifest-policy.ts";
import * as check from "./packages-check.ts";
import * as bump from "./release-bump.ts";
import * as release from "./package-release.ts";

const FILES = { policy: "package-manifest-policy.ts", check: "packages-check.ts", bump: "release-bump.ts", release: "package-release.ts" } as const;
/** The modules, and the file the release workflow runs as package-release.ts. */
type Modules = { policy: typeof policy; check: typeof check; bump: typeof bump; release: typeof release; releaseScript: string };
const committed: Modules = { policy, check, bump, release, releaseScript: fileURLToPath(new URL("./package-release.ts", import.meta.url)) };
const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
const identity = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: { ...inherited, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
/** The annotated tag the release workflow makes: the release App as tagger, the release message. */
const appTag = (cwd: string, name: string, version: string, commit: string, message = `OpenLup package @openlup/${name} ${version}.`) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "tag", "-a", "-m", message, `openlup-${name}-v${version}`, commit], { cwd, env: { ...inherited, ...identity, GIT_COMMITTER_NAME: "openlup-release[bot]", GIT_COMMITTER_EMAIL: "334697227+openlup-release[bot]@users.noreply.github.com" }, stdio: "ignore" });
let scratch = "";

// --- A repository with two publishable packages and one private package that pins core. ---
const build = "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/a.js','export const a = 1;\\n')\"";
const publishable = (name: string, version: string, extra: Record<string, unknown> = {}) => ({ name: `@openlup/${name}`, version, license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: policy.PUBLIC_REPOSITORY_URL, directory: `packages/${name}` }, exports: { ".": "./dist/a.js" }, scripts: { build }, ...extra });
const changelog = (version: string, name: string) => `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A fix.\n\n## [${version}]\n\n- Publishable on the npm \`latest\` dist-tag as \`${version}\`, from tag\n  \`openlup-${name}-v${version}\`.\n`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
type Fixture = { root: string; write: (path: string, contents: string) => void; read: (path: string) => string; commit: (message: string) => string };

/** Commit A: core and kit publishable at 0.4.0 (kit peer-pins core in its manifest and lockfile), demo private at 0.1.0 pinning both; the App's 0.4.0 tags at A. */
function fixture({ kitPublishable = true } = {}): Fixture & { a: string } {
  const root = realpathSync(mkdtempSync(join(scratch, "repository-")));
  const write = (path: string, contents: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); };
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const commit = (message: string) => { git(root, "add", "--all"); git(root, "commit", "--quiet", "-m", message); return git(root, "rev-parse", "HEAD"); };
  write("config/openlup-packages.json", json({ schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: true }, { name: "@openlup/kit", directory: "packages/kit", publish: kitPublishable }, { name: "@openlup/demo", directory: "packages/demo", publish: false }], unreleased: [] }));
  write("packages/core/package.json", json(publishable("core", "0.4.0")));
  const kit = { peerDependencies: { "@openlup/core": "0.4.0" } };
  write("packages/kit/package.json", json(kitPublishable ? publishable("kit", "0.4.0", kit) : { name: "@openlup/kit", version: "0.4.0", private: true, exports: { ".": "./dist/a.js" }, ...kit }));
  write("packages/demo/package.json", json({ name: "@openlup/demo", version: "0.1.0", private: true, exports: { ".": "./dist/a.js" }, dependencies: { "@openlup/core": "0.4.0" }, optionalDependencies: { "@openlup/kit": "0.4.0" } }));
  write("package-lock.json", json({ name: "fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", workspaces: ["packages/*"] }, "node_modules/unrelated": { version: "0.4.0" }, "packages/core": { name: "@openlup/core", version: "0.4.0" }, "packages/kit": { name: "@openlup/kit", version: "0.4.0", peerDependencies: { "@openlup/core": "0.4.0" } }, "packages/demo": { name: "@openlup/demo", version: "0.1.0", dependencies: { "@openlup/core": "0.4.0" }, optionalDependencies: { "@openlup/kit": "0.4.0" } } } }));
  write("packages/core/package-lock.json", json({ name: "@openlup/core", version: "0.4.0", lockfileVersion: 3, packages: { "": { name: "@openlup/core", version: "0.4.0" } } }));
  write("packages/kit/package-lock.json", json({ name: "@openlup/kit", version: "0.4.0", lockfileVersion: 3, packages: { "": { name: "@openlup/kit", version: "0.4.0", peerDependencies: { "@openlup/core": "0.4.0" } } } }));
  for (const name of ["core", "kit"]) {
    write(`packages/${name}/CHANGELOG.md`, changelog("0.4.0", name));
    write(`packages/${name}/api/${name}.api.md`, `# ${name} API\n`);
    write(`packages/${name}/src/a.ts`, "export const a = 1;\n");
  }
  write(".gitignore", "dist/\n");
  git(root, "init", "--quiet");
  const a = commit("A");
  for (const name of ["core", "kit"]) appTag(root, name, "0.4.0", a);
  return { root, write, read, commit, a };
}

// --- GitHub and npm, answered by URL. ---
const API = "https://api.github.com/repos/openlup/openlup";
const REGISTRY = "https://registry.npmjs.org";
const TARGET = "a".repeat(40);
const APP = { id: 334697227, login: "openlup-release[bot]" };
const TAR = Buffer.from("package/package.json and its files, as one tar stream");
/** The same tar, gzipped as two machines might: different bytes, the same content. */
const PACKED = gzipSync(TAR, { level: 9 }), PUBLISHED = gzipSync(TAR, { level: 1 });
const integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
type Answer = Response | (() => Response);
const routes = (table: Record<string, Answer>): GithubFetch => async (url: string) => {
  const answer = table[url.startsWith(`${REGISTRY}/@openlup%2f`) ? url.split("?")[0]! : url];
  return typeof answer === "function" ? answer() : answer?.clone() ?? new Response(null, { status: 404 });
};
/** The tag, the release and the npm document of `name@version`, each present or absent as asked. */
function world(name: string, version: string, { tag = false, release = false, npm = [] as string[], held = undefined as Uint8Array | undefined, tagPatch = {}, releasePatch = {}, distPatch = {}, times = [] as string[], target = TARGET } = {}): Record<string, Answer> {
  const tagName = `openlup-${name}-v${version}`, tarball = `${REGISTRY}/@openlup/${name}/-/${name}-${version}.tgz`;
  const versions: Record<string, unknown> = Object.fromEntries(npm.map((other) => [other, { dist: { tarball: `${REGISTRY}/@openlup/${name}/-/${name}-${other}.tgz`, integrity: "sha512-other" } }]));
  if (held) versions[version] = { dist: { tarball, integrity: integrity(held), ...distPatch } };
  const table: Record<string, Answer> = {
    [`${REGISTRY}/@openlup%2f${name}`]: Response.json({ name: `@openlup/${name}`, versions, time: { created: "x", modified: "y", ...Object.fromEntries([...Object.keys(versions), ...times].map((other) => [other, "z"])) } }),
  };
  if (held) table[tarball] = () => new Response(held);
  if (tag) {
    const tagObject = createHash("sha1").update(tagName).digest("hex");
    table[`${API}/git/ref/tags/${tagName}`] = Response.json({ ref: `refs/tags/${tagName}`, object: { type: "tag", sha: tagObject } });
    table[`${API}/git/tags/${tagObject}`] = Response.json({ sha: tagObject, tag: tagName, message: `OpenLup package @openlup/${name} ${version}.\n`, object: { type: "commit", sha: target }, ...tagPatch });
  }
  if (release) table[`${API}/releases/tags/${tagName}`] = Response.json({ id: 7, tag_name: tagName, immutable: true, draft: false, prerelease: false, author: APP, assets: [], ...releasePatch });
  return table;
}
const input = (version = "0.4.1", name = "core", target = TARGET) => release.packageReleaseInputs(name, version, target, "Set note.\n");
/**
 * Runs `script` as the release workflow does, in `cwd`. Its fetch refuses every read, or with
 * FETCH_TABLE answers each URL, without its query, from that JSON file and 404 otherwise.
 */
function cli(script: string, cwd: string, args: string[], env: Record<string, string>) {
  const stub = join(scratch, "fetch-stub.mjs");
  if (!existsSync(stub)) writeFileSync(stub, "import { readFileSync } from \"node:fs\";\nconst table = process.env.FETCH_TABLE ? JSON.parse(readFileSync(process.env.FETCH_TABLE, \"utf8\")) : undefined;\nglobalThis.fetch = async (url) => {\n  if (!table) throw new Error(`network read ${url}`);\n  const answer = table[String(url).split(\"?\")[0]];\n  return answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer);\n};\n");
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", pathToFileURL(stub).href, script, ...args], { cwd, encoding: "utf8", timeout: 60_000, env: { ...inherited, FETCH_TABLE: "", GITHUB_TOKEN: "", GITHUB_OUTPUT: "", RELEASE_OUTPUT_DIR: "", RELEASE_NOTES: "Set note.\n", ...env } });
}
const API_REFUSAL = "packages/core/api differs from openlup-core-v0.4.0; a patch set only fixes, so an API change is a minor set";
let outputs = 0;

/** Each behaviour throws unless it holds for the given modules. */
const BEHAVIOUR: Record<string, (m: Modules) => Promise<void>> = {
  "publishable packages carry one set version": async (m) => {
    const config = m.policy.parsePackagesConfig(readFileSync(join(fixture().root, policy.PACKAGES_CONFIG_PATH), "utf8"));
    const versions = (core: string, kit: string, demo = "0.1.0") => new Map([["@openlup/core", core], ["@openlup/kit", kit], ["@openlup/demo", demo]]);
    expect(m.policy.checkSetVersions(config, versions("0.4.0", "0.4.0"))).toEqual([]);
    expect(m.policy.checkSetVersions(config, versions("0.4.0", "0.4.0", "2.0.0")), "a private package keeps its own version").toEqual([]);
    expect(m.policy.checkSetVersions(config, versions("0.4.0", "0.5.0"))).toEqual([{ subject: policy.PACKAGES_CONFIG_PATH, rule: "set-version", detail: "every publishable package carries one set version, not @openlup/core@0.4.0, @openlup/kit@0.5.0; run npm run release:bump -- --set <version>" }]);
  },
  "a publishable package carries a set version 0.N.P below 1.0": async (m) => {
    const config = m.policy.parsePackagesConfig(readFileSync(join(fixture().root, policy.PACKAGES_CONFIG_PATH), "utf8"));
    const both = (version: string) => m.policy.checkSetVersions(config, new Map([["@openlup/core", version], ["@openlup/kit", version], ["@openlup/demo", "1.0.0"]]));
    for (const version of ["0.4.0", "0.12.1", "0.99.10"]) expect(both(version), version).toEqual([]);
    for (const version of ["1.0.0", "1.12.0", "0.0.3", "2.0.1"]) expect(both(version), version).toEqual(["core", "kit"].map((name) => ({ subject: `@openlup/${name}`, rule: "set-version", detail: `${version} is not a set version 0.N.P below 1.0` })));
  },
  "no package directory takes the set's dispatch name": async (m) => {
    const config = (packages: unknown[], unreleased: unknown[] = []) => JSON.stringify({ schemaVersion: 2, packages, unreleased });
    expect(() => m.policy.parsePackagesConfig(config([{ name: "@openlup/all", directory: "packages/all", publish: true }]))).toThrow("config/openlup-packages.json: packages/all is reserved: a release dispatch names the whole set with all");
    expect(() => m.policy.parsePackagesConfig(config([{ name: "@openlup/core", directory: "packages/core", publish: true }], [{ directory: "packages/all", reason: "scaffold" }]))).toThrow(/packages\/all is reserved/u);
    expect(m.policy.parsePackagesConfig(config([{ name: "@openlup/allure", directory: "packages/allure", publish: true }])).packages).toHaveLength(1);
  },
  "packages:check refuses a tree outside the set rule": async (m) => {
    const errors = quiet();
    const { root, write, read } = fixture();
    expect(m.check.runPackagesCheck(root, [])).toBe(0);
    const kit = read("packages/kit/package.json");
    for (const [why, core, other] of [["two versions", "0.4.0", "0.5.0"], ["1.0.0", "1.0.0", "1.0.0"]] as const) {
      write("packages/core/package.json", json(publishable("core", core)));
      write("packages/kit/package.json", kit.replace('"version": "0.4.0"', `"version": "${other}"`).replace('"@openlup/core": "0.4.0"', `"@openlup/core": "${core}"`));
      write("packages/demo/package.json", read("packages/demo/package.json").replace(/"@openlup\/core": "[^"]+"/u, `"@openlup/core": "${core}"`));
      errors.mockClear();
      expect(m.check.runPackagesCheck(root, []), why).toBe(1);
      expect(errors.mock.calls.flat().join("\n"), why).toMatch(/^set-version /mu);
    }
  },
  "--release-set packs every publishable package, each at the set version": async (m) => {
    quiet();
    const { root } = fixture();
    const out = mkdtempSync(join(scratch, "packs-"));
    expect(m.check.runPackagesCheck(root, ["--release-set", "0.4.0", "--out", out])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, check.PACKAGES_MANIFEST_FILE), "utf8")) as { packages: Array<{ name: string; version: string }> };
    expect(manifest.packages.map(({ name, version }) => `${name}@${version}`)).toEqual(["@openlup/core@0.4.0", "@openlup/kit@0.4.0"]);
    for (const version of ["0.4.1", "0.5.0", "1.0.0", "0.4"]) expect(m.check.runPackagesCheck(root, ["--release-set", version]), version).toBe(1);
    expect(m.check.runPackagesCheck(root, ["--release-set", "0.4.0", "--release-tag", "openlup-core-v0.4.0"]), "one package and the set at once").toBe(2);
  },
  "release:bump --set moves every publishable package and every exact pin on one": async (m) => {
    const { root, read } = fixture();
    expect(m.bump.bumpSet(root, "0.5.0").sort()).toEqual(["package-lock.json", "packages/core/CHANGELOG.md", "packages/core/package-lock.json", "packages/core/package.json", "packages/demo/package.json", "packages/kit/CHANGELOG.md", "packages/kit/package-lock.json", "packages/kit/package.json"]);
    const manifest = (name: string) => JSON.parse(read(`packages/${name}/package.json`));
    expect([manifest("core").version, manifest("kit").version, manifest("kit").peerDependencies, manifest("demo").version, manifest("demo").dependencies, manifest("demo").optionalDependencies]).toEqual(["0.5.0", "0.5.0", { "@openlup/core": "0.5.0" }, "0.1.0", { "@openlup/core": "0.5.0" }, { "@openlup/kit": "0.5.0" }]);
    expect(JSON.parse(read("package-lock.json")).packages).toMatchObject({ "node_modules/unrelated": { version: "0.4.0" }, "packages/core": { version: "0.5.0" }, "packages/kit": { version: "0.5.0", peerDependencies: { "@openlup/core": "0.5.0" } }, "packages/demo": { version: "0.1.0", dependencies: { "@openlup/core": "0.5.0" }, optionalDependencies: { "@openlup/kit": "0.5.0" } } });
    expect(JSON.parse(read("packages/core/package-lock.json"))).toMatchObject({ version: "0.5.0", packages: { "": { version: "0.5.0" } } });
    expect(JSON.parse(read("packages/kit/package-lock.json"))).toMatchObject({ version: "0.5.0", packages: { "": { version: "0.5.0", peerDependencies: { "@openlup/core": "0.5.0" } } } });
    quiet();
    expect(committed.check.runPackagesCheck(root, []), "the bumped tree passes packages:check").toBe(0);
    for (const version of ["0.5.0", "0.4.9", "1.0.0", "0.0.9"]) expect(() => m.bump.bumpSet(root, version), version).toThrow(/is not a set version|the next set version must be above it/u);
    const skewed = fixture();
    skewed.write("packages/kit/package.json", skewed.read("packages/kit/package.json").replace('"version": "0.4.0"', '"version": "0.3.0"'));
    const before = skewed.read("packages/core/package.json");
    expect(() => m.bump.bumpSet(skewed.root, "0.5.0")).toThrow("the publishable packages carry different versions (@openlup/core@0.4.0, @openlup/kit@0.3.0); packages:check refuses that");
    expect(skewed.read("packages/core/package.json")).toBe(before);
  },
  "the Publishable line opens a new version section below Unreleased": async (m) => {
    const text = changelog("0.4.0", "core");
    expect(m.bump.addReleaseSection("CHANGELOG.md", text, "0.4.1", "openlup-core-v0.4.1")).toBe(text.replace("## [Unreleased]\n\n", "$&## [0.4.1]\n\n- Publishable on the npm `latest` dist-tag as `0.4.1`, from tag\n  `openlup-core-v0.4.1`.\n\n"));
    expect(() => m.bump.addReleaseSection("CHANGELOG.md", text, "0.4.0", "openlup-core-v0.4.0")).toThrow("CHANGELOG.md: already has a 0.4.0 section");
    expect(() => m.bump.addReleaseSection("CHANGELOG.md", "# Changelog\n\n## [0.4.0]\n", "0.4.1", "openlup-core-v0.4.1")).toThrow(/has no "## \[Unreleased\]" heading/u);
  },
  "a publishable package moves only with its set, at a set version": async (m) => {
    const both = fixture();
    expect(() => m.bump.bumpRelease(both.root, "core", "0.5.0")).toThrow("@openlup/core moves with its set: npm run release:bump -- --set <version>");
    const alone = fixture({ kitPublishable: false });
    expect(() => m.bump.bumpRelease(alone.root, "core", "1.0.0")).toThrow("@openlup/core is publishable, so its next version is a set version 0.N.P below 1.0, not 1.0.0");
    expect(m.bump.bumpRelease(alone.root, "core", "0.5.0")).toContain("packages/core/package.json");
    expect(JSON.parse(alone.read("packages/kit/package.json")).peerDependencies).toEqual({ "@openlup/core": "0.5.0" });
  },
  "a package's tag, release and npm state decide skip, resume or full": async (m) => {
    expect(await m.release.packageState(input(), PACKED, undefined, routes(world("core", "0.4.1", { npm: ["0.4.0"] })))).toBe("full");
    expect(await m.release.packageState(input(), PACKED, undefined, routes(world("core", "0.4.1", { tag: true, release: true, npm: ["0.4.0"] })))).toBe("resume");
    expect(await m.release.packageState(input(), PACKED, undefined, routes(world("core", "0.4.1", { tag: true, release: true, npm: ["0.4.0"], held: PUBLISHED })))).toBe("skip");
    expect(await m.release.packageState(input("0.4.0", "kit"), PACKED, undefined, routes({})), "a name npm never held").toBe("full");
  },
  "every other state stops the set": async (m) => {
    const state = (options: Parameters<typeof world>[2], version = "0.4.1") => m.release.packageState(input(version), PACKED, undefined, routes(world("core", version, options)));
    const stops: Array<[string, Parameters<typeof world>[2], RegExp]> = [
      ["a tag without its release", { tag: true }, /exists without its published release, or the reverse/u],
      ["a release without its tag", { release: true }, /exists without its published release, or the reverse/u],
      ["the tag at another commit", { tag: true, release: true, target: "b".repeat(40) }, /names another commit or message/u],
      ["the tag with another message", { tag: true, release: true, tagPatch: { message: "OpenLup package @openlup/core 0.4.2.\n" } }, /names another commit or message/u],
      ["a mutable release", { tag: true, release: true, releasePatch: { immutable: false } }, /is not an immutable, published, App-authored release/u],
      ["a draft", { tag: true, release: true, releasePatch: { draft: true } }, /is not an immutable, published, App-authored release/u],
      ["a prerelease", { tag: true, release: true, releasePatch: { prerelease: true } }, /is not an immutable, published, App-authored release/u],
      ["another author", { tag: true, release: true, releasePatch: { author: { id: 43, login: APP.login } } }, /is not an immutable, published, App-authored release/u],
      ["a release asset", { tag: true, release: true, releasePatch: { assets: [{ id: 1 }] } }, /is not an immutable, published, App-authored release/u],
      ["npm holding another tarball", { tag: true, release: true, held: gzipSync(Buffer.from("other content")) }, /npm holds @openlup\/core@0\.4\.1 with another tarball/u],
      ["npm once held the version", { tag: true, release: true, times: ["0.4.1"] }, /was on npm and is gone; a version is never republished/u],
      ["npm holding the version without its tag", { held: PUBLISHED }, /is or was on npm, but openlup-core-v0\.4\.1 does not exist/u],
      ["npm holding a later version", { npm: ["0.5.0"] }, /is not above @openlup\/core@0\.5\.0 on npm/u],
      ["npm holding a later version, after a complete release", { tag: true, release: true, held: PUBLISHED, npm: ["0.5.0"] }, /is not above @openlup\/core@0\.5\.0 on npm/u],
    ];
    for (const [why, options, message] of stops) await expect(state(options), why).rejects.toThrow(message);
    const lightweight = { ...world("core", "0.4.1", { release: true }), [`${API}/git/ref/tags/openlup-core-v0.4.1`]: Response.json({ ref: "refs/tags/openlup-core-v0.4.1", object: { type: "commit", sha: TARGET } }) };
    await expect(m.release.packageState(input(), PACKED, undefined, routes(lightweight)), "a lightweight tag").rejects.toThrow(/must be an annotated tag/u);
    const refused = { ...world("core", "0.4.1"), [`${API}/git/ref/tags/openlup-core-v0.4.1`]: new Response(null, { status: 403 }) };
    await expect(m.release.packageState(input(), PACKED, undefined, routes(refused)), "a refused read").rejects.toThrow(/HTTP 403/u);
  },
  "the same tarball: npm's bytes match its integrity and unpack to the packed tar": async (m) => {
    const complete = { tag: true, release: true, held: PUBLISHED };
    expect(await m.release.packageState(input(), PACKED, undefined, routes(world("core", "0.4.1", complete))), "gzip bytes differ, the tar is the same").toBe("skip");
    await expect(m.release.packageState(input(), PACKED, undefined, routes(world("core", "0.4.1", { ...complete, distPatch: { integrity: integrity(PACKED) } }))), "npm's bytes do not match its integrity").rejects.toThrow(/does not match npm's integrity/u);
    await expect(m.release.packageState(input(), PACKED, undefined, routes(world("core", "0.4.1", { ...complete, distPatch: { tarball: "https://example.invalid/core-0.4.1.tgz" } }))), "a tarball outside the registry").rejects.toThrow(/as the tarball of @openlup\/core@0\.4\.1/u);
  },
  "a patch set keeps each package's API snapshot from its previous set": async (m) => {
    const repository = fixture();
    repository.write("packages/core/src/a.ts", "export const a = 2;\n");
    const fix = repository.commit("B: a fix");
    const guard = (version: string, target: string, name = "core") => m.release.assertPatchSetApiUnchanged(repository.root, `packages/${name}`, version, target);
    for (const version of ["0.4.1", "0.4.7"]) expect(() => guard(version, fix), version).not.toThrow();
    repository.write("packages/core/api/core.api.md", "# core API\n\nexport declare const added: 1;\n");
    const change = repository.commit("C: an API change");
    for (const version of ["0.5.0", "0.4.0"]) expect(() => guard(version, change), version).not.toThrow();
    expect(() => guard("0.4.1", change)).toThrow("packages/core/api differs from openlup-core-v0.4.0; a patch set only fixes, so an API change is a minor set");
    appTag(repository.root, "core", "0.4.1", change);
    expect(() => guard("0.4.2", change), "against the latest earlier patch").not.toThrow();
    expect(() => guard("0.4.2", fix), "back to the API of 0.4.0 differs from 0.4.1").toThrow(/differs from openlup-core-v0\.4\.1;/u);
    // Later tags at the fix, with the API of 0.4.0, that the release App did not make: none moves the baseline.
    git(repository.root, "tag", "openlup-core-v0.4.3", fix);
    git(repository.root, "tag", "-a", "-m", "OpenLup package @openlup/core 0.4.4.", "openlup-core-v0.4.4", fix);
    appTag(repository.root, "core", "0.4.5", fix, "OpenLup package @openlup/core 0.4.5, by hand.");
    expect(() => guard("0.4.6", change), "a lightweight, a hand-made and a misworded tag are not the previous set").not.toThrow();
    expect(() => guard("0.4.6", fix)).toThrow(/differs from openlup-core-v0\.4\.1;/u);
    expect(() => guard("0.6.1", change)).toThrow("0.6.1 is a patch set, but core has no earlier 0.6.<p> set tag; a package joins the set at a minor set");
    expect(() => guard("1.0.1", change)).toThrow(/is not a set version/u);
  },
  "the release plan: one package only from nothing; a set skips, resumes, and releases at least one": async (m) => {
    const repository = fixture();
    const packs = mkdtempSync(join(scratch, "plan-packs-"));
    const tarballs = { core: PACKED, kit: gzipSync(Buffer.from("kit tar")) };
    const packed = (commit = repository.a) => writeFileSync(join(packs, check.PACKAGES_MANIFEST_FILE), JSON.stringify({ schemaVersion: 2, commit, packages: (["core", "kit"] as const).map((name) => ({ name: `@openlup/${name}`, version: "0.4.0", filename: `openlup-${name}-0.4.0.tgz`, sha256: createHash("sha256").update(tarballs[name]).digest("hex"), integrity: integrity(tarballs[name]) })) }));
    for (const name of ["core", "kit"] as const) writeFileSync(join(packs, `openlup-${name}-0.4.0.tgz`), tarballs[name]);
    packed();
    const set = release.setReleaseInputs("0.4.0", repository.a, "Set note.\n");
    const at = { target: repository.a };
    const lines: string[] = [];
    const plan = (requested: release.PackageRelease | release.SetRelease, table: Record<string, Answer>) => m.release.planRelease(repository.root, packs, requested, undefined, routes(table), (line) => { lines.push(line); });
    const coreDone = world("core", "0.4.0", { ...at, tag: true, release: true, held: PUBLISHED });
    const kitResume = world("kit", "0.4.0", { ...at, tag: true, release: true });
    expect(await plan(set, { ...coreDone, ...world("kit", "0.4.0", at) })).toEqual(["kit"]);
    expect(lines).toEqual(["openlup-core-v0.4.0: skip, npm holds this tarball", "openlup-kit-v0.4.0: release in full"]);
    expect(await plan(set, { ...world("core", "0.4.0", at), ...kitResume })).toEqual(["core"]);
    await expect(plan(set, { ...coreDone, ...kitResume }), "nothing to release in full").rejects.toThrow(/^nothing to release in full at 0\.4\.0/u);
    expect(lines.at(-1)).toBe("::warning::openlup-kit-v0.4.0: resume, the release exists and npm lacks 0.4.0; re-run the failed Publish Packages run of openlup-kit-v0.4.0");
    const one = input("0.4.0", "core", repository.a);
    expect(await plan(one, world("core", "0.4.0", at))).toEqual(["core"]);
    await expect(plan(one, coreDone), "one package that is released").rejects.toThrow("openlup-core-v0.4.0 has a release already; dispatch package all to resume a set");
    await expect(plan(one, world("core", "0.4.0", { ...at, tag: true, release: true })), "one package to resume").rejects.toThrow(/has a release already/u);
    packed("d".repeat(40));
    await expect(plan(set, world("core", "0.4.0", at)), "a packs manifest of another commit").rejects.toThrow("the packs manifest is not the target's");
    packed();
    writeFileSync(join(packs, "openlup-core-0.4.0.tgz"), gzipSync(Buffer.from("changed")));
    await expect(plan(set, world("core", "0.4.0", at)), "a tarball changed after packing").rejects.toThrow("openlup-core-0.4.0.tgz changed after packing");
  },
  "every preflight and each release leg run the patch-set check, before any network read": async (m) => {
    const repository = fixture();
    committed.bump.bumpSet(repository.root, "0.4.1");
    repository.write("packages/core/api/core.api.md", "# core API\n\nexport declare const added: 1;\n");
    const change = repository.commit("B: an API change in the patch set 0.4.1");
    const calls: string[] = [];
    const offline: GithubFetch = async (url: string) => { calls.push(url); throw new Error(`network read ${url}`); };
    const one = input("0.4.1", "core", change), out = realpathSync(mkdtempSync(join(scratch, "leg-")));
    await expect(m.release.preflightPackageRelease(repository.root, one, undefined, offline), "the one-package preflight").rejects.toThrow(API_REFUSAL);
    await expect(m.release.preparePackageRelease(repository.root, one, out, undefined, offline), "a release leg").rejects.toThrow(API_REFUSAL);
    expect(() => m.release.preflightSetRelease(repository.root, release.setReleaseInputs("0.4.1", change, "note\n")), "the set preflight").toThrow(API_REFUSAL);
    expect(calls, "no network read before the refusal").toEqual([]);
    const coordinates = { VERSION: "0.4.1", TARGET_COMMIT: change };
    for (const [why, phase, env] of [["one package", "preflight", { PACKAGE: "core" }], ["the set", "preflight", { PACKAGE: "all" }], ["a release leg", "prepare", { PACKAGE: "core", RELEASE_OUTPUT_DIR: out }]] as const) {
      const refused = cli(m.releaseScript, repository.root, [phase], { ...coordinates, ...env });
      expect([refused.status, refused.stderr.trim()], `package-release.ts ${phase}, ${why}`).toEqual([1, API_REFUSAL]);
    }
    expect(existsSync(join(out, "notes.md")), "a refused leg prepares no note").toBe(false);
    const fixed = fixture();
    committed.bump.bumpSet(fixed.root, "0.4.1");
    fixed.write("packages/core/src/a.ts", "export const a = 2;\n");
    const fix = fixed.commit("B: a fix in the patch set 0.4.1");
    const set = cli(m.releaseScript, fixed.root, ["preflight"], { PACKAGE: "all", VERSION: "0.4.1", TARGET_COMMIT: fix });
    expect(set.status, set.stderr).toBe(0);
    const reached = cli(m.releaseScript, fixed.root, ["preflight"], { PACKAGE: "core", VERSION: "0.4.1", TARGET_COMMIT: fix });
    expect([reached.status, reached.stderr.trim()], "a fix passes the check and reaches the tag read").toEqual([1, "network read https://api.github.com/repos/openlup/openlup/git/ref/tags/openlup-core-v0.4.1"]);
  },
  "the plan passes the packages to release in full to the step output": async (m) => {
    const repository = fixture();
    const packs = realpathSync(mkdtempSync(join(scratch, "cli-packs-")));
    const tarballs = { core: PACKED, kit: gzipSync(Buffer.from("kit tar")) };
    writeFileSync(join(packs, check.PACKAGES_MANIFEST_FILE), JSON.stringify({ schemaVersion: 2, commit: repository.a, packages: (["core", "kit"] as const).map((name) => ({ name: `@openlup/${name}`, version: "0.4.0", filename: `openlup-${name}-0.4.0.tgz`, sha256: createHash("sha256").update(tarballs[name]).digest("hex"), integrity: integrity(tarballs[name]) })) }));
    for (const name of ["core", "kit"] as const) writeFileSync(join(packs, `openlup-${name}-0.4.0.tgz`), tarballs[name]);
    // kit's release exists and npm lacks it: the set resumes kit and releases only core in full.
    const kitTag = "openlup-kit-v0.4.0", kitObject = createHash("sha1").update(kitTag).digest("hex");
    const kitResumes = {
      [`${API}/git/ref/tags/${kitTag}`]: { ref: `refs/tags/${kitTag}`, object: { type: "tag", sha: kitObject } },
      [`${API}/git/tags/${kitObject}`]: { sha: kitObject, tag: kitTag, message: "OpenLup package @openlup/kit 0.4.0.\n", object: { type: "commit", sha: repository.a } },
      [`${API}/releases/tags/${kitTag}`]: { id: 7, tag_name: kitTag, immutable: true, draft: false, prerelease: false, author: APP, assets: [] },
    };
    for (const [packageName, table, expected] of [["all", {}, '["core","kit"]'], ["all", kitResumes, '["core"]'], ["core", {}, '["core"]']] as const) {
      const output = join(scratch, `output-${++outputs}`), answers = join(scratch, `answers-${outputs}.json`);
      writeFileSync(output, "earlier=1\n");
      writeFileSync(answers, JSON.stringify(table));
      const planned = cli(m.releaseScript, repository.root, ["plan", packs], { FETCH_TABLE: answers, PACKAGE: packageName, VERSION: "0.4.0", TARGET_COMMIT: repository.a, GITHUB_OUTPUT: output });
      expect(planned.status, planned.stderr).toBe(0);
      expect(readFileSync(output, "utf8"), `${packageName} ${expected}`).toBe(`earlier=1\npackages=${expected}\n`);
    }
  },
  "the set preflight checks the clean target, the set and every package's patch": async (m) => {
    const repository = fixture();
    committed.bump.bumpSet(repository.root, "0.4.1");
    repository.write("packages/kit/src/a.ts", "export const a = 3;\n");
    const fix = repository.commit("B: set 0.4.1 with a fix");
    const manifestCheck = vi.fn((root: string, version: string) => { expect([root, version]).toEqual([repository.root, "0.4.1"]); });
    expect(m.release.preflightSetRelease(repository.root, release.setReleaseInputs("0.4.1", fix, "note\n"), manifestCheck)).toEqual(["@openlup/core", "@openlup/kit"]);
    expect(manifestCheck).toHaveBeenCalledOnce();
    quiet();
    expect(m.release.preflightSetRelease(repository.root, release.setReleaseInputs("0.4.1", fix, "note\n")), "with packages:check --release-set").toHaveLength(2);
    expect(() => m.release.preflightSetRelease(repository.root, release.setReleaseInputs("0.4.2", fix, "note\n")), "a set version the packages do not carry").toThrow("packages:check --release-set 0.4.2 refused the target");
    repository.write("packages/kit/api/kit.api.md", "# kit API\n\nexport declare const added: 1;\n");
    expect(() => m.release.preflightSetRelease(repository.root, release.setReleaseInputs("0.4.1", fix, "note\n"), () => undefined), "a tracked change").toThrow("the checkout must be the target commit without tracked changes");
    const change = repository.commit("C: kit's API changes in a patch set");
    expect(() => m.release.preflightSetRelease(repository.root, release.setReleaseInputs("0.4.1", change, "note\n"), () => undefined), "the second package's API").toThrow("packages/kit/api differs from openlup-kit-v0.4.0; a patch set only fixes, so an API change is a minor set");
  },
};

const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => undefined); return vi.spyOn(console, "error").mockImplementation(() => undefined); };

type Defect = { control: string; plant: string; in: keyof Modules; from: string; to: string };
/** One or more planted defects per control. Each replaces committed text that occurs once, so a stale anchor fails too. */
const DEFECTS: Defect[] = [
  { control: "publishable packages carry one set version", plant: "two versions admitted", in: "policy", from: "if (new Set(publishable.map(({ name }) => versions.get(name))).size > 1) {", to: "if (false) {" },
  { control: "publishable packages carry one set version", plant: "a private package held to the set", in: "policy", from: "  const publishable = config.packages.filter(({ publish }) => publish);\n  const findings: Finding[] = [];", to: "  const publishable = config.packages;\n  const findings: Finding[] = [];" },
  { control: "a publishable package carries a set version 0.N.P below 1.0", plant: "any release version admitted", in: "policy", from: "&& !SET_VERSION.test(version)) findings.push", to: "&& false) findings.push" },
  { control: "a publishable package carries a set version 0.N.P below 1.0", plant: "1.0.0 admitted", in: "policy", from: String.raw`export const SET_VERSION = /^0\.[1-9]\d*\.(?:0|[1-9]\d*)$/u;`, to: String.raw`export const SET_VERSION = /^(?:0|1)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;` },
  { control: "a publishable package carries a set version 0.N.P below 1.0", plant: "0.0.P admitted", in: "policy", from: String.raw`export const SET_VERSION = /^0\.[1-9]\d*\.`, to: String.raw`export const SET_VERSION = /^0\.\d+\.` },
  { control: "no package directory takes the set's dispatch name", plant: "packages/all admitted", in: "policy", from: "  if (directories.includes(`packages/${SET_DISPATCH}`)) fail(", to: "  if (false) fail(" },
  { control: "packages:check refuses a tree outside the set rule", plant: "the set rule never runs", in: "check", from: "  findings.push(...checkSetVersions(config, versions));\n", to: "" },
  { control: "--release-set packs every publishable package, each at the set version", plant: "a package behind the set version admitted", in: "check", from: "const behind = publishable.filter(({ name }) => versions.get(name) !== version)", to: "const behind = publishable.filter(() => false)" },
  { control: "--release-set packs every publishable package, each at the set version", plant: "the set option ignored", in: "check", from: ": options.releaseSet !== undefined ? setSelection(options.releaseSet, config.packages, versions, findings) : config.packages;", to: ": config.packages;" },
  { control: "--release-set packs every publishable package, each at the set version", plant: "a private package in the set", in: "check", from: "  const publishable = packages.filter(({ publish }) => publish);\n  if (publishable.length === 0)", to: "  const publishable = [...packages];\n  if (publishable.length === 0)" },
  { control: "--release-set packs every publishable package, each at the set version", plant: "one package and the set at once", in: "check", from: "  if (options.releaseTag !== undefined && options.releaseSet !== undefined) return", to: "  if (false) return" },
  { control: "release:bump --set moves every publishable package and every exact pin on one", plant: "manifest pins left behind", in: "bump", from: "const manifestEdits = [...ownVersion([\"version\"]), ...pins(JSON.parse(read(manifest)), [], bumped, from, version)];", to: "const manifestEdits = [...ownVersion([\"version\"])];" },
  { control: "release:bump --set moves every publishable package and every exact pin on one", plant: "lockfile pins left behind", in: "bump", from: ", ...pins(lockEntry, [\"packages\", entry.directory], bumped, from, version));", to: ");" },
  { control: "release:bump --set moves every publishable package and every exact pin on one", plant: "own-lockfile pins left behind", in: "bump", from: ", ...pins(at(JSON.parse(read(ownLock)), [\"packages\", \"\"]), [\"packages\", \"\"], bumped, from, version)];", to: "];" },
  { control: "release:bump --set moves every publishable package and every exact pin on one", plant: "optionalDependencies pins left behind", in: "bump", from: "const PIN_FIELDS = [\"dependencies\", \"peerDependencies\", \"optionalDependencies\"] as const;", to: "const PIN_FIELDS = [\"dependencies\", \"peerDependencies\"] as const;" },
  { control: "release:bump --set moves every publishable package and every exact pin on one", plant: "only the first publishable package moves", in: "bump", from: "bumpFiles(root, config, publishable, from, version)", to: "bumpFiles(root, config, publishable.slice(0, 1), from, version)" },
  { control: "release:bump --set moves every publishable package and every exact pin on one", plant: "a skewed set bumped", in: "bump", from: "if (current.some(([, other]) => other !== from)) throw", to: "if (false) throw" },
  { control: "the Publishable line opens a new version section below Unreleased", plant: "the line inside Unreleased, as before", in: "bump", from: "return `${text.slice(0, end)}## [${version}]\\n\\n- Publishable", to: "return `${text.slice(0, end)}- Publishable" },
  { control: "the Publishable line opens a new version section below Unreleased", plant: "a second section of one version", in: "bump", from: "if (text.includes(`\\n## [${version}]`)) throw", to: "if (false) throw" },
  { control: "a publishable package moves only with its set, at a set version", plant: "one package of several bumped alone", in: "bump", from: "if (entry.publish && config.packages.some((row) => row.publish && row !== entry)) throw", to: "if (false) throw" },
  { control: "a publishable package moves only with its set, at a set version", plant: "1.0.0 admitted", in: "bump", from: "if (entry.publish && !SET_VERSION.test(version)) throw", to: "if (false) throw" },
  { control: "a package's tag, release and npm state decide skip, resume or full", plant: "a missing npm version taken as published", in: "release", from: "if (!held.includes(input.version)) return \"resume\";", to: "if (!held.includes(input.version)) return \"skip\";" },
  { control: "a package's tag, release and npm state decide skip, resume or full", plant: "every complete release resumed", in: "release", from: "  return \"skip\";\n}", to: "  return \"resume\";\n}" },
  { control: "every other state stops the set", plant: "a half-made release admitted", in: "release", from: "if (tag === undefined || release === undefined) throw", to: "if (false) throw" },
  { control: "every other state stops the set", plant: "the tag's commit unchecked", in: "release", from: "if (tag.commit !== input.target || tag.message !== `${input.message}\\n`) throw new Error(`${input.tag} names another", to: "if (tag.message !== `${input.message}\\n`) throw new Error(`${input.tag} names another" },
  { control: "every other state stops the set", plant: "a mutable release admitted", in: "release", from: "release.immutable !== true || release.draft", to: "release.draft" },
  { control: "every other state stops the set", plant: "a prerelease admitted", in: "release", from: "release.prerelease !== false || author.id", to: "author.id" },
  { control: "every other state stops the set", plant: "any author admitted", in: "release", from: "author.id !== RELEASE_APP.id || author.login !== RELEASE_APP.login || !Array", to: "!Array" },
  { control: "every other state stops the set", plant: "another tarball skipped", in: "release", from: "if (!(await sameTarball(input.name, input.version, packument!, local, fetcher))) throw", to: "if (false) throw" },
  { control: "every other state stops the set", plant: "an unpublished version resumed", in: "release", from: "if (versions[input.version] === undefined) throw", to: "if (versions[input.version] === undefined) return \"resume\"; if (false) throw" },
  { control: "every other state stops the set", plant: "npm's version without a tag released", in: "release", from: "    if (held.includes(input.version)) throw", to: "    if (false) throw" },
  { control: "every other state stops the set", plant: "a later npm version admitted", in: "release", from: "  assertNoneAbove(input.name, input.version, held);\n  if (tag === undefined && release === undefined)", to: "  if (tag === undefined && release === undefined)" },
  { control: "the same tarball: npm's bytes match its integrity and unpack to the packed tar", plant: "gzip bytes compared", in: "release", from: "update(gunzipSync(bytes))", to: "update(bytes)" },
  { control: "the same tarball: npm's bytes match its integrity and unpack to the packed tar", plant: "npm's integrity unchecked", in: "release", from: ".digest(\"base64\")}` !== dist.integrity) throw", to: ".digest(\"base64\")}` === \"\") throw" },
  { control: "the same tarball: npm's bytes match its integrity and unpack to the packed tar", plant: "any tarball address", in: "release", from: "if (dist.tarball !== url) throw", to: "if (false) throw" },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "no patch check", in: "release", from: "  if (patch === 0) return;\n", to: "  return;\n" },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "a package without an earlier tag admitted", in: "release", from: "if (previous === undefined) throw new Error(", to: "if (previous === undefined) return; if (false) throw new Error(" },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "the whole package compared, not its API", in: "release", from: "\"--\", `${directory}/api`]", to: "\"--\", directory]" },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "the earliest earlier tag compared", in: "release", from: ".sort((left, right) => right.patch - left.patch)", to: ".sort((left, right) => left.patch - right.patch)" },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "the previous set compared with itself", in: "release", from: "[\"diff\", \"--quiet\", previous, target,", to: "[\"diff\", \"--quiet\", previous, previous," },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "any tag as the previous set", in: "release", from: "const made = tagger === RELEASE_TAGGER && message === `OpenLup package ${release?.name} ${release?.version}.\\n`;", to: "const made = true;" },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "any tagger's tag as the previous set", in: "release", from: "const made = tagger === RELEASE_TAGGER && ", to: "const made = " },
  { control: "a patch set keeps each package's API snapshot from its previous set", plant: "any message's tag as the previous set", in: "release", from: " && message === `OpenLup package ${release?.name} ${release?.version}.\\n`", to: "" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the one-package preflight without the check", in: "release", from: "  assertPatchSetApiUnchanged(root, input.directory, input.version, input.target);\n", to: "" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the one-package preflight swallows the refusal", in: "release", from: "  assertPatchSetApiUnchanged(root, input.directory, input.version, input.target);\n", to: "  try { assertPatchSetApiUnchanged(root, input.directory, input.version, input.target); } catch { /* bypassed */ }\n" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the check after the tag and npm reads", in: "release", from: "  assertPatchSetApiUnchanged(root, input.directory, input.version, input.target);\n  await assertTagAbsent(input.tag, token, fetcher);\n  assertVersionUnpublished(input.name, input.version, await readPackument(input.name, fetcher));\n", to: "  await assertTagAbsent(input.tag, token, fetcher);\n  assertVersionUnpublished(input.name, input.version, await readPackument(input.name, fetcher));\n  assertPatchSetApiUnchanged(root, input.directory, input.version, input.target);\n" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "a release leg prepares without the check", in: "release", from: "  await preflightPackageRelease(root, input, token, fetcher, manifestCheck);\n  writeFileSync(", to: "  assertReleaseCandidate(root, input);\n  manifestCheck(root, input.tag);\n  await assertTagAbsent(input.tag, token, fetcher);\n  assertVersionUnpublished(input.name, input.version, await readPackument(input.name, fetcher));\n  writeFileSync(" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the set preflight without the check", in: "release", from: "  for (const { directory } of packages) assertPatchSetApiUnchanged(root, directory, set.version, set.target);\n", to: "" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the set preflight swallows the refusal", in: "release", from: "  for (const { directory } of packages) assertPatchSetApiUnchanged(root, directory, set.version, set.target);\n", to: "  for (const { directory } of packages) try { assertPatchSetApiUnchanged(root, directory, set.version, set.target); } catch { /* bypassed */ }\n" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the one-package command skips its preflight", in: "release", from: "    await preflightPackageRelease(root, input, token);\n", to: "" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the set command skips its preflight", in: "release", from: "const names = preflightSetRelease(root, set);", to: "const names = [\"unchecked\"];" },
  { control: "every preflight and each release leg run the patch-set check, before any network read", plant: "the leg command prepares only the note", in: "release", from: "if (phase === \"prepare\") return preparePackageRelease(root, input, out, token);", to: "if (phase === \"prepare\") return writeFileSync(resolve(out, \"notes.md\"), input.note);" },
  { control: "the plan passes the packages to release in full to the step output", plant: "no step output", in: "release", from: "    appendFileSync(output, `packages=${JSON.stringify(full)}\\n`);\n", to: "" },
  { control: "the plan passes the packages to release in full to the step output", plant: "a list the matrix cannot parse", in: "release", from: "`packages=${JSON.stringify(full)}\\n`", to: "`packages=${full.join(\",\")}\\n`" },
  { control: "the plan passes the packages to release in full to the step output", plant: "the step output overwritten", in: "release", from: "    appendFileSync(output, `packages=", to: "    writeFileSync(output, `packages=" },
  { control: "the plan passes the packages to release in full to the step output", plant: "every publishable package, not the plan's", in: "release", from: "`packages=${JSON.stringify(full)}\\n`", to: "`packages=${JSON.stringify(set ? [\"core\", \"kit\"] : full)}\\n`" },
  { control: "the release plan: one package only from nothing; a set skips, resumes, and releases at least one", plant: "one package resumed", in: "release", from: "if (single && state !== \"full\") throw", to: "if (false) throw" },
  { control: "the release plan: one package only from nothing; a set skips, resumes, and releases at least one", plant: "an empty plan", in: "release", from: "if (full.length === 0) throw", to: "if (false) throw" },
  { control: "the release plan: one package only from nothing; a set skips, resumes, and releases at least one", plant: "a skipped package released again", in: "release", from: "if (state === \"full\") full.push(", to: "if (state !== \"resume\") full.push(" },
  { control: "the release plan: one package only from nothing; a set skips, resumes, and releases at least one", plant: "a packs manifest of any commit", in: "release", from: "if (manifest.commit !== target || ", to: "if (" },
  { control: "the release plan: one package only from nothing; a set skips, resumes, and releases at least one", plant: "a tarball changed after packing", in: "release", from: ".digest(\"hex\") !== entry.sha256) throw", to: ".digest(\"hex\") === \"\") throw" },
  { control: "the set preflight checks the clean target, the set and every package's patch", plant: "only the first package's patch checked", in: "release", from: "for (const { directory } of packages) assertPatchSetApiUnchanged", to: "for (const { directory } of packages.slice(0, 1)) assertPatchSetApiUnchanged" },
  { control: "the set preflight checks the clean target, the set and every package's patch", plant: "no packages:check --release-set", in: "release", from: "  manifestCheck(root, set.version);\n", to: "" },
  { control: "the set preflight checks the clean target, the set and every package's patch", plant: "a dirty checkout admitted", in: "release", from: "  assertCleanTarget(root, set.target);\n  manifestCheck(root, set.version);", to: "  manifestCheck(root, set.version);" },
];

let mutants = 0;
/** The committed modules, with `module` replaced by a copy that carries one planted defect. */
async function load(defect: Defect): Promise<Modules> {
  const file = fileURLToPath(new URL(`./${FILES[defect.in]}`, import.meta.url));
  const source = readFileSync(file, "utf8");
  expect(source.split(defect.from), "the anchor occurs exactly once").toHaveLength(2);
  // A function replacer, so a `$` in the source is never read as a replacement pattern.
  const planted = source.replace(defect.from, () => defect.to);
  const bound = planted.replace(/(\bfrom\s+)"(\.\.?\/[^"]+)"/gu, (_, keyword: string, specifier: string) => `${keyword}${JSON.stringify(resolve(dirname(file), specifier))}`);
  const copy = join(scratch, `mutant-${++mutants}-${FILES[defect.in]}`);
  writeFileSync(copy, bound);
  return { ...committed, [defect.in]: await import(pathToFileURL(copy).href), releaseScript: defect.in === "release" ? copy : committed.releaseScript };
}

describe("set release controls", () => {
  beforeAll(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), "openlup-set-release-"))); });
  afterAll(() => { vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); });

  it("hold on the committed modules", async () => {
    for (const [name, holds] of Object.entries(BEHAVIOUR)) await expect(holds(committed), name).resolves.toBeUndefined();
  }, 120_000);

  it("each control has a planted defect", () => {
    expect(new Set(DEFECTS.map(({ control }) => control))).toEqual(new Set(Object.keys(BEHAVIOUR)));
  });

  it.each(DEFECTS.map((defect) => [`${defect.control}: ${defect.plant}`, defect] as const))("turns red on %s", async (_, defect) => {
    const modules = await load(defect);
    await expect(BEHAVIOUR[defect.control]!(modules)).rejects.toThrow();
    vi.restoreAllMocks();
  }, 60_000);
});
