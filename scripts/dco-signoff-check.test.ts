// Both directions, against a real repository.
//
// A sign-off check is only worth its runner minute if it can be shown to FAIL. A test that only
// ever feeds it good input proves the happy path and nothing about the property the gate exists
// for, so the cases here are paired: a range that passes, and the same range with one thing wrong.
//
// The commits are made in throwaway repositories built by the test rather than read out of this
// checkout. That is deliberate on two counts: this repository's own history carries no sign-offs,
// so reading it would only ever prove the failing half; and a published tree has a history of
// exactly one commit, which is the shape the check must survive on day one.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SIGN_OFF, main, readCommits, report, signOffVerdict, type Commit } from "./dco-signoff-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Fixed identity and a neutralised configuration, so the fixture does not depend on whose machine
// runs it - and so `-s` writes a trailer this test can predict.
const IDENTITY = ["-c", "user.name=A Contributor", "-c", "user.email=contributor@example.com"];
const ENVIRONMENT = { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" };

const repositories: string[] = [];

function makeRepository(): { at: string; git: (...args: string[]) => string; commit: (subject: string, ...flags: string[]) => string } {
  const at = mkdtempSync(join(tmpdir(), "dco-signoff-"));
  repositories.push(at);
  const git = (...args: string[]): string =>
    execFileSync("git", [...IDENTITY, ...args], { cwd: at, encoding: "utf8", env: ENVIRONMENT }).trim();
  git("init", "--quiet", "--initial-branch=main");
  const commit = (subject: string, ...flags: string[]): string => {
    git("commit", "--allow-empty", "--no-gpg-sign", ...flags, "-m", subject);
    return git("rev-parse", "HEAD");
  };
  return { at, git, commit };
}

const verdictOf = (at: string, base: string, head: string): { code: number; output: string } => {
  const lines: string[] = [];
  const code = main(at, [base, head], (line) => lines.push(line));
  return { code, output: lines.join("\n") };
};

afterAll(() => {
  for (const at of repositories) rmSync(at, { recursive: true, force: true });
});

describe("a real commit range", () => {
  // root -> certified -> uncertified -> tip, plus a side branch merged back at the end.
  let at = "";
  const sha: Record<string, string> = {};

  beforeAll(() => {
    const repository = makeRepository();
    at = repository.at;
    sha.root = repository.commit("root: the one commit a published tree starts from", "-s");
    sha.certified = repository.commit("feat: a change whose author certified it", "-s");
    sha.uncertified = repository.commit("feat: a change nobody certified");
    sha.tip = repository.commit("fix: certified, on top of the one that is not", "-s");
    repository.git("checkout", "--quiet", "-b", "side", sha.certified);
    sha.contributed = repository.commit("feat: contributed on a branch", "-s");
    repository.git("checkout", "--quiet", "main");
    repository.git("merge", "--no-ff", "--no-gpg-sign", "-m", "Merge branch 'side'", "side");
    sha.merged = repository.git("rev-parse", "HEAD");
  });

  it("passes when every commit carries the trailer, and says how many it certified", () => {
    const { code, output } = verdictOf(at, sha.root, sha.certified);
    expect(code).toBe(0);
    expect(output).toContain("- commits read: 1");
    expect(output).toContain("- signed off: 1");
    expect(output).toContain("every commit is signed off.");
  });

  it("certifies the first push through the non-empty parentless bootstrap mode", () => {
    const result = verdictOf(at, "0".repeat(40), sha.root);
    expect(result).toMatchObject({ code: 0 });
    expect(result.output).toContain("- commits read: 1");
    expect(() => readCommits(at, "0".repeat(40), sha.certified)).toThrow(/exactly one non-empty parentless root/);
  });

  it("fails on a missing sign-off, names the commit, and tells the contributor how to fix it", () => {
    const { code, output } = verdictOf(at, sha.certified, sha.uncertified);
    expect(code).toBe(1);
    expect(output).toContain("without a sign-off: 1");
    expect(output).toContain(sha.uncertified.slice(0, 12));
    expect(output).toContain("feat: a change nobody certified");
    expect(output).toContain("git rebase --signoff");
    expect(output).not.toContain("every commit is signed off.");
  });

  it("fails a range whose LAST commit is signed but whose earlier one is not", () => {
    // The obvious wrong implementation reads only the head commit. This range ends signed.
    const { code, output } = verdictOf(at, sha.certified, sha.tip);
    expect(code).toBe(1);
    expect(output).toContain("- commits read: 2");
    expect(output).toContain(sha.uncertified.slice(0, 12));
    expect(output).not.toContain(sha.tip.slice(0, 12));
  });

  it("refuses an empty range rather than reporting a green check over nothing", () => {
    const { code, output } = verdictOf(at, sha.certified, sha.certified);
    expect(code).toBe(1);
    expect(output).toContain("nothing was certified");
  });

  it("requires a sign-off on the merge commit as well as the commits it brought in", () => {
    const commits = readCommits(at, sha.tip, sha.merged);
    const verdict = signOffVerdict(commits);
    expect(verdict.merges.map((entry) => entry.parents.length)).toEqual([2]);
    expect(verdict.certified.map((entry) => entry.sha)).toEqual([sha.contributed]);
    expect(verdict.missing.map((entry) => entry.sha)).toEqual([sha.merged]);
    const { code, output } = verdictOf(at, sha.tip, sha.merged);
    expect(code).toBe(1);
    expect(output).toContain("- merge commits included: 1");
  });

  it("refuses an end that is not a full commit digest, so no argument can be read as an option", () => {
    expect(() => readCommits(at, "--all", sha.certified)).toThrow(/not a full commit digest/);
    expect(() => readCommits(at, sha.certified, "HEAD")).toThrow(/not a full commit digest/);
    expect(main(at, ["--all", sha.certified], () => {})).toBe(2);
    expect(main(at, [sha.certified], () => {})).toBe(2);
  });
});

describe("the same content, before and after the sign-off is added", () => {
  it("fails, then passes, with nothing else changed", () => {
    const repository = makeRepository();
    const base = repository.commit("root: nothing to certify yet", "-s");
    const before = repository.commit("feat: the contribution");
    expect(verdictOf(repository.at, base, before)).toMatchObject({ code: 1 });

    repository.git("commit", "--amend", "--no-edit", "--allow-empty", "--no-gpg-sign", "-s");
    const after = repository.git("rev-parse", "HEAD");
    expect(after).not.toEqual(before);
    expect(repository.git("log", "-1", "--format=%s", after)).toEqual("feat: the contribution");

    const { code, output } = verdictOf(repository.at, base, after);
    expect(code).toBe(0);
    expect(output).toContain("- signed off: 1");
  });
});

describe("the unsigned first push", () => {
  it("is measured and rejected rather than skipped or certified empty", () => {
    const repository = makeRepository();
    const root = repository.commit("root without the certificate");
    const result = verdictOf(repository.at, "0".repeat(40), root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("without a sign-off: 1");
    expect(result.output).not.toContain("nothing was certified");
  });
});

describe("what a range may not silently be", () => {
  const merge: Commit = { sha: "a".repeat(40), parents: ["b".repeat(40), "c".repeat(40)], message: "Merge branch 'side'" };

  it("refuses an unsigned merge-only range under the every-commit rule", () => {
    const lines: string[] = [];
    expect(report(signOffVerdict([merge]), (line) => lines.push(line))).toBe(false);
    expect(lines.join("\n")).toContain("without a sign-off: 1");
  });

  it("refuses a range with no commit at all, and says why a pass there would be meaningless", () => {
    const lines: string[] = [];
    expect(report(signOffVerdict([]), (line) => lines.push(line))).toBe(false);
    expect(lines.join("\n")).toContain("A green check over an empty measurement is not a check.");
  });
});

describe("the trailer this accepts is the trailer the contributor was told to write", () => {
  const accepts = (body: string): boolean =>
    signOffVerdict([{ sha: "0".repeat(40), parents: ["1".repeat(40)], message: body }]).certified.length === 1;

  it("accepts exactly what CONTRIBUTING.md documents", () => {
    const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    const documented = /^Signed-off-by: .+$/m.exec(contributing)?.[0];
    expect(documented).toBeTruthy();
    expect(accepts(`subject\n\n${documented}`)).toBe(true);
  });

  it("accepts a trailer with another trailer after it, and one written with tabs", () => {
    expect(accepts("subject\n\nSigned-off-by: A Contributor <contributor@example.com>\nCo-authored-by: Someone <s@example.com>")).toBe(true);
    expect(accepts("subject\n\nSigned-off-by:\tTabbed Name <t@example.com>\t")).toBe(true);
  });

  it("refuses a line that only looks like one", () => {
    expect(accepts("subject\n\nSigned-off-by: A Contributor")).toBe(false);
    expect(accepts("subject\n\nSigned-off-by: <contributor@example.com>")).toBe(false);
    expect(accepts("subject\n\nSigned-off-by: A Contributor <not-an-address>")).toBe(false);
    expect(accepts("subject\n\nnot really Signed-off-by: A Contributor <c@example.com>")).toBe(false);
    expect(accepts("subject with no body at all")).toBe(false);
  });

  it("is a per-line assertion with no state carried between calls", () => {
    expect(SIGN_OFF.flags).toContain("m");
    expect(SIGN_OFF.global).toBe(false);
  });
});
