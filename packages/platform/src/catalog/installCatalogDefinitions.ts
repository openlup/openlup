import { canonicalCatalogSubscriptionProfileJson } from "@openlup/core/catalog";
import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogDefinitionInstallReceipt } from "./contracts/definitionInstall.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogProfileDeclarationFix } from "./catalogConformance.js";
import { catalogDefinitionJson } from "./catalogDefinitionDigest.js";
import { catalogPackManifest } from "./catalogPackManifest.js";
import { catalogPackIssues } from "./productTypeIssues.js";
import { verifyCatalogRulesAtInstall } from "./publicationRules.js";

/** Supply the native migration-owner executor explicitly. No runtime binding or hook is created.
 * @experimental
 */
export async function installCatalogDefinitions(installExecutor: PgQueryExecutor, pack: CatalogPackInput): Promise<CatalogDefinitionInstallReceipt> {
  const issue = catalogPackIssues(pack)[0];
  if (issue) {
    throw Object.assign(new Error("invalid_catalog_pack"), { issue,
      ...(issue.code === "definition_profile_invalid" && { fix: catalogProfileDeclarationFix(issue.path) }) });
  }
  verifyCatalogRulesAtInstall(pack);
  const manifest = catalogPackManifest(pack);
  if (!Number.isSafeInteger(pack.version) || pack.version < 1 || pack.version > 2147483647
    || pack.types.some(type => !type.validatorRef)
    || new Set(pack.types.map(type => `${type.key}@${type.version}`)).size !== pack.types.length
    || new Set(pack.taxClasses.map(taxClass => taxClass.key)).size !== pack.taxClasses.length) throw new Error("invalid_catalog_pack");
  const { digest: _digest, ...projection } = manifest;
  const payload = {
    manifest: canonicalCatalogDraftJson(projection),
    ...(manifest.subscriptionProfileDefinitions && {
      profileDeclarationBytes: manifest.subscriptionProfileDefinitions.map(({ profileDigest: _digest, ...declaration }) =>
        canonicalCatalogSubscriptionProfileJson(declaration)),
    }),
    types: pack.types.map(type => ({ canonicalDefinition: catalogDefinitionJson(type) })),
    taxClasses: pack.taxClasses.map(({ key }) => ({ key, label: key })),
  };
  const { rows } = await installExecutor.query(
    "SELECT public.catalog_definition_install($1::text, $2::integer, $3::jsonb) AS receipt",
    [pack.id, pack.version, JSON.stringify(payload)],
  );
  const receipt = rows[0]?.receipt as CatalogDefinitionInstallReceipt | undefined;
  if (rows.length !== 1 || receipt?.manifestDigest !== manifest.digest
    || receipt.canonicalManifest !== (manifest.subscriptionProfileDefinitions ? payload.manifest : undefined)
    || canonicalCatalogDraftJson(receipt.subscriptionProfileDefinitions ?? null)
    !== canonicalCatalogDraftJson(manifest.subscriptionProfileDefinitions ?? null)) throw new Error("invalid_catalog_install_receipt");
  return receipt;
}
