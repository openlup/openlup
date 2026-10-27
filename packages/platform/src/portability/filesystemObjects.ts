import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  encodeTransferObject, normalizeObjectTransferError, ObjectTransferError, validateTransferObject,
  type TransferObject, type TransferObjectRead, type TransferObjectStore,
} from "./objects.js";

// Covers bounded metadata JSON in UTF-8 plus JSON-escaped bounded identifiers.
const maximumDescriptorBytes = 262144;

/**
 * Private local transfer store, exclusively controlled by its owner process/account.
 * Metadata and bytes publish together through one directory rename. Concurrent use through
 * this adapter is supported; hostile same-UID filesystem mutation is outside that guarantee.
 */
export async function createFilesystemTransferObjects(options: {
  root: string;
  maximumObjectBytes: number;
  /** Host label for this filesystem owner's private-read policy; other ACLs refuse. */
  access: string;
}): Promise<TransferObjectStore> {
  if (!isAbsolute(options.root) || !Number.isSafeInteger(options.maximumObjectBytes) || options.maximumObjectBytes < 0
    || typeof options.access !== "string" || !options.access.trim()) {
    throw new ObjectTransferError("invalid_input");
  }
  const root = resolve(options.root), maximum = options.maximumObjectBytes, access = options.access;
  try {
    if (await realpath(dirname(root)) !== dirname(root)) throw new ObjectTransferError("denied");
    await mkdir(root, { mode: 0o700 }).catch(error => { if (errno(error) !== "EEXIST") throw error; });
    await privateDirectory(root, true);
  } catch (error) { throw filesystemFailure(error); }
  const location = (key: string) => join(root, createHash("sha256").update(JSON.stringify(key)).digest("hex"));
  return {
    async read(key, expectedVersion): Promise<TransferObjectRead> {
      let body: FileHandle | undefined;
      let published = false;
      try {
        await privateDirectory(root, true);
        const directory = location(key);
        await privateDirectory(directory);
        published = true;
        const metadata = await openPrivateFile(join(directory, "metadata.json"));
        let object: TransferObject;
        try {
          if ((await metadata.stat()).size > maximumDescriptorBytes) throw new ObjectTransferError("integrity_conflict");
          try { object = JSON.parse(await metadata.readFile("utf8")) as TransferObject; }
          catch { throw new ObjectTransferError("integrity_conflict"); }
        } finally { await metadata.close(); }
        validateTransferObject(object);
        if (object.access !== access) throw new ObjectTransferError("denied");
        if (object.key !== key || (expectedVersion !== undefined && object.version !== expectedVersion)) throw new ObjectTransferError("version_conflict");
        if (object.bytes > maximum) throw new ObjectTransferError("invalid_input");
        body = await openPrivateFile(join(directory, "bytes"));
        if ((await body.stat()).size !== object.bytes) throw new ObjectTransferError("integrity_conflict");
        await body.close();
        body = undefined;
        // Open lazily: descriptor refusal must not leave an unconsumed stream holding a file.
        return { object, body: (async function* () {
          let opened: FileHandle | undefined;
          try {
            await privateDirectory(root, true);
            await privateDirectory(directory);
            opened = await openPrivateFile(join(directory, "bytes"));
            if ((await opened.stat()).size !== object.bytes) throw new ObjectTransferError("integrity_conflict");
            for await (const chunk of opened.createReadStream({ autoClose: false })) yield Buffer.from(chunk);
          }
          catch (error) { throw errno(error) === "ENOENT" ? new ObjectTransferError("integrity_conflict") : filesystemFailure(error); }
          finally { await opened?.close(); }
        })() };
      } catch (error) {
        await body?.close();
        if (published && errno(error) === "ENOENT") throw new ObjectTransferError("integrity_conflict");
        throw filesystemFailure(error);
      }
    },
    async createIfAbsent(object, bytes) {
      let temporary: string | undefined;
      try {
        const encoded = Buffer.from(encodeTransferObject(object));
        if (encoded.byteLength > maximumDescriptorBytes) throw new ObjectTransferError("invalid_input");
        if (object.access !== access) throw new ObjectTransferError("denied");
        const key = object.key;
        if (object.bytes > maximum || bytes.byteLength !== object.bytes
          || createHash("sha256").update(bytes).digest("hex") !== object.sha256) throw new ObjectTransferError("integrity_conflict");
        await privateDirectory(root, true);
        temporary = join(root, `.partial-${randomUUID()}`);
        await mkdir(temporary, { mode: 0o700 });
        await writePrivateFile(join(temporary, "metadata.json"), encoded);
        await writePrivateFile(join(temporary, "bytes"), bytes);
        const directoryHandle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        try {
          // Existing published objects are nonempty directories, so rename cannot replace them.
          // Check also refuses an empty directory or symlink occupying a target key.
          await lstat(location(key));
          throw new ObjectTransferError("version_conflict");
        } catch (error) { if (errno(error) !== "ENOENT") throw error; }
        await rename(temporary, location(key));
        temporary = undefined;
        const rootHandle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await rootHandle.sync(); } finally { await rootHandle.close(); }
      } catch (error) { throw filesystemFailure(error); }
      finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    },
  };
}

async function privateDirectory(path: string, storeRoot = false): Promise<void> {
  const stat = await lstat(path).catch(error => {
    if (storeRoot && errno(error) === "ENOENT") throw new ObjectTransferError("unavailable");
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) {
    throw new ObjectTransferError("denied");
  }
}
async function openPrivateFile(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new ObjectTransferError("denied");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | undefined)?.code; }
function filesystemFailure(error: unknown): ObjectTransferError {
  if (error instanceof ObjectTransferError) return error;
  if (errno(error) === "ENOENT") return new ObjectTransferError("absent");
  if (["EACCES", "EPERM", "ELOOP"].includes(errno(error) ?? "")) return new ObjectTransferError("denied");
  if (["EEXIST", "ENOTEMPTY"].includes(errno(error) ?? "")) return new ObjectTransferError("version_conflict");
  return normalizeObjectTransferError(error);
}
