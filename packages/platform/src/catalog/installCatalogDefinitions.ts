import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogDefinitionInstallReceipt } from "./contracts/definitionInstall.js";
import { catalogDefinitionJson } from "./catalogDefinitionDigest.js";
import { prepareCatalogPackManifest } from "./catalogPackManifest.js";
import { inspectCatalogPack, invalidCatalogPack } from "./productTypeIssues.js";
import { verifyCatalogRulesAtInstall } from "./publicationRules.js";

/** Supply the native migration-owner executor explicitly. No runtime binding or hook is created.
 * @experimental
 */
export async function installCatalogDefinitions(installExecutor: PgQueryExecutor, pack: CatalogPackInput): Promise<CatalogDefinitionInstallReceipt> {
  const { issues, profiles } = inspectCatalogPack(pack);
  if (issues[0]) throw invalidCatalogPack(issues[0]);
  verifyCatalogRulesAtInstall(pack);
  const prepared = prepareCatalogPackManifest(pack, profiles);
  if ("issue" in prepared) throw invalidCatalogPack(prepared.issue);
  if (!Number.isSafeInteger(pack.version) || pack.version < 1 || pack.version > 2147483647
    || pack.types.some(type => !type.validatorRef)
    || new Set(pack.types.map(type => `${type.key}@${type.version}`)).size !== pack.types.length
    || new Set(pack.taxClasses.map(taxClass => taxClass.key)).size !== pack.taxClasses.length) throw new Error("invalid_catalog_pack");
  const { manifest, canonicalManifest, profileDeclarationBytes } = prepared;
  const payload = {
    manifest: canonicalManifest,
    types: pack.types.map(type => ({ canonicalDefinition: catalogDefinitionJson(type) })),
    taxClasses: pack.taxClasses.map(({ key }) => ({ key, label: key })),
    profileDeclarationBytes,
  };
  const { rows } = await installExecutor.query(
    "SELECT public.catalog_definition_install($1::text, $2::integer, $3::jsonb) AS receipt",
    [pack.id, pack.version, JSON.stringify(payload)],
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "22023"
      && error.message === "definition_unknown_profile_ref" && "detail" in error && typeof error.detail === "string") {
      const ref = JSON.parse(error.detail) as { key: string; version: number };
      const index = pack.subscriptionProfiles?.findIndex(({ key, version }) => key === ref.key && version === ref.version) ?? -1;
      if (index >= 0) Object.assign(error, { issue: {
        code: "definition_unknown_profile_ref", path: `/subscriptionProfiles/${index}`, ref,
        fix: `Install or declare ${ref.key}@${ref.version}.`,
      } });
    }
    throw error;
  });
  const receipt = rows[0]?.receipt as CatalogDefinitionInstallReceipt | undefined;
  if (rows.length !== 1 || receipt?.manifestDigest !== manifest.digest) throw new Error("invalid_catalog_install_receipt");
  return receipt;
}
