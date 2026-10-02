/**
 * One `@openlup/*` package release, for `.github/workflows/publish-package.yml` and
 * `publish-packages.yml`: `node --experimental-strip-types scripts/packages/package-release.ts <phase>`.
 *
 * - `preflight` and `prepare` run at the clean target commit, from the dispatch inputs
 *   PACKAGE, VERSION, TARGET_COMMIT and RELEASE_NOTES. Both refuse unless the package is
 *   publishable at exactly that version and passes `packages:check --release-tag` (manifests
 *   only: no install, build or pack), the tag `openlup-<package>-v<version>` is absent, and npm
 *   has never held that version and holds none above it. `prepare` then writes the exact note
 *   bytes to RELEASE_OUTPUT_DIR, outside the checkout.
 * - `check-draft` reads only the draft whose ID creation returned (RELEASE_ID) and refuses any
 *   difference from the prepared tag, title and note, or any asset.
 * - `verify` checks the published release by that ID: immutable, authored by the release App,
 *   with the exact note and no asset, and its annotated tag at the target.
 * - `registry` repeats the npm check for the published release tag RELEASE_TAG.
 *
 * Every phase only reads. The workflow writes the tag and the release with the release App.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { annotatedTag, type GithubFetch } from "../source-preview-release.ts";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, parsePackageReleaseTag, parsePackagesConfig, releaseVersionAbove } from "./package-manifest-policy.ts";
import { runPackagesCheck } from "./packages-check.ts";

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
  if (!RELEASE_VERSION.test(version)) throw new Error("version must be a MAJOR.MINOR.PATCH release version");
  if (!/^[a-f0-9]{40}$/u.test(target)) throw new Error("target_commit must be a full lowercase commit SHA");
  if (note.trim() === "" || note.includes("\0")) throw new Error("notes must contain the reviewed UTF-8 release body");
  const tag = `openlup-${directoryName}-v${version}`;
  const release = parsePackageReleaseTag(tag);
  if (!release) throw new Error(`${tag} is not a package release tag`);
  return { ...release, target, tag, title: `${release.name} ${version}`, message: `OpenLup package ${release.name} ${version}.`, note };
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
  if (!packument) return;
  const versions = Object.keys(packument.versions === undefined ? {} : record(packument.versions, "npm versions"));
  const times = Object.keys(packument.time === undefined ? {} : record(packument.time, "npm time")).filter((key) => !["created", "modified", "unpublished"].includes(key));
  const held = [...new Set([...versions, ...times])];
  if (held.includes(version)) throw new Error(`${name}@${version} is or was on npm; a version is never republished`);
  for (const other of held) {
    const above = releaseVersionAbove(version, other);
    if (above === undefined) throw new Error(`npm lists ${name}@${other}, which is not a semver version`);
    if (!above) throw new Error(`${name}@${version} is not above ${name}@${other} on npm; latest only moves forward`);
  }
}

/** The checkout is the clean target, and its package is publishable at exactly the requested version. */
export function assertReleaseCandidate(root: string, input: PackageRelease): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
  if (head !== input.target || dirty !== "") throw new Error("the checkout must be the target commit without tracked changes");
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  if (config.packages.find(({ directory }) => directory === input.directory)?.publish !== true) throw new Error(`${input.directory} is not a publishable package in ${PACKAGES_CONFIG_PATH}`);
  const { version } = JSON.parse(readFileSync(join(root, input.directory, "package.json"), "utf8")) as { version?: unknown };
  if (version !== input.version) throw new Error(`${input.directory}/package.json is at ${String(version)}, not ${input.version}; merge its release:bump first`);
}

/** The manifest policy and release version of every package at the tag: `packages:check --release-tag`, with no install, build or pack. */
export function checkReleaseManifests(root: string, tag: string): void {
  if (runPackagesCheck(root, ["--release-tag", tag]) !== 0) throw new Error(`packages:check --release-tag ${tag} refused the target`);
}

/** Every refusal that needs no write, before the protected approval and again after it. */
export async function preflightPackageRelease(root: string, input: PackageRelease, token?: string, fetcher: GithubFetch = fetch, manifestCheck: typeof checkReleaseManifests = checkReleaseManifests): Promise<void> {
  assertReleaseCandidate(root, input);
  manifestCheck(root, input.tag);
  await assertTagAbsent(input.tag, token, fetcher);
  assertVersionUnpublished(input.name, input.version, await readPackument(input.name, fetcher));
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

const PHASES = ["preflight", "prepare", "check-draft", "verify", "registry"];

async function main(): Promise<void> {
  const { env, argv } = process;
  const phase = argv[2] ?? "";
  if (argv.length !== 3 || !PHASES.includes(phase)) throw new Error(`expected one phase: ${PHASES.join(", ")}`);
  if (phase === "registry") {
    await assertRegistryReady(env.RELEASE_TAG ?? "");
    console.log(`npm holds neither ${env.RELEASE_TAG} nor any later version`);
    return;
  }
  const input = packageReleaseInputs(env.PACKAGE ?? "", env.VERSION ?? "", env.TARGET_COMMIT ?? "", env.RELEASE_NOTES ?? "");
  const root = realpathSync(process.cwd());
  const token = env.GITHUB_TOKEN;
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "package release refused"); process.exitCode = 1; });
}
