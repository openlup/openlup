import { createHash } from "node:crypto";
import { canonicalCatalogSubscriptionProfileJson, type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogDefinitionIssue } from "./contracts/catalogConformance.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { inspectCatalogPack, invalidCatalogPack } from "./productTypeIssues.js";
/** @experimental */
export interface CatalogPackManifest {
  readonly id: string; readonly namespace: string; readonly version: number; readonly openlupRange: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly types: readonly { readonly key: string; readonly version: number; readonly definitionDigest: string }[];
  readonly taxClasses: readonly string[];
  readonly subscriptionProfiles: readonly { readonly key: string; readonly version: number }[];
  readonly subscriptionProfileDefinitions?: readonly (CatalogSubscriptionProfileV1 & { readonly profileDigest: string })[];
  readonly digest: string;
}
/** A derived in-memory projection; no manifest or digest is accepted from a client.
 * @experimental
 */
export function catalogPackManifest(pack: CatalogPackInput): CatalogPackManifest {
  const { issues, profiles } = Object.hasOwn(pack, "subscriptionProfileDefinitions")
    ? inspectCatalogPack(pack) : { issues: [], profiles: undefined };
  if (issues[0]) throw invalidCatalogPack(issues[0]);
  const prepared = prepareCatalogPackManifest(pack, profiles);
  if ("issue" in prepared) throw invalidCatalogPack(prepared.issue);
  return prepared.manifest;
}

/** @internal */
export function prepareCatalogPackManifest(pack: CatalogPackInput, profiles: readonly CatalogSubscriptionProfileV1[] | undefined, reportLegacySize = false):
  { manifest: CatalogPackManifest; canonicalManifest: string; profileDeclarationBytes?: string[] } | { issue: CatalogDefinitionIssue } {
  const declarations = profiles?.map(profile => {
    const bytes = canonicalCatalogSubscriptionProfileJson(profile);
    return { bytes, definition: Object.freeze({ ...profile, profileDigest: createHash("sha256").update(bytes).digest("hex") }) };
  });
  const projection = {
    id: pack.id, namespace: pack.namespace, version: pack.version, openlupRange: pack.openlupRange,
    capabilities: Object.freeze({ ...pack.capabilities }),
    types: Object.freeze(pack.types.map((definition) => Object.freeze({ key: definition.key, version: definition.version, definitionDigest: catalogDefinitionDigest(definition) }))),
    taxClasses: Object.freeze(pack.taxClasses.map(({ key }) => key)),
    subscriptionProfiles: Object.freeze((pack.subscriptionProfiles ?? []).map((ref) => Object.freeze({ key: ref.key, version: ref.version }))),
    ...(declarations === undefined ? {} : { subscriptionProfileDefinitions: Object.freeze(declarations.map(({ definition }) => definition)) }),
  };
  let canonicalManifest: string;
  try {
    canonicalManifest = canonicalCatalogDraftJson(projection);
  } catch (error) {
    if (profiles === undefined && !reportLegacySize || !(error instanceof Error) || error.message !== "draft_payload_too_large") throw error;
    return { issue: { code: "draft_payload_too_large", path: "", fix: profiles === undefined ? "Split the catalogue definitions across packs." : "Split the profile declarations across pack versions or packs." } };
  }
  const digest = createHash("sha256").update(canonicalManifest).digest("hex");
  return { manifest: Object.freeze({ ...projection, digest }), canonicalManifest, profileDeclarationBytes: declarations?.map(({ bytes }) => bytes) };
}
