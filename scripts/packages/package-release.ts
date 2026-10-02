/**
 * `@openlup/*` package releases, for `.github/workflows/publish-package.yml` and
 * `publish-packages.yml`: `node --experimental-strip-types scripts/packages/package-release.ts <phase>`.
 * PACKAGE `all` names the whole set: every publishable package at the set version VERSION.
 *
 * - `preflight` and `prepare` run at the clean target commit, from the dispatch inputs
 *   PACKAGE, VERSION, TARGET_COMMIT and RELEASE_NOTES. Both refuse unless the package is
 *   publishable at exactly that version and passes `packages:check --release-tag` (manifests
 *   only: no install, build or pack), a patch set leaves the package's API snapshot as its
 *   previous set left it, the tag `openlup-<package>-v<version>` is absent, and npm has never
 *   held that version and holds none above it. `prepare` then writes the exact note bytes to
 *   RELEASE_OUTPUT_DIR, outside the checkout. For the set, `preflight` runs
 *   `packages:check --release-set` and the patch-set check for every publishable package.
 * - `plan <packs directory>` runs after the preflight's pack and decides each package of the
 *   release by its tag, release and npm state (`packageState`). It writes the packages to
 *   release in full, as a JSON array, to the step output `packages`. One package is released
 *   only from the absent state; a set skips and resumes packages, and stops on any other state.
 * - `check-draft` reads only the draft whose ID creation returned (RELEASE_ID) and refuses any
 *   difference from the prepared tag, title and note, or any asset.
 * - `verify` checks the published release by that ID: immutable, authored by the release App,
 *   with the exact note and no asset, and its annotated tag at the target.
 * - `registry` repeats the npm check for the published release tag RELEASE_TAG.
 *
 * Every phase only reads. The workflow writes the tag and the release with the release App.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { annotatedTag, type GithubFetch } from "../source-preview-release.ts";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, SET_DISPATCH, SET_VERSION, parsePackageReleaseTag, parsePackagesConfig, releaseVersionAbove } from "./package-manifest-policy.ts";
import { PACKAGES_MANIFEST_FILE, runPackagesCheck } from "./packages-check.ts";

const GITHUB_API = "https://api.github.com/repos/openlup/openlup";
const NPM_REGISTRY = "https://registry.npmjs.org";
/** The release App's bot user, which alone creates package release tags and releases. */
export const RELEASE_APP = { id: 334697227, login: "openlup-release[bot]" } as const;
type Json = Record<string, unknown>;

function record(value: unknown, what: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is malformed`);
  return value as Json;
}

export type PackageRelease = { directory: string; name: string; version: string; target: string; tag: string; title: string; message: string; note: string };

/** The dispatch inputs, refused unless each is exactly one canonical value. */
export function packageReleaseInputs(directoryName: string, version: string, target: string, note: string): PackageRelease {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(directoryName)) throw new Error("package must be a directory name under packages/");
  if (directoryName === SET_DISPATCH) throw new Error(`package ${SET_DISPATCH} names the whole set, not one package`);
  if (!RELEASE_VERSION.test(version)) throw new Error("version must be a MAJOR.MINOR.PATCH release version");
  if (!/^[a-f0-9]{40}$/u.test(target)) throw new Error("target_commit must be a full lowercase commit SHA");
  if (note.trim() === "" || note.includes("\0")) throw new Error("notes must contain the reviewed UTF-8 release body");
  const tag = `openlup-${directoryName}-v${version}`;
  const release = parsePackageReleaseTag(tag);
  if (!release) throw new Error(`${tag} is not a package release tag`);
  return { ...release, target, tag, title: `${release.name} ${version}`, message: `OpenLup package ${release.name} ${version}.`, note };
}

export type SetRelease = { version: string; target: string; note: string };

/** The dispatch inputs of a set release, PACKAGE `all`: a set version, the target and the note. */
export function setReleaseInputs(version: string, target: string, note: string): SetRelease {
  if (!SET_VERSION.test(version)) throw new Error("version must be a set version 0.N.P below 1.0 for a set release");
  if (!/^[a-f0-9]{40}$/u.test(target)) throw new Error("target_commit must be a full lowercase commit SHA");
  if (note.trim() === "" || note.includes("\0")) throw new Error("notes must contain the reviewed UTF-8 release body");
  return { version, target, note };
}

const githubHeaders = (token?: string) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function githubRead(path: string, token: string | undefined, fetcher: GithubFetch): Promise<unknown> {
  const response = await fetcher(`${GITHUB_API}${path}`, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`package release API refused ${path}: HTTP ${response.status}`);
  return response.json();
}

/** A package release never retags: its tag must not exist yet. */
export async function assertTagAbsent(tag: string, token?: string, fetcher: GithubFetch = fetch): Promise<void> {
  const response = await fetcher(`${GITHUB_API}/git/ref/tags/${encodeURIComponent(tag)}`, { headers: githubHeaders(token) });
  if (response.status !== 404) throw new Error(`${tag} is present or unavailable (HTTP ${response.status}); never retag or overwrite`);
}

/**
 * The full npm document of `name`, or undefined when npm has never held the name. The registry's
 * CDN serves a document for up to five minutes, so a unique query reads past that cache.
 */
export async function readPackument(name: string, fetcher: GithubFetch = fetch): Promise<Json | undefined> {
  const response = await fetcher(`${NPM_REGISTRY}/${name.replace("/", "%2f")}?cache-bypass=${randomUUID()}`, { headers: { Accept: "application/json" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry refused ${name}: HTTP ${response.status}`);
  const document = record(await response.json(), "npm document");
  if (document.name !== name) throw new Error(`npm registry answered ${String(document.name)} for ${name}`);
  return document;
}

