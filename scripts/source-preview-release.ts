import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PACKAGES_CONFIG_PATH, parsePackagesConfig } from "./packages/package-manifest-policy.ts";
import { runPackagesCheck } from "./packages/packages-check.ts";
import { pathToFileURL } from "node:url";
import { assertDescendantSourceRelease, assertNoOverdueRemovals } from "./oss-source-release-contract.ts";

export type GithubFetch = (input: string, init?: RequestInit) => Promise<Response>;
const api = "https://api.github.com/repos/openlup/openlup";
const tagFor = (number: number) => `openlup-source-preview/${number}`;
const commitSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release API record is malformed");
  return value as Record<string, unknown>;
}

export function previewInputs(target: string, ordinal: string, note: string) {
  if (!/^[a-f0-9]{40}$/u.test(target)) throw new Error("target_commit must be a full lowercase commit SHA");
  if (!/^[1-9][0-9]*$/u.test(ordinal) || !Number.isSafeInteger(Number(ordinal)) || Number(ordinal) < 2) throw new Error("preview_number must be the next descendant preview number (at least 2)");
  if (note.trim() === "" || note.includes("\0")) throw new Error("release_notes must contain the reviewed UTF-8 release body");
  return { target, number: Number(ordinal), tag: tagFor(Number(ordinal)), message: `OpenLup source preview ${ordinal}.`, note };
}

function headers(token?: string, accept = "application/vnd.github+json") {
  return { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function read(path: string, token: string | undefined, fetcher: GithubFetch, accept?: string) {
  const response = await fetcher(`${api}${path}`, { headers: headers(token, accept) });
  if (!response.ok) throw new Error(`source preview API refused ${path}: HTTP ${response.status}`);
  return response;
}

/** The commit and message of the annotated tag `tag`. A lightweight tag refuses. */
export async function annotatedTag(tag: string, token?: string, fetcher: GithubFetch = fetch): Promise<{ commit: string; message: string }> {
  const ref = record(await (await read(`/git/ref/tags/${encodeURIComponent(tag)}`, token, fetcher)).json());
  const object = record(ref.object);
  if (ref.ref !== `refs/tags/${tag}` || object.type !== "tag" || !commitSha(object.sha)) throw new Error(`${tag} must be an annotated tag`);
  const tagObject = record(await (await read(`/git/tags/${object.sha}`, token, fetcher)).json());
  const tagged = record(tagObject.object);
  if (tagObject.sha !== object.sha || tagObject.tag !== tag || tagged.type !== "commit" || !commitSha(tagged.sha) || typeof tagObject.message !== "string") throw new Error(`${tag} annotated tag identity is malformed`);
  return { commit: tagged.sha, message: tagObject.message };
}

/**
 * The preview immediately before `number`: an immutable published prerelease and the commit its
 * annotated tag names. GitHub's release attestation of that tag is verified separately, by
 * `gh release verify` in the workflow, before this runs.
 */
export async function previousPreview(number: number, token?: string, fetcher: GithubFetch = fetch): Promise<{ tag: string; commit: string }> {
  const tag = tagFor(number - 1);
  const release = record(await (await read(`/releases/tags/${encodeURIComponent(tag)}`, token, fetcher)).json());
  if (release.tag_name !== tag || release.immutable !== true || release.prerelease !== true || release.draft !== false) throw new Error(`${tag} is not an immutable published preview`);
  return { tag, commit: (await annotatedTag(tag, token, fetcher)).commit };
}

export async function assertNextPreview(number: number, token?: string, fetcher: GithubFetch = fetch) {
  let latest = 0;
  for (let page = 1; ; page++) {
    const releases = await (await read(`/releases?per_page=100&page=${page}`, token, fetcher)).json();
    if (!Array.isArray(releases)) throw new Error("release inventory is malformed");
    for (const release of releases) {
      if (!String(release.tag_name).startsWith("openlup-source-preview/")) continue;
      const match = /^openlup-source-preview\/([1-9][0-9]*)$/u.exec(release.tag_name);
      if (!match || !Number.isSafeInteger(Number(match[1])) || release.draft === true || release.prerelease !== true || release.immutable !== true) throw new Error("source preview inventory contains an unfinished or invalid release; maintainer recovery is required");
      latest = Math.max(latest, Number(match[1]));
    }
    if (releases.length < 100) break;
  }
  if (number !== latest + 1) throw new Error("preview_number must immediately follow the newest immutable preview");
  const ref = await fetcher(`${api}/git/ref/tags/${encodeURIComponent(tagFor(number))}`, { headers: headers(token) });
  if (ref.status !== 404) throw new Error(`preview tag is present or unavailable (HTTP ${ref.status}); never retag or overwrite`);
}

/** Refuse an unpublishable or mismatched release before notes or an App token exist. */
export function assertReleasablePackages(root: string, target: string, tag: string, pack: boolean | string = false): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
  if (head !== target || dirty !== "") throw new Error("the checkout must be the target commit without tracked changes");
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  if (!config.packages.some(({ publish }) => publish)) throw new Error(`${PACKAGES_CONFIG_PATH} lists no publishable package; a source preview carries its package`);
  const args = ["--release-tag", tag, ...(typeof pack === "string" ? ["--out", pack] : pack ? ["--pack"] : [])];
  if (runPackagesCheck(root, args) !== 0) throw new Error(`packages:check ${args.join(" ")} refused the target; a source preview carries its lockstep package`);
}

/**
 * The prepare phase, before any tag exists: the next ordinal, removal markers, the previous
 * release, ancestry and the descendant check that the target describes itself. It writes the
 * exact note bytes that creation and publication use.
 */
export async function preparePreview(input: ReturnType<typeof previewInputs>, root: string, out: string, token?: string, fetcher: GithubFetch = fetch, packageCheck: typeof assertReleasablePackages = assertReleasablePackages) {
  await assertNextPreview(input.number, token, fetcher);
  assertNoOverdueRemovals(input.number, input.target, root);
  const previous = await previousPreview(input.number, token, fetcher);
  if (previous.commit === input.target) throw new Error("target must advance the previous preview");
  execFileSync("git", ["merge-base", "--is-ancestor", previous.commit, input.target], { cwd: root });
  assertDescendantSourceRelease(root, previous.commit, input.target);
  packageCheck(root, input.target, input.tag);
  writeFileSync(resolve(out, "notes.md"), input.note, { flag: "wx" });
}

/** A release that must carry exactly the prepared note and no asset. */
function assertReleaseBody(release: Record<string, unknown>, note: string, label: string) {
  if (release.body !== note) throw new Error(`${label} release body differs from the prepared note`);
  if (!Array.isArray(release.assets) || release.assets.length !== 0) throw new Error(`${label} release must carry no asset`);
}

export function assertDraft(value: unknown, tag: string, note: string) {
  const release = record(value);
  if (release.tag_name !== tag || release.draft !== true || release.prerelease !== true) throw new Error("draft release identity differs from the prepared tag");
  assertReleaseBody(release, note, "draft");
}

// GitHub's release lookup by tag returns only published releases, so the draft is found in
// the release list, which includes drafts for a token with push access.
export async function findDraft(tag: string, token?: string, fetcher: GithubFetch = fetch) {
  const drafts: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const releases = await (await read(`/releases?per_page=100&page=${page}`, token, fetcher)).json();
    if (!Array.isArray(releases)) throw new Error("release inventory is malformed");
    for (const release of releases.map(record)) if (release.tag_name === tag && release.draft === true) drafts.push(release);
    if (releases.length < 100) break;
  }
  if (drafts.length !== 1) throw new Error(`expected exactly one draft release for ${tag}, found ${drafts.length}; maintainer recovery is required`);
  return drafts[0];
}

