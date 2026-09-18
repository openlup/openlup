import { execFileSync } from "node:child_process";

/** The comparison ref a repository finding is attributed to, and where it came from. */
export type ReviewBase = { ref: string | null; reason: string };

export function gitLines(root: string, args: string[]): { lines: string[]; error: string | null } {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { lines: out.trim().split("\n").filter(Boolean), error: null };
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr || (error as Error).message;
    return { lines: [], error: String(detail).trim().split("\n")[0] };
  }
}

/** Every path proposed by this checkout: committed, staged, unstaged, or untracked. */
export function pathsUnderReview(
  root: string,
  base: ReviewBase,
  pathspecs: string[] = [],
): { paths: string[]; error: string | null } {
  if (base.ref === null) return { paths: [], error: null };
  const paths = new Set<string>();
  const suffix = pathspecs.length > 0 ? ["--", ...pathspecs] : [];
  for (const args of [
    ["diff", "--name-only", `${base.ref}..HEAD`, ...suffix],
    ["diff", "--name-only", "--cached", ...suffix],
    ["diff", "--name-only", ...suffix],
    ["ls-files", "--others", "--exclude-standard", ...suffix],
  ]) {
    const result = gitLines(root, args);
    if (result.error) return { paths: [], error: result.error };
    for (const path of result.lines) paths.add(path);
  }
  return { paths: [...paths].sort(), error: null };
}

/** Resolve the reviewed base without dropping local work when that base equals HEAD. */
export function resolveReviewBase(root: string, override: string | undefined): ReviewBase {
  const head = gitLines(root, ["rev-parse", "HEAD"]);
  if (head.error || !head.lines[0]) return { ref: null, reason: "HEAD does not resolve" };
  const requested = override ?? process.env.ORIENTATION_STALE_BASE;
  const source = requested ? `base ref '${requested}'` : "the merge base with origin/main";
  const resolved = requested
    ? gitLines(root, ["rev-parse", "--verify", `${requested}^{commit}`])
    : gitLines(root, ["merge-base", "HEAD", "origin/main"]);
  if (resolved.error || !resolved.lines[0]) return { ref: null, reason: `${source} does not resolve` };
  const ref = resolved.lines[0];
  if (ref === head.lines[0]) {
    const working = pathsUnderReview(root, { ref, reason: source });
    if (working.error) return { ref: null, reason: `${source} is HEAD and the working tree cannot be read: ${working.error}` };
    if (working.paths.length === 0) return { ref: null, reason: `${source} is HEAD and the working tree is clean` };
  }
  return { ref, reason: source };
}

/**
 * Attribution, the way `docs-header-stale` already does it: a repository-wide finding blocks the
 * change under review only when that change touched one of the inputs the verdict is computed
 * from. Everything else is drift the branch inherited, and a whole-tree invariant that fails on
 * inherited drift evicts whoever is next in the queue rather than whoever wrote it.
 *
 * It fails CLOSED, and the asymmetry is deliberate. With no comparison base, or with a pathspec
 * git cannot read, nothing can be attributed to anyone - so the finding keeps the verdict it
 * already has instead of being demoted on the strength of a comparison that never happened. That
 * is the opposite of the staleness rule, which has nothing to fall back to and reports; here the
 * fallback is the whole-tree judgement that was in force before attribution existed.
 */
export function introducedUnderReview(root: string, base: ReviewBase, inputs: string[]): boolean {
  if (base.ref === null) return true;
  const touched = pathsUnderReview(root, base, inputs);
  if (touched.error) return true;
  return touched.paths.length > 0;
}
