import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogDefinitionInstallReceipt } from "./contracts/definitionInstall.js";
import { catalogDefinitionJson } from "./catalogDefinitionDigest.js";
import { prepareCatalogPackManifest } from "./catalogPackManifest.js";
import { inspectCatalogPack, invalidCatalogPack } from "./productTypeIssues.js";
import { verifyCatalogRulesAtInstall } from "./publicationRules.js";

const replayFix = "Replay the original declaration bytes, digest and identity together. Issue a new version for an intentional change.";
const sqlInstallFixes = new Map([
  ["25000:catalog_profile_install_requires_read_committed", "Retry in a READ COMMITTED transaction."],
  ["23505:catalog_profile_install_refuses_redefinition", replayFix],
  ["22023:catalog_profile_install_manifest_mismatch", replayFix],
  ["23505:catalog_type_install_refuses_redefinition", replayFix],
  ["23505:catalog_definition_install_conflict", replayFix],
]);

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
    if (profiles === undefined) throw error;
    if (error instanceof Error && "code" in error && error.code === "22023"
      && error.message === "definition_unknown_profile_ref" && "detail" in error && typeof error.detail === "string") {
      const ref = JSON.parse(error.detail) as { key: string; version: number };
      const index = manifest.subscriptionProfiles.findIndex(({ key, version }) => key === ref.key && version === ref.version);
      if (index >= 0) Object.assign(error, { issue: {
        code: "definition_unknown_profile_ref", path: `/subscriptionProfiles/${index}`, ref,
        fix: `Install or declare ${ref.key}@${ref.version}.`,
      } });
    } else if (error instanceof Error && "code" in error && typeof error.code === "string") {
      const fix = sqlInstallFixes.get(`${error.code}:${error.message}`);
      if (fix) Object.assign(error, { issue: { code: error.message, path: "", fix } });
    }
    throw error;
  });
  const receipt = rows[0]?.receipt as CatalogDefinitionInstallReceipt | undefined;
  if (rows.length !== 1 || receipt?.manifestDigest !== manifest.digest) throw new Error("invalid_catalog_install_receipt");
  return receipt;
}
