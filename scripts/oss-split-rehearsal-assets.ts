// The asset stage of the split rehearsal: the edge class the compiler is structurally blind to.
//
// `src/vite-env.d.ts` pulls in `vite/client`, which declares `module "*.png"` and its siblings, so
// TypeScript resolves an image import WHETHER OR NOT the file exists. Every asset edge a published
// tree would lose therefore passes the module stage in silence. That is why assertion 5 of the
// sizing document needs two falsifiers rather than one.
//
// METHOD, and why it is not the bundler. The flag this stage stands behind was declared inert with
// a stated reason: run the bundler on the published tree and it aborts on the first unresolved lazy
// import in the entry module, reporting zero asset edges. That reason still holds - the module stage
// measures unresolved pairs in three figures - and it is not a temporary one either: the bundler
// reports the FIRST failure, so it can never enumerate a class of debt that sits behind another
// class. This stage therefore resolves asset specifiers directly against the same shadow partition
// the module stage uses. No bundler, no build, no abort, and the measurement is available now
// instead of after the module debt is paid.
//
// The stage measures the same thing the bundler would have: a specifier, written in a file the
// published tree KEEPS, naming a file the published tree DOES NOT CONTAIN.

import { posix } from "node:path";

/** Extensions the bundler treats as assets rather than modules. Kept narrow on purpose. */
export const ASSET_EXTENSIONS = [
  ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".mp3", ".mp4", ".png", ".svg", ".webm", ".webp", ".woff", ".woff2",
] as const;

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bnew\s+URL\s*\(\s*["']([^"']+)["']/g,
];

export const isAssetSpecifier = (specifier: string): boolean => {
  const withoutQuery = specifier.replace(/[?#].*$/, "");
  return ASSET_EXTENSIONS.some((extension) => withoutQuery.toLowerCase().endsWith(extension));
};

/** Repository-relative target of an asset specifier, or null when it names no path in this tree. */
export function assetTarget(importer: string, specifier: string): string | null {
  const path = specifier.replace(/[?#].*$/, "");
  if (path.startsWith("@/")) return `src/${path.slice(2)}`;
  if (path.startsWith("/")) return `public${path}`;
  if (!path.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(importer), path));
}

export type AssetEdges = { pairs: string[]; specifiers: number };

/**
 * Asset edges a published tree would lose, measured over the files it keeps.
 *
 * `read` returns the text of a kept file; `contains` answers whether the published tree carries a
 * given repository path. Both are injected so this is testable without a tree on disk.
 */
export function assetEdges(kept: string[], read: (path: string) => string, contains: (path: string) => boolean): AssetEdges {
  const pairs = new Set<string>();
  let specifiers = 0;
  for (const importer of kept) {
    if (!/\.(?:[cm]?[jt]sx?|html)$/.test(importer)) continue;
    const text = read(importer);
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const [, specifier] of text.matchAll(pattern)) {
        if (!isAssetSpecifier(specifier)) continue;
        specifiers += 1;
        const target = assetTarget(importer, specifier);
        if (target !== null && !contains(target)) pairs.add(`${importer} -> ${target}`);
      }
    }
  }
  // An extraction that finds nothing reads exactly like a tree with no asset debt, which is how a
  // stage goes green while measuring nothing. It is fatal instead.
  if (specifiers === 0) throw new Error("the asset stage found no asset specifier at all in the kept tree; the extraction is dead");
  return { pairs: [...pairs].sort(), specifiers };
}
