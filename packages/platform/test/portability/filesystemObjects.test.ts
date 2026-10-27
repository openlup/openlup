import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemTransferObjects } from "../../src/portability/filesystemObjects.js";
import { copyTransferObjects, verifyRead, type TransferObject } from "../../src/portability/objects.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "openlup-object-transfer-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
function descriptor(bytes = Buffer.from("private object")): TransferObject {
  return { key: "nested/object name", version: "v1", bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), metadata: { contentType: "application/pdf" }, access: "private" };
}
const objectDirectory = (root: string) => join(root, createHash("sha256").update(descriptor().key).digest("hex"));

describe("private filesystem transfer objects", () => {
  it("copies Unicode metadata between real stores and resumes after checkpoint interruption", async () => {
    const sourceRoot = await directory(), targetRoot = await directory();
    const source = await createFilesystemTransferObjects({ root: sourceRoot, maximumObjectBytes: 1024, access: "private" });
    const destination = await createFilesystemTransferObjects({ root: targetRoot, maximumObjectBytes: 1024, access: "private-target" });
    const object = { ...descriptor(), metadata: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`m${index}`, "\u6c49".repeat(8000)])) };
    expect(Buffer.byteLength(JSON.stringify(object.metadata))).toBeGreaterThan(131072);
    await source.createIfAbsent(object, Buffer.from("private object"));
    const input = { source, destination, inventory: { sourceId: "local-source", snapshot: { kind: "quiesced" as const, id: "fence" }, objects: [object] },
      accessMapping: { private: "private-target" }, maximumObjectBytes: 1024, maximumTotalBytes: 1024 };
    await expect(copyTransferObjects({ ...input, checkpoint: async () => { throw new Error("interruption"); } })).rejects.toThrow("interruption");
    const resumeStarted = performance.now();
    const reopened = await createFilesystemTransferObjects({ root: targetRoot, maximumObjectBytes: 1024, access: "private-target" });
    expect(await copyTransferObjects({ ...input, destination: reopened })).toEqual({ copied: 0, replayed: 1, verifiedKeys: [descriptor().key] });
    console.info(`M14 local object resume objects=1 bytes=${descriptor().bytes} ms=${(performance.now() - resumeStarted).toFixed(2)}`);
    const read = await reopened.read(descriptor().key, "v1");
    expect(Buffer.from(await verifyRead(read, read.object))).toEqual(Buffer.from("private object"));
    expect(read.object).toMatchObject({ access: "private-target", lineage: { sourceId: "local-source", snapshotId: "fence", sourceVersion: "v1" } });
    expect(read.object.metadata).toEqual(object.metadata);
    expect((await lstat(objectDirectory(targetRoot))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(objectDirectory(targetRoot), "bytes"))).mode & 0o777).toBe(0o600);
    expect((await readdir(targetRoot)).some(name => name.startsWith(".partial-"))).toBe(false);
  });

  it("publishes one object atomically under competing create attempts and never overwrites it", async () => {
    const root = await directory(), store = await createFilesystemTransferObjects({ root, maximumObjectBytes: 1024, access: "private" });
    const attempts = await Promise.allSettled([store.createIfAbsent(descriptor(), Buffer.from("private object")), store.createIfAbsent(descriptor(), Buffer.from("private object"))]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "version_conflict" } });
    const changed = Buffer.from("different bytes");
    await expect(store.createIfAbsent(descriptor(changed), changed)).rejects.toMatchObject({ code: "version_conflict" });
    expect(await readFile(join(objectDirectory(root), "bytes"), "utf8")).toBe("private object");
    expect((await readdir(root)).some(name => name.startsWith(".partial-"))).toBe(false);
  });

  it("distinguishes missing objects and expected-version conflicts", async () => {
    const store = await createFilesystemTransferObjects({ root: await directory(), maximumObjectBytes: 1024, access: "private" });
    await expect(store.read("missing")).rejects.toMatchObject({ code: "absent" });
    await store.createIfAbsent(descriptor(), Buffer.from("private object"));
    await expect(store.read(descriptor().key, "v2")).rejects.toMatchObject({ code: "version_conflict" });
    await expect(store.createIfAbsent({ ...descriptor(), key: "unsupported-access", access: "public" }, Buffer.from("private object"))).rejects.toMatchObject({ code: "denied" });
  });

  it("distinguishes an unavailable root from incomplete published data", async () => {
    const root = await directory(), store = await createFilesystemTransferObjects({ root, maximumObjectBytes: 1024, access: "private" });
    await store.createIfAbsent(descriptor(), Buffer.from("private object"));
    await rm(join(objectDirectory(root), "bytes"));
    await expect(store.read(descriptor().key)).rejects.toMatchObject({ code: "integrity_conflict" });
    await rm(root, { recursive: true });
    await expect(store.read(descriptor().key)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses unsafe root modes and symlink roots or parents", async () => {
    const parent = await directory(), unsafe = join(parent, "unsafe");
    await mkdir(unsafe, { mode: 0o755 });
    await chmod(unsafe, 0o755);
    await expect(createFilesystemTransferObjects({ root: unsafe, maximumObjectBytes: 1024, access: "private" })).rejects.toMatchObject({ code: "denied" });
    const target = join(parent, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(parent, "link"));
    await expect(createFilesystemTransferObjects({ root: join(parent, "link"), maximumObjectBytes: 1024, access: "private" })).rejects.toMatchObject({ code: "denied" });
    await expect(createFilesystemTransferObjects({ root: join(parent, "link", "child"), maximumObjectBytes: 1024, access: "private" })).rejects.toMatchObject({ code: "denied" });
  });

  it("refuses a symlink or unsafe mode at an existing object's bytes", async () => {
    const root = await directory(), store = await createFilesystemTransferObjects({ root, maximumObjectBytes: 1024, access: "private" });
    await store.createIfAbsent(descriptor(), Buffer.from("private object"));
    const path = join(objectDirectory(root), "bytes");
    await chmod(path, 0o644);
    await expect(store.read(descriptor().key)).rejects.toMatchObject({ code: "denied" });
    await rm(path);
    const external = join(root, "external");
    await writeFile(external, "private object", { mode: 0o600 });
    await symlink(external, path);
    await expect(store.read(descriptor().key)).rejects.toMatchObject({ code: "denied" });
  });

  it("refuses unsafe object directories, corrupt data and declared ceilings", async () => {
    const root = await directory(), store = await createFilesystemTransferObjects({ root, maximumObjectBytes: 1024, access: "private" });
    await store.createIfAbsent(descriptor(), Buffer.from("private object"));
    await chmod(objectDirectory(root), 0o755);
    await expect(store.read(descriptor().key)).rejects.toMatchObject({ code: "denied" });
    await chmod(objectDirectory(root), 0o700);
    await writeFile(join(objectDirectory(root), "bytes"), "short");
    await expect(store.read(descriptor().key)).rejects.toMatchObject({ code: "integrity_conflict" });
    const bounded = await createFilesystemTransferObjects({ root: await directory(), maximumObjectBytes: 1, access: "private" });
    await expect(bounded.createIfAbsent(descriptor(), Buffer.from("private object"))).rejects.toMatchObject({ code: "integrity_conflict" });
    await expect(store.createIfAbsent({ ...descriptor(), key: "bad-digest", sha256: "0".repeat(64) }, Buffer.from("private object"))).rejects.toMatchObject({ code: "integrity_conflict" });
  });
});
