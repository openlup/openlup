import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReviewReceipt } from "./agent-review-gate.mjs";
import { verifyReviewHook, verifyReviewObjectGraph } from "./agent-review-hook.mjs";

// These keys exist only in memory for falsifiers; they are never controller credentials.
const fixtureKey = generateKeyPairSync("ed25519");
const wrongKey = generateKeyPairSync("ed25519");
const now = 1_800_000_000_000;
const contexts = ["dco", "typecheck", "install-proof", "test", "self-check", "gitleaks"];
function fixture(stage: "local" | "hosted" = "local", risk = "behavior") {
  const expected = {
    publicKey: fixtureKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
    version: 1, stage, repository: "openlup/openlup", base: "1".repeat(40),
    head: "2".repeat(40), tree: "3".repeat(40), authorityDigest: "4".repeat(64),
    policyDigest: "5".repeat(64), requestId: "fixture-request", risk,
    requiredRoles: ["correctness", "security"], authorRunId: "author-run", now,
    maxValidityMs: 60_000,
    ...(stage === "hosted" ? { checks: contexts.map(name => ({ name, source: "trusted-controller/workflow-v1", runId: `ci-${name}`, head: "2".repeat(40) })) } : {}),
  };
  const reviewer = (id: string, role: string) => ({ id, runId: `review-${id}`, role, cold: true, complete: true, verdict: "pass", simplicityChecked: true });
  const payload = {
    version: 1, stage, repository: expected.repository, base: expected.base,
    head: expected.head, tree: expected.tree, authorityDigest: expected.authorityDigest,
    policyDigest: expected.policyDigest, requestId: expected.requestId, risk,
    issuedAt: now - 1_000, expiresAt: now + 30_000, unresolvedMaterialFindings: 0,
    reviewers: [reviewer("a", "correctness"), reviewer("b", "security")],
    checks: (expected.checks ?? []).map(check => ({ ...check, status: "completed", conclusion: "SUCCESS" })),
  };
  return { expected, payload };
}
function envelope(payload: unknown) {
  const bytes = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  return { payload: bytes.toString("base64"), signature: sign(null, bytes, fixtureKey.privateKey).toString("base64") };
}
function refused(change: (f: ReturnType<typeof fixture>) => void, stage: "local" | "hosted" = "local") {
  const f = fixture(stage); change(f);
  expect(() => verifyReviewReceipt(envelope(f.payload), f.expected)).toThrow();
}

