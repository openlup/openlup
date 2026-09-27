import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { authenticateGithubSourceRelease, parseSourceReleaseReceiptEnvelope, type AuthenticatedSourceCandidate, type GithubFetch, type GithubSourceTransportInput, type PreviousReleaseIdentity } from "./oss-consume-github-transport.ts";
import { writeDescendantSourceReleaseReceipt } from "./oss-source-release-contract.ts";

const repository = "https://github.com/openlup/openlup";
const api = "https://api.github.com/repos/openlup/openlup";
const assetName = "openlup-source-receipt.json";
const digest = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const tagFor = (number: number) => `openlup-source-preview/${number}`;
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

export function authenticatedIdentity(candidate: AuthenticatedSourceCandidate): PreviousReleaseIdentity {
  return { releaseTag: candidate.release.tag, assetName: candidate.release.assetName, assetId: candidate.release.assetId, assetDigest: candidate.release.assetDigest, sourceReceiptDigest: candidate.sourceReceiptDigest, targetPublicSha: candidate.targetCommit };
}

// Bootstrap evidence is never trusted by itself. The strict authenticator below re-reads
// the immutable asset, tag, body, Git ancestry and checks before returning an identity.
async function bootstrapIdentity(number: number, token: string | undefined, fetcher: GithubFetch): Promise<PreviousReleaseIdentity> {
  const tag = tagFor(number);
  const release = record(await (await read(`/releases/tags/${encodeURIComponent(tag)}`, token, fetcher)).json());
  if (release.tag_name !== tag || release.immutable !== true || release.prerelease !== true || release.draft !== false || !Array.isArray(release.assets)) throw new Error("bootstrap release must be an immutable published preview");
  const assets = release.assets.map(record).filter((asset) => asset.name === assetName);
  if (assets.length !== 1 || !Number.isSafeInteger(assets[0].id) || Number(assets[0].id) < 1 || typeof assets[0].digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(assets[0].digest)) throw new Error("bootstrap receipt asset identity is malformed");
  const asset = assets[0];
  const bytes = Buffer.from(await (await read(`/releases/assets/${asset.id}`, token, fetcher, "application/octet-stream")).arrayBuffer());
  if (digest(bytes) !== asset.digest) throw new Error("bootstrap receipt asset digest differs");
  const receipt = parseSourceReleaseReceiptEnvelope(bytes);
  if (receipt.evidenceClass !== "activation-candidate" || receipt.identity.repository !== repository || receipt.disclosure.tag?.name !== tag) throw new Error("bootstrap receipt identity differs");
  return { releaseTag: tag, assetName, assetId: Number(asset.id), assetDigest: String(asset.digest), sourceReceiptDigest: digest(bytes), targetPublicSha: receipt.export.commit };
}

export async function previousPreview(number: number, token?: string, fetcher: GithubFetch = fetch): Promise<{ previous: GithubSourceTransportInput; identity: PreviousReleaseIdentity }> {
  const transport = (ordinal: number, previousRelease?: PreviousReleaseIdentity): GithubSourceTransportInput => ({ repository, releaseTag: tagFor(ordinal), assetName, receiptCodec: parseSourceReleaseReceiptEnvelope, token, ...(previousRelease ? { previousRelease } : {}) });
  let predecessor: PreviousReleaseIdentity | undefined;
  if (number > 2) {
    const anchor = number > 3 ? await bootstrapIdentity(number - 3, token, fetcher) : undefined;
    predecessor = authenticatedIdentity(await authenticateGithubSourceRelease(transport(number - 2, anchor), fetcher));
  }
  const previous = transport(number - 1, predecessor);
  const authenticated = await authenticateGithubSourceRelease(previous, fetcher);
  return { previous, identity: authenticatedIdentity(authenticated) };
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

export function assertDraft(value: unknown, tag: string, note: string, receiptBytes: Buffer) {
  const release = record(value);
  const receipt = parseSourceReleaseReceiptEnvelope(receiptBytes);
  if (receipt.schemaVersion !== 5 || receipt.disclosure.tag?.name !== tag || receipt.disclosure.releaseNote.digest !== digest(note)) throw new Error("local receipt does not bind this tag and note");
  if (release.tag_name !== tag || release.draft !== true || release.prerelease !== true || release.body !== note) throw new Error("draft release body or identity differs from the receipt");
  if (!Array.isArray(release.assets) || release.assets.length !== 1) throw new Error("draft receipt asset differs from the attested bytes");
  const asset = record(release.assets[0]);
  if (asset.name !== assetName || asset.digest !== digest(receiptBytes)) throw new Error("draft receipt asset differs from the attested bytes");
}

async function main() {
  const input = previewInputs(process.env.TARGET_COMMIT ?? "", process.env.PREVIEW_NUMBER ?? "", process.env.RELEASE_NOTES ?? "");
  const root = realpathSync(process.cwd()), out = realpathSync(process.env.RELEASE_OUTPUT_DIR ?? "");
  if (out === root || out.startsWith(`${root}${sep}`)) throw new Error("release outputs must stay outside the checkout");
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== input.target) throw new Error("checkout differs from target_commit");
  const token = process.env.GITHUB_TOKEN;
  const path = (name: string) => resolve(out, name);
  const phase = process.argv[2];
  if (phase === "prepare") {
    await assertNextPreview(input.number, token);
    const { previous, identity } = await previousPreview(input.number, token);
    if (identity.targetPublicSha === input.target) throw new Error("target must advance the previous preview");
    execFileSync("git", ["merge-base", "--is-ancestor", identity.targetPublicSha, input.target]);
    const { token: _token, receiptCodec: _codec, ...publicPrevious } = previous;
    writeFileSync(path("previous.json"), `${JSON.stringify({ previous: publicPrevious, identity }, null, 2)}\n`, { flag: "wx" });
    writeFileSync(path("notes.md"), input.note, { flag: "wx" });
  } else if (phase === "produce") {
    const state = JSON.parse(readFileSync(path("previous.json"), "utf8"));
    await writeDescendantSourceReleaseReceipt({ root, previous: { ...state.previous, receiptCodec: parseSourceReleaseReceiptEnvelope, token }, releaseTag: input.tag, tagMessage: input.message, releaseNote: readFileSync(path("notes.md")), outputPath: path(assetName) });
  } else if (phase === "check-draft") {
    const release = await (await read(`/releases/tags/${encodeURIComponent(input.tag)}`, token, fetch)).json();
    assertDraft(release, input.tag, readFileSync(path("notes.md"), "utf8"), readFileSync(path(assetName)));
  } else if (phase === "verify") {
    const state = JSON.parse(readFileSync(path("previous.json"), "utf8"));
    const candidate = await authenticateGithubSourceRelease({ repository, releaseTag: input.tag, assetName, receiptCodec: parseSourceReleaseReceiptEnvelope, previousRelease: state.identity, token });
    if (candidate.targetCommit !== input.target || !candidate.sourceReceiptRaw.equals(readFileSync(path(assetName)))) throw new Error("published release differs from the prepared target or receipt");
    console.log(`Authenticated immutable ${input.tag} at ${input.target}; ${candidate.sourceReceiptDigest}`);
  } else throw new Error("expected prepare, produce, check-draft or verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "source preview operation refused"); process.exitCode = 1; });
}
