import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { authenticateGithubSourceRelease, parseSourceReleaseReceiptEnvelope, renderSourceReleaseAllowlist, type GithubFetch, type GithubSourceTransportInput, type PreviousReleaseIdentity, type SourceReceiptCodec, type SourceReceiptEnvelope } from "./oss-consume-github-transport.ts";
import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, createPublicPublicationCatalog, packageExecutionDigest } from "./oss-publication-policy.ts";
import { createSourceReleaseContract, deriveSourceReleaseContract, writeDescendantSourceReleaseReceipt, type SourceReleaseContractInput } from "./oss-source-release-contract.ts";

const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const blob = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const target = "a".repeat(40), targetTree = "b".repeat(40), oldTarget = "d".repeat(40), oldTree = "e".repeat(40), intermediate = "9".repeat(40), olderParent = "8".repeat(40), tag = "openlup-source-preview/2", oldTag = "openlup-source-preview/1", root = "https://api.github.com/repos/openlup/openlup";
type Scenario = { targetTag?: string; previousTag?: string; targetCommit?: string; targetTree?: string; previousTarget?: string; previousTree?: string; intermediateCommit?: string; descendant?: boolean; previousDescendant?: boolean; contractBytes?: Buffer; readmeBytes?: Buffer; receiptDrift?: SourceReceiptEnvelope["drift"]; repositoryRecord?: Record<string, unknown>; inputRepository?: string; inputExpectedPublicCi?: GithubSourceTransportInput["expectedPublicCi"]; protected?: boolean; branchCommit?: unknown; protectedHeadRecord?: unknown; protectedCompare?: unknown; rules?: unknown; release?: Record<string, unknown>; releaseBody?: unknown; tagRecord?: Record<string, unknown>; previousReleaseBody?: unknown; previousTagRecord?: Record<string, unknown>; receiptRaw?: Buffer; refType?: string; parents?: unknown[]; receiptParents?: string[]; receiptCommit?: string; receiptTree?: string; receiptContractDigest?: string; receiptPathDigest?: string; receiptPaths?: SourceReceiptEnvelope["disclosure"]["paths"]; targetEntries?: unknown[]; targetContractMode?: string; targetTreeSha?: string; targetTruncated?: boolean; targetBlobBytes?: Buffer; runs?: unknown[]; statuses?: unknown[]; statusSha?: string; nextRuns?: unknown[]; nextStatuses?: unknown[]; previousAssetBytes?: Buffer; previousRefType?: string; previousTagTarget?: string; previousReceiptCommit?: string; previousReceiptTree?: string; previousParents?: unknown[]; previousReceiptParents?: string[]; previousTreeEntries?: unknown[]; previousReceiptPaths?: SourceReceiptEnvelope["disclosure"]["paths"]; previousContractMode?: string; previousTreeSha?: string; compare?: Record<string, unknown>; olderCompare?: Record<string, unknown> };

