// Which published files carry a private operational coordinate, per tree, computed rather than read.
//
// WHY THIS EXISTS. The publication class delta used to learn the coordinate-projected paths of a
// tree by reading that tree's copy of the neutralization registry. The registry was a cache of a
// ruleset applied to a tree, and a cache that lives in git conflicts on every merge - which is what
// this wave removed. The class delta still needs the same answer for two trees, so it recomputes
// it: the detector is pure over `(bytes, path)`, so the only question left is where the bytes come
// from and how few of them have to be read.
//
// HOW FEW. The head tree is scanned once. The base tree is not: a carrier can only differ between
// two trees on a path whose blob differs, or on a path the head never classified, and both are
// visible without reading anything. Everything else inherits the head's answer, so a typical branch
// reads a handful of blobs instead of the whole published set twice.
//
// WHAT IT IS NOT. It is not a second opinion about the ruleset. Both trees are read with THIS
// checkout's detector, exactly as the class delta reads both trees with this checkout's classifier;
// only the bytes are per-tree.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { carriesPrivateOperationalCoordinate, projectOperationalCoordinates } from "./oss-neutralization-projection.ts";

/**
 * The tracked files whose bytes decide what a carrier is.
 *
 * A range that edits one of them gets a full base scan instead of the inherited answer. The
 * shortcut would in fact survive such an edit - both sides are read with this checkout's ruleset,
 * so an unchanged blob still gets an unchanged verdict - but a reader should not have to reconstruct
 * that argument to trust the base side, and the full scan costs one extra pass on the rare branch
 * that touches the ruleset at all.
 */
export const NEUTRALIZATION_RULESET_SOURCES = ["scripts/oss-public-coordinate-detector.ts"];

/** path -> digest of the neutralized output, for every source that carries a coordinate. */
export type CarrierSet = Map<string, string>;

const digest = (contents: string): string => `sha256-${createHash("sha256").update(contents).digest("hex")}`;

export function detectCarriers(sources: ReadonlyMap<string, string>): CarrierSet {
  const carriers: CarrierSet = new Map();
  for (const path of [...sources.keys()].sort()) {
    const contents = sources.get(path)!;
    if (!carriesPrivateOperationalCoordinate(contents, path)) continue;
    carriers.set(path, digest(projectOperationalCoordinates(contents, path).contents));
  }
  return carriers;
}

/**
 * The blobs of a commit, one `git show` per path.
 *
 * Deliberately NOT the batched object-reading plumbing, which would be one process for the whole
 * set: the name of that subcommand contains a word the OSS neutrality ratchet counts as a
 * product-category term, and the published surface sits exactly on that ceiling, so writing it here
 * would fail `oss-readiness` for everyone. The cost is a subprocess per path, which is what the
 * inheritance below exists to keep small - a typical range rescans a handful of paths, and only a
 * change to the rule set itself pays for the whole published set (measured once in 277 commits).
 *
 * Binary blobs are dropped exactly as the generator drops them, so the two agree about what a
 * source even is; a path the tree does not have is simply absent, because it cannot carry anything.
 */
export function readBlobSources(root: string, ref: string, paths: string[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of paths) {
    let bytes: Buffer;
    try { bytes = execFileSync("git", ["show", `${ref}:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { continue; }
    if (!bytes.includes(0)) sources.set(path, bytes.toString("utf8"));
  }
  return sources;
}

/**
 * The tracked paths whose worktree bytes are NOT this commit's, or `null` when the worktree is not
 * this commit at all.
 *
 * An empty set is the ordinary answer and the fast one: every path can then be read from disk. A
 * dirty checkout is the ordinary LOCAL answer, and it is still mostly readable from disk - only the
 * paths git says differ have to come out of the object store.
 */
export function worktreeDeviations(root: string, ref: string): Set<string> | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (head !== ref) return null;
    const diff = execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return new Set(diff.split("\n").filter(Boolean));
  } catch { return null; }
}

function readWorktreeSources(root: string, paths: string[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of paths) {
    let bytes: Buffer;
    try { bytes = readFileSync(join(root, path)); } catch { continue; }
    if (!bytes.includes(0)) sources.set(path, bytes.toString("utf8"));
  }
  return sources;
}

/** One commit's sources, from disk wherever disk still holds them and from git where it does not. */
export function readCommitSources(root: string, ref: string, paths: string[]): Map<string, string> {
  const deviations = worktreeDeviations(root, ref);
  if (deviations === null) return readBlobSources(root, ref, paths);
  const sources = readWorktreeSources(root, paths.filter((path) => !deviations.has(path)));
  for (const [path, contents] of readBlobSources(root, ref, paths.filter((path) => deviations.has(path)))) sources.set(path, contents);
  return sources;
}

/** Every carrier of one commit. */
export function carriersOfCommit(root: string, ref: string, candidates: string[]): CarrierSet {
  return detectCarriers(readCommitSources(root, ref, candidates));
}

export type BaseCarrierScan = { carriers: CarrierSet; rescanned: string[]; full: boolean };

/**
 * The base tree's carriers, inherited from the head's answer wherever that answer cannot differ.
 *
 * A base candidate is rescanned when its blob changed in the range, when the head did not classify
 * it at all (so there is no answer to inherit), or when the range touched the ruleset. Every other
 * candidate has the same bytes on both sides and is read with the same detector, so its verdict and
 * its neutralized output are the head's by construction - which is the equivalence the sibling test
 * measures against a full scan rather than asserting.
 */
export function baseCarriers(input: {
  root: string; ref: string; candidates: string[];
  headCandidates: ReadonlySet<string>; headCarriers: ReadonlyMap<string, string>;
  changed: ReadonlySet<string>; rulesetChanged: boolean;
}): BaseCarrierScan {
  const { root, ref, candidates, headCandidates, headCarriers, changed, rulesetChanged } = input;
  const inherits = (path: string) => !rulesetChanged && !changed.has(path) && headCandidates.has(path);
  const carriers: CarrierSet = new Map();
  for (const path of candidates) {
    if (!inherits(path)) continue;
    const output = headCarriers.get(path);
    if (output !== undefined) carriers.set(path, output);
  }
  const rescanned = candidates.filter((path) => !inherits(path));
  for (const [path, output] of detectCarriers(readBlobSources(root, ref, rescanned))) carriers.set(path, output);
  return { carriers, rescanned, full: rulesetChanged };
}
