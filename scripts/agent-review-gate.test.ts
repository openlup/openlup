import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readReviewObjects, reviewTreeEntries, verifyReviewObjectGraph } from "./agent-review-hook.mjs";

describe("native review source graph authentication", () => {
  const scratch = resolve(".context/scratch/agent-review-tests");
  const owned: string[] = [];
  afterEach(() => { for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  function harness() {
    mkdirSync(scratch, { recursive: true });
    const cwd = mkdtempSync(join(scratch, "fixture-")); owned.push(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    const commit = () => { git("add", "file.txt"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"); };
    git("init", "--quiet", "-b", "main"); writeFileSync(join(cwd, "file.txt"), "baseline\n"); commit();
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "file.txt"), "changed\n"); commit();
    const expected = { base, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
    return { cwd, git, expected };
  }
  it("authenticates the actual reachable object graph of an unchanged fixture", async () => {
    const f = harness();
    const graph = await verifyReviewObjectGraph(f.cwd, f.expected);
    const entries = reviewTreeEntries(graph, graph.headTree);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({ path: "file.txt", mode: "100644" });
    const objects = await readReviewObjects(f.cwd, [entry.object]);
    expect(objects.get(entry.object)?.bytes).toEqual(readFileSync(join(f.cwd, "file.txt")));
  });
  it("refuses raw commit bytes stored under another claimed commit digest", async () => {
    const f = harness();
    const raw = execFileSync("/usr/bin/git", ["-C", f.cwd, "cat-file", "commit", f.expected.head]);
    const replaced = Buffer.concat([raw, Buffer.from("forged trailing commit message\n")]);
    const target = join(f.cwd, ".git", "objects", f.expected.head.slice(0, 2), f.expected.head.slice(2));
    chmodSync(target, 0o644);
    writeFileSync(target, deflateSync(Buffer.concat([Buffer.from(`commit ${replaced.length}\0`), replaced])));
    expect(f.git("rev-parse", "HEAD")).toBe(f.expected.head);
    // Some Git versions refuse corrupt loose objects during revision peeling;
    // direct graph authentication must also refuse independently of that behavior.
    await expect(verifyReviewObjectGraph(f.cwd, { base: f.expected.base, head: f.expected.head, tree: f.expected.tree })).rejects.toThrow();
  });
  it("refuses benign tree bytes substituted under a different claimed tree digest", async () => {
    const f = harness();
    const baseTree = f.git("rev-parse", `${f.expected.base}^{tree}`);
    const raw = execFileSync("/usr/bin/git", ["-C", f.cwd, "cat-file", "tree", baseTree]);
    writeFileSync(join(f.cwd, "file.txt"), "baseline\n"); f.git("read-tree", baseTree);
    const target = join(f.cwd, ".git", "objects", f.expected.tree.slice(0, 2), f.expected.tree.slice(2));
    chmodSync(target, 0o644);
    writeFileSync(target, deflateSync(Buffer.concat([Buffer.from(`tree ${raw.length}\0`), raw])));
    await expect(verifyReviewObjectGraph(f.cwd, { base: f.expected.base, head: f.expected.head, tree: f.expected.tree })).rejects.toThrow();
  });
  it("refuses a hash-valid commit whose late parent header does not establish Git ancestry", async () => {
    const f = harness();
    const raw = Buffer.from(`tree ${f.expected.tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\nparent ${f.expected.base}\n\nlate parent fixture\n`);
    const object = Buffer.concat([Buffer.from(`commit ${raw.length}\0`), raw]);
    const digest = createHash("sha1").update(object).digest("hex");
    const directory = join(f.cwd, ".git", "objects", digest.slice(0, 2)); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, digest.slice(2)), deflateSync(object));
    expect(f.git("rev-list", "--parents", digest)).toBe(digest);
    await expect(verifyReviewObjectGraph(f.cwd, { base: f.expected.base, head: digest, tree: f.expected.tree })).rejects.toThrow();
  });
});