/**
 * npm never held `version`, not even as a since-unpublished version, and holds nothing at or
 * above it. Every release moves `latest`, which npm would otherwise refuse to move backwards
 * only for a publish that names no tag.
 */
export function assertVersionUnpublished(name: string, version: string, packument: Json | undefined): void {
  const held = heldVersions(packument);
  if (held.includes(version)) throw new Error(`${name}@${version} is or was on npm; a version is never republished`);
  assertNoneAbove(name, version, held);
}

/** Every version npm holds or held for a package, a since-unpublished one included. */
function heldVersions(packument: Json | undefined): string[] {
  if (!packument) return [];
  const versions = Object.keys(packument.versions === undefined ? {} : record(packument.versions, "npm versions"));
  const times = Object.keys(packument.time === undefined ? {} : record(packument.time, "npm time")).filter((key) => !["created", "modified", "unpublished"].includes(key));
  return [...new Set([...versions, ...times])];
}

/** Every version in `held` other than `version` itself is below it. */
function assertNoneAbove(name: string, version: string, held: readonly string[]): void {
  for (const other of held) {
    if (other === version) continue;
    const above = releaseVersionAbove(version, other);
    if (above === undefined) throw new Error(`npm lists ${name}@${other}, which is not a semver version`);
    if (!above) throw new Error(`${name}@${version} is not above ${name}@${other} on npm; latest only moves forward`);
  }
}

function assertCleanTarget(root: string, target: string): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
  if (head !== target || dirty !== "") throw new Error("the checkout must be the target commit without tracked changes");
}

/** The checkout is the clean target, and its package is publishable at exactly the requested version. */
export function assertReleaseCandidate(root: string, input: PackageRelease): void {
  assertCleanTarget(root, input.target);
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  if (config.packages.find(({ directory }) => directory === input.directory)?.publish !== true) throw new Error(`${input.directory} is not a publishable package in ${PACKAGES_CONFIG_PATH}`);
  const { version } = JSON.parse(readFileSync(join(root, input.directory, "package.json"), "utf8")) as { version?: unknown };
  if (version !== input.version) throw new Error(`${input.directory}/package.json is at ${String(version)}, not ${input.version}; merge its release:bump first`);
}

/** The manifest policy and release version of every package at the tag: `packages:check --release-tag`, with no install, build or pack. */
export function checkReleaseManifests(root: string, tag: string): void {
  if (runPackagesCheck(root, ["--release-tag", tag]) !== 0) throw new Error(`packages:check --release-tag ${tag} refused the target`);
}

/** The tagger of every package release tag: the release App's bot user, as GitHub writes it. */
export const RELEASE_TAGGER = `${RELEASE_APP.login} <${RELEASE_APP.id}+${RELEASE_APP.login}@users.noreply.github.com>`;

