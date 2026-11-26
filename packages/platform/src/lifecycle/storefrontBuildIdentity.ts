import type { StorefrontVerdict } from "./storefrontVerdict.js";

// Internal: for the platform's own readers; not exported from the lifecycle entry.

type BuildIdentity = StorefrontVerdict["build"];

function members(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = members(a), right = members(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Two build identities are equal when the package set (`name`, `version`,
 * `integrity`), the client digests (`name`, `digest`) and `proofFile` are equal.
 * A package with `integrity` never equals one without; `source` is ignored.
 */
export function sameStorefrontBuild(a: BuildIdentity, b: BuildIdentity): boolean {
  const pkg = (item: BuildIdentity["packages"][number]) => JSON.stringify([item.name, item.version, item.integrity === undefined ? null : item.integrity]);
  const client = (item: BuildIdentity["clients"][number]) => JSON.stringify([item.name, item.digest]);
  return a.proofFile === b.proofFile
    && sameMembers(a.packages.map(pkg), b.packages.map(pkg))
    && sameMembers(a.clients.map(client), b.clients.map(client));
}