function fixture(scenario: Scenario = {}) {
  const targetTag = scenario.targetTag ?? (scenario.previousDescendant ? "openlup-source-preview/3" : scenario.descendant ? tag : oldTag), previousTag = scenario.previousTag ?? (scenario.previousDescendant ? tag : oldTag), targetSha = scenario.targetCommit ?? target, targetTreeSha = scenario.targetTree ?? targetTree, previousSha = scenario.previousTarget ?? oldTarget, previousTreeSha = scenario.previousTree ?? oldTree, middleSha = scenario.intermediateCommit ?? intermediate;
  const contract = scenario.contractBytes ?? Buffer.from('{"source":"contract"}\n'), readme = scenario.readmeBytes ?? Buffer.from("public\n"), oldFile = Buffer.from("old public\n"), contractBlob = blob(contract), readmeBlob = blob(readme), oldBlob = blob(oldFile);
  const targetEntries = scenario.targetEntries ?? [{ path: "README.md", mode: "100644", type: "blob", sha: readmeBlob }, { path: "config/openlup-source-release-contract.json", mode: scenario.targetContractMode ?? "100644", type: "blob", sha: contractBlob }];
  const oldEntries = scenario.previousTreeEntries ?? (scenario.previousContractMode ? [{ path: "config/openlup-source-release-contract.json", mode: scenario.previousContractMode, type: "blob", sha: contractBlob }] : [{ path: "old.txt", mode: "100644", type: "blob", sha: oldBlob }]);
  const paths = scenario.receiptPaths ?? [{ path: "README.md", mode: "100644" as const, digest: digest(readme) }, { path: "config/openlup-source-release-contract.json", mode: (scenario.targetContractMode ?? "100644") as "100644" | "100755", digest: scenario.receiptPathDigest ?? digest(contract) }];
  const targetParents = scenario.receiptParents ?? (scenario.descendant ? [middleSha] : []);
  const receipt = { schemaVersion: scenario.descendant ? 5 : 4, evidenceClass: "activation-candidate", identity: { repository: "https://github.com/openlup/openlup", securityRoute: "dev@openlup.com", evidenceClass: "activation-candidate", owner: { name: "Owner", email: "owner@openlup.com" } }, contract: { path: "config/openlup-source-release-contract.json", digest: scenario.receiptContractDigest ?? digest(contract) }, export: { commit: scenario.receiptCommit ?? targetSha, tree: scenario.receiptTree ?? targetTreeSha, parents: targetParents }, disclosure: { allowlist: { schemaVersion: 1, digest: digest("allowlist") }, paths, releaseNote: { digest: digest("release note") }, tag: { name: targetTag, message: `OpenLup source preview ${targetTag.split("/")[1]}.` } }, drift: scenario.receiptDrift ?? [] } as SourceReceiptEnvelope;
  if (receipt.schemaVersion === 5) receipt.disclosure.allowlist.digest = digest(renderSourceReleaseAllowlist(receipt));
  const oldPaths = scenario.previousReceiptPaths ?? (scenario.previousContractMode ? [{ path: "config/openlup-source-release-contract.json", mode: scenario.previousContractMode as "100644" | "100755", digest: digest(contract) }] : [{ path: "old.txt", mode: "100644" as const, digest: digest(oldFile) }]);
  const oldReceipt = { ...receipt, schemaVersion: scenario.previousDescendant ? 5 : 4, contract: { ...receipt.contract }, export: { commit: scenario.previousReceiptCommit ?? previousSha, tree: scenario.previousReceiptTree ?? previousTreeSha, parents: scenario.previousReceiptParents ?? (scenario.previousDescendant ? [olderParent] : []) }, disclosure: { ...receipt.disclosure, allowlist: { ...receipt.disclosure.allowlist }, releaseNote: { ...receipt.disclosure.releaseNote }, paths: oldPaths, tag: { name: previousTag, message: `OpenLup source preview ${previousTag.split("/")[1]}.` } } } as SourceReceiptEnvelope;
  if (oldReceipt.schemaVersion === 5) oldReceipt.disclosure.allowlist.digest = digest(renderSourceReleaseAllowlist(oldReceipt));
  const receiptBytes = scenario.receiptRaw ?? Buffer.from(JSON.stringify(receipt)), oldReceiptBytes = Buffer.from(JSON.stringify(oldReceipt));
  const rules = scenario.rules ?? [{ type: "required_status_checks", ruleset_id: 7, parameters: { required_status_checks: [{ context: "test" }] } }, { type: "required_status_checks", ruleset_id: 2, parameters: { required_status_checks: [{ context: "build", integration_id: 1 }] } }];
  const calls: Array<{ url: string; headers: Headers }> = [], previous: PreviousReleaseIdentity = { releaseTag: previousTag, assetName: "openlup-source-receipt.json", assetId: 40, assetDigest: digest(oldReceiptBytes), sourceReceiptDigest: digest(oldReceiptBytes), targetPublicSha: previousSha };
  const response = (body: unknown, headers: Record<string, string> = {}) => new Response(Buffer.isBuffer(body) ? body : JSON.stringify(body), { status: 200, headers });
  const fetcher: GithubFetch = async (input, init) => {
    const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
    if (url === root) return response({ full_name: "openlup/openlup", html_url: "https://github.com/openlup/openlup", default_branch: "main", ...scenario.repositoryRecord });
    if (url === `${root}/branches/main`) return response({ protected: scenario.protected ?? true, commit: scenario.branchCommit === undefined ? { sha: targetSha } : scenario.branchCommit });
    if (url === `${root}/rules/branches/main`) return response(rules);
    if (url === `${root}/releases/tags/${encodeURIComponent(targetTag)}`) return response({ tag_name: targetTag, immutable: true, prerelease: true, draft: false, body: scenario.releaseBody ?? "release note", assets: [{ id: 41, name: "openlup-source-receipt.json", digest: digest(receiptBytes) }], ...scenario.release });
    if (url === `${root}/releases/tags/${encodeURIComponent(previousTag)}`) return response({ tag_name: previousTag, immutable: true, prerelease: true, draft: false, body: scenario.previousReleaseBody ?? "release note", assets: [{ id: 40, name: "openlup-source-receipt.json", digest: previous.assetDigest }] });
    if (url === `${root}/git/ref/tags/${encodeURIComponent(targetTag)}`) return response({ object: { type: scenario.refType ?? "tag", sha: "c".repeat(40) } });
    if (url === `${root}/git/tags/${"c".repeat(40)}`) return response({ tag: targetTag, message: `OpenLup source preview ${targetTag.split("/")[1]}.\n`, object: { type: "commit", sha: targetSha }, ...scenario.tagRecord });
    if (url === `${root}/git/ref/tags/${encodeURIComponent(previousTag)}`) return response({ object: { type: scenario.previousRefType ?? "tag", sha: "6".repeat(40) } });
    if (url === `${root}/git/tags/${"6".repeat(40)}`) return response({ tag: previousTag, message: `OpenLup source preview ${previousTag.split("/")[1]}.\n`, object: { type: "commit", sha: scenario.previousTagTarget ?? previousSha }, ...scenario.previousTagRecord });
    if (url === `${root}/git/commits/${targetSha}`) return response({ sha: targetSha, tree: { sha: targetTreeSha }, parents: scenario.parents ?? (scenario.descendant ? [{ sha: middleSha }] : []) });
    if (scenario.branchCommit && typeof scenario.branchCommit === "object" && "sha" in scenario.branchCommit && url === `${root}/git/commits/${String(scenario.branchCommit.sha)}` && scenario.protectedHeadRecord !== undefined) return response(scenario.protectedHeadRecord);
    if (url === `${root}/git/commits/${previousSha}`) return response({ sha: previousSha, tree: { sha: previousTreeSha }, parents: scenario.previousParents ?? (scenario.previousDescendant ? [{ sha: olderParent }] : []) });
    if (url === `${root}/compare/${previousSha}...${targetSha}`) return response(scenario.compare ?? { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, base_commit: { sha: previousSha }, merge_base_commit: { sha: previousSha }, commits: [{ sha: middleSha, parents: [{ sha: previousSha }] }, { sha: targetSha, parents: [{ sha: middleSha }] }] });
    if (scenario.branchCommit && typeof scenario.branchCommit === "object" && "sha" in scenario.branchCommit && url === `${root}/compare/${targetSha}...${String(scenario.branchCommit.sha)}` && scenario.protectedCompare !== undefined) return response(scenario.protectedCompare);
    if (url === `${root}/compare/${olderParent}...${oldTarget}` && scenario.olderCompare) return response(scenario.olderCompare);
    if (url === `${root}/git/trees/${targetTreeSha}?recursive=1`) return response({ sha: scenario.targetTreeSha ?? targetTreeSha, truncated: scenario.targetTruncated ?? false, tree: targetEntries });
    if (url === `${root}/git/trees/${previousTreeSha}?recursive=1`) return response({ sha: scenario.previousTreeSha ?? previousTreeSha, truncated: false, tree: oldEntries });
    if (url === `${root}/commits/${targetSha}/check-runs?per_page=100`) return response({ check_runs: scenario.runs ?? [{ name: "build", app: { id: 1 }, head_sha: targetSha, status: "completed", conclusion: "success" }] }, scenario.nextRuns ? { link: '<https://next.example/runs>; rel="next"' } : {});
    if (url === "https://next.example/runs") return response({ check_runs: scenario.nextRuns ?? [] });
    if (url === `${root}/commits/${targetSha}/status?per_page=100`) return response({ sha: scenario.statusSha ?? targetSha, statuses: scenario.statuses ?? [{ context: "test", state: "success", sha: targetSha }] }, scenario.nextStatuses ? { link: '<https://next.example/statuses>; rel="next"' } : {});
    if (url === "https://next.example/statuses") return response({ sha: scenario.statusSha ?? target, statuses: scenario.nextStatuses ?? [] });
    if (url === `${root}/releases/assets/41`) return response(receiptBytes);
    if (url === `${root}/releases/assets/40`) return response(scenario.previousAssetBytes ?? oldReceiptBytes);
    if (url === `${root}/git/blobs/${contractBlob}`) return response({ sha: contractBlob, encoding: "base64", content: (scenario.targetBlobBytes ?? contract).toString("base64") });
    if (url === `${root}/git/blobs/${readmeBlob}`) return response({ sha: readmeBlob, encoding: "base64", content: readme.toString("base64") });
    if (url === `${root}/git/blobs/${oldBlob}`) return response({ sha: oldBlob, encoding: "base64", content: oldFile.toString("base64") });
    throw new Error(`unexpected route ${url}`);
  };
  const input: GithubSourceTransportInput = { repository: "https://github.com/openlup/openlup", releaseTag: targetTag, assetName: "openlup-source-receipt.json", receiptCodec: parseSourceReleaseReceiptEnvelope };
  return { calls, fetcher, input, receiptBytes, oldReceiptBytes, previous, contractBlob };
}

