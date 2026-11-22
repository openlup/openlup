import { validateCatalogSubscriptionProfile } from "@openlup/core/catalog";
import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogDefinitionInstallReceipt } from "./contracts/definitionInstall.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { catalogSubscriptionProfileIdentity } from "./installedSubscriptionProfiles.js";
/** @experimental */
export interface CatalogPackManifest {
  readonly id: string; readonly namespace: string; readonly version: number; readonly openlupRange: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly types: readonly { readonly key: string; readonly version: number; readonly definitionDigest: string }[];
  readonly taxClasses: readonly string[];
  readonly subscriptionProfiles: readonly { readonly key: string; readonly version: number }[];
  readonly subscriptionProfileDefinitions?: CatalogDefinitionInstallReceipt["subscriptionProfileDefinitions"];
  /** SHA-256 of canonical pack bytes, with a profiles-v1: tag for full profile declarations. */
  readonly digest: string;
}
/** A derived in-memory projection; no manifest or digest is accepted from a client.
 * @experimental
 */
export function catalogPackManifest(pack: CatalogPackInput): CatalogPackManifest {
  const profiles = pack.subscriptionProfileDefinitions?.map(input => {
    const result = validateCatalogSubscriptionProfile(input);
    if ("issue" in result) throw Object.assign(new Error(result.issue.code), result);
    return Object.freeze({ ...result.profile, profileDigest: catalogSubscriptionProfileIdentity(result.profile).profileDigest });
  });
  const projection = {
    id: pack.id, namespace: pack.namespace, version: pack.version, openlupRange: pack.openlupRange,
    capabilities: Object.freeze({ ...pack.capabilities }),
    types: Object.freeze(pack.types.map((definition) => Object.freeze({ key: definition.key, version: definition.version, definitionDigest: catalogDefinitionDigest(definition) }))),
    taxClasses: Object.freeze(pack.taxClasses.map(({ key }) => key)),
    subscriptionProfiles: Object.freeze((pack.subscriptionProfiles ?? []).map((ref) => Object.freeze({ key: ref.key, version: ref.version }))),
    ...(profiles?.length && { subscriptionProfileDefinitions: Object.freeze(profiles) }),
  };
  const hash = createHash("sha256").update(canonicalCatalogDraftJson(projection)).digest("hex");
  return Object.freeze({ ...projection, digest: profiles?.length ? `profiles-v1:${hash}` : hash });
}
