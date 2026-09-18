// Filesystem adapter for the platform-runtime BlobStoragePort (Platform Portability, W5).
//
// Stores blobs as plain files under a root directory and serves them through a configurable
// public base URL (e.g. a static file server / nginx in a self-hosted node-postgres bundle).
// This is the credential-free adapter the per-adapter contract test runs against in CI.

import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BlobStoragePort } from "../../../src/domains/platform-runtime/ports.js";

export interface FilesystemBlobOptions {
  /** Absolute root directory blobs are written under. */
  root: string;
  /** Base URL prefix for urlFor()/upload() result URLs. No trailing slash required. */
  baseUrl: string;
}

export function createFilesystemBlobStorage(options: FilesystemBlobOptions): BlobStoragePort {
  const root = resolve(options.root);
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  const pathFor = (key: string): string => {
    const target = resolve(root, normalizeKey(key));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`filesystem_blob_key_escapes_root:${key}`);
    }
    return target;
  };

  return {
    urlFor(key: string): string {
      return `${baseUrl}/${normalizeKey(key)}`;
    },

    async upload(key, data, _opts) {
      const filePath = pathFor(key);
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
      return { url: this.urlFor(key), pathname: normalizeKey(key) };
    },

    async exists(key) {
      try {
        await fs.access(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },

    async delete(keyOrUrl) {
      const key = stripBaseUrl(keyOrUrl, baseUrl);
      await fs.rm(pathFor(key), { force: true });
    },

    async list(prefix) {
      const dir = prefix ? pathFor(prefix) : root;
      const keys = await walk(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      return {
        keys: keys.map((absolute) => relative(root, absolute).split(sep).join("/")).sort(),
      };
    },
  };
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, "");
}

function stripBaseUrl(keyOrUrl: string, baseUrl: string): string {
  return keyOrUrl.startsWith(`${baseUrl}/`) ? keyOrUrl.slice(baseUrl.length + 1) : keyOrUrl;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}
