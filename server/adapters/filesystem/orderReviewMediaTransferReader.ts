import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ObjectTransferError, type TransferObjectReader } from "@openlup/platform/portability";

const maximumMediaBytes = 20 * 1024 * 1024;
const segment = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Read the application's actual order-review objects layout without creating or
 * changing it. The access label describes observed POSIX owner-mode storage,
 * not review grants or effective HTTP access. The host must exclusively control
 * the owner/root account and separately qualify any additional filesystem ACLs.
 *
 * No inventory, database snapshot, temporary-upload recovery or writer seal is
 * established here. A complete export must separately account for every DB row,
 * physical object and pending/tmp/cleanup obligation before using this reader.
 */
export function createOrderReviewMediaTransferReader(options: {
  root: string;
  maximumObjectBytes: number;
  /** The application's final-object tree or reconstructible partial-upload tree. */
  area?: "objects" | "tmp";
}): TransferObjectReader {
  if (!isAbsolute(options.root) || !Number.isSafeInteger(options.maximumObjectBytes)
    || options.maximumObjectBytes < 1 || options.maximumObjectBytes > maximumMediaBytes
    || options.area !== undefined && options.area !== "objects" && options.area !== "tmp") {
    throw new ObjectTransferError("invalid_input");
  }
  const root = resolve(options.root), maximum = options.maximumObjectBytes;
  const area = options.area ?? "objects", objects = join(root, area);
  return {
    async read(key, expectedVersion) {
      const parts = typeof key === "string" ? key.split("/") : [];
      if (parts.length < 1 || parts.length > 4 || parts.some(part => !segment.test(part))
        || area === "tmp" && (parts.length !== 1 || !/^[a-f0-9]{64}-part$/.test(key))
        || expectedVersion !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expectedVersion)) {
        throw new ObjectTransferError("invalid_input");
      }
      try {
        // Match the application's canonical root; do not bootstrap/chmod it.
        await privateDirectory(root, true);
        if (await realpath(dirname(root)) !== dirname(root)) throw new ObjectTransferError("denied");
        await privateDirectory(objects, true);
        let parent = objects;
        for (const part of parts.slice(0, -1)) {
          parent = join(parent, part);
          await privateDirectory(parent);
        }
        const path = join(parent, parts[parts.length - 1]!);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat({ bigint: true });
          if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n
            || before.uid !== BigInt(process.getuid?.() ?? -1)) throw new ObjectTransferError("denied");
          if (before.size > BigInt(maximum)) throw new ObjectTransferError("invalid_input");
          const hash = createHash("sha256"), chunks: Buffer[] = [];
          const buffer = Buffer.alloc(Math.min(64 * 1024, maximum));
          let bytes = 0;
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > maximum) throw new ObjectTransferError("integrity_conflict");
            const chunk = Buffer.from(buffer.subarray(0, bytesRead));
            hash.update(chunk);
            chunks.push(chunk);
          }
          const after = await handle.stat({ bigint: true });
          const leaf = await lstat(path, { bigint: true });
          if (BigInt(bytes) !== before.size || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
            || leaf.dev !== before.dev || leaf.ino !== before.ino || !leaf.isFile()
            || leaf.nlink !== 1n || leaf.mode !== before.mode || leaf.uid !== before.uid
            || leaf.size !== after.size || leaf.mtimeNs !== after.mtimeNs || leaf.ctimeNs !== after.ctimeNs) {
            throw new ObjectTransferError("version_conflict");
          }
          // Recheck all admitted directories after asynchronous byte reads.
          await privateDirectory(root, true);
          parent = objects;
          await privateDirectory(parent, true);
          for (const part of parts.slice(0, -1)) {
            parent = join(parent, part);
            await privateDirectory(parent);
          }
          const sha256 = hash.digest("hex"), version = `sha256:${sha256}`;
          if (expectedVersion !== undefined && expectedVersion !== version) throw new ObjectTransferError("version_conflict");
          return {
            object: { key, version, bytes, sha256, metadata: {}, access: "posix-owner-mode" },
            // Return owned captured bytes, so a later source write cannot alter
            // the already returned stream or its descriptor.
            body: (async function* () { for (const chunk of chunks) yield Buffer.from(chunk); })(),
          };
        } finally { await handle.close(); }
      } catch (error) {
        if (error instanceof ObjectTransferError) throw error;
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") throw new ObjectTransferError("absent");
        if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(code ?? "")) throw new ObjectTransferError("denied");
        throw new ObjectTransferError("unavailable");
      }
    },
  };
}

async function privateDirectory(path: string, storeRoot = false): Promise<void> {
  const stat = await lstat(path).catch(error => {
    if (storeRoot && (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new ObjectTransferError("unavailable");
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || stat.uid !== process.getuid?.()) throw new ObjectTransferError("denied");
}
