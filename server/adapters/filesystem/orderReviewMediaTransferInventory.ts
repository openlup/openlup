import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ObjectTransferError, type TransferObject } from "@openlup/platform/portability";
import { createOrderReviewMediaTransferReader } from "./orderReviewMediaTransferReader.js";

/** Observed files, not a DB/object snapshot or a claim about domain access. */
export interface OrderReviewMediaFilesystemCensus {
  objects: TransferObject[];
  temporary: TransferObject[];
}

/**
 * Enumerate both actual application trees, including partial uploads. The host
 * must hold its real writer exclusion for a coherent capture. The caller must
 * reconcile every result against DB refs/leases/cleanup duties; this function
 * never filters orphan, expired, pending or cleanup data into apparent absence.
 */
export async function captureOrderReviewMediaFilesystem(input: {
  root: string;
  maximumObjectBytes: number;
  maximumTotalBytes: number;
  maximumFiles: number;
}): Promise<OrderReviewMediaFilesystemCensus> {
  const { root: sourceRoot, maximumObjectBytes, maximumTotalBytes, maximumFiles } = input;
  if (!isAbsolute(sourceRoot) || !Number.isSafeInteger(maximumTotalBytes)
    || maximumTotalBytes < 1 || maximumTotalBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maximumFiles) || maximumFiles < 1 || maximumFiles > 10000) {
    throw new ObjectTransferError("invalid_input");
  }
  const root = resolve(sourceRoot);
  const readers = {
    objects: createOrderReviewMediaTransferReader({ root, maximumObjectBytes }),
    tmp: createOrderReviewMediaTransferReader({ root, maximumObjectBytes, area: "tmp" }),
  };
  try {
    if (await realpath(dirname(root)) !== dirname(root)) throw new ObjectTransferError("denied");
    await directory(root);
    const top = await directoryEntries(root, 2);
    if (JSON.stringify(top) !== JSON.stringify(["objects", "tmp"])) throw new ObjectTransferError("invalid_input");
    const result: OrderReviewMediaFilesystemCensus = { objects: [], temporary: [] };
    let files = 0, bytes = 0;
    for (const area of ["objects", "tmp"] as const) {
      const before = await names(join(root, area), area, "", maximumFiles, { entries: maximumFiles * 4 + 2 });
      files += before.length;
      if (files > maximumFiles) throw new ObjectTransferError("invalid_input");
      for (const key of before) {
        const read = await readers[area].read(key);
        bytes += read.object.bytes;
        if (!Number.isSafeInteger(bytes) || bytes > maximumTotalBytes) throw new ObjectTransferError("invalid_input");
        (area === "objects" ? result.objects : result.temporary).push(read.object);
      }
      if (JSON.stringify(before) !== JSON.stringify(await names(join(root, area), area, "", maximumFiles, { entries: maximumFiles * 4 + 2 }))) {
        throw new ObjectTransferError("version_conflict");
      }
    }
    if (JSON.stringify(await directoryEntries(root, 2)) !== JSON.stringify(top)) throw new ObjectTransferError("version_conflict");
    return result;
  } catch (error) {
    if (error instanceof ObjectTransferError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(code ?? "")) throw new ObjectTransferError("denied");
    // Missing configured source/area is not a successful empty inventory.
    throw new ObjectTransferError("unavailable");
  }
}

async function names(root: string, area: "objects" | "tmp", prefix: string, maximum: number, budget: { entries: number }): Promise<string[]> {
  const path = prefix ? join(root, prefix) : root;
  await directory(path);
  const result: string[] = [];
  for (const name of await directoryEntries(path, budget.entries)) {
    if (--budget.entries < 0) throw new ObjectTransferError("invalid_input");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new ObjectTransferError("invalid_input");
    const key = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(root, key));
    if (stat.isSymbolicLink()) throw new ObjectTransferError("denied");
    if (stat.isDirectory()) {
      if (area === "tmp" || key.split("/").length >= 4) throw new ObjectTransferError("invalid_input");
      result.push(...await names(root, area, key, maximum - result.length, budget));
    } else if (stat.isFile()) {
      if (area === "tmp" && !/^[a-f0-9]{64}-part$/.test(name)) throw new ObjectTransferError("invalid_input");
      result.push(key);
    } else throw new ObjectTransferError("denied");
    if (result.length > maximum) throw new ObjectTransferError("invalid_input");
  }
  return result;
}

async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || stat.uid !== process.getuid?.()) throw new ObjectTransferError("denied");
}

async function directoryEntries(path: string, maximum: number): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of await opendir(path)) {
    if (entries.length >= maximum) throw new ObjectTransferError("invalid_input");
    entries.push(entry.name);
  }
  return entries.sort();
}
