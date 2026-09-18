// This deployment's own shell files, mapped over the platform's neutral ones.
//
// The entry document (`index.html`) is a root file of a publishable surface
// family, so every static path it names must be answerable by a tree that
// contains only publishable files. It therefore names the neutral shell under
// `public/platform/`, which that tree does contain.
//
// A deployment that ships its own icons does NOT edit the entry document. It
// declares the substitution here, and `openlup:app-shell-asset-overlay` in
// `vite.config.ts` applies it to the served document — in the dev server and in
// the build alike — so the transformed output is byte-identical to a document
// that had named the files directly. Nothing copies, renames or deletes a file.
//
// The selected presentation owns concrete identity. Published trees resolve an
// empty map, while this deployment resolves its private overlay.
//
// Keys are the neutral paths as written in the entry document; values are the
// paths this deployment serves instead. A key with no file behind it is inert:
// nothing in the document matches it and nothing is rewritten.

import { APP_SHELL_ASSET_OVERRIDES } from "./appBrand.js";

export { APP_SHELL_ASSET_OVERRIDES };

/** Apply the overrides to a markup document. Order-independent: keys never overlap values. */
export function applyAppShellAssetOverrides(
  markup: string,
  overrides: Readonly<Record<string, string>> = APP_SHELL_ASSET_OVERRIDES,
): string {
  let result = markup;
  for (const [neutral, override] of Object.entries(overrides)) {
    result = result.split(neutral).join(override);
  }
  return result;
}