describe("authenticated independent review admission", () => {
  it.each(["local", "hosted"] as const)("admits a complete %s fixture", stage => {
    const f = fixture(stage);
    expect(verifyReviewReceipt(envelope(f.payload), f.expected)).toEqual(f.payload);
  });
  it("admits one cold reviewer for prose only", () => {
    const f = fixture("local", "prose"); f.payload.reviewers.pop(); f.expected.requiredRoles = ["correctness"];
    expect(verifyReviewReceipt(envelope(f.payload), f.expected)).toEqual(f.payload);
  });
  it("requires two reviewers when classification is unknown", () => {
    const f = fixture("local", "unknown"); f.payload.reviewers.pop(); f.expected.requiredRoles = ["correctness"];
    expect(() => verifyReviewReceipt(envelope(f.payload), f.expected)).toThrow();
  });
  it("admits unknown risk with the behavioral floor", () => {
    const f = fixture("local", "unknown");
    expect(verifyReviewReceipt(envelope(f.payload), f.expected)).toEqual(f.payload);
  });
  it("rejects a signature from an unexpected issuer", () => refused(f => { f.expected.publicKey = wrongKey.publicKey.export({ type: "spki", format: "pem" }).toString(); }));
  it("rejects bytes changed after signing", () => {
    const f = fixture(); const signed = envelope(f.payload); f.payload.head = "9".repeat(40);
    signed.payload = Buffer.from(JSON.stringify(f.payload)).toString("base64");
    expect(() => verifyReviewReceipt(signed, f.expected)).toThrow();
  });
  it("rejects authenticated malformed JSON", () => expect(() => verifyReviewReceipt(envelope("{"), fixture().expected)).toThrow());
  it.each(["payload", "signature"])("rejects malformed base64 %s", field => {
    const f = fixture(); const signed = envelope(f.payload); signed[field as "payload" | "signature"] = "%%%";
    expect(() => verifyReviewReceipt(signed, f.expected)).toThrow();
  });
  it("rejects oversized authenticated payloads", () => expect(() => verifyReviewReceipt(envelope(" ".repeat(128 * 1024 + 1)), fixture().expected)).toThrow());
  it("bounds otherwise valid JSON before admitting it", () => {
    const f = fixture(); f.payload.requestId = "r".repeat(128 * 1024); f.expected.requestId = f.payload.requestId;
    expect(() => verifyReviewReceipt(envelope(f.payload), f.expected)).toThrow();
  });
  it.each(["repository", "base", "head", "tree", "authorityDigest", "policyDigest", "requestId", "risk", "stage", "version"])("rejects signed %s drift", field => {
    refused(f => { (f.payload as Record<string, unknown>)[field] = field === "version" ? 2 : "other"; });
  });
  it("rejects local evidence used for hosted delivery", () => {
    const f = fixture(); const hosted = fixture("hosted");
    expect(() => verifyReviewReceipt(envelope(f.payload), hosted.expected)).toThrow();
  });
  it("rejects a future protocol even if caller and receipt agree", () => refused(f => { f.expected.version = 2; f.payload.version = 2; }));
  it.each(["expired", "future", "overlong", "reversed"])("rejects %s validity", kind => refused(f => {
    if (kind === "expired") f.payload.expiresAt = now;
    if (kind === "future") f.payload.issuedAt = now + 1_000;
    if (kind === "overlong") f.payload.expiresAt = now + 120_000;
    if (kind === "reversed") f.payload.expiresAt = f.payload.issuedAt - 1;
  }));
  it.each(["id", "runId"])("rejects duplicate reviewer %s", field => refused(f => {
    f.payload.reviewers[1][field as "id" | "runId"] = f.payload.reviewers[0][field as "id" | "runId"];
  }));
  it("rejects author reviewing their own execution", () => refused(f => { f.payload.reviewers[0].runId = f.expected.authorRunId; }));
  it("rejects a missing specialist role", () => refused(f => { f.expected.requiredRoles.push("database-specialist"); }));
  it("rejects one reviewer for behavior even if roles are satisfied", () => refused(f => { f.payload.reviewers.pop(); f.expected.requiredRoles = ["correctness"]; }));
  it.each(["cold", "complete"])("rejects reviewer missing %s", field => refused(f => { f.payload.reviewers[0][field as "cold" | "complete"] = false; }));
  it("rejects a nonpassing reviewer", () => refused(f => { f.payload.reviewers[0].verdict = "fail"; }));
  it("rejects unresolved material findings", () => refused(f => { f.payload.unresolvedMaterialFindings = 1; }));
  it("requires the permanent simplicity perspective", () => refused(f => { f.payload.reviewers.forEach(reviewer => { reviewer.simplicityChecked = false; }); }));
  it("rejects hosted checks smuggled into local evidence", () => {
    const f = fixture(); f.payload.checks = fixture("hosted").payload.checks;
    expect(() => verifyReviewReceipt(envelope(f.payload), f.expected)).toThrow();
  });
  it.each(["SKIPPED", "NEUTRAL", "FAILURE", "success"])("rejects hosted conclusion %s", conclusion => refused(f => { f.payload.checks[0].conclusion = conclusion; }, "hosted"));
  it("rejects missing hosted checks", () => refused(f => { f.payload.checks.pop(); }, "hosted"));
  it("rejects duplicate hosted checks", () => refused(f => { f.payload.checks[1] = { ...f.payload.checks[0] }; }, "hosted"));
  it.each(["source", "runId", "head", "status"])("rejects hosted %s mismatch", field => refused(f => { (f.payload.checks[0] as Record<string, unknown>)[field] = "other"; }, "hosted"));
  it("rejects a caller that omits expected check identities", () => refused(f => { f.expected.checks = []; }, "hosted"));
});

