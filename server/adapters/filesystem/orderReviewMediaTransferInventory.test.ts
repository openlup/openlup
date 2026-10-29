import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { OrderReviewMediaObjectStore } from "./orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem, reconcileOrderReviewMediaFilesystem,
  type OrderReviewMediaSourceReference } from "./orderReviewMediaTransferInventory.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "review-transfer-census-"));
  roots.push(root);
  return { root, store: await OrderReviewMediaObjectStore.create(root) };
}
const body = (value: string) => (async function* () { yield Buffer.from(value); })();
const capture = (root: string, maximumFiles = 10) => captureOrderReviewMediaFilesystem({
  root, maximumFiles, maximumObjectBytes: 1024, maximumTotalBytes: 4096,
});

it("includes every final object and reconstructible partial upload without domain-state filtering", async () => {
  const f = await fixture();
  const complete = await f.store.writeTemp("completed", body("final"), 5, "2999-01-01T00:00:00Z");
  await f.store.promote(complete.tempRef, "review/media");
  const partial = await f.store.writeTemp("pending", body("part"), 8, "2999-01-01T00:00:00Z");
  const census = await capture(f.root);
  expect(census.objects.map(object => [object.key, object.bytes])).toEqual([["review/media", 5]]);
  expect(census.temporary.map(object => [object.key, object.bytes])).toEqual([[partial.tempRef.slice(4), 4]]);
  expect(await f.store.inspect("review/media")).toMatchObject({ exists: true, sha256: census.objects[0]!.sha256 });
  expect(await f.store.inspect(partial.tempRef)).toMatchObject({ exists: true, sha256: census.temporary[0]!.sha256 });
});

it("reconciles source rows with final, pending partial and cleanup obligations", async () => {
  const f = await fixture();
  const final = await f.store.writeTemp("completed", body("final"), 5, "2999-01-01T00:00:00Z");
  await f.store.promote(final.tempRef, "review/media");
  const partial = await f.store.writeTemp("pending", body("part"), 8, "2999-01-01T00:00:00Z");
  const census = await capture(f.root);
  const row = (suffix: string, state: OrderReviewMediaSourceReference["state"], objectKey: string): OrderReviewMediaSourceReference => ({
    mediaReference: `order-review-media:123e4567-e89b-12d3-a456-42661417400${suffix}`,
    state, objectKey,
    observedDigest: state === "stored" || state === "confirmed" ? census.objects[0]!.sha256 : null,
    observedByteLength: state === "stored" || state === "confirmed" ? census.objects[0]!.bytes : null,
    observedContentType: state === "stored" || state === "confirmed" ? "image/webp" : null,
    tempKey: null, writerReference: null, cleanupReceipt: null, nextAttemptAt: null,
  });
  const references = [row("0", "stored", "review/media"),
    { ...row("1", "pending", "review/pending"), writerReference: "pending", tempKey: partial.tempRef },
    { ...row("2", "cleanup_pending", "review/cleanup"), cleanupReceipt: "cleanup:1", nextAttemptAt: "2030-01-01T00:00:00Z" }];
  expect(reconcileOrderReviewMediaFilesystem({ census, references })).toMatchObject({
    retained: references, physicalObjects: 1, partialObjects: 1,
  });
  expect(() => reconcileOrderReviewMediaFilesystem({ census, references: references.slice(1) }))
    .toThrow(expect.objectContaining({ code: "integrity_conflict" }));
  expect(() => reconcileOrderReviewMediaFilesystem({ census, references: references.slice(0, 1) }))
    .toThrow(expect.objectContaining({ code: "integrity_conflict" }));
  expect(() => reconcileOrderReviewMediaFilesystem({ census: { ...census, objects: [] }, references }))
    .toThrow(expect.objectContaining({ code: "absent" }));
  expect(() => reconcileOrderReviewMediaFilesystem({ census, references: [
    { ...references[0]!, observedDigest: "0".repeat(64) }, ...references.slice(1),
  ] })).toThrow(expect.objectContaining({ code: "integrity_conflict" }));
  expect(() => reconcileOrderReviewMediaFilesystem({ census, references: [
    { ...references[0]!, observedByteLength: 6 }, ...references.slice(1),
  ] })).toThrow(expect.objectContaining({ code: "integrity_conflict" }));
});

it("refuses unknown nonempty source layout instead of omitting it", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "unowned"), "retain me", { mode: 0o600 });
  await expect(capture(f.root)).rejects.toMatchObject({ code: "invalid_input" });
});

it("refuses file-count overflow and unavailable source roots", async () => {
  const f = await fixture();
  await f.store.writeTemp("first", body("one"), 3, "2999-01-01T00:00:00Z");
  await f.store.writeTemp("second", body("two"), 3, "2999-01-01T00:00:00Z");
  await expect(capture(f.root, 1)).rejects.toMatchObject({ code: "invalid_input" });
  await rm(f.root, { recursive: true });
  await expect(capture(f.root)).rejects.toMatchObject({ code: "unavailable" });
});
