import { describe, expect, it } from "vitest";

import { activationJournalEntryKey, canonicalDigest, inventoryBase, ownerPageViolations, parseActivationJournal, parseConsumerReceipt, parseSourceAuthorityExceptions, sha256, validateJournalAppend } from "./oss-consumer-state.ts";

const d = (value: string) => sha256(value);
const receipt = {
  schemaVersion: 2,
  state: "pre-split",
  waveMarker: "oss-consume:",
  source: { repository: null, protectedRef: null, rulesetIds: [], releaseTagPrefix: "openlup-source-preview/", assetName: "openlup-source-receipt.json" },
  reviewPolicy: { metricVersion: "git-diff-v1", measurementSha: "a".repeat(40), windowSize: 500, limits: { paths: 24, hunks: 86, patchBytes: 86559 } },
  pinMarkers: ["measuredOn", "pairHashes"],
  classes: { localMeasurement: [{ selector: "config/pin.json", reason: "local measure" }], projected: [{ selector: "package.json", reason: "projected output" }] },
  lastConsume: null,
};

describe("consumer receipt v2", () => {
  it("accepts the strict pre-split state", () => expect(parseConsumerReceipt(JSON.stringify(receipt))).toMatchObject({ state: "pre-split", lastConsume: null }));

  it.each([
    [{ ...receipt, schemaVersion: 1 }, /schema\/state/],
    [{ ...receipt, extra: true }, /unknown field/],
    [{ ...receipt, source: { ...receipt.source, repository: "https://example.invalid/repo" } }, /non-placeholder GitHub/],
    [{ ...receipt, pinMarkers: ["pairHashes", "measuredOn"] }, /sorted and unique/],
    [{ ...receipt, classes: { ...receipt.classes, projected: [{ selector: "../escape", reason: "no" }] } }, /canonical repository-relative/],
  ])("refuses a malformed strict shape", (value, error) => expect(() => parseConsumerReceipt(JSON.stringify(value))).toThrow(error));

  it("accepts an active identity only when source and last consume agree", () => {
    const repository = "https://github.com/openlup/openlup";
    const lastConsume = {
      repository, releaseTag: "openlup-source-preview/1", releaseImmutable: true, assetName: "openlup-source-receipt.json", assetId: 7, assetDigest: d("asset"), previousPublicSha: null,
      targetPublicSha: "b".repeat(40), targetTree: "c".repeat(40), publicContractDigest: d("contract"), sourceReceiptDigest: d("receipt"), downstreamBase: inventoryBase([{ path: "src/a.ts", blobDigest: d("a") }]),
      changePathDigest: d("paths"), patchDigest: d("patch"), metrics: { paths: 1, hunks: 1, patchBytes: 1 }, changeSetDigest: d("change"), executionPlanDigest: d("plan"),
    };
    expect(parseConsumerReceipt(JSON.stringify({ ...receipt, state: "active", source: { ...receipt.source, repository, protectedRef: "main", rulesetIds: [17] }, lastConsume })).lastConsume).toMatchObject({ repository });
    expect(parseConsumerReceipt(JSON.stringify({ ...receipt, state: "active", source: { ...receipt.source, repository, protectedRef: "main", rulesetIds: [17] }, lastConsume: { ...lastConsume, metrics: { paths: 0, hunks: 0, patchBytes: 0 } } })).lastConsume!.metrics).toEqual({ paths: 0, hunks: 0, patchBytes: 0 });
    expect(() => parseConsumerReceipt(JSON.stringify({ ...receipt, state: "active", source: { ...receipt.source, repository: "https://github.com/openlup/other", protectedRef: "main", rulesetIds: [17] }, lastConsume }))).toThrow(/combination/);
    expect(() => parseConsumerReceipt(JSON.stringify({ ...receipt, state: "active", source: { ...receipt.source, repository: "https://example.invalid/openlup", protectedRef: "main", rulesetIds: [17] }, lastConsume }))).toThrow(/non-placeholder GitHub/);
  });
});