/**
 * The package release tags of `directory` in the checkout that look as the release workflow makes
 * them: annotated with the release App's tagger line (a lightweight tag has none) and worded as a
 * release tag. This is a consistency check, since a tagger line is not authenticated; the
 * tag-creation ruleset, which lets only the release App and administrators create these tags, is
 * the control.
 */
function appReleaseTags(root: string, directory: string, pattern: string): Array<{ tag: string; version: string }> {
  const fields = ["%(refname:strip=2)", "%(taggername) %(taggeremail)", "%(contents)"].join("%00");
  const refs = execFileSync("git", ["for-each-ref", `--format=${fields}%01`, `refs/tags/${pattern}`], { cwd: root, encoding: "utf8" }).split("\u0001\n").filter(Boolean);
  return refs.flatMap((line) => {
    const [tag = "", tagger, message] = line.split("\0");
    const release = parsePackageReleaseTag(tag);
    const made = tagger === RELEASE_TAGGER && message === `OpenLup package ${release?.name} ${release?.version}.\n`;
    return release?.directory === directory && made ? [{ tag, version: release.version }] : [];
  });
}

/**
 * A patch set `0.N.P`, P above 0, only fixes: the package's API snapshot (`<directory>/api/`) at
 * `target` equals the one at its previous set, the highest release tag `openlup-<package>-v0.N.<p>`
 * with p below P that the release App made. A package with no such tag joins the set at a minor set.
 */
export function assertPatchSetApiUnchanged(root: string, directory: string, version: string, target: string): void {
  const set = /^0\.([1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!set) throw new Error(`${version} is not a set version 0.N.P below 1.0`);
  const minor = `0.${set[1]}.`, patch = Number(set[2]);
  if (patch === 0) return;
  const name = directory.slice("packages/".length);
  const earlier = appReleaseTags(root, directory, `openlup-${name}-v${minor}*`).flatMap(({ tag, version: other }) => {
    return other.startsWith(minor) && Number(other.slice(minor.length)) < patch ? [{ tag, patch: Number(other.slice(minor.length)) }] : [];
  });
  const previous = earlier.sort((left, right) => right.patch - left.patch)[0]?.tag;
  if (previous === undefined) throw new Error(`${version} is a patch set, but ${name} has no earlier ${minor}<p> set tag; a package joins the set at a minor set`);
  try {
    execFileSync("git", ["diff", "--quiet", previous, target, "--", `${directory}/api`], { cwd: root, stdio: "ignore" });
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) throw new Error(`${directory}/api differs from ${previous}; a patch set only fixes, so an API change is a minor set`);
    throw error;
  }
}

/** Every refusal that needs no write, before the protected approval and again after it. */
export async function preflightPackageRelease(root: string, input: PackageRelease, token?: string, fetcher: GithubFetch = fetch, manifestCheck: typeof checkReleaseManifests = checkReleaseManifests): Promise<void> {
  assertReleaseCandidate(root, input);
  manifestCheck(root, input.tag);
  assertPatchSetApiUnchanged(root, input.directory, input.version, input.target);
  await assertTagAbsent(input.tag, token, fetcher);
  assertVersionUnpublished(input.name, input.version, await readPackument(input.name, fetcher));
}

/** The set's manifests at the target: `packages:check --release-set`, with no install, build or pack. */
export function checkSetManifests(root: string, version: string): void {
  if (runPackagesCheck(root, ["--release-set", version]) !== 0) throw new Error(`packages:check --release-set ${version} refused the target`);
}

/** The publishable packages of the set at the target. */
function publishablePackages(root: string): Array<{ directory: string; name: string }> {
  return parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8")).packages.filter(({ publish }) => publish);
}

/** The set's refusals that need no network: the clean target, every publishable package at the set version, and the patch-set check. */
export function preflightSetRelease(root: string, set: SetRelease, manifestCheck: typeof checkSetManifests = checkSetManifests): string[] {
  assertCleanTarget(root, set.target);
  manifestCheck(root, set.version);
  const packages = publishablePackages(root);
  for (const { directory } of packages) assertPatchSetApiUnchanged(root, directory, set.version, set.target);
  return packages.map(({ name }) => name);
}

/** What a release does with one package: nothing, publish its existing release again, or release it in full. */
export type PackageState = "skip" | "resume" | "full";