describe("dormant hook snapshot falsifiers", () => {
  const scratch = resolve(".context/scratch/agent-review-tests");
  const owned: string[] = [];
  afterEach(() => { for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  function harness() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "fixture-")); owned.push(directory);
    const cwd = join(directory, "candidate"); mkdirSync(cwd);
    // A synthetic Git fixture, never a clone or a real protected installation.
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    const commit = () => { git("add", "file.txt"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"); };
    git("init", "--quiet", "-b", "main"); writeFileSync(join(cwd, "file.txt"), "baseline\n"); commit();
    const base = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", base);
    writeFileSync(join(cwd, "file.txt"), "changed\n"); commit();
    const f = fixture(); f.expected.base = f.payload.base = base;
    f.expected.head = f.payload.head = git("rev-parse", "HEAD");
    f.expected.tree = f.payload.tree = git("rev-parse", "HEAD^{tree}");
    const path = join(directory, "agent-review-gate.mjs"); copyFileSync(resolve("scripts/agent-review-gate.mjs"), path);
    const installation = { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
    const input = () => ({ cwd, expectation: f.expected, envelope: envelope(f.payload), installation, now: () => f.expected.now });
    return { ...f, cwd, directory, git, commit, installation, input };
  }
  it("admits exact clean synthetic input with a pinned fixture verifier", async () => {
    const f = harness(); expect(await verifyReviewHook(f.input())).toEqual(f.payload);
  });
  it("authenticates the actual reachable object graph of an unchanged fixture", async () => {
    const f = harness();
    await verifyReviewObjectGraph(f.cwd, { base: f.expected.base, head: f.expected.head, tree: f.expected.tree });
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
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
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
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
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
  it("refuses a receipt that expires during the second actual snapshot scan", async () => {
    const f = harness(); let samples = 0;
    await expect(verifyReviewHook({ ...f.input(), now: () => ++samples === 1 ? f.expected.now : f.payload.expiresAt + 1 })).rejects.toThrow(/expired/u);
    expect(samples).toBe(2);
  });
  it("refuses a dirty or untracked candidate", async () => {
    const f = harness(); writeFileSync(join(f.cwd, "untracked.txt"), "dirty");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it.each(["--assume-unchanged", "--skip-worktree"])("refuses changed bytes hidden by index flag %s", async flag => {
    const f = harness(); f.git("update-index", flag, "file.txt");
    writeFileSync(join(f.cwd, "file.txt"), "hidden changed bytes\n");
    expect(f.git("status", "--porcelain=v1")).toBe("");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses mode drift hidden by core.filemode=false", async () => {
    const f = harness(); f.git("config", "core.filemode", "false");
    chmodSync(join(f.cwd, "file.txt"), 0o755);
    expect(f.git("status", "--porcelain=v1")).toBe("");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses same-size bytes hidden by restored mtime and minimal stat checks", async () => {
    const f = harness(); const path = join(f.cwd, "file.txt"); const fixedTime = 1_700_000_000;
    f.git("config", "core.trustctime", "false"); f.git("config", "core.checkStat", "minimal");
    utimesSync(path, fixedTime, fixedTime); expect(f.git("status", "--porcelain=v1")).toBe("");
    writeFileSync(path, "altered\n"); utimesSync(path, fixedTime, fixedTime);
    expect(f.git("status", "--porcelain=v1")).toBe("");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("checks raw bytes without executing a clean filter that conceals mutation", async () => {
    const f = harness(); const marker = join(f.directory, "filter-executed"); const filter = join(f.directory, "filter.cjs");
    writeFileSync(filter, `const fs = require('node:fs'); fs.readFileSync(0); fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write('changed\\n');\n`);
    f.git("config", "filter.conceal.clean", `"${process.execPath}" "${filter}"`);
    writeFileSync(join(f.cwd, ".git/info/attributes"), "file.txt filter=conceal\n");
    writeFileSync(join(f.cwd, "file.txt"), "altered\n");
    expect(f.git("status", "--porcelain=v1")).toBe(""); expect(existsSync(marker)).toBe(true); rmSync(marker);
    await expect(verifyReviewHook(f.input())).rejects.toThrow(); expect(existsSync(marker)).toBe(false);
  });
  it("admits a committed symlink and refuses changed link targets", async () => {
    const f = harness(); const path = join(f.cwd, "link"); symlinkSync("file.txt", path); f.git("add", "link"); f.commit();
    f.expected.head = f.payload.head = f.git("rev-parse", "HEAD");
    f.expected.tree = f.payload.tree = f.git("rev-parse", "HEAD^{tree}");
    expect(await verifyReviewHook(f.input())).toEqual(f.payload);
    rmSync(path); symlinkSync("else.txt", path);
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses a tracked parent directory replaced by an external symlink", async () => {
    const f = harness(); const nested = join(f.cwd, "nested"); mkdirSync(nested);
    writeFileSync(join(nested, "child.txt"), "committed bytes\n"); f.git("add", "nested/child.txt"); f.commit();
    f.expected.head = f.payload.head = f.git("rev-parse", "HEAD");
    f.expected.tree = f.payload.tree = f.git("rev-parse", "HEAD^{tree}");
    expect(await verifyReviewHook(f.input())).toEqual(f.payload);
    const external = join(f.directory, "external"); renameSync(nested, external); symlinkSync(external, nested, "dir");
    // Hide the replacement directory entry from untracked inventory: its file
    // bytes still match HEAD, but the tracked path crosses a mutable symlink.
    writeFileSync(join(f.cwd, ".git/info/exclude"), "nested\n");
    expect(f.git("ls-files", "--others", "--exclude-standard")).toBe("");
    await expect(verifyReviewHook(f.input())).rejects.toThrow(/symlink|parent/u);
  });
  it("refuses a commit added after review", async () => {
    const f = harness(); writeFileSync(join(f.cwd, "file.txt"), "later\n"); f.commit();
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses stale base expectations", async () => {
    const f = harness(); f.git("update-ref", "refs/remotes/origin/main", f.expected.head);
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses baseline-only task approval", async () => {
    const f = harness(); f.expected.base = f.payload.base = f.expected.head;
    f.git("update-ref", "refs/remotes/origin/main", f.expected.head);
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses a verifier from the candidate checkout", async () => {
    const f = harness(); f.installation.path = join(f.cwd, "file.txt");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses altered protected verifier bytes", async () => {
    const f = harness(); writeFileSync(f.installation.path, "export function verifyReviewReceipt() { return {}; }\n");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("refuses a snapshot mutated during verification", async () => {
    const f = harness(); const path = join(f.directory, "mutation-fixture.mjs");
    writeFileSync(path, `import { verifyReviewReceipt as actual } from './agent-review-gate.mjs';
import { writeFileSync } from 'node:fs';
export function verifyReviewReceipt(...args) {
  const receipt = actual(...args);
  writeFileSync(${JSON.stringify(join(f.cwd, "file.txt"))}, 'changed during verification');
  return receipt;
}\n`);
    f.installation.path = path; f.installation.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    await expect(verifyReviewHook(f.input())).rejects.toThrow();
  });
  it("CLI checks live time rather than a persisted expectation clock", () => {
    const f = harness(); const live = Date.now(); f.expected.now = live - 10_000;
    f.payload.issuedAt = live - 11_000; f.payload.expiresAt = live - 5_000;
    expect(verifyReviewReceipt(envelope(f.payload), f.expected)).toEqual(f.payload);
    const adapter = join(f.directory, "agent-review-hook.mjs"); copyFileSync(resolve("scripts/agent-review-hook.mjs"), adapter);
    writeFileSync(join(f.directory, "agent-review-hook.json"), JSON.stringify({ expectation: f.expected, installation: f.installation }));
    const receipt = join(f.directory, "receipt.json"); writeFileSync(receipt, JSON.stringify(envelope(f.payload)));
    const result = spawnSync(process.execPath, [adapter, f.cwd, receipt], { encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/expired/u);
  });
  it.each(["configuration", "receipt"])("CLI refuses FIFO %s without blocking", which => {
    const f = harness(); const adapter = join(f.directory, "agent-review-hook.mjs"); copyFileSync(resolve("scripts/agent-review-hook.mjs"), adapter);
    const configuration = join(f.directory, "agent-review-hook.json");
    writeFileSync(configuration, JSON.stringify({ expectation: f.expected, installation: f.installation }));
    const receipt = join(f.directory, "receipt.json"); writeFileSync(receipt, JSON.stringify(envelope(f.payload)));
    const fifo = which === "configuration" ? configuration : receipt; rmSync(fifo); execFileSync("mkfifo", [fifo]);
    const result = spawnSync(process.execPath, [adapter, f.cwd, receipt], { encoding: "utf8", timeout: 2_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).toMatch(/regular file/u);
  });
});