describe("GitHub source consume transport", () => {
  it("rejects a local-fixture receipt after a wide v4 decode", async () => {
    const sample = fixture();
    const codec: SourceReceiptCodec = (raw) => {
      const receipt = JSON.parse(raw.toString()) as SourceReceiptEnvelope;
      return { ...receipt, evidenceClass: "local-fixture", identity: { ...receipt.identity, evidenceClass: "local-fixture" } };
    };
    await expect(authenticateGithubSourceRelease({ ...sample.input, receiptCodec: codec }, sample.fetcher)).rejects.toThrow(/source receipt/u);
  });

  it("authenticates the canonical release, top-level rules array, paginated checks, inventory and blobs", async () => {
    const sample = fixture({ rules: [{ type: "required_status_checks", ruleset_id: 7, parameters: { required_status_checks: [{ context: "test" }] } }, { type: "required_status_checks", ruleset_id: 2, parameters: { required_status_checks: [{ context: "build", integration_id: 1 }] } }, { type: "required_status_checks", ruleset_id: 9, parameters: { required_status_checks: [{ context: "test" }] } }], runs: [], nextRuns: [{ name: "build", app: { id: 1 }, head_sha: target, status: "completed", conclusion: "success" }] });
    const result = await authenticateGithubSourceRelease({ ...sample.input, repository: "openlup/openlup", expectedPublicCi: { protectedRef: "refs/heads/main", rulesetIds: [2, 7, 9] } }, sample.fetcher);
    expect(result).toMatchObject({ repository: "https://github.com/openlup/openlup", targetCommit: target, targetTree, sourceReceiptDigest: digest(sample.receiptBytes), publicCi: { protectedRef: "refs/heads/main", rulesetIds: [2, 7, 9], checks: [{ context: "build", integrationId: 1, conclusion: "success", sha: target }, { context: "test", conclusion: "success", sha: target }] }, targetInventory: [{ path: "README.md", mode: "100644" }, { path: "config/openlup-source-release-contract.json", gitBlobSha: sample.contractBlob, mode: "100644" }] });
    expect(await result.readPublicBlob(sample.contractBlob)).toEqual(Buffer.from('{"source":"contract"}\n'));
    await expect(result.readPublicBlob("f".repeat(40))).rejects.toThrow(/authenticated inventory/u);
    await expect(result.readPublicObject("config/../private.json")).rejects.toThrow(/canonical/u);
    expect(sample.calls.some(({ url }) => url === "https://next.example/runs")).toBe(true);
    expect(sample.calls.find(({ url }) => url === `${root}/releases/assets/41`)!.headers.get("accept")).toBe("application/octet-stream");
    expect(sample.calls.every(({ headers }) => headers.get("authorization") === null)).toBe(true);
  });

  it("accepts the authenticated target at the protected branch head", async () => {
    const sample = fixture(), result = await authenticateGithubSourceRelease(sample.input, sample.fetcher);
    expect(result.targetCommit).toBe(target);
    expect(sample.calls.some(({ url }) => url.startsWith(`${root}/compare/${target}...`))).toBe(false);
  });

  it("accepts an authenticated target contained in an advanced protected branch head", async () => {
    const head = "7".repeat(40), sample = fixture({ branchCommit: { sha: head }, protectedHeadRecord: { sha: head, tree: { sha: "6".repeat(40) }, parents: [{ sha: target }] }, protectedCompare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: target }, merge_base_commit: { sha: target }, commits: [{ sha: head, parents: [{ sha: target }] }] } });
    await expect(authenticateGithubSourceRelease(sample.input, sample.fetcher)).resolves.toMatchObject({ targetCommit: target });
  });

  it("accepts an advanced protected merge head after authenticating its older external parent", async () => {
    const head = "7".repeat(40), sample = fixture({ descendant: true, branchCommit: { sha: head }, protectedHeadRecord: { sha: head, tree: { sha: "6".repeat(40) }, parents: [{ sha: target }, { sha: oldTarget }] }, protectedCompare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: target }, merge_base_commit: { sha: target }, commits: [{ sha: head, parents: [{ sha: target }, { sha: oldTarget }] }] } });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).resolves.toMatchObject({ targetCommit: target });
    expect(sample.calls.filter(({ url }) => url === `${root}/compare/${oldTarget}...${target}`)).toHaveLength(2);
  });

  it("refuses a schema-v5 target when protected main is still its previous release", async () => {
    const sample = fixture({ descendant: true, branchCommit: { sha: oldTarget }, protectedCompare: { status: "behind", ahead_by: 0, behind_by: 2, total_commits: 0, base_commit: { sha: target }, merge_base_commit: { sha: oldTarget }, commits: [] } });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(/protected branch ancestry/u);
  });

  it.each([
    ["an unmerged target", { branchCommit: { sha: "7".repeat(40) }, protectedHeadRecord: { sha: "7".repeat(40), tree: { sha: "6".repeat(40) }, parents: [] }, protectedCompare: { status: "behind", ahead_by: 0, behind_by: 1, total_commits: 0, base_commit: { sha: target }, merge_base_commit: { sha: "7".repeat(40) }, commits: [] } }, /protected branch ancestry/u],
    ["a divergent protected head", { branchCommit: { sha: "7".repeat(40) }, protectedHeadRecord: { sha: "7".repeat(40), tree: { sha: "6".repeat(40) }, parents: [{ sha: target }] }, protectedCompare: { status: "diverged", ahead_by: 1, behind_by: 1, total_commits: 1, base_commit: { sha: target }, merge_base_commit: { sha: "5".repeat(40) }, commits: [{ sha: "7".repeat(40), parents: [{ sha: target }] }] } }, /protected branch ancestry/u],
    ["a missing protected head", { branchCommit: null }, /default branch commit/u],
    ["a malformed protected head", { branchCommit: { sha: "short" } }, /default branch commit/u],
    ["truncated protected-containment evidence", { branchCommit: { sha: "7".repeat(40) }, protectedHeadRecord: { sha: "7".repeat(40), tree: { sha: "6".repeat(40) }, parents: [{ sha: target }] }, protectedCompare: { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, base_commit: { sha: target }, merge_base_commit: { sha: target }, commits: [{ sha: "7".repeat(40), parents: [{ sha: target }] }] } }, /protected branch ancestry/u],
    ["unavailable protected-containment evidence", { branchCommit: { sha: "7".repeat(40) }, protectedHeadRecord: { sha: "7".repeat(40), tree: { sha: "6".repeat(40) }, parents: [{ sha: target }] } }, /protected branch ancestry was unavailable/u],
    ["protected-head parents inconsistent with Compare", { branchCommit: { sha: "7".repeat(40) }, protectedHeadRecord: { sha: "7".repeat(40), tree: { sha: "6".repeat(40) }, parents: [{ sha: target }] }, protectedCompare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: target }, merge_base_commit: { sha: target }, commits: [{ sha: "7".repeat(40), parents: [{ sha: "5".repeat(40) }] }] } }, /protected branch ancestry/u],
    ["missing protected-head external-parent evidence", { branchCommit: { sha: "7".repeat(40) }, protectedHeadRecord: { sha: "7".repeat(40), tree: { sha: "6".repeat(40) }, parents: [{ sha: target }, { sha: "5".repeat(40) }] }, protectedCompare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: target }, merge_base_commit: { sha: target }, commits: [{ sha: "7".repeat(40), parents: [{ sha: target }, { sha: "5".repeat(40) }] }] } }, /protected branch external-parent ancestry was unavailable/u],
  ] as const)("refuses %s", async (_label, change, expected) => {
    const sample = fixture(change as Scenario);
    await expect(authenticateGithubSourceRelease(sample.input, sample.fetcher)).rejects.toThrow(expected);
  });

  it("refuses wrong protected-head external-parent ancestry", async () => {
    const head = "7".repeat(40), sample = fixture({ descendant: true, branchCommit: { sha: head }, protectedHeadRecord: { sha: head, tree: { sha: "6".repeat(40) }, parents: [{ sha: target }, { sha: oldTarget }] }, protectedCompare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: target }, merge_base_commit: { sha: target }, commits: [{ sha: head, parents: [{ sha: target }, { sha: oldTarget }] }] }, compare: { status: "diverged", ahead_by: 2, behind_by: 1, total_commits: 2, base_commit: { sha: oldTarget }, merge_base_commit: { sha: olderParent }, commits: [] } });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(/external merge-parent ancestry/u);
  });

  it("keeps the optional token only in request headers", async () => {
    const sample = fixture(), result = await authenticateGithubSourceRelease({ ...sample.input, token: "memory-only-token" }, sample.fetcher);
    expect(sample.calls.every(({ headers }) => headers.get("authorization") === "Bearer memory-only-token")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("memory-only-token");
  });

  it("does not expose a process-memory token when transport fails", async () => {
    const sample = fixture();
    await expect(authenticateGithubSourceRelease({ ...sample.input, token: "memory-only-token" }, async () => { throw new Error("Bearer memory-only-token"); })).rejects.toThrow("repository was unavailable");
  });

  it("retrieves the exact previous immutable receipt and its full inventory", async () => {
    const sample = fixture({ descendant: true }), result = await authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher);
    expect(result.previousSourceReceiptRaw).toEqual(sample.oldReceiptBytes);
    expect(result.previousInventory).toEqual([{ path: "old.txt", gitBlobSha: blob(Buffer.from("old public\n")), mode: "100644" }]);
    expect(await result.readPublicObject("old.txt", oldTarget)).toEqual(Buffer.from("old public\n"));
  });

  it("uses receipt-ordinal ordering and omits authenticated target and previous directory entries", async () => {
    const targetPaths = [
      { path: ".github/AI_CONTRIBUTION_POLICY.md", mode: "100644" as const, digest: digest("target upper") },
      { path: ".github/actionlint.yaml", mode: "100644" as const, digest: digest("target lower") },
      { path: ".github/workflows/+CI.yml", mode: "100755" as const, digest: digest("target symbol") },
      { path: "config/openlup-source-release-contract.json", mode: "100644" as const, digest: digest(Buffer.from('{"source":"contract"}\n')) },
    ];
    const previousPaths = [
      { path: ".previous/+note.md", mode: "100644" as const, digest: digest("previous symbol") },
      { path: ".previous/A-note.md", mode: "100644" as const, digest: digest("previous upper") },
      { path: ".previous/a-note.md", mode: "100755" as const, digest: digest("previous lower") },
    ];
    const sample = fixture({
      descendant: true,
      receiptPaths: targetPaths,
      previousReceiptPaths: previousPaths,
      targetEntries: [
        { path: ".github/actionlint.yaml", mode: "100644", type: "blob", sha: "1".repeat(40) },
        { path: ".github", mode: "040000", type: "tree", sha: "2".repeat(40) },
        { path: "config/openlup-source-release-contract.json", mode: "100644", type: "blob", sha: blob(Buffer.from('{"source":"contract"}\n')) },
        { path: ".github/workflows", mode: "040000", type: "tree", sha: "3".repeat(40) },
        { path: ".github/workflows/+CI.yml", mode: "100755", type: "blob", sha: "4".repeat(40) },
        { path: ".github/AI_CONTRIBUTION_POLICY.md", mode: "100644", type: "blob", sha: "5".repeat(40) },
      ],
      previousTreeEntries: [
        { path: ".previous/a-note.md", mode: "100755", type: "blob", sha: "6".repeat(40) },
        { path: ".previous", mode: "040000", type: "tree", sha: "7".repeat(40) },
        { path: ".previous/A-note.md", mode: "100644", type: "blob", sha: "8".repeat(40) },
        { path: ".previous/+note.md", mode: "100644", type: "blob", sha: "9".repeat(40) },
      ],
    });
    const result = await authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher);
    expect(result.targetInventory.map(({ path, mode }) => ({ path, mode }))).toEqual(targetPaths.map(({ path, mode }) => ({ path, mode })));
    expect(result.previousInventory?.map(({ path, mode }) => ({ path, mode }))).toEqual(previousPaths.map(({ path, mode }) => ({ path, mode })));
  });

  it("preserves a mode-only target/previous delta for the full-index diff", async () => {
    const sample = fixture({ descendant: true, targetContractMode: "100755", previousContractMode: "100644" }), result = await authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher);
    expect(result.targetInventory.find((entry) => entry.path === "config/openlup-source-release-contract.json")?.mode).toBe("100755");
    expect(result.previousInventory?.find((entry) => entry.path === "config/openlup-source-release-contract.json")?.mode).toBe("100644");
  });

  it("accepts a descendant of a previously consumed descendant across a skipped linear commit", async () => {
    const sample = fixture({ descendant: true, previousDescendant: true });
    const result = await authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher);
    expect(result.receipt).toMatchObject({ schemaVersion: 5, export: { parents: [intermediate] } });
    expect(JSON.parse(result.previousSourceReceiptRaw!.toString())).toMatchObject({ schemaVersion: 5, export: { parents: [olderParent] } });
    expect(sample.calls.some(({ url }) => url === `${root}/compare/${oldTarget}...${target}`)).toBe(true);
  });

  it("authenticates an actual Git root, descendant, skipped commit, and next descendant", async () => {
    const repo = mkdtempSync(join(tmpdir(), "oss-transport-history-")), run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(), entries = (commit: string) => run(["ls-tree", "-r", "-t", commit]).split("\n").filter(Boolean).map((line) => { const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u.exec(line)!; return { mode: match[1], type: match[2], sha: match[3], path: match[4] }; });
    try {
      run(["init", "--quiet"]); run(["config", "user.name", "Transport Test"]); run(["config", "user.email", "transport@example.com"]); writeFileSync(join(repo, "old.txt"), "old public\n"); run(["add", "old.txt"]); run(["commit", "--quiet", "-m", "root"]); const rootCommit = run(["rev-parse", "HEAD"]), rootTree = run(["rev-parse", "HEAD^{tree}"]);
      rmSync(join(repo, "old.txt")); mkdirSync(join(repo, "config")); writeFileSync(join(repo, "README.md"), "public\n"); writeFileSync(join(repo, "config/openlup-source-release-contract.json"), '{"source":"contract"}\n'); run(["add", "--all"]); run(["commit", "--quiet", "-m", "descendant"]); const firstDescendant = run(["rev-parse", "HEAD"]), descendantTree = run(["rev-parse", "HEAD^{tree}"]);
      run(["commit", "--quiet", "--allow-empty", "-m", "protected intermediate"]); const skipped = run(["rev-parse", "HEAD"]); run(["commit", "--quiet", "--allow-empty", "-m", "next descendant"]); const nextDescendant = run(["rev-parse", "HEAD"]), targetEntries = entries(nextDescendant), rootEntries = entries(rootCommit), publicPaths = [{ path: "README.md", mode: "100644" as const, digest: digest("public\n") }, { path: "config/openlup-source-release-contract.json", mode: "100644" as const, digest: digest('{"source":"contract"}\n') }];
      const firstCompare = { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: rootCommit }, merge_base_commit: { sha: rootCommit }, commits: [{ sha: firstDescendant, parents: [{ sha: rootCommit }] }] }, first = fixture({ descendant: true, targetCommit: firstDescendant, targetTree: descendantTree, previousTarget: rootCommit, previousTree: rootTree, parents: [{ sha: rootCommit }], receiptParents: [rootCommit], targetEntries, previousTreeEntries: rootEntries, compare: firstCompare });
      await expect(authenticateGithubSourceRelease({ ...first.input, previousRelease: first.previous }, first.fetcher)).resolves.toMatchObject({ targetCommit: firstDescendant });
      const secondCompare = { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, base_commit: { sha: firstDescendant }, merge_base_commit: { sha: firstDescendant }, commits: [{ sha: skipped, parents: [{ sha: firstDescendant }] }, { sha: nextDescendant, parents: [{ sha: skipped }] }] }, second = fixture({ targetTag: "openlup-source-preview/3", previousTag: "openlup-source-preview/2", descendant: true, previousDescendant: true, targetCommit: nextDescendant, targetTree: descendantTree, previousTarget: firstDescendant, previousTree: descendantTree, intermediateCommit: skipped, parents: [{ sha: skipped }], receiptParents: [skipped], previousParents: [{ sha: rootCommit }], previousReceiptParents: [rootCommit], targetEntries, previousTreeEntries: targetEntries, previousReceiptPaths: publicPaths, compare: secondCompare });
      await expect(authenticateGithubSourceRelease({ ...second.input, previousRelease: second.previous }, second.fetcher)).resolves.toMatchObject({ targetCommit: nextDescendant, previousRelease: { targetPublicSha: firstDescendant } });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("accepts a complete authenticated descendant DAG and binds the merge's exact immediate parents", async () => {
    const branchCommit = "7".repeat(40);
    const sample = fixture({ descendant: true, parents: [{ sha: intermediate }, { sha: branchCommit }], receiptParents: [intermediate, branchCommit], compare: { status: "ahead", ahead_by: 3, behind_by: 0, total_commits: 3, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: intermediate, parents: [{ sha: oldTarget }] }, { sha: branchCommit, parents: [{ sha: oldTarget }] }, { sha: target, parents: [{ sha: intermediate }, { sha: branchCommit }] }] } });
    const result = await authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher);
    expect(result.receipt.export.parents).toEqual([intermediate, branchCommit]);
  });

  it("authenticates a merge parent forked before the previously consumed descendant", async () => {
    const branchCommit = "7".repeat(40), compare = { status: "ahead", ahead_by: 3, behind_by: 0, total_commits: 3, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: branchCommit, parents: [{ sha: olderParent }] }, { sha: intermediate, parents: [{ sha: oldTarget }] }, { sha: target, parents: [{ sha: intermediate }, { sha: branchCommit }] }] }, olderCompare = { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: olderParent }, merge_base_commit: { sha: olderParent }, commits: [{ sha: oldTarget, parents: [{ sha: olderParent }] }] };
    const sample = fixture({ descendant: true, previousDescendant: true, parents: [{ sha: intermediate }, { sha: branchCommit }], receiptParents: [intermediate, branchCommit], compare, olderCompare });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).resolves.toMatchObject({ targetCommit: target });
    expect(sample.calls.some(({ url }) => url === `${root}/compare/${olderParent}...${oldTarget}`)).toBe(true);
  });

  it.each([
    ["schema-v5 without a previous release", { descendant: true }, undefined, /source receipt/u],
    ["schema-v4 as a descendant", {}, "previous", /source receipt/u],
    ["target receipt parent mismatch", { descendant: true, receiptParents: [oldTarget] }, "previous", /source receipt/u],
    ["previous descendant parent mismatch", { descendant: true, previousDescendant: true, previousReceiptParents: ["7".repeat(40)] }, "previous", /previous source receipt\/tree/u],
    ["missing compare commits", { descendant: true, compare: { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: target, parents: [{ sha: intermediate }] }] } }, "previous", /ancestry/u],
    ["compare omits the authenticated target", { descendant: true, compare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: intermediate, parents: [{ sha: oldTarget }] }] } }, "previous", /ancestry/u],
    ["compare graph never reaches the previous release", { descendant: true, compare: { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: intermediate, parents: [{ sha: olderParent }] }, { sha: target, parents: [{ sha: intermediate }] }] }, olderCompare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: olderParent }, merge_base_commit: { sha: olderParent }, commits: [{ sha: oldTarget, parents: [{ sha: olderParent }] }] } }, "previous", /ancestry/u],
    ["compare target parents differ from the authenticated commit", { descendant: true, compare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: target, parents: [{ sha: oldTarget }] }] } }, "previous", /ancestry/u],
    ["diverged compare", { descendant: true, compare: { status: "diverged", ahead_by: 2, behind_by: 1, total_commits: 2, base_commit: { sha: oldTarget }, merge_base_commit: { sha: olderParent }, commits: [] } }, "previous", /ancestry/u],
    ["foreign compare base", { descendant: true, compare: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: olderParent }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: target, parents: [{ sha: oldTarget }] }] } }, "previous", /ancestry/u],
    ["broken compare chain with unproved external parent", { descendant: true, compare: { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, base_commit: { sha: oldTarget }, merge_base_commit: { sha: oldTarget }, commits: [{ sha: intermediate, parents: [{ sha: olderParent }] }, { sha: target, parents: [{ sha: intermediate }] }] } }, "previous", /unexpected route|ancestry/u],
  ] as const)("refuses %s", async (_label, change, previousMode, expected) => {
    const sample = fixture(change as Scenario);
    await expect(authenticateGithubSourceRelease({ ...sample.input, ...(previousMode ? { previousRelease: sample.previous } : {}) }, sample.fetcher)).rejects.toThrow(expected);
  });

  it.each([
    ["placeholder repository", { inputRepository: "https://github.com/openlup.invalid/platform" }, /canonical GitHub/u],
    ["repository mismatch", { repositoryRecord: { full_name: "openlup/other" } }, /repository identity/u],
    ["unprotected default branch", { protected: false }, /not protected/u],
    ["rules object instead of top-level array", { rules: { rules: [] } }, /rules are malformed/u],
    ["expected protected-ref drift", { inputExpectedPublicCi: { protectedRef: "refs/heads/main", rulesetIds: [7] } }, /expected protected/u],
    ["mutable release", { release: { immutable: false } }, /immutable preview/u],
    ["ordinary release", { release: { prerelease: false } }, /immutable preview/u],
    ["wrong asset", { release: { assets: [{ id: 41, name: "other.json", digest: digest("x") }] } }, /asset identity/u],
    ["asset digest mismatch", { release: { assets: [{ id: 41, name: "openlup-source-receipt.json", digest: digest("wrong") }] } }, /asset digest/u],
    ["lightweight tag", { refType: "commit" }, /annotated/u],
    ["parentful schema-v4 root commit", { parents: [{ sha: "f".repeat(40) }] }, /source receipt/u],
    ["receipt commit mismatch", { receiptCommit: "f".repeat(40) }, /source receipt/u],
    ["receipt tree mismatch", { receiptTree: "f".repeat(40) }, /source receipt/u],
    ["source contract mismatch", { receiptContractDigest: digest("other") }, /source contract digest/u],
    ["receipt path digest mismatch", { receiptPathDigest: digest("other") }, /receipt inventory/u],
    ["receipt inventory mismatch", { receiptPaths: [{ path: "README.md", mode: "100644", digest: digest("public\n") }] }, /disclosure inventory/u],
    ["combined status target SHA mismatch", { statusSha: "f".repeat(40) }, /target SHA/u],
    ["missing required check", { runs: [], statuses: [] }, /missing/u],
    ["pending check", { runs: [{ name: "build", app: { id: 1 }, head_sha: target, status: "in_progress", conclusion: null }] }, /did not succeed/u],
    ["skipped check", { runs: [{ name: "build", app: { id: 1 }, head_sha: target, status: "completed", conclusion: "skipped" }] }, /did not succeed/u],
    ["failing status", { statuses: [{ context: "test", state: "failure", sha: target }] }, /did not succeed/u],
    ["wrong check SHA", { runs: [{ name: "build", app: { id: 1 }, head_sha: "f".repeat(40), status: "completed", conclusion: "success" }] }, /did not succeed/u],
    ["ambiguous check runs", { runs: [{ name: "build", app: { id: 1 }, head_sha: target, status: "completed", conclusion: "success" }, { name: "build", app: { id: 1 }, head_sha: target, status: "completed", conclusion: "success" }] }, /ambiguous/u],
    ["truncated target tree", { targetTruncated: true }, /inventory is incomplete/u],
    ["target tree mismatch", { targetTreeSha: "f".repeat(40) }, /inventory is incomplete/u],
    ["symlink target entry", { targetEntries: [{ path: "link", type: "blob", mode: "120000", sha: "f".repeat(40) }] }, /non-regular/u],
    ["malformed regular-file mode", { targetEntries: [{ path: "file", type: "blob", mode: "100600", sha: "f".repeat(40) }] }, /non-regular/u],
    ["tree entry with a file mode", { targetEntries: [{ path: "dir", type: "tree", mode: "100644", sha: "f".repeat(40) }] }, /non-regular/u],
    ["blob entry with a directory mode", { targetEntries: [{ path: "dir", type: "blob", mode: "040000", sha: "f".repeat(40) }] }, /non-regular/u],
    ["submodule target entry", { targetEntries: [{ path: "module", type: "commit", mode: "160000", sha: "f".repeat(40) }] }, /non-regular/u],
    ["unknown target entry type", { targetEntries: [{ path: "unknown", type: "other", mode: "040000", sha: "f".repeat(40) }] }, /non-regular/u],
    ["tree entry with a malformed SHA", { targetEntries: [{ path: "dir", type: "tree", mode: "040000", sha: "short" }] }, /non-regular/u],
    ["duplicate target entry", { targetEntries: [{ path: "same", type: "blob", mode: "100644", sha: "f".repeat(40) }, { path: "same", type: "blob", mode: "100644", sha: "e".repeat(40) }] }, /duplicate/u],
    ["duplicate target directory", { targetEntries: [{ path: "same", type: "tree", mode: "040000", sha: "f".repeat(40) }, { path: "same", type: "tree", mode: "040000", sha: "e".repeat(40) }] }, /duplicate/u],
    ["noncanonical target entry", { targetEntries: [{ path: "dir/", type: "blob", mode: "100644", sha: "f".repeat(40) }] }, /canonical/u],
    ["substituted blob bytes", { targetBlobBytes: Buffer.from("substituted") }, /blob bytes differ/u],
  ] as const)("refuses %s", async (_label, change, expected) => {
    const sample = fixture(change as Scenario), input = { ...sample.input, ...(change.inputRepository ? { repository: change.inputRepository } : {}), ...(change.inputExpectedPublicCi ? { expectedPublicCi: change.inputExpectedPublicCi } : {}) };
    await expect(authenticateGithubSourceRelease(input, sample.fetcher)).rejects.toThrow(expected);
  });

  it.each([
    ["previous asset bytes tampered", { previousAssetBytes: Buffer.from("tampered") }, /previous release asset digest/u],
    ["previous lightweight tag", { previousRefType: "commit" }, /previous release tag must be annotated/u],
    ["previous tag target mismatch", { previousTagTarget: "f".repeat(40) }, /previous release tag target differs/u],
    ["previous receipt target mismatch", { previousReceiptCommit: "f".repeat(40) }, /previous source receipt/u],
    ["previous tree inventory mismatch", { previousTreeSha: "f".repeat(40) }, /previous tree inventory/u],
    ["previous tree entry with a file mode", { previousTreeEntries: [{ path: "dir", type: "tree", mode: "100644", sha: "f".repeat(40) }] }, /non-regular/u],
  ] as const)("refuses %s", async (_label, change, expected) => {
    const sample = fixture({ ...change, descendant: true }); await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(expected);
  });

  it("refuses a caller-supplied previous asset name that differs from the canonical receipt asset", async () => {
    const sample = fixture({ descendant: true });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: { ...sample.previous, assetName: "other.json" } }, sample.fetcher)).rejects.toThrow(/previous release identity/u);
  });

  it("authenticates a selected preview/3 directly from an immutable preview/1", async () => {
    const sample = fixture({ descendant: true, targetTag: "openlup-source-preview/3", previousTag: oldTag });
    const result = await authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher);
    expect(result.release.tag).toBe("openlup-source-preview/3");
    expect(result.previousRelease?.releaseTag).toBe(oldTag);
    expect(sample.calls.some(({ url }) => url === `${root}/compare/${oldTarget}...${target}`)).toBe(true);
  });

  it.each([
    ["equal", "openlup-source-preview/2", "openlup-source-preview/2"],
    ["older target", "openlup-source-preview/2", "openlup-source-preview/3"],
  ])("refuses an %s preview selection", async (_label, targetTag, previousTag) => {
    const sample = fixture({ descendant: true, targetTag, previousTag });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(/previous release identity/u);
  });

  it("refuses a newer preview when its protected Git ancestry diverges", async () => {
    const sample = fixture({ descendant: true, targetTag: "openlup-source-preview/3", previousTag: oldTag, compare: { status: "diverged", ahead_by: 2, behind_by: 1, total_commits: 2, base_commit: { sha: oldTarget }, merge_base_commit: { sha: intermediate }, commits: [] } });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(/previous release ancestry/u);
  });

  const mutableObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
  it.each([
    ["unknown root field", (value: Record<string, unknown>) => { value.extra = true; }, /unknown fields/u],
    ["schema-4 non-root tag", (value: Record<string, unknown>) => { mutableObject(value.disclosure).tag = { name: "openlup-source-preview/2", message: "OpenLup source preview 2." }; }, /tag is invalid/u],
    ["unsafe preview ordinal", (value: Record<string, unknown>) => { value.schemaVersion = 5; mutableObject(value.export).parents = ["f".repeat(40)]; mutableObject(value.disclosure).tag = { name: "openlup-source-preview/9007199254740993", message: "OpenLup source preview 9007199254740993." }; }, /exact preview tag/u],
    ["unsorted paths", (value: Record<string, unknown>) => { (mutableObject(value.disclosure).paths as unknown[]).reverse(); }, /sorted and unique/u],
    ["invalid optional owner type", (value: Record<string, unknown>) => { mutableObject(mutableObject(value.identity).owner).email = 42; }, /owner email/u],
    ["false current drift outcome", (value: Record<string, unknown>) => { value.drift = [{ class: "local-measurement", selector: "local.json", sourceSelector: null, source: { disposition: "present", digest: digest("source") }, public: { disposition: "projected", digest: digest("public") } }]; }, /drift public/u],
  ])("strict codec refuses %s", (_label, mutate, expected) => {
    const sample = fixture(), value = JSON.parse(sample.receiptBytes.toString()) as Record<string, unknown>; mutate(value); expect(() => parseSourceReleaseReceiptEnvelope(JSON.stringify(value))).toThrow(expected);
  });

  it.each([
    ["release body", { releaseBody: "other" }, /release body digest/u],
    ["annotated tag message without its canonical newline", { tagRecord: { message: "OpenLup source preview 2." } }, /annotated tag name or message/u],
    ["annotated tag message with extra bytes", { tagRecord: { message: "OpenLup source preview 2.\nExtra" } }, /annotated tag name or message/u],
  ] as const)("authenticates schema-5 %s metadata", async (_label, change, expected) => {
    const sample = fixture({ descendant: true, ...change }); await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(expected);
  });

  it.each([
    ["release body", { previousReleaseBody: "other" }, /previous receipt release body digest/u],
    ["tag message without its canonical newline", { previousTagRecord: { message: "OpenLup source preview 2." } }, /previous receipt annotated tag name or message/u],
    ["tag message with extra bytes", { previousTagRecord: { message: "OpenLup source preview 2.\nExtra" } }, /previous receipt annotated tag name or message/u],
  ] as const)("authenticates preceding schema-5 %s", async (_label, change, expected) => {
    const sample = fixture({ descendant: true, previousDescendant: true, ...change });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(expected);
  });

  it("refuses a schema-5 receipt whose canonical allowlist digest was replaced", async () => {
    const initial = fixture({ descendant: true }), receipt = JSON.parse(initial.receiptBytes.toString()); receipt.disclosure.allowlist.digest = digest("other");
    const sample = fixture({ descendant: true, receiptRaw: Buffer.from(JSON.stringify(receipt)) });
    await expect(authenticateGithubSourceRelease({ ...sample.input, previousRelease: sample.previous }, sample.fetcher)).rejects.toThrow(/reconstructed allowlist digest/u);
  });
});