describe("portable downstream inventory", () => {
  it("is order-independent and path-sensitive", () => {
    const left = inventoryBase([{ path: "src/b.ts", blobDigest: d("b") }, { path: "src/a.ts", blobDigest: d("a") }]);
    expect(left).toEqual(inventoryBase([{ path: "src/a.ts", blobDigest: d("a") }, { path: "src/b.ts", blobDigest: d("b") }]));
    expect(left.digest).not.toBe(inventoryBase([{ path: "src/c.ts", blobDigest: d("a") }, { path: "src/b.ts", blobDigest: d("b") }]).digest);
  });

  it("refuses duplicate paths", () => expect(() => inventoryBase([{ path: "src/a.ts", blobDigest: d("a") }, { path: "src/a.ts", blobDigest: d("b") }])).toThrow(/sorted and unique/));
});

describe("source-authority exceptions", () => {
  const open = { schemaVersion: 1, exceptions: [{ id: "INC-1", incidentId: "live-1", owner: "owner-login", openedAt: "2026-09-03T08:00:00.000Z", expiresAt: "2026-09-04T08:00:00.000Z", paths: [{ path: "src/a.ts", preimageDigest: d("before"), localDigest: d("after") }] }] };

  it("parses a path-scoped 24-hour exception", () => expect(parseSourceAuthorityExceptions(JSON.stringify(open)).exceptions[0]?.paths).toHaveLength(1));
  it("refuses a longer expiry", () => expect(() => parseSourceAuthorityExceptions(JSON.stringify({ ...open, exceptions: [{ ...open.exceptions[0], expiresAt: "2026-09-04T08:00:00.001Z" }] }))).toThrow(/24 hours/));
  it("refuses overlapping path authority", () => expect(() => parseSourceAuthorityExceptions(JSON.stringify({ ...open, exceptions: [open.exceptions[0], { ...open.exceptions[0], id: "INC-2" }] }))).toThrow(/claimed twice/));

  it("emits an exact owner-page payload for missing coordination or expiry", () => {
    const registry = parseSourceAuthorityExceptions(JSON.stringify(open));
    const [page] = ownerPageViolations(registry, new Date("2026-09-03T09:00:00.000Z"));
    expect(page).toMatchObject({ code: "source-authority-owner-page-required", owner: "owner-login", incidentId: "live-1", paths: ["src/a.ts"] });
    expect(page?.evidenceDigest).toBe(canonicalDigest({ id: "INC-1", incidentId: "live-1", owner: "owner-login", paths: registry.exceptions[0]?.paths, expiresAt: "2026-09-04T08:00:00.000Z", coordination: null, overlap: ["src/a.ts"] }));
  });

  it("limits an owner page to the overlapping authority paths", () => {
    const registry = parseSourceAuthorityExceptions(JSON.stringify(open));
    expect(ownerPageViolations(registry, new Date("2026-09-03T09:00:00.000Z"), new Set(["src/other.ts"]))).toEqual([]);
  });
});

describe("activation journal", () => {
  const entry = { candidateDigest: d("candidate"), receiptPreimageDigest: d("preimage"), refusalCode: "candidate-refused", evidenceDigest: d("evidence"), recordedAt: "2026-09-03T08:00:00.000Z" };
  it("allows append-only growth", () => expect(validateJournalAppend({ schemaVersion: 1, entries: [] }, parseActivationJournal(JSON.stringify({ schemaVersion: 1, entries: [entry] })))).toEqual([]));
  it("refuses rewriting prior evidence", () => expect(validateJournalAppend({ schemaVersion: 1, entries: [entry] }, { schemaVersion: 1, entries: [{ ...entry, refusalCode: "rewritten" }] })).toEqual(["activation journal is not append-only"]));
  it("keys idempotency by the exact evidence tuple, not only the candidate", () => {
    const changedPreimage = { ...entry, receiptPreimageDigest: d("other preimage"), recordedAt: "2026-09-03T09:00:00.000Z" };
    expect(parseActivationJournal(JSON.stringify({ schemaVersion: 1, entries: [entry, changedPreimage] })).entries).toHaveLength(2);
    expect(activationJournalEntryKey(entry)).not.toBe(activationJournalEntryKey(changedPreimage));
    expect(() => parseActivationJournal(JSON.stringify({ schemaVersion: 1, entries: [entry, { ...entry, recordedAt: "2026-09-03T10:00:00.000Z" }] }))).toThrow(/unique/);
  });
});
