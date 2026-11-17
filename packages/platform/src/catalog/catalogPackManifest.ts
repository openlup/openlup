import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
/** @experimental */
export interface CatalogPackManifest {
  readonly id: string; readonly namespace: string; readonly version: number; readonly openlupRange: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly types: readonly { readonly key: string; readonly version: number; readonly definitionDigest: string }[];
  readonly taxClasses: readonly string[];
  readonly subscriptionProfiles: readonly { readonly key: string; readonly version: number }[];
  readonly digest: string;
}
/** A derived in-memory projection; no manifest or digest is accepted from a client.
 * @experimental
 */
export function catalogPackManifest(pack: CatalogPackInput): CatalogPackManifest {
  const projection = {
    id: pack.id, namespace: pack.namespace, version: pack.version, openlupRange: pack.openlupRange,
    capabilities: Object.freeze({ ...pack.capabilities }),
    types: Object.freeze(pack.types.map((definition) => Object.freeze({ key: definition.key, version: definition.version, definitionDigest: catalogDefinitionDigest(definition) }))),
    taxClasses: Object.freeze(pack.taxClasses.map(({ key }) => key)),
    subscriptionProfiles: Object.freeze((pack.subscriptionProfiles ?? []).map((ref) => Object.freeze({ key: ref.key, version: ref.version }))),
  };
  return Object.freeze({ ...projection, digest: createHash("sha256").update(canonicalCatalogDraftJson(projection)).digest("hex") });
}
