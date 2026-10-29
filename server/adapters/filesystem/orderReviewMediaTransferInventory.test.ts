import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { OrderReviewMediaObjectStore } from "./orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem } from "./orderReviewMediaTransferInventory.js";

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
