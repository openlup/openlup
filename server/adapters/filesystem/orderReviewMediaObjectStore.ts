import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_WRITER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface OrderReviewMediaWriteReceipt {
  tempRef: string;
  sha256: string;
  bytes: number;
}

export interface OrderReviewMediaObjectInspection {
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

/** Capability-local private object store. It deliberately has no URL/list API. */
export class OrderReviewMediaObjectStore {
  private constructor(
    private readonly root: string,
    private readonly tempRoot: string,
    private readonly objectRoot: string,
    private readonly now: () => number,
  ) {}

  static async create(
    configuredRoot: string,
    options: { now?: () => number } = {},
  ): Promise<OrderReviewMediaObjectStore> {
    if (!isAbsolute(configuredRoot)) throw new Error("ORDER_REVIEW_MEDIA_ROOT must be absolute");
    const root = resolve(configuredRoot);
    const parent = dirname(root);
    if (await realpath(parent) !== parent) {
      throw new Error("ORDER_REVIEW_MEDIA_ROOT parent must not traverse a symlink");
    }
    await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertPrivateDirectory(root);
    const canonical = await realpath(root);
    if (canonical !== root) throw new Error("ORDER_REVIEW_MEDIA_ROOT must not traverse a symlink");
    await chmod(root, PRIVATE_DIRECTORY_MODE);

    const tempRoot = join(root, "tmp");
    const objectRoot = join(root, "objects");
    for (const directory of [tempRoot, objectRoot]) {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await assertPrivateDirectory(directory);
      await chmod(directory, PRIVATE_DIRECTORY_MODE);
    }
    return new OrderReviewMediaObjectStore(root, tempRoot, objectRoot, options.now ?? Date.now);
  }

  async writeTemp(
    writerOwner: string,
    chunks: AsyncIterable<Uint8Array>,
    maximumBytes: number,
    leaseExpiresAt: string,
  ): Promise<OrderReviewMediaWriteReceipt> {
    if (!OPAQUE_WRITER.test(writerOwner)) throw new Error("invalid writer owner");
    const owner = createHash("sha256").update(writerOwner, "utf8").digest("hex");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("maximumBytes must be a positive safe integer");
    }
    const deadline = Date.parse(leaseExpiresAt);
    if (!Number.isFinite(deadline)) throw new Error("writer lease deadline is invalid");
    await assertPrivateDirectory(this.tempRoot);
    if (this.now() >= deadline) throw new Error("writer lease expired before temp open");
    // The database persists writerOwner with the fenced lease, so this reference
    // is reconstructible after process death without scanning the volume.
    const tempRef = `tmp/${owner}-part`;
    const path = this.resolveTemp(tempRef);
    let handle: FileHandle | undefined;
    let created = false;
    let complete = false;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      created = true;
      if (this.now() >= deadline) throw new Error("writer lease expired while temp opened");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const value of chunks) {
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) throw new Error("object exceeds declared byte ceiling");
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertPrivateFile(path);
      complete = true;
      return { tempRef, sha256: hash.digest("hex"), bytes };
    } finally {
      await handle?.close().catch(() => undefined);
      if (created && !complete) await unlink(path).catch(() => undefined);
    }
  }

  async promote(tempRef: string, objectKey: string): Promise<void> {
    await assertPrivateDirectory(this.tempRoot);
    const source = this.resolveTemp(tempRef);
    const target = await this.resolveObject(objectKey, true);
    await assertPrivateFile(source);
    await assertAbsent(target);
    await rename(source, target);
    try {
      await assertPrivateFile(target);
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }

  async open(objectKey: string): Promise<AsyncIterable<Uint8Array>> {
    const path = await this.resolveObject(objectKey, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await assertHandleIsPrivateFile(handle);
      return handle.createReadStream({ autoClose: true });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async inspect(reference: string, maximumBytes = MAX_MEDIA_BYTES): Promise<OrderReviewMediaObjectInspection> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_MEDIA_BYTES) {
      throw new Error("inspection byte ceiling is invalid");
    }
    try {
      if (reference.startsWith("tmp/")) await assertPrivateDirectory(this.tempRoot);
      const path = reference.startsWith("tmp/")
        ? this.resolveTemp(reference)
        : await this.resolveObject(reference, false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await assertHandleIsPrivateFile(handle);
        const stat = await handle.stat();
        if (stat.size > maximumBytes) throw new Error("object exceeds inspection byte ceiling");
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const value of handle.createReadStream({ autoClose: false })) {
          const chunk = Buffer.from(value);
          bytes += chunk.byteLength;
          if (bytes > maximumBytes) throw new Error("object exceeds inspection byte ceiling");
          hash.update(chunk);
        }
        if (bytes !== stat.size) throw new Error("object changed during inspection");
        const leaf = await lstat(path);
        if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1
          || leaf.dev !== stat.dev || leaf.ino !== stat.ino) {
          throw new Error("object changed during inspection");
        }
        return { exists: true, bytes, sha256: hash.digest("hex") };
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (isMissing(error)) return { exists: false, bytes: 0, sha256: null };
      throw error;
    }
  }

  async remove(reference: string): Promise<boolean> {
    try {
      if (reference.startsWith("tmp/")) await assertPrivateDirectory(this.tempRoot);
      const path = reference.startsWith("tmp/")
        ? this.resolveTemp(reference)
        : await this.resolveObject(reference, false);
      await assertPrivateFile(path);
      await unlink(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private resolveTemp(reference: string): string {
    const parts = reference.split("/");
    if (parts.length !== 2 || parts[0] !== "tmp") throw new Error("invalid temp reference");
    return confined(this.root, this.tempRoot, safeSegment(parts[1]!, "temp reference"));
  }

  private async resolveObject(objectKey: string, createParents: boolean): Promise<string> {
    const parts = objectKey.split("/");
    if (parts.length < 1 || parts.length > 4) throw new Error("invalid object key");
    const safe = parts.map((part) => safeSegment(part, "object key"));
    let parent = this.objectRoot;
    await assertPrivateDirectory(parent);
    for (const segment of safe.slice(0, -1)) {
      parent = confined(this.root, parent, segment);
      if (createParents) {
        await mkdir(parent, { mode: PRIVATE_DIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      }
      await assertPrivateDirectory(parent);
    }
    return confined(this.root, parent, safe[safe.length - 1]!);
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesWritten < 1) throw new Error("filesystem write made no progress");
    offset += result.bytesWritten;
  }
}

function confined(root: string, parent: string, segment: string): string {
  const candidate = join(parent, segment);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("object path escapes root");
  }
  return candidate;
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path} is not a private directory`);
  }
}

async function assertPrivateFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${path} is not one private regular file`);
  }
}

async function assertHandleIsPrivateFile(handle: FileHandle): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("opened object is not one regular file");
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("object already exists");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