/** The local tarball and npm's tarball unpack to the same bytes, and npm's bytes match npm's own integrity. */
async function sameTarball(name: string, version: string, packument: Json, local: Uint8Array, fetcher: GithubFetch): Promise<boolean> {
  const dist = record(record(record(packument.versions, "npm versions")[version], `npm ${name}@${version}`).dist, `npm ${name}@${version} dist`);
  const url = `${NPM_REGISTRY}/${name}/-/${name.slice("@openlup/".length)}-${version}.tgz`;
  if (dist.tarball !== url) throw new Error(`npm names ${String(dist.tarball)} as the tarball of ${name}@${version}, not ${url}`);
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`npm registry refused ${url}: HTTP ${response.status}`);
  const published = new Uint8Array(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(published).digest("base64")}` !== dist.integrity) throw new Error(`the tarball npm serves for ${name}@${version} does not match npm's integrity`);
  // Gzip bytes depend on the packing machine's zlib, so the unpacked tar is what is compared.
  const tar = (bytes: Uint8Array) => createHash("sha256").update(gunzipSync(bytes)).digest("hex");
  return tar(published) === tar(local);
}

/** The tag and release exist as the release workflow leaves them: annotated at the target, immutable, App-authored, assetless. */
function assertCompletedRelease(input: PackageRelease, tag: { commit: string; message: string }, release: Json): void {
  if (tag.commit !== input.target || tag.message !== `${input.message}\n`) throw new Error(`${input.tag} names another commit or message than this release at ${input.target}`);
  const author = record(release.author, "release author");
  if (release.tag_name !== input.tag || release.immutable !== true || release.draft !== false || release.prerelease !== false || author.id !== RELEASE_APP.id || author.login !== RELEASE_APP.login || !Array.isArray(release.assets) || release.assets.length !== 0) throw new Error(`${input.tag} is not an immutable, published, App-authored release without assets`);
}

/**
 * The state of one package of a release at `input.target`:
 * - tag and release exist, npm holds the version with the same tarball: `skip`;
 * - tag and release exist, npm never held the version: `resume`, publishing from the existing release;
 * - neither exists and npm never held the version: `full`.
 * Every other state throws, and so does npm holding a version above this one.
 */
export async function packageState(input: PackageRelease, local: Uint8Array, token?: string, fetcher: GithubFetch = fetch): Promise<PackageState> {
  const ref = await fetcher(`${GITHUB_API}/git/ref/tags/${encodeURIComponent(input.tag)}`, { headers: githubHeaders(token) });
  if (ref.status !== 404 && !ref.ok) throw new Error(`package release API refused the tag ${input.tag}: HTTP ${ref.status}`);
  const tag = ref.status === 404 ? undefined : await annotatedTag(input.tag, token, fetcher);
  const found = await fetcher(`${GITHUB_API}/releases/tags/${encodeURIComponent(input.tag)}`, { headers: githubHeaders(token) });
  if (found.status !== 404 && !found.ok) throw new Error(`package release API refused the release ${input.tag}: HTTP ${found.status}`);
  const release = found.status === 404 ? undefined : record(await found.json(), "release");
  const packument = await readPackument(input.name, fetcher);
  const held = heldVersions(packument);
  assertNoneAbove(input.name, input.version, held);
  if (tag === undefined && release === undefined) {
    if (held.includes(input.version)) throw new Error(`${input.name}@${input.version} is or was on npm, but ${input.tag} does not exist`);
    return "full";
  }
  if (tag === undefined || release === undefined) throw new Error(`${input.tag} exists without its published release, or the reverse; recover it before the set continues`);
  assertCompletedRelease(input, tag, release);
  if (!held.includes(input.version)) return "resume";
  const versions = record(packument!.versions ?? {}, "npm versions");
  if (versions[input.version] === undefined) throw new Error(`${input.name}@${input.version} was on npm and is gone; a version is never republished`);
  if (!(await sameTarball(input.name, input.version, packument!, local, fetcher))) throw new Error(`npm holds ${input.name}@${input.version} with another tarball than this release packs`);
  return "skip";
}

/** The tarball of `name` the preflight packed at `target`, as its packs manifest lists it. */
function packedTarball(packsDirectory: string, target: string, name: string, version: string): Uint8Array {
  const manifest = record(JSON.parse(readFileSync(join(packsDirectory, PACKAGES_MANIFEST_FILE), "utf8")), "packs manifest");
  if (manifest.commit !== target || !Array.isArray(manifest.packages)) throw new Error("the packs manifest is not the target's");
  const entry = manifest.packages.map((row) => record(row, "packed package")).find((row) => row.name === name);
  if (!entry || entry.version !== version || typeof entry.filename !== "string" || entry.filename.includes("/")) throw new Error(`the preflight packed no ${name}@${version}`);
  const bytes = readFileSync(join(packsDirectory, entry.filename));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`${entry.filename} changed after packing`);
  return bytes;
}