/** The check-draft phase: the one draft carrying the tag must hold the exact note and no asset. */
export async function checkDraft(tag: string, note: string, token?: string, fetcher: GithubFetch = fetch) {
  assertDraft(await findDraft(tag, token, fetcher), tag, note);
}

/** The verify phase: the published immutable prerelease, its exact note and its annotated tag at the target. */
export async function verifyPublished(input: ReturnType<typeof previewInputs>, note: string, token?: string, fetcher: GithubFetch = fetch) {
  const release = record(await (await read(`/releases/tags/${encodeURIComponent(input.tag)}`, token, fetcher)).json());
  if (release.tag_name !== input.tag || release.immutable !== true || release.prerelease !== true || release.draft !== false) throw new Error(`${input.tag} is not an immutable published preview`);
  assertReleaseBody(release, note, "published");
  const tag = await annotatedTag(input.tag, token, fetcher);
  if (tag.commit !== input.target || tag.message !== `${input.message}\n`) throw new Error("published tag differs from the prepared target or message");
}

async function main() {
  const input = previewInputs(process.env.TARGET_COMMIT ?? "", process.env.PREVIEW_NUMBER ?? "", process.env.RELEASE_NOTES ?? "");
  const root = realpathSync(process.cwd());
  const phase = process.argv[2];
  if (phase === "packages") {
    if (process.argv.length !== 4) throw new Error("packages phase needs exactly one output directory");
    assertReleasablePackages(root, input.target, input.tag, process.argv[3]);
    console.log(`${input.target} packs a publishable package for ${input.tag}`);
    return;
  }
  const out = realpathSync(process.env.RELEASE_OUTPUT_DIR ?? "");
  if (out === root || out.startsWith(`${root}${sep}`)) throw new Error("release outputs must stay outside the checkout");
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== input.target) throw new Error("checkout differs from target_commit");
  const token = process.env.GITHUB_TOKEN;
  const notes = () => readFileSync(resolve(out, "notes.md"), "utf8");
  if (phase === "prepare") {
    await preparePreview(input, root, out, token);
  } else if (phase === "check-draft") {
    await checkDraft(input.tag, notes(), token);
  } else if (phase === "verify") {
    await verifyPublished(input, notes(), token);
    console.log(`Verified immutable ${input.tag} at ${input.target}`);
  } else throw new Error("expected packages, prepare, check-draft or verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "source preview operation refused"); process.exitCode = 1; });
}