// The descendant producer's fixtures are a synthetic public tree built in a temporary Git repository;
// they never read this checkout, so an adopting repository runs them unchanged.
const CATALOG = "config/openlup-publication-catalog.json", CONTRACT = "config/openlup-source-release-contract.json", OWNER = { name: "Owner", email: "owner@openlup.com" };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
// `PUBLIC_PACKAGE_EXECUTION_SURFACES` pins these workspace scripts by digest; the first test names a drift.
const CORE_SCRIPTS = {
  build: "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsc -p tsconfig.build.json",
  "api:check": "node --experimental-strip-types ./scripts/api-contract.ts",
  "api:update": "npm run build && node --experimental-strip-types ./scripts/api-contract.ts --update",
  ci: "npm run test:coverage && npm run typecheck:smoke && npm run api:check && npm run docs:check && npm run release:check && npm run test:consumer",
  "docs:check": "node --experimental-strip-types ./scripts/documentation-contract.ts",
  prepack: "npm run build",
  prepublishOnly: "node --experimental-strip-types ./scripts/refuse-publish.ts",
  "release:audit": "node --experimental-strip-types ./scripts/release-check.ts audit",
  "release:bundle": "node --experimental-strip-types ./scripts/release-bundle.ts",
  "release:check": "npm run build && node --experimental-strip-types ./scripts/release-check.ts all",
  "release:licenses": "node --experimental-strip-types ./scripts/release-check.ts licenses",
  "release:lock": "node --experimental-strip-types ./scripts/release-check.ts lock",
  "release:pack": "node --experimental-strip-types ./scripts/release-check.ts pack",
  "release:publish-block": "node --experimental-strip-types ./scripts/release-check.ts publish",
  "release:sbom": "node --experimental-strip-types ./scripts/release-check.ts sbom",
  "test:consumer": "node --experimental-strip-types ./scripts/core-package-consumer-smoke.ts",
  "test:coverage": "npm run build && npm run test:runtime-import && vitest run --config vitest.config.ts --coverage && node --experimental-strip-types ./test/assertNoZeroCoverage.ts",
  "test:runtime-import": "node -e \"const p=require('./package.json'); Promise.all(Object.keys(p.exports).map((s)=>import(s==='.'?p.name:p.name+'/'+s.slice(2)))).then((m)=>console.log('core runtime import ok', m.length))\"",
  "test:smoke": "npm run build && npm run test:runtime-import && vitest run --config vitest.config.ts",
  "typecheck:smoke": "tsc -p tsconfig.smoke.json --noEmit",
};
const UI_SCRIPTS = { build: CORE_SCRIPTS.build, typecheck: "tsc -p tsconfig.json --noEmit", "test:neutrality": "node --experimental-strip-types smoke/neutrality.ts" };
const compatibility = (diagnostics: number) => ({ typecheck: { projects: ["tsconfig.synthetic.json"], signedPreviewDebt: { unresolvedEdges: { mode: "exact-ratchet", pairs: 0, importers: 0, targets: 0, digest: "sha256-e3b0c44298fc1c149afbf4c8996fb924", pairHashes: [] }, inferenceCascades: { mode: "ceiling-ratchet", diagnostics } } } });
const SYNTHETIC_TREE: Record<string, string> = {
  "README.md": "public root\n",
  "docs/guide.md": "synthetic guide\n",
  "config/openlup-policy-registry.json": json({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "synthetic-readme", owners: ["README.md"] }] }),
  "config/platform-migration-manifest.json": json({ synthetic: "manifest" }),
  "db/platform/migrations/0001_synthetic.sql": "select 1;\n",
  "src/integrations/supabase/types.ts": "export type SyntheticDatabase = never;\n",
  "package.json": json({ name: "synthetic-root", private: true, scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }),
  "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3 }),
  "packages/core/package.json": json({ name: "synthetic-core", scripts: CORE_SCRIPTS }),
  "packages/core/package-lock.json": json({ name: "synthetic-core", lockfileVersion: 3 }),
  "packages/ui/package.json": json({ name: "synthetic-ui", scripts: UI_SCRIPTS }),
  [CONTRACT]: createSourceReleaseContract({ ...Object.fromEntries(["inventoryDigest", "classDigest", "packageDigest", "rootLockDigest", "coreLockDigest", "migrationManifestDigest", "databaseTypesDigest", "policyRegistryDigest", "publicationCatalogDigest"].map((name) => [name, `sha256-${"0".repeat(64)}`])) as unknown as SourceReleaseContractInput, compatibility: compatibility(0) as SourceReleaseContractInput["compatibility"] }, { evidenceClass: "activation-candidate", coordinate: "https://github.com/openlup/openlup", securityRoute: "dev@openlup.com", owner: OWNER }).contents,
};
type TreeChange = Record<string, string | null> | ((repo: string) => void);
type Seal = { regenerate?: boolean; classes?: Record<string, string> };