/**
 * Decides the release package by package and returns the directory names to release in full.
 * One package (`PACKAGE` other than `all`) is released only from the `full` state. A set skips
 * and resumes packages, needs at least one to release in full, and stops on any other state.
 */
export async function planRelease(root: string, packsDirectory: string, requested: PackageRelease | SetRelease, token?: string, fetcher: GithubFetch = fetch, log: (line: string) => void = console.log): Promise<string[]> {
  assertCleanTarget(root, requested.target);
  const single = "tag" in requested;
  const names = single ? [requested.name] : publishablePackages(root).map(({ name }) => name);
  const full: string[] = [];
  for (const name of names) {
    const input = packageReleaseInputs(name.slice("@openlup/".length), requested.version, requested.target, requested.note);
    const state = await packageState(input, packedTarball(packsDirectory, requested.target, input.name, input.version), token, fetcher);
    if (single && state !== "full") throw new Error(`${input.tag} has a release already; dispatch package ${SET_DISPATCH} to resume a set`);
    if (state === "full") full.push(input.directory.slice("packages/".length));
    log(state === "full" ? `${input.tag}: release in full` : state === "skip" ? `${input.tag}: skip, npm holds this tarball`
      : `::warning::${input.tag}: resume, the release exists and npm lacks ${input.version}; re-run the failed Publish Packages run of ${input.tag}`);
  }
  if (full.length === 0) throw new Error(`nothing to release in full at ${requested.version}; a package to resume needs only its Publish Packages run re-run`);
  return full;
}

/** The preflight refusals, then the exact note bytes that creation and the checks use. */
export async function preparePackageRelease(root: string, input: PackageRelease, out: string, token?: string, fetcher: GithubFetch = fetch, manifestCheck: typeof checkReleaseManifests = checkReleaseManifests): Promise<void> {
  await preflightPackageRelease(root, input, token, fetcher, manifestCheck);
  writeFileSync(resolve(out, "notes.md"), input.note, { flag: "wx" });
}

function releaseId(text: string): number {
  if (!/^[1-9][0-9]*$/u.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("RELEASE_ID must be the positive safe integer returned by draft creation");
  return Number(text);
}

function assertReleaseBody(release: Json, note: string, label: string): void {
  if (release.body !== note) throw new Error(`${label} release body differs from the prepared note`);
  if (!Array.isArray(release.assets) || release.assets.length !== 0) throw new Error(`${label} release must carry no asset`);
}

export function assertPackageDraft(value: unknown, id: number, input: PackageRelease): void {
  const release = record(value, "draft release");
  if (release.id !== id || release.tag_name !== input.tag || release.name !== input.title || release.draft !== true || release.prerelease !== false) throw new Error("draft release identity differs from the created draft");
  assertReleaseBody(release, input.note, "draft");
}

const second = (milliseconds: number) => new Promise<void>((done) => { setTimeout(done, milliseconds); });

/** Reads only the created draft; a newly created ID may briefly answer 404. */
export async function checkPackageDraft(idText: string, input: PackageRelease, token?: string, fetcher: GithubFetch = fetch, pause: (milliseconds: number) => Promise<void> = second): Promise<void> {
  const id = releaseId(idText), path = `/releases/${id}`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetcher(`${GITHUB_API}${path}`, { headers: githubHeaders(token) });
    if (response.status === 404 && attempt < 3) { await pause(1000); continue; }
    if (!response.ok) throw new Error(`package release API refused ${path}: HTTP ${response.status}`);
    assertPackageDraft(await response.json(), id, input);
    return;
  }
}

