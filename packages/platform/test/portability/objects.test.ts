import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  copyTransferObjects, ObjectTransferError, type TransferObject, type TransferObjectRead,
  type TransferObjectStore, type TransferObjectInventory,
} from "../../src/portability/objects.js";

const content = Buffer.from("portable bytes");
function object(overrides: Partial<TransferObject> = {}): TransferObject {
  return { key: "nested/private object", version: "generation-7", bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    metadata: { contentType: "application/octet-stream", disposition: "attachment" }, access: "private-owner", ...overrides };
}
function memoryStore(): TransferObjectStore & { rows: Map<string, { object: TransferObject; bytes: Uint8Array }> } {
  const rows = new Map<string, { object: TransferObject; bytes: Uint8Array }>();
  return {
    rows,
    async read(key, expectedVersion): Promise<TransferObjectRead> {
      const row = rows.get(key);
      if (!row) throw new ObjectTransferError("absent");
      if (expectedVersion !== undefined && row.object.version !== expectedVersion) throw new ObjectTransferError("version_conflict");
      return { object: structuredClone(row.object), body: (async function* () { yield row.bytes; })() };
    },
    async createIfAbsent(value, bytes) {
      if (rows.has(value.key)) throw new ObjectTransferError("version_conflict");
      rows.set(value.key, { object: structuredClone(value), bytes: Buffer.from(bytes) });
    },
  };
}
async function fixture() {
  const source = memoryStore(), destination = memoryStore(), value = object();
  await source.createIfAbsent(value, content);
  const inventory: TransferObjectInventory = { sourceId: "source-deployment", snapshot: { kind: "quiesced", id: "fence-4" }, objects: [value] };
  return { source, destination, inventory, accessMapping: { "private-owner": "private-import" }, maximumObjectBytes: 100, maximumTotalBytes: 100 };
}

describe("bounded object transfer", () => {
  it("preserves bytes, key, metadata and source lineage with an explicit access mapping", async () => {
    const input = await fixture();
    const checkpoint = vi.fn(async (value: TransferObject) => {
      expect(input.destination.rows.get(value.key)?.bytes).toEqual(content);
    });
    expect(await copyTransferObjects({ ...input, checkpoint })).toEqual({ copied: 1, replayed: 0, verifiedKeys: [object().key] });
    expect(input.destination.rows.get(object().key)?.object).toEqual({ ...object(), access: "private-import",
      lineage: { sourceId: "source-deployment", snapshotId: "fence-4", sourceVersion: "generation-7" } });
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  it("recovers a write-before-checkpoint interruption through destination readback", async () => {
    const input = await fixture();
    await expect(copyTransferObjects({ ...input, checkpoint: async () => { throw new Error("checkpoint interrupted"); } })).rejects.toThrow("checkpoint interrupted");
    input.source.read = vi.fn(async () => { throw new ObjectTransferError("unavailable"); });
    expect(await copyTransferObjects(input)).toEqual({ copied: 0, replayed: 1, verifiedKeys: [object().key] });
    expect(input.source.read).not.toHaveBeenCalled();
  });

  it("accepts an immutable inventory and recovers a committed write with a lost acknowledgement", async () => {
    const input = await fixture();
    input.inventory.snapshot.kind = "immutable";
    const create = input.destination.createIfAbsent;
    input.destination.createIfAbsent = async (value, bytes) => { await create(value, bytes); throw new ObjectTransferError("unavailable"); };
    const checkpoint = vi.fn(async () => undefined);
    expect((await copyTransferObjects({ ...input, checkpoint })).verifiedKeys).toEqual([object().key]);
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  it.each(["absent", "denied", "unavailable", "version_conflict"] as const)("preserves a source %s refusal without writing", async code => {
    const input = await fixture();
    input.source.read = async () => { throw new ObjectTransferError(code); };
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code });
    expect(input.destination.rows.size).toBe(0);
  });

  it("does not treat destination denial as absence", async () => {
    const input = await fixture();
    input.destination.read = async () => { throw new ObjectTransferError("denied"); };
    input.destination.createIfAbsent = vi.fn();
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "denied" });
    expect(input.destination.createIfAbsent).not.toHaveBeenCalled();
  });

  it("retains an unavailable write when readback proves no object was published", async () => {
    const input = await fixture();
    input.destination.createIfAbsent = async () => { throw new ObjectTransferError("unavailable"); };
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "unavailable" });
    expect(input.destination.rows.size).toBe(0);
  });

  it("refuses source version drift and corrupted source bytes before writing", async () => {
    const input = await fixture();
    input.source.rows.get(object().key)!.object.version = "generation-8";
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "version_conflict" });
    input.source.rows.get(object().key)!.object.version = "generation-7";
    input.source.rows.get(object().key)!.bytes = Buffer.alloc(content.length);
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "integrity_conflict" });
    expect(input.destination.rows.size).toBe(0);
  });

  it("refuses a changed destination descriptor or bytes rather than overwriting", async () => {
    const input = await fixture();
    await copyTransferObjects(input);
    input.destination.rows.get(object().key)!.object.access = "public";
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "version_conflict" });
    input.destination.rows.get(object().key)!.object.access = "private-import";
    input.destination.rows.get(object().key)!.bytes = Buffer.alloc(content.length);
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "integrity_conflict" });
  });

  it("checks readback before recording completion", async () => {
    const input = await fixture(), checkpoint = vi.fn(async () => undefined);
    const create = input.destination.createIfAbsent;
    input.destination.createIfAbsent = async (value, bytes) => {
      await create(value, bytes);
      input.destination.rows.get(value.key)!.bytes = Buffer.alloc(bytes.length);
    };
    await expect(copyTransferObjects({ ...input, checkpoint })).rejects.toMatchObject({ code: "integrity_conflict" });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("checks the whole inventory, limits and access mapping before the first write", async () => {
    const input = await fixture();
    input.inventory.objects = [object(), object({ key: "second" })];
    for (const override of [
      { maximumObjectBytes: 1 }, { maximumTotalBytes: content.length }, { accessMapping: {} },
      { inventory: { ...input.inventory, snapshot: undefined } },
      { inventory: { ...input.inventory, objects: [object(), object()] } },
    ]) {
      await expect(copyTransferObjects({ ...input, ...override } as Parameters<typeof copyTransferObjects>[0])).rejects.toMatchObject({ code: "invalid_input" });
      expect(input.destination.rows.size).toBe(0);
    }
  });

  it("stops a source stream exceeding its declared length", async () => {
    const input = await fixture();
    let closed = false;
    input.source.read = async () => ({ object: object(), body: (async function* () {
      try { yield content; yield Buffer.from("extra"); } finally { closed = true; }
    })() });
    await expect(copyTransferObjects(input)).rejects.toMatchObject({ code: "integrity_conflict" });
    expect(closed).toBe(true);
    expect(input.destination.rows.size).toBe(0);
  });
});