/** A synthetic preview/1 root, authenticated through the fixture transport, plus helpers that cut its descendant. */
function syntheticRelease(options: { extraFiles?: Record<string, string | Buffer>; drift?: (rows: SourceReceiptEnvelope["drift"]) => SourceReceiptEnvelope["drift"] } = {}) {
  const physical = realpathSync(tmpdir()), repo = mkdtempSync(join(physical, "openlup-descendant-producer-")), artifacts = mkdtempSync(join(physical, "openlup-descendant-artifact-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const read = (path: string) => existsSync(join(repo, path)) ? readFileSync(join(repo, path)) : undefined;
  const apply = (change: TreeChange) => {
    if (typeof change === "function") return change(repo);
    for (const [path, contents] of Object.entries(change)) { if (contents === null) { rmSync(join(repo, path)); continue; } mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); }
  };
  const commit = (message: string, { regenerate = true, classes = {} }: Seal = {}) => {
    run(["add", "--all"]);
    const paths = [...new Set([...run(["ls-files"]).split("\n").filter(Boolean), CATALOG])].sort();
    writeFileSync(join(repo, CATALOG), createPublicPublicationCatalog(paths.map((path) => ({ path, class: classes[path] ?? "public-output" })), []).contents);
    if (regenerate) writeFileSync(join(repo, CONTRACT), deriveSourceReleaseContract(read).contents);
    run(["add", "--all"]); run(["commit", "--quiet", "-m", `${message}\n\nSigned-off-by: Owner <owner@openlup.com>`]);
  };
  run(["init", "--quiet"]); run(["config", "user.name", OWNER.name]); run(["config", "user.email", OWNER.email]);
  apply({ ...SYNTHETIC_TREE, ...options.extraFiles }); commit("Initial public source release.");
  const rootCommit = run(["rev-parse", "HEAD"]), rootTree = run(["rev-parse", "HEAD^{tree}"]);
  const entries = run(["ls-tree", "-r", "-t", "HEAD"]).split("\n").map((line) => { const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u.exec(line)!; return { mode: match[1], type: match[2], sha: match[3], path: match[4] }; });
  const paths = entries.filter(({ type }) => type === "blob").map(({ path, mode, sha }) => ({ path, mode: mode as "100644" | "100755", digest: digest(execFileSync("git", ["cat-file", "blob", sha], { cwd: repo, maxBuffer: 8 * 1024 * 1024 })) }));
  const rows: SourceReceiptEnvelope["drift"] = [
    { class: "local-measurement", selector: "local/measurement.json", sourceSelector: null, source: { disposition: "present", digest: digest("local measurement") }, public: { disposition: "absent", digest: null } },
    { class: "projection", selector: "README.md", sourceSelector: "source/README.md", source: { disposition: "present", digest: digest("source readme") }, public: { disposition: "projected", digest: digest(read("README.md")!) } },
    { class: "projection", selector: "docs/guide.md", sourceSelector: null, source: { disposition: "absent", digest: null }, public: { disposition: "projected", digest: digest(read("docs/guide.md")!) } },
  ];
  const previous = fixture({ targetTag: oldTag, targetCommit: rootCommit, targetTree: rootTree, contractBytes: read(CONTRACT), readmeBytes: read("README.md"), targetEntries: entries, receiptPaths: paths, receiptDrift: options.drift ? options.drift(rows) : rows });
  let outputs = 0;
  const input = (overrides: Partial<Parameters<typeof writeDescendantSourceReleaseReceipt>[0]> = {}) => ({ root: repo, previous: previous.input, fetcher: previous.fetcher, releaseTag: tag, tagMessage: "OpenLup source preview 2.", releaseNote: "release note", outputPath: join(artifacts, `receipt-${outputs += 1}.json`), ...overrides });
  /** Commits one change, tags it as the next preview and runs the producer. */
  const release = (change: TreeChange, seal: Seal = {}, overrides: Partial<Parameters<typeof writeDescendantSourceReleaseReceipt>[0]> = {}) => {
    apply(change); commit("Public descendant", seal);
    const releaseTag = overrides.releaseTag ?? tag; run(["tag", "--annotate", releaseTag, "--message", overrides.tagMessage ?? `OpenLup source preview ${releaseTag.split("/")[1]}.`]);
    return writeDescendantSourceReleaseReceipt(input(overrides));
  };
  return { repo, artifacts, run, read, rows, rootCommit, input, release, cleanup: () => { rmSync(repo, { recursive: true, force: true }); rmSync(artifacts, { recursive: true, force: true }); } };
}
const selectors = (rows: SourceReceiptEnvelope["drift"]) => rows.map(({ selector }) => selector);
const editContract = (edit: (contract: { compatibility?: unknown; repository: { owner: { name: string } } }) => void) => (repo: string) => { const contract = JSON.parse(readFileSync(join(repo, CONTRACT), "utf8")); edit(contract); writeFileSync(join(repo, CONTRACT), json(contract)); };

describe("descendant source release producer", () => {
  it("builds its synthetic workspace manifests with the pinned public execution surfaces", () => {
    expect(PUBLIC_PACKAGE_EXECUTION_SURFACES.map(({ path, digest: pinned }) => [path, packageExecutionDigest(JSON.parse(SYNTHETIC_TREE[path]!)) === pinned])).toEqual(PUBLIC_PACKAGE_EXECUTION_SURFACES.map(({ path }) => [path, true]));
  });

  it("authenticates preview/1 then writes and reads a deterministic schema-5 receipt from real Git objects", async () => {
    const sample = syntheticRelease({ extraFiles: { "large-public-blob.bin": Buffer.alloc(3_000_000, 0x61) } });
    try {
      writeFileSync(join(sample.repo, "README.md"), "public descendant\n"); sample.run(["add", "README.md"]); sample.run(["commit", "--quiet", "-m", "Public descendant\n\nSigned-off-by: Owner <owner@openlup.com>"]); sample.run(["tag", "--annotate", tag, "--message", "OpenLup source preview 2.\n\nExtra text"]);
      const tagInput = sample.input(); await expect(writeDescendantSourceReleaseReceipt(tagInput)).rejects.toThrow(/exact annotated tag/u); expect(() => readFileSync(tagInput.outputPath)).toThrow(); sample.run(["tag", "--delete", tag]); sample.run(["tag", "--annotate", tag, "--message", "OpenLup source preview 2."]);
      const input = sample.input(), result = await writeDescendantSourceReleaseReceipt(input);
      expect(parseSourceReleaseReceiptEnvelope(readFileSync(input.outputPath))).toEqual(result.receipt); expect(result.receipt).toMatchObject({ schemaVersion: 5, export: { commit: sample.run(["rev-parse", "HEAD"]), parents: [sample.rootCommit] }, disclosure: { releaseNote: { digest: digest("release note") } } }); expect(result.allowlistDigest).toBe(digest(result.allowlist));
      expect(result.receipt.drift).toEqual([sample.rows[0], { ...sample.rows[1], public: { disposition: "projected", digest: digest("public descendant\n") } }, sample.rows[2]]);
      const original = readFileSync(input.outputPath); await expect(writeDescendantSourceReleaseReceipt(input)).rejects.toThrow(/already exists/u); expect(readFileSync(input.outputPath)).toEqual(original);
      const checkoutOutput = join(realpathSync(sample.repo), "receipt.json"); await expect(writeDescendantSourceReleaseReceipt({ ...input, outputPath: checkoutOutput })).rejects.toThrow(/outside the checkout/u); expect(() => readFileSync(checkoutOutput)).toThrow();
    } finally { sample.cleanup(); }
  });

  it.each([
    ["an added path", { "src/synthetic/added.ts": "export const added = 1;\n" }, (receipt: SourceReceiptEnvelope) => expect(receipt.disclosure.paths.map(({ path }) => path)).toContain("src/synthetic/added.ts")],
    ["a deleted projected path", { "docs/guide.md": null }, (receipt: SourceReceiptEnvelope) => expect(receipt.drift[2]!.public).toEqual({ disposition: "absent", digest: null })],
    ["a package change with a regenerated contract", { "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: { "": { name: "synthetic-root" } } }) }, (receipt: SourceReceiptEnvelope, previous: string) => expect(receipt.contract.digest).not.toBe(previous)],
    ["a projected change", { "README.md": "changed public readme\n" }, (receipt: SourceReceiptEnvelope, _previous: string, rows: SourceReceiptEnvelope["drift"]) => expect(receipt.drift[1]).toEqual({ ...rows[1], public: { disposition: "projected", digest: digest("changed public readme\n") } })],
    ["a valid compatibility change", editContract((contract) => { contract.compatibility = compatibility(2); }), (receipt: SourceReceiptEnvelope, previous: string) => expect(receipt.contract.digest).not.toBe(previous)],
  ] as const)("accepts %s when the tree describes itself", async (_label, change, check) => {
    const sample = syntheticRelease(), previous = digest(sample.read(CONTRACT)!);
    try {
      const { receipt } = await sample.release(change);
      expect(selectors(receipt.drift)).toEqual(selectors(sample.rows)); expect(receipt.drift.map(({ source }) => source)).toEqual(sample.rows.map(({ source }) => source));
      check(receipt, previous, sample.rows);
    } finally { sample.cleanup(); }
  });

  it.each([
    ["a package change with a stale contract", { "package-lock.json": json({ name: "synthetic-root", lockfileVersion: 3, packages: {} }) }, { regenerate: false }, /does not describe its tree.*packages\.rootLockDigest/u],
    ["a stale class digest", {}, { regenerate: false, classes: { "docs/guide.md": "platform-documentation" } }, /does not describe its tree.*inventory\.classDigest/u],
    ["a changed fixed contract field", editContract((contract) => { contract.repository.owner.name = "Second Owner"; }), {}, /previous release's repository\.owner\.name/u],
    ["a public path at a local-measurement selector", { "local/measurement.json": "{}\n" }, {}, /local-measurement selector: local\/measurement\.json/u],
    ["a migration manifest change", { "config/platform-migration-manifest.json": json({ synthetic: "changed" }) }, {}, /schema-bearing.*platform-migration-manifest/u],
    ["a database types change", { "src/integrations/supabase/types.ts": "export type SyntheticDatabase = unknown;\n" }, {}, /schema-bearing.*supabase\/types\.ts/u],
    ["a policy registry change", { "config/openlup-policy-registry.json": json({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "synthetic-readme-renamed", owners: ["README.md"] }] }) }, {}, /schema-bearing.*openlup-policy-registry/u],
    ["an added platform migration", { "db/platform/migrations/0002_synthetic.sql": "select 2;\n" }, {}, /schema-bearing.*0002_synthetic/u],
    ["an added schema migration", { "supabase/migrations/0001_synthetic.sql": "select 1;\n" }, {}, /schema-bearing.*supabase\/migrations/u],
    ["an added bootstrap script", { "db/bootstrap/synthetic/00_synthetic.sql": "select 1;\n" }, {}, /schema-bearing.*db\/bootstrap/u],
    ["a migration mode change", (repo: string) => chmodSync(join(repo, "db/platform/migrations/0001_synthetic.sql"), 0o755), {}, /schema-bearing.*0001_synthetic/u],
    ["an unregistered direct execution entrypoint", { "scripts/synthetic-tool.mjs": "#!/usr/bin/env node\n" }, {}, /unregistered direct execution entrypoint/u],
  ] as const)("refuses %s", async (_label, change, seal, expected) => {
    const sample = syntheticRelease();
    try { await expect(sample.release(change, seal)).rejects.toThrow(expected); } finally { sample.cleanup(); }
  });

  it("refuses a next preview number that is not exactly the previous one plus one", async () => {
    const sample = syntheticRelease();
    try { await expect(sample.release({ "README.md": "changed\n" }, {}, { releaseTag: "openlup-source-preview/3", tagMessage: "OpenLup source preview 3." })).rejects.toThrow(/exactly next preview tag/u); } finally { sample.cleanup(); }
  });

  it("refuses a previous receipt whose drift does not match its own Git objects", async () => {
    const sample = syntheticRelease({ drift: (rows) => rows.map((row) => row.selector === "README.md" ? { ...row, public: { disposition: "projected", digest: digest("tampered") } } : row) });
    try { await expect(sample.release({ "README.md": "changed\n" })).rejects.toThrow(/previous drift differs.*README\.md/u); } finally { sample.cleanup(); }
  });

  it("drops exactly the named retired projection rows and keeps every unnamed row", async () => {
    const sample = syntheticRelease();
    try {
      const { receipt } = await sample.release({ "README.md": "changed\n" }, {}, { retireProjectedSelectors: ["docs/guide.md"] });
      expect(selectors(receipt.drift)).toEqual(["local/measurement.json", "README.md"]);
      expect(JSON.parse(renderSourceReleaseAllowlist(receipt)).driftSelectors).toEqual([{ class: "local-measurement", selector: "local/measurement.json" }, { class: "projection", selector: "README.md" }]);
      await expect(writeDescendantSourceReleaseReceipt(sample.input({ retireProjectedSelectors: [] }))).resolves.toMatchObject({ receipt: { drift: expect.arrayContaining([expect.objectContaining({ selector: "docs/guide.md" })]) } });
    } finally { sample.cleanup(); }
  });

  it.each([
    ["an unknown selector", ["missing.md"], /names no previous projection row: missing\.md/u],
    ["a local-measurement selector", ["local/measurement.json"], /names no previous projection row: local\/measurement\.json/u],
    ["unsorted selectors", ["docs/guide.md", "README.md"], /sorted and unique/u],
    ["duplicate selectors", ["README.md", "README.md"], /sorted and unique/u],
    ["a noncanonical selector", ["./README.md"], /canonical/u],
  ] as const)("refuses retiring %s", async (_label, retireProjectedSelectors, expected) => {
    const sample = syntheticRelease();
    try { await expect(sample.release({ "README.md": "changed\n" }, {}, { retireProjectedSelectors })).rejects.toThrow(expected); } finally { sample.cleanup(); }
  });
});
