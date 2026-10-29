import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ObjectTransferError } from "@openlup/platform/portability";
import { OrderReviewMediaObjectStore } from "./orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem } from "./orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "./orderReviewMediaTransferReader.js";
import { restoreOrderReviewMediaFilesystem, stageOrderReviewMediaFilesystem } from "./orderReviewMediaTransferRestore.js";

const roots: string[] = [];
const limits = { maximumFiles: 20, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const body = (value: string) => (async function* () { yield Buffer.from(value); })();
async function fixture() {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "review-transfer-restore-")); roots.push(parent);
  const source = join(parent, "source"), target = join(parent, "target");
  const store = await OrderReviewMediaObjectStore.create(source);
  const complete = await store.writeTemp("complete", body("final bytes"), 11, "2999-01-01T00:00:00Z");
  await store.promote(complete.tempRef, "review/media");
  const partial = await store.writeTemp("still-pending", body("partial"), 20, "2999-01-01T00:00:00Z");
  const census = await captureOrderReviewMediaFilesystem({ root: source, ...limits });
  const objects = createOrderReviewMediaTransferReader({ root: source, maximumObjectBytes: limits.maximumObjectBytes });
  const temporary = createOrderReviewMediaTransferReader({ root: source, maximumObjectBytes: limits.maximumObjectBytes, area: "tmp" });
  return { parent, source, target, partial, census, objects, temporary,
    input: { root: target, census, objects, temporary, ...limits } };
}

it("publishes final and partial bytes in the actual runtime layout and replays after an unobserved acknowledgement", async () => {
  const f = await fixture();
  await restoreOrderReviewMediaFilesystem(f.input); // Caller loses this ACK.
  expect(await restoreOrderReviewMediaFilesystem(f.input)).toEqual({ replayed: true, objects: 1, temporary: 1 });
  const runtime = await OrderReviewMediaObjectStore.create(f.target);
  const chunks: Uint8Array[] = []; for await (const chunk of await runtime.open("review/media")) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("final bytes");
  expect(await runtime.inspect(f.partial.tempRef)).toEqual({ exists: true, bytes: 7, sha256: f.partial.sha256 });
  expect(await captureOrderReviewMediaFilesystem({ root: f.target, ...limits })).toEqual(f.census);
  expect(await readdir(f.parent)).toEqual(expect.arrayContaining(["source", "target"]));
  expect((await readdir(f.parent)).filter(name => name.startsWith(".openlup-media-transfer-"))).toEqual([]);
});

it("stages a complete generation without creating the configured serving root", async () => {
  const f = await fixture();
  const copy = { census: f.census, objects: f.objects, temporary: f.temporary, ...limits };
  const staged = await stageOrderReviewMediaFilesystem({ ...copy, servingRoot: f.target, generationId: "snapshot-1" });
  expect(staged.generationRoot).toBe(join(f.parent, ".openlup-inactive-media-snapshot-1"));
  expect(await readdir(f.parent)).toEqual([".openlup-inactive-media-snapshot-1", "source"]);
  expect(await captureOrderReviewMediaFilesystem({ root: staged.generationRoot, ...limits })).toEqual(f.census);
  expect((await stageOrderReviewMediaFilesystem({ ...copy, servingRoot: f.target, generationId: "snapshot-1" })).replayed).toBe(true);
  await expect(stageOrderReviewMediaFilesystem({ ...copy, servingRoot: f.target, generationId: "../escape" }))
    .rejects.toMatchObject({ code: "invalid_input" });
});

it("leaves the runtime target absent after an interrupted source read and can resume from the same capture", async () => {
  const f = await fixture();
  await expect(restoreOrderReviewMediaFilesystem({ ...f.input, temporary: {
    async read() { throw new ObjectTransferError("unavailable"); },
  } })).rejects.toMatchObject({ code: "unavailable" });
  expect(await readdir(f.parent)).toEqual(["source"]);
  expect(await restoreOrderReviewMediaFilesystem(f.input)).toEqual({ replayed: false, objects: 1, temporary: 1 });
});

it("refuses changed source bytes without publishing a mixed image", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "objects/review/media"), "new bytes");
  await expect(restoreOrderReviewMediaFilesystem(f.input)).rejects.toMatchObject({ code: "version_conflict" });
  expect(await readdir(f.parent)).toEqual(["source"]);
});

it("refuses a divergent existing target and preserves its bytes", async () => {
  const f = await fixture();
  await restoreOrderReviewMediaFilesystem(f.input);
  const path = join(f.target, "objects/review/media"); await writeFile(path, "adopter bytes");
  await expect(restoreOrderReviewMediaFilesystem(f.input)).rejects.toMatchObject({ code: "version_conflict" });
  expect(await readFile(path, "utf8")).toBe("adopter bytes");
});

it("refuses unknown target files and duplicate source keys rather than treating them as resumable", async () => {
  const f = await fixture();
  await restoreOrderReviewMediaFilesystem(f.input);
  await writeFile(join(f.target, "objects/unowned"), "retained extra", { mode: 0o600 });
  await expect(restoreOrderReviewMediaFilesystem(f.input)).rejects.toMatchObject({ code: "version_conflict" });
  await expect(restoreOrderReviewMediaFilesystem({ ...f.input, census: { ...f.census, objects: [...f.census.objects, ...f.census.objects] } }))
    .rejects.toMatchObject({ code: "invalid_input" });
});
