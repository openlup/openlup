import { link, lstat, mkdir, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { OrderReviewMediaObjectStore } from "./orderReviewMediaObjectStore.js";

const LIVE_LEASE = "2999-01-01T00:00:00.000Z";

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function testRoot(prefix = "order-review-store-"): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

describe("OrderReviewMediaObjectStore", () => {
  it("writes 0600 bytes, hashes them, atomically promotes and streams them back", async () => {
    const root = await testRoot();
    const store = await OrderReviewMediaObjectStore.create(root);
    const receipt = await store.writeTemp("node:one", chunks("abc", "def"), 6, LIVE_LEASE);

    expect(receipt).toMatchObject({ bytes: 6, sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" });
    expect((await lstat(join(root, receipt.tempRef))).mode & 0o777).toBe(0o600);

    await store.promote(receipt.tempRef, "review_1/media_1");
    expect(await store.inspect(receipt.tempRef)).toEqual({ exists: false, bytes: 0, sha256: null });
    expect(await store.inspect("review_1/media_1")).toEqual({
      exists: true,
      bytes: 6,
      sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    });
    const read: Buffer[] = [];
    for await (const chunk of await store.open("review_1/media_1")) read.push(Buffer.from(chunk));
    expect(Buffer.concat(read).toString()).toBe("abcdef");
    expect(await store.remove("review_1/media_1")).toBe(true);
    expect(await store.remove("review_1/media_1")).toBe(false);
    await expect(OrderReviewMediaObjectStore.create(root)).resolves.toBeInstanceOf(OrderReviewMediaObjectStore);
  });

  it("removes an exact partial temp after a streaming failure", async () => {
    const root = await testRoot();
    const store = await OrderReviewMediaObjectStore.create(root);
    const failing = async function* () {
      yield Buffer.from("abc");
      throw new Error("socket aborted");
    };
    await expect(store.writeTemp("writer_1", failing(), 10, LIVE_LEASE)).rejects.toThrow("socket aborted");
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("refuses to open a temp after the durable writer lease expires", async () => {
    const root = await testRoot();
    const store = await OrderReviewMediaObjectStore.create(root);
    await expect(store.writeTemp("late-writer", chunks("bytes"), 5, "2000-01-01T00:00:00.000Z"))
      .rejects.toThrow("writer lease expired before temp open");
    await expect(store.writeTemp("late-writer", chunks("bytes"), 5, "not-a-date"))
      .rejects.toThrow("writer lease deadline is invalid");
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("closes and unlinks when the lease expires while temp open awaits", async () => {
    const root = await testRoot();
    let clock = 0;
    let cleanupCompleted = false;
    const store = await OrderReviewMediaObjectStore.create(root, { now: () => {
      if (clock++ === 0) return 0;
      cleanupCompleted = true;
      return 2_000;
    } });
    let bodyConsumed = false;
    const body = async function* () { bodyConsumed = true; yield Buffer.from("bytes"); };
    await expect(store.writeTemp("barrier-writer", body(), 5, "1970-01-01T00:00:01.000Z"))
      .rejects.toThrow("writer lease expired while temp opened");
    expect(cleanupCompleted).toBe(true);
    expect(bodyConsumed).toBe(false);
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("rejects relative roots, traversal, unsafe owners and duplicate final objects", async () => {
    await expect(OrderReviewMediaObjectStore.create("relative")).rejects.toThrow("must be absolute");
    const root = await testRoot();
    const store = await OrderReviewMediaObjectStore.create(root);
    await expect(store.writeTemp("../owner", chunks("a"), 1, LIVE_LEASE)).rejects.toThrow("invalid writer owner");
    const first = await store.writeTemp("owner", chunks("a"), 1, LIVE_LEASE);
    await expect(store.writeTemp("owner", chunks("b"), 1, LIVE_LEASE)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.promote(first.tempRef, "../escape")).rejects.toThrow("invalid object key");
    await store.promote(first.tempRef, "review/media");
    const second = await store.writeTemp("owner", chunks("b"), 1, LIVE_LEASE);
    await expect(store.promote(second.tempRef, "review/media")).rejects.toThrow("already exists");
    expect(await store.remove(second.tempRef)).toBe(true);
    expect(await store.inspect("never/created")).toEqual({ exists: false, bytes: 0, sha256: null });
  });

  it("refuses symlink parents, symlink leaves and hardlinked leaves", async () => {
    const root = await testRoot();
    const outside = await testRoot("order-review-outside-");
    const store = await OrderReviewMediaObjectStore.create(root);

    await symlink(outside, join(root, "objects", "linked"));
    const temp = await store.writeTemp("owner", chunks("a"), 1, LIVE_LEASE);
    await expect(store.promote(temp.tempRef, "linked/media")).rejects.toThrow("not a private directory");
    expect(await store.remove(temp.tempRef)).toBe(true);

    await writeFile(join(outside, "victim"), "secret");
    await symlink(join(outside, "victim"), join(root, "objects", "leaf"));
    await expect(store.open("leaf")).rejects.toThrow();
    await expect(store.remove("leaf")).rejects.toThrow("not one private regular file");

    await writeFile(join(root, "objects", "one"), "bytes", { mode: 0o600 });
    await link(join(root, "objects", "one"), join(root, "objects", "two"));
    await expect(store.open("one")).rejects.toThrow("not one regular file");
    await expect(store.remove("two")).rejects.toThrow("not one private regular file");
  });

  it("rejects a symlink root and oversized streams without residue", async () => {
    const outside = await testRoot("order-review-real-");
    const parent = await testRoot("order-review-link-");
    const linkedRoot = join(parent, "root");
    await symlink(outside, linkedRoot);
    await expect(OrderReviewMediaObjectStore.create(linkedRoot)).rejects.toThrow();

    const root = await testRoot();
    const store = await OrderReviewMediaObjectStore.create(root);
    await expect(store.writeTemp("owner", chunks("too-long"), 2, LIVE_LEASE)).rejects.toThrow("byte ceiling");
    await mkdir(join(root, "objects", "directory"));
    await expect(store.inspect("directory")).rejects.toThrow("not one regular file");
    const receipt = await store.writeTemp("oversized:inspect", chunks("abc"), 3, LIVE_LEASE);
    await store.promote(receipt.tempRef, "review/oversized");
    await expect(store.inspect("review/oversized", 2)).rejects.toThrow("inspection byte ceiling");
  });

  it("rechecks the temp parent before exact inspect/remove/promote operations", async () => {
    const root = await testRoot();
    const outside = await testRoot("order-review-temp-outside-");
    const store = await OrderReviewMediaObjectStore.create(root);
    const receipt = await store.writeTemp("node:writer", chunks("abc"), 3, LIVE_LEASE);
    await rename(join(root, "tmp"), join(root, "tmp-owned"));
    await symlink(outside, join(root, "tmp"));
    await writeFile(join(outside, receipt.tempRef.slice(4)), "attacker", { mode: 0o600 });
    await expect(store.inspect(receipt.tempRef)).rejects.toThrow("not a private directory");
    await expect(store.remove(receipt.tempRef)).rejects.toThrow("not a private directory");
    await expect(store.promote(receipt.tempRef, "review/media")).rejects.toThrow("not a private directory");
    expect(await readdir(outside)).toEqual([receipt.tempRef.slice(4)]);
  });
});
