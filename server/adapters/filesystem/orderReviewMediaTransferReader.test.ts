import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { OrderReviewMediaObjectStore } from "./orderReviewMediaObjectStore.js";
import { createOrderReviewMediaTransferReader } from "./orderReviewMediaTransferReader.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "review-transfer-reader-"));
  roots.push(root);
  const store = await OrderReviewMediaObjectStore.create(root);
  const receipt = await store.writeTemp("reader-fixture", (async function* () { yield Buffer.from("abc"); })(), 3, "2999-01-01T00:00:00Z");
  await store.promote(receipt.tempRef, "review/media");
  return { root, path: join(root, "objects/review/media"), reader: createOrderReviewMediaTransferReader({ root, maximumObjectBytes: 1024 }) };
}

it("reads actual application-created bytes without a transfer-store layout or source mutation", async () => {
  const f = await fixture();
  const before = await lstat(f.path);
  const result = await f.reader.read("review/media");
  expect(result.object).toEqual({ key: "review/media", bytes: 3,
    version: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", metadata: {}, access: "posix-owner-mode" });
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.body) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("abc");
  const after = await lstat(f.path);
  expect([after.ino, after.mtimeMs, after.ctimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.ctimeMs, before.mode]);
});

it("rejects a changed source version and keeps already captured bytes stable", async () => {
  const f = await fixture();
  const captured = await f.reader.read("review/media");
  await writeFile(f.path, "xyz");
  await expect(f.reader.read("review/media", captured.object.version)).rejects.toMatchObject({ code: "version_conflict" });
  const chunks: Uint8Array[] = [];
  for await (const chunk of captured.body) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("abc");
});

it("separates an absent key from unavailable source roots", async () => {
  const f = await fixture();
  await expect(f.reader.read("review/missing")).rejects.toMatchObject({ code: "absent" });
  await rm(join(f.root, "objects"), { recursive: true });
  await expect(f.reader.read("review/media")).rejects.toMatchObject({ code: "unavailable" });
});

it("refuses unsafe permissions without repairing or reading the source", async () => {
  const f = await fixture();
  await chmod(f.path, 0o644);
  await expect(f.reader.read("review/media")).rejects.toMatchObject({ code: "denied" });
  expect((await lstat(f.path)).mode & 0o777).toBe(0o644);
  await chmod(f.path, 0o600);
  await chmod(join(f.root, "objects/review"), 0o755);
  await expect(f.reader.read("review/media")).rejects.toMatchObject({ code: "denied" });
});

it("refuses symlink and hardlink leaves", async () => {
  const f = await fixture();
  await symlink(f.path, join(f.root, "objects/review/linked"));
  await expect(f.reader.read("review/linked")).rejects.toMatchObject({ code: "denied" });
  await link(f.path, join(f.root, "objects/review/hardlinked"));
  await expect(f.reader.read("review/media")).rejects.toMatchObject({ code: "denied" });
  expect(await readFile(f.path, "utf8")).toBe("abc");
});

it("refuses a byte ceiling before returning a stream", async () => {
  const f = await fixture();
  const reader = createOrderReviewMediaTransferReader({ root: f.root, maximumObjectBytes: 2 });
  await expect(reader.read("review/media")).rejects.toMatchObject({ code: "invalid_input" });
});

it.each(["../media", "tmp/../media", "review//media", "a/b/c/d/e", "review/media.txt"])("refuses keys outside the real application grammar: %s", async key => {
  const f = await fixture();
  await expect(f.reader.read(key)).rejects.toMatchObject({ code: "invalid_input" });
});
