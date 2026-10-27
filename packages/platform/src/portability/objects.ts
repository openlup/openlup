import { createHash } from "node:crypto";

export type ObjectTransferFailure = "absent" | "denied" | "unavailable" | "version_conflict" | "integrity_conflict" | "invalid_input";

/** Adapters distinguish missing data from permission and availability failures. */
export class ObjectTransferError extends Error {
  constructor(readonly code: ObjectTransferFailure) {
    super(`object_transfer_${code}`);
    this.name = "ObjectTransferError";
  }
}

export interface TransferObject {
  key: string;
  /** Logical immutable source version; never a claim about a target provider's native version ID. */
  version: string;
  bytes: number;
  sha256: string;
  metadata: Readonly<Record<string, string>>;
  /** An explicit access classification, never inferred from a public URL. */
  access: string;
  lineage?: { sourceId: string; snapshotId: string; sourceVersion: string };
}

export interface TransferObjectRead {
  object: TransferObject;
  body: AsyncIterable<Uint8Array>;
}

export interface TransferObjectReader {
  /** Must read the requested version or refuse, never silently read a newer one. */
  read(key: string, expectedVersion?: string): Promise<TransferObjectRead>;
}

export interface TransferObjectStore extends TransferObjectReader {
  /** Atomic publication; an existing key must refuse with version_conflict. */
  createIfAbsent(object: TransferObject, bytes: Uint8Array): Promise<void>;
}

export interface TransferObjectInventory {
  sourceId: string;
  /** Host prerequisite: complete inventory and stable versioned reads, or a held write fence. */
  snapshot: { kind: "immutable" | "quiesced"; id: string };
  objects: readonly TransferObject[];
}

/** Canonical descriptor encoding also preserves metadata independent of property order. */
export function encodeTransferObject(object: TransferObject): string {
  validateTransferObject(object);
  return JSON.stringify({
    key: object.key, version: object.version, bytes: object.bytes, sha256: object.sha256,
    metadata: Object.fromEntries(Object.entries(object.metadata).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    access: object.access,
    ...(object.lineage ? { lineage: { sourceId: object.lineage.sourceId, snapshotId: object.lineage.snapshotId, sourceVersion: object.lineage.sourceVersion } } : {}),
  });
}

export function validateTransferObject(object: TransferObject): void {
  if (!object || !text(object.key, 4096) || !text(object.version, 1024)
    || !Number.isSafeInteger(object.bytes) || object.bytes < 0 || !/^[a-f0-9]{64}$/.test(object.sha256)
    || !text(object.access, 1024) || !object.metadata || typeof object.metadata !== "object" || Array.isArray(object.metadata)
    || Object.entries(object.metadata).some(([key, value]) => !text(key, 1024) || typeof value !== "string" || value.length > 8192)
    || JSON.stringify(object.metadata).length > 65536
    || (object.lineage !== undefined && (!object.lineage || !text(object.lineage.sourceId, 1024)
      || !text(object.lineage.snapshotId, 1024) || !text(object.lineage.sourceVersion, 1024)))) {
    throw new ObjectTransferError("invalid_input");
  }
}

/** Bounded in-memory object copy; ceilings are explicit and checked before any destination mutation. */
export async function copyTransferObjects(input: {
  inventory: TransferObjectInventory;
  source: TransferObjectReader;
  destination: TransferObjectStore;
  accessMapping: Readonly<Record<string, string>>;
  maximumObjectBytes: number;
  maximumTotalBytes: number;
  /** Called only after destination descriptor and bytes have been read back successfully. */
  checkpoint?: (object: TransferObject) => Promise<void>;
}): Promise<{ copied: number; replayed: number; verifiedKeys: string[] }> {
  const { inventory } = input;
  if (!inventory || !text(inventory.sourceId, 1024) || !inventory.snapshot
    || !["immutable", "quiesced"].includes(inventory.snapshot.kind) || !text(inventory.snapshot.id, 1024)
    || !Array.isArray(inventory.objects) || !input.accessMapping
    || !ceiling(input.maximumObjectBytes) || !ceiling(input.maximumTotalBytes)) throw new ObjectTransferError("invalid_input");
  // Snapshot inputs before the first await; a caller cannot change the plan during a copy.
  const sourceId = inventory.sourceId, snapshotId = inventory.snapshot.id;
  const keys = new Set<string>();
  let total = 0;
  const plan = inventory.objects.map(object => {
    const source = JSON.parse(encodeTransferObject(object)) as TransferObject;
    const access = Object.hasOwn(input.accessMapping, source.access) ? input.accessMapping[source.access] : undefined;
    total += source.bytes;
    if (keys.has(source.key) || !text(access, 1024) || source.bytes > input.maximumObjectBytes
      || !Number.isSafeInteger(total) || total > input.maximumTotalBytes) throw new ObjectTransferError("invalid_input");
    keys.add(source.key);
    const target: TransferObject = { ...source, access, lineage: { sourceId, snapshotId, sourceVersion: source.version } };
    return { source, target };
  });
  const result = { copied: 0, replayed: 0, verifiedKeys: [] as string[] };
  for (const { source, target } of plan) {
    let existing: TransferObjectRead | undefined;
    try { existing = await input.destination.read(target.key); }
    catch (error) { if (!failure(error, "absent")) throw normalizeObjectTransferError(error); }
    if (existing) {
      await verifyRead(existing, target);
      result.replayed++;
    } else {
      let read: TransferObjectRead;
      try { read = await input.source.read(source.key, source.version); }
      catch (error) { throw normalizeObjectTransferError(error); }
      const bytes = await verifyRead(read, source);
      let writeFailure: ObjectTransferError | undefined;
      try { await input.destination.createIfAbsent(target, bytes); }
      catch (error) {
        // A competing writer or lost write acknowledgement still requires exact readback.
        if (!failure(error, "version_conflict") && !failure(error, "unavailable")) throw normalizeObjectTransferError(error);
        writeFailure = normalizeObjectTransferError(error);
      }
      try { await verifyRead(await input.destination.read(target.key), target); }
      catch (error) { throw failure(error, "absent") && writeFailure ? writeFailure : normalizeObjectTransferError(error); }
      if (writeFailure) result.replayed++;
      else result.copied++;
    }
    await input.checkpoint?.(JSON.parse(encodeTransferObject(target)) as TransferObject);
    result.verifiedKeys.push(target.key);
  }
  return result;
}

/** Read exactly the declared bytes and hash; never trust a successful HEAD alone. */
export async function verifyRead(read: TransferObjectRead, expected: TransferObject): Promise<Uint8Array> {
  if (encodeTransferObject(read.object) !== encodeTransferObject(expected)) throw new ObjectTransferError("version_conflict");
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of read.body) {
      if (!(chunk instanceof Uint8Array)) throw new ObjectTransferError("integrity_conflict");
      bytes += chunk.byteLength;
      if (bytes > expected.bytes) throw new ObjectTransferError("integrity_conflict");
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      hash.update(copy);
    }
  } catch (error) { throw normalizeObjectTransferError(error); }
  if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new ObjectTransferError("integrity_conflict");
  return Buffer.concat(chunks, bytes);
}

export function normalizeObjectTransferError(error: unknown): ObjectTransferError {
  return error instanceof ObjectTransferError ? error : new ObjectTransferError("unavailable");
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function ceiling(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function failure(error: unknown, code: ObjectTransferFailure): boolean { return error instanceof ObjectTransferError && error.code === code; }