/** The published release is the created one: immutable, App-authored, exact, assetless, and tagged at the target. */
export async function verifyPackageRelease(idText: string, input: PackageRelease, token?: string, fetcher: GithubFetch = fetch): Promise<void> {
  const id = releaseId(idText);
  const release = record(await githubRead(`/releases/tags/${encodeURIComponent(input.tag)}`, token, fetcher), "release");
  if (release.id !== id || release.tag_name !== input.tag || release.immutable !== true || release.prerelease !== false || release.draft !== false) throw new Error(`${input.tag} is not the created immutable published release`);
  const author = record(release.author, "release author");
  if (author.id !== RELEASE_APP.id || author.login !== RELEASE_APP.login) throw new Error(`${input.tag} is not authored by the release App`);
  assertReleaseBody(release, input.note, "published");
  const tag = await annotatedTag(input.tag, token, fetcher);
  if (tag.commit !== input.target || tag.message !== `${input.message}\n`) throw new Error("published tag differs from the prepared target or message");
}

/** For a published release tag: npm still holds neither that version nor any above it. */
export async function assertRegistryReady(tag: string, fetcher: GithubFetch = fetch): Promise<void> {
  const release = parsePackageReleaseTag(tag);
  if (!release) throw new Error(`${tag} is not a package release tag`);
  assertVersionUnpublished(release.name, release.version, await readPackument(release.name, fetcher));
}

const PHASES = ["preflight", "plan <packs directory>", "prepare", "check-draft", "verify", "registry"];

async function main(): Promise<void> {
  const { env, argv } = process;
  const phase = argv[2] ?? "";
  if (argv.length !== (phase === "plan" ? 4 : 3) || !PHASES.some((listed) => listed.split(" ")[0] === phase)) throw new Error(`expected one phase: ${PHASES.join(", ")}`);
  if (phase === "registry") {
    await assertRegistryReady(env.RELEASE_TAG ?? "");
    console.log(`npm holds neither ${env.RELEASE_TAG} nor any later version`);
    return;
  }
  const root = realpathSync(process.cwd());
  const token = env.GITHUB_TOKEN;
  const set = env.PACKAGE === SET_DISPATCH ? setReleaseInputs(env.VERSION ?? "", env.TARGET_COMMIT ?? "", env.RELEASE_NOTES ?? "") : undefined;
  if (set && phase === "preflight") {
    const names = preflightSetRelease(root, set);
    console.log(`${set.target} carries the set ${set.version}: ${names.join(", ")}`);
    return;
  }
  if (phase === "plan") {
    const output = env.GITHUB_OUTPUT ?? "";
    if (output === "") throw new Error("plan writes its packages to GITHUB_OUTPUT");
    const requested = set ?? packageReleaseInputs(env.PACKAGE ?? "", env.VERSION ?? "", env.TARGET_COMMIT ?? "", env.RELEASE_NOTES ?? "");
    const full = await planRelease(root, realpathSync(argv[3]!), requested, token);
    appendFileSync(output, `packages=${JSON.stringify(full)}\n`);
    return;
  }
  if (set) throw new Error(`phase ${phase} releases one package; the release job runs it once per planned package`);
  const input = packageReleaseInputs(env.PACKAGE ?? "", env.VERSION ?? "", env.TARGET_COMMIT ?? "", env.RELEASE_NOTES ?? "");
  if (phase === "preflight") {
    await preflightPackageRelease(root, input, token);
    console.log(`${input.target} can release ${input.name}@${input.version} as ${input.tag}`);
    return;
  }
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== input.target) throw new Error("checkout differs from target_commit");
  const out = realpathSync(env.RELEASE_OUTPUT_DIR ?? "");
  if (out === root || out.startsWith(`${root}${sep}`)) throw new Error("release outputs must stay outside the checkout");
  if (phase === "prepare") return preparePackageRelease(root, input, out, token);
  if (readFileSync(resolve(out, "notes.md"), "utf8") !== input.note) throw new Error("the prepared note differs from the dispatched notes");
  if (phase === "check-draft") return checkPackageDraft(env.RELEASE_ID ?? "", input, token);
  await verifyPackageRelease(env.RELEASE_ID ?? "", input, token);
  console.log(`Verified immutable ${input.tag} at ${input.target}`);
}

/** Run as a command, also through a symbolic link; never when imported. */
function invokedDirectly(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "package release refused"); process.exitCode = 1; });
} else if (/(?:^|[\\/])package-release\.m?ts$/u.test(process.argv[1] ?? "")) {
  // Started as a package-release command, yet not detected as the entry module: an exit 0 would skip every check.
  console.error(`package release: ${process.argv[1]} started, but this module is not its entry; refusing`);
  process.exitCode = 1;
}
