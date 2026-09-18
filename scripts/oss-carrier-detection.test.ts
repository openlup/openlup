// The base-side shortcut, measured against the scan it replaces.
//
// The publication class delta reads the head tree once and then declines to read most of the base
// tree, on the argument that a carrier can only differ where the blob differs. That argument is
// worth exactly as much as a fixture that tries to break it, so every case here computes the base
// carriers BOTH ways - incrementally and by reading every candidate blob - and compares.
//
// The repositories are real, because the reader under test reads git objects, and a fake would
// only prove that the fake agrees with itself.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { baseCarriers, carriersOfCommit, detectCarriers, NEUTRALIZATION_RULESET_SOURCES, readBlobSources, worktreeDeviations } from "./oss-carrier-detection.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

const git = (root: string, args: string[]) => execFileSync("git", args, {
  cwd: root, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
}).trim();

const write = (root: string, path: string, contents: string | Buffer) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};

const commit = (root: string, message: string): string => {
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};

// A real coordinate of the real rule set, never spelled contiguously in a tracked file.
const CARRIER = `export const endpoint = '${["https://github.com/example", "app"].join("/")}';\n`;
const CARRIER_MOVED = `${CARRIER}export const revision = 2;\n`;
const PLAIN = "export const plain = 1;\n";

/** Six candidates, two of which carry a coordinate, plus one binary blob and one absent path. */
function repository(): { root: string; base: string; candidates: string[] } {
  const root = mkdtempSync(join(tmpdir(), "carrier-detection-"));
  scratch.push(root);
  git(root, ["init", "--quiet", "-b", "main", "."]);
  write(root, "src/carrier.ts", CARRIER);
  write(root, "src/second-carrier.ts", CARRIER);
  write(root, "src/plain.ts", PLAIN);
  write(root, "src/also-plain.ts", PLAIN);
  write(root, "src/binary.bin", Buffer.from([0x66, 0x00, 0x67]));
  return { root, base: commit(root, "base"), candidates: ["src/also-plain.ts", "src/binary.bin", "src/carrier.ts", "src/plain.ts", "src/second-carrier.ts", "src/vanished.ts"] };
}

describe("reading one tree's sources", () => {
  it("returns text blobs, skips binary ones and is silent about paths a tree does not have", () => {
    const { root, base, candidates } = repository();
    const sources = readBlobSources(root, base, candidates);
    expect([...sources.keys()].sort()).toEqual(["src/also-plain.ts", "src/carrier.ts", "src/plain.ts", "src/second-carrier.ts"]);
    expect(sources.get("src/carrier.ts")).toBe(CARRIER);
    expect(readBlobSources(root, base, [])).toEqual(new Map());
  });

  it("reads the worktree only where the worktree still holds that commit's bytes", () => {
    const { root, base, candidates } = repository();
    expect(worktreeDeviations(root, base)).toEqual(new Set());
    expect(carriersOfCommit(root, base, candidates)).toEqual(detectCarriers(readBlobSources(root, base, candidates)));

    write(root, "src/plain.ts", CARRIER);
    expect(worktreeDeviations(root, base)).toEqual(new Set(["src/plain.ts"]));
    // The uncommitted edit must not leak into the answer for a commit that does not contain it,
    // and the paths it did not touch must still be read from disk.
    expect([...carriersOfCommit(root, base, candidates).keys()]).toEqual(["src/carrier.ts", "src/second-carrier.ts"]);

    // A worktree that is a different commit entirely has nothing on disk worth trusting.
    write(root, "src/late.ts", PLAIN);
    const head = commit(root, "move the worktree off the base");
    expect(worktreeDeviations(root, base)).toBeNull();
    expect(head).not.toBe(base);
    expect([...carriersOfCommit(root, base, candidates).keys()]).toEqual(["src/carrier.ts", "src/second-carrier.ts"]);
  });

  it("names a carrier by its neutralized output, so a change of bytes is visible without a class move", () => {
    const carriers = detectCarriers(new Map([["a.ts", CARRIER], ["b.ts", CARRIER_MOVED], ["c.ts", PLAIN]]));
    expect([...carriers.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(carriers.get("a.ts")).not.toBe(carriers.get("b.ts"));
    expect(carriers.get("a.ts")).toMatch(/^sha256-[a-f0-9]{64}$/u);
  });
});

describe("the base side is rescanned only where it can differ", () => {
  /** The base carriers computed the cheap way, and the same thing computed by reading everything. */
  function bothWays(root: string, base: string, head: string, candidates: string[], rulesetChanged: boolean) {
    const headCandidates = candidates;
    const headCarriers = carriersOfCommit(root, head, headCandidates);
    const changed = new Set(git(root, ["diff", "--name-only", "--no-renames", base, head]).split("\n").filter(Boolean));
    const scan = baseCarriers({ root, ref: base, candidates, headCandidates: new Set(headCandidates), headCarriers, changed, rulesetChanged });
    return { scan, full: detectCarriers(readBlobSources(root, base, candidates)) };
  }

  it("agrees with a full scan when a carrier gains, loses and moves its coordinate", () => {
    const { root, base, candidates } = repository();
    write(root, "src/carrier.ts", CARRIER_MOVED);
    write(root, "src/second-carrier.ts", PLAIN);
    write(root, "src/plain.ts", CARRIER);
    const head = commit(root, "three ways for a carrier to move");

    const { scan, full } = bothWays(root, base, head, candidates, false);
    expect([...scan.carriers].sort()).toEqual([...full].sort());
    expect(scan.full).toBe(false);
    expect(scan.rescanned).toEqual(["src/carrier.ts", "src/plain.ts", "src/second-carrier.ts"]);
  });

  it("agrees with a full scan when the range changes the rule set, and reads everything to do it", () => {
    const { root, base, candidates } = repository();
    const [ruleset] = NEUTRALIZATION_RULESET_SOURCES;
    write(root, ruleset!, "// the rule set moved\n");
    write(root, "src/carrier.ts", CARRIER_MOVED);
    const head = commit(root, "change the rule set");

    const changed = new Set(git(root, ["diff", "--name-only", "--no-renames", base, head]).split("\n").filter(Boolean));
    expect(NEUTRALIZATION_RULESET_SOURCES.some((path) => changed.has(path))).toBe(true);

    const { scan, full } = bothWays(root, base, head, candidates, true);
    expect([...scan.carriers].sort()).toEqual([...full].sort());
    expect(scan.full).toBe(true);
    expect(scan.rescanned).toEqual(candidates);
  });

  it("rescans a base candidate the head never classified, because there is no answer to inherit", () => {
    const { root, base, candidates } = repository();
    // The head withholds the path rather than changing it: its blob is identical on both sides, so
    // only its absence from the head's candidate set can make the base read it.
    const head = base;
    const headCandidates = new Set(candidates.filter((path) => path !== "src/second-carrier.ts"));
    const scan = baseCarriers({
      root, ref: base, candidates, headCandidates,
      headCarriers: carriersOfCommit(root, head, [...headCandidates]),
      changed: new Set<string>(), rulesetChanged: false,
    });
    expect(scan.rescanned).toEqual(["src/second-carrier.ts"]);
    expect([...scan.carriers].sort()).toEqual([...detectCarriers(readBlobSources(root, base, candidates))].sort());
  });
});
