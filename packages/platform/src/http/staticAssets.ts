// Filesystem reader for a built static site, used by the Node runtime's static branch.

import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";

import { contentTypeFor, type StaticAssetReader } from "./security.js";

const SPA_FALLBACK_DOCUMENT = "spa-fallback.html";

/** Read files below `distDir` (path-traversal safe; null for a missing file or a directory). */
export function createDistStaticReader(distDir: string): StaticAssetReader {
  const root = resolve(distDir);
  const safe = (relative: string): string | null => {
    const full = normalize(join(root, relative));
    return full.startsWith(root) ? full : null;
  };
  return {
    async read(relative) {
      const full = safe(relative);
      if (!full) return null;
      try {
        const info = await stat(full);
        if (!info.isFile()) return null;
        const body = await readFile(full);
        return { body, contentType: contentTypeFor(relative) };
      } catch {
        return null;
      }
    },
    async readIndex() {
      // Prefer the client fallback document; a build without a pre-render step has only
      // index.html, which then serves as the fallback.
      try {
        const body = await readFile(join(root, SPA_FALLBACK_DOCUMENT));
        return { body, contentType: "text/html; charset=utf-8" };
      } catch {
        const body = await readFile(join(root, "index.html"));
        return { body, contentType: "text/html; charset=utf-8" };
      }
    },
  };
}
