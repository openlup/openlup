import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ObjectTransferError, type TransferObject, type TransferObjectRead, type TransferObjectReader,
} from "@openlup/platform/portability";
import { captureOrderReviewMediaFilesystem, type OrderReviewMediaFilesystemCensus } from "./orderReviewMediaTransferInventory.js";

/**
 * Materialize the finite native media profile, including reconstructible partial
 * uploads, into the application's actual objects/tmp layout. The trusted host
 * must keep the fresh target inactive and exclude ALL source/target writers.
 * An existing exact tree permits replay; that equality is not a freshness or
 * ownership certificate. No DB lifecycle, lease, cleanup or access grant changes.
 *
 * Preparation takes place in a private sibling directory. Only a fully verified
 * tree is renamed into the absent target path. A killed preparation can leave a
 * private sibling artifact, never partial bytes inside the runtime directory.
 * Same-owner concurrent writers are outside this held-exclusion profile.
 */
export async function restoreOrderReviewMediaFilesystem(input: {
  root: string;
  census: OrderReviewMediaFilesystemCensus;
  objects: TransferObjectReader;
  temporary: TransferObjectReader;
  maximumObjectBytes: number;
  maximumTotalBytes: number;
  maximumFiles: number;
}): Promise<{ replayed: boolean; objects: number; temporary: number }> {
  const { root: configuredRoot, objects, temporary, maximumObjectBytes, maximumTotalBytes, maximumFiles } = input;
  if (!isAbsolute(configuredRoot) || !Number.isSafeInteger(maximumObjectBytes)
    || maximumObjectBytes < 1 || maximumObjectBytes > 20 * 1024 * 1024
    || !Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 1 || maximumTotalBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maximumFiles) || maximumFiles < 1 || maximumFiles > 10000
    || !input.census || !Array.isArray(input.census.objects) || !Array.isArray(input.census.temporary)) {
    throw new ObjectTransferError("invalid_input");
  }
  // Copy bounded descriptors before the first await; raw runtime layout cannot
  // retain arbitrary provider metadata, lineage or another access classification.
  let bytes = 0;
  const plan: OrderReviewMediaFilesystemCensus = { objects: [], temporary: [] };
  for (const area of ["objects", "temporary"] as const) {
    const keys = new Set<string>();
    if (input.census[area].length + plan.objects.length > maximumFiles) throw new ObjectTransferError("invalid_input");
    for (const value of input.census[area]) {
      const object = descriptor(value);
      const parts = object.key.split("/");
      if (parts.length > 4 || parts.some(part => !/^[A-Za-z0-9_-]{1,128}$/.test(part))
        || area === "temporary" && !/^[a-f0-9]{64}-part$/.test(object.key)
        || object.version !== `sha256:${object.sha256}` || object.access !== "posix-owner-mode"
        || Object.keys(object.metadata).length || object.lineage !== undefined || keys.has(object.key)
        || object.bytes > maximumObjectBytes) throw new ObjectTransferError("invalid_input");
      keys.add(object.key); bytes += object.bytes;
      if (!Number.isSafeInteger(bytes) || bytes > maximumTotalBytes) throw new ObjectTransferError("invalid_input");
      plan[area].push(object);
    }
    // A file cannot also be an ancestor directory of another admitted key.
    for (const key of keys) {
      const segments = key.split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        if (keys.has(segments.slice(0, depth).join("/"))) throw new ObjectTransferError("invalid_input");
      }
    }
    plan[area].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  }
  const root = resolve(configuredRoot), parent = dirname(root);
  const limits = { maximumObjectBytes, maximumTotalBytes, maximumFiles };
  let staging: string | undefined;
  try {
    if (await realpath(parent) !== parent) throw new ObjectTransferError("denied");
    if (await present(root)) {
      await compare(root, plan, limits);
      return { replayed: true, objects: plan.objects.length, temporary: plan.temporary.length };
    }
    staging = await mkdtemp(join(parent, ".openlup-media-transfer-"));
    await mkdir(join(staging, "objects"), { mode: 0o700 });
    await mkdir(join(staging, "tmp"), { mode: 0o700 });
    const directories = new Set([staging, join(staging, "objects"), join(staging, "tmp")]);
    for (const area of ["objects", "temporary"] as const) {
      const reader = area === "objects" ? objects : temporary;
      for (const object of plan[area]) {
        const body = await bytesRead(await reader.read(object.key, object.version), object);
        let directory = join(staging, area === "objects" ? "objects" : "tmp");
        const parts = object.key.split("/");
        for (const part of parts.slice(0, -1)) {
          directory = join(directory, part);
          await mkdir(directory, { mode: 0o700 }).catch(error => { if (errno(error) !== "EEXIST") throw error; });
          directories.add(directory);
        }
        const file = await open(join(directory, parts[parts.length - 1]!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      }
    }
    await compare(staging, plan, limits);
    // Recheck every source version after preparation; the actual held fence is
    // still required to bind this observation to the DB capture and publication.
    for (const area of ["objects", "temporary"] as const) for (const object of plan[area]) {
      await bytesRead(await (area === "objects" ? objects : temporary).read(object.key, object.version), object);
    }
    for (const directory of [...directories].sort((left, right) => right.split("/").length - left.split("/").length)) await syncDirectory(directory);
    if (await present(root)) throw new ObjectTransferError("version_conflict");
    await rename(staging, root); staging = undefined;
    await syncDirectory(parent);
    await compare(root, plan, limits);
    return { replayed: false, objects: plan.objects.length, temporary: plan.temporary.length };
  } catch (error) {
    if (error instanceof ObjectTransferError) throw error;
    if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(errno(error) ?? "")) throw new ObjectTransferError("denied");
    if (["EEXIST", "ENOTEMPTY"].includes(errno(error) ?? "")) throw new ObjectTransferError("version_conflict");
    throw new ObjectTransferError("unavailable");
  } finally {
    // This path was created by this invocation, never an existing runtime tree.
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function compare(root: string, expected: OrderReviewMediaFilesystemCensus, limits: {
  maximumObjectBytes: number; maximumTotalBytes: number; maximumFiles: number;
}): Promise<void> {
  const observed = await captureOrderReviewMediaFilesystem({ root, ...limits });
  for (const area of ["objects", "temporary"] as const) {
    const descriptors = (values: TransferObject[]) => values.map(value => JSON.stringify(descriptor(value))).sort();
    if (JSON.stringify(descriptors(observed[area])) !== JSON.stringify(descriptors(expected[area]))) {
      throw new ObjectTransferError("version_conflict");
    }
  }
}
function descriptor(value: TransferObject): TransferObject {
  if (!value || typeof value.key !== "string" || typeof value.version !== "string"
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 20 * 1024 * 1024
    || value.version !== `sha256:${value.sha256}` || value.access !== "posix-owner-mode"
    || !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)
    || Object.keys(value.metadata).length || value.lineage !== undefined) throw new ObjectTransferError("invalid_input");
  return { key: value.key, version: value.version, bytes: value.bytes, sha256: value.sha256, metadata: {}, access: value.access };
}
async function bytesRead(read: TransferObjectRead, expected: TransferObject): Promise<Buffer> {
  if (JSON.stringify(descriptor(read.object)) !== JSON.stringify(expected)) throw new ObjectTransferError("version_conflict");
  const hash = createHash("sha256"), chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of read.body) {
    if (!(value instanceof Uint8Array)) throw new ObjectTransferError("integrity_conflict");
    bytes += value.byteLength;
    if (bytes > expected.bytes) throw new ObjectTransferError("integrity_conflict");
    const chunk = Buffer.from(value); hash.update(chunk); chunks.push(chunk);
  }
  if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new ObjectTransferError("integrity_conflict");
  return Buffer.concat(chunks, bytes);
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (errno(error) === "ENOENT") return false; throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | undefined)?.code; }
import { createHash } from "node:crypto";
