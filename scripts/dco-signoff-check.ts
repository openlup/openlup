#!/usr/bin/env node
// Every commit a pull request proposes carries a Developer Certificate of Origin sign-off, or
// this check fails and names the ones that do not.
//
// CONTRIBUTING.md states the requirement in words - `Signed-off-by: Your Name <name@example.com>`
// on every commit, written by `git commit -s`, certifying DCO 1.1, and explicitly no CLA - and
// .github/GOVERNANCE.md points at that file as the single source. Until this instrument existed,
// nothing read a commit message: the requirement was a rule to the contributor and a promise to
// the reader, and it was enforced against neither. A documented rule with no falsifier behind it
// is the one kind of governance text that is worse than saying nothing.
//
// ⛔ NOT a third-party action. A checker for this is a `git log` call and a regular expression.
// Pinned by a mutable tag it would be a standing supply-chain hole in the first automation a
// public repository ever runs - and `dependabot.yml` ships beside it, so that pin would also be
// the example every reader copies. Pinned by full commit digest it is safe but still an
// unreviewable dependency in commit 1 of a project whose whole claim is that you can read it.
//
// ⛔ NOT author matching. Several well-known checkers additionally demand that the sign-off name
// and address equal the commit author's. CONTRIBUTING.md does not say that, and a check may not
// be stricter than the document a contributor agreed to: it would refuse a patch legitimately
// carried on someone else's behalf. What is enforced here is exactly the documented sentence.
//
// ⛔ A range that certifies zero commits is an ERROR, not a pass. A shallow checkout, a bad range,
// or a workflow edit that stops passing both ends of it would otherwise produce a green badge
// over an empty measurement, which is strictly worse than having no check at all.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** One commit, as `git log` reports it: identity, parents, and the raw message. */
export type Commit = { sha: string; parents: string[]; message: string };

export type Verdict = { certified: Commit[]; merges: Commit[]; missing: Commit[] };

// The trailer, on a line of its own: a non-empty display name, then an address in angle brackets.
// Anchored per line rather than to the end of the message, because `git commit -s` writes it into
// the trailer block and a contributor may legitimately add another trailer after it.
export const SIGN_OFF = /^[ \t]*Signed-off-by:[ \t]*(\S[^<>]*?)[ \t]*<([^<>@\s]+@[^<>\s]+)>[ \t]*$/m;

const DIGEST = /^[0-9a-f]{40}$/;
const ZERO = /^0{40}$/;
// Unit separator. Records are NUL-terminated by `-z`, fields inside one are split by this, and
// a commit message can contain neither - which is what makes the message safe to carry last
// and raw, with no escaping and no length prefix.
const FIELD = "\u001f";

/**
 * The verdict, as a pure function of the commits, so both directions are testable without a
 * process. Merge commits are included: conflict resolution can introduce content, and the public
 * contribution contract says every commit rather than every non-merge commit.
 */
export function signOffVerdict(commits: Commit[]): Verdict {
  const merges = commits.filter((commit) => commit.parents.length > 1);
  return {
    merges,
    certified: commits.filter((commit) => SIGN_OFF.test(commit.message)),
    missing: commits.filter((commit) => !SIGN_OFF.test(commit.message)),
  };
}

/**
 * The commits a pull request adds, read from the repository at `root`. Both ends are re-validated
 * as full digests here, after the workflow has already passed them through `env:` rather than
 * interpolating them into a shell line - so nothing reaching `git` can be read as an option.
 */
export function readCommits(root: string, base: string, head: string): Commit[] {
  if ((!DIGEST.test(base) && !ZERO.test(base)) || !DIGEST.test(head)) throw new Error("one or both range ends are not a full commit digest");
  const revision = ZERO.test(base) ? head : `${base}..${head}`;
  const raw = execFileSync("git", ["log", "-z", `--format=%H${FIELD}%P${FIELD}%B`, revision], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const commits = raw.split("\0").filter(Boolean).map((record) => {
    const [sha, parents, ...rest] = record.split(FIELD);
    return { sha, parents: (parents ?? "").split(" ").filter(Boolean), message: rest.join(FIELD) };
  });
  if (ZERO.test(base)) {
    const count = execFileSync("git", ["rev-list", "--count", head], { cwd: root, encoding: "utf8" }).trim();
    if (count !== "1" || commits.length !== 1 || commits[0]!.sha !== head || commits[0]!.parents.length !== 0) throw new Error("bootstrap DCO requires exactly one non-empty parentless root");
  }
  return commits;
}

const subject = (commit: Commit): string => (commit.message.split("\n")[0] ?? "").trim();

export function report(verdict: Verdict, log: (line: string) => void): boolean {
  const seen = verdict.certified.length + verdict.missing.length;
  if (seen === 0) {
    log("no commit was read in that range, so nothing was certified.");
    log("A green check over an empty measurement is not a check. Verify the range and the checkout depth.");
    return false;
  }
  log(`- commits read: ${seen}`);
  log(`- signed off: ${verdict.certified.length}`);
  log(`- merge commits included: ${verdict.merges.length}`);
  if (verdict.missing.length === 0) return true;
  log(`- ⛔ without a sign-off: ${verdict.missing.length}`);
  for (const commit of verdict.missing) log(`  ${commit.sha.slice(0, 12)}  ${subject(commit)}`);
  log("");
  log("Every commit needs a line of its own reading");
  log("    Signed-off-by: Your Name <your.email@example.com>");
  log("which certifies the Developer Certificate of Origin 1.1 (https://developercertificate.org).");
  log("`git commit -s` writes it. To add it to work already committed:");
  log("    git rebase --signoff <base>   # then force-push the branch");
  log("See CONTRIBUTING.md. There is no CLA; the sign-off is the whole requirement.");
  return false;
}

export function main(root: string, argv: string[], log: (line: string) => void): number {
  const [base, head, ...extra] = argv;
  if (!base || !head || extra.length > 0) {
    process.stderr.write("usage: dco-signoff-check.ts <base-commit> <head-commit>\n  both ends as full 40-character digests\n");
    return 2;
  }
  let commits: Commit[];
  try {
    commits = readCommits(root, base, head);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const ok = report(signOffVerdict(commits), log);
  log(ok ? "every commit is signed off." : "the sign-off CONTRIBUTING.md requires is missing.");
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.cwd(), process.argv.slice(2), (line) => process.stdout.write(`${line}\n`)));
}
