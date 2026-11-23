import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogDefinitionInstallReceipt } from "./contracts/definitionInstall.js";
import type { CatalogDefinitionIssue } from "./contracts/catalogConformance.js";
import { catalogDefinitionJson } from "./catalogDefinitionDigest.js";
import { prepareCatalogPackManifest } from "./catalogPackManifest.js";
import { inspectCatalogPack, invalidCatalogPack } from "./productTypeIssues.js";
import { CatalogDefinitionInstallError, verifyCatalogRulesAtInstall } from "./publicationRules.js";

export { CatalogDefinitionInstallError } from "./publicationRules.js";

const retry = "Retry the installation.";
type ProfileRef = NonNullable<CatalogPackInput["subscriptionProfiles"]>[number];

function sqlRefusal(error: unknown, refs: readonly ProfileRef[]): CatalogDefinitionInstallError | undefined {
  if (!(error instanceof Error) || !("code" in error)) return;
  const { code, message } = error;
  if (code === "23505" && message === "catalog_definition_install_conflict") {
    return new CatalogDefinitionInstallError(message, "/version",
      "The installed pack version has a different manifest.", "An installed pack identity is immutable.",
      "Restore the installed declaration and matching rules. For an intentional change, issue a new pack version and new versions for changed types or profiles, and update their references.", retry);
  }
  if (code === "22023" && message === "catalog_profile_install_manifest_mismatch") {
    return new CatalogDefinitionInstallError("catalog_definition_install_conflict", "/subscriptionProfileDefinitions",
      "The submitted subscription profile manifest or its stored integrity evidence is inconsistent.",
      "The installation could not verify the submitted or stored subscription profile manifest.",
      "Verify the qualified package and schema pair. Correct the mismatch, then retry the unchanged declaration.", retry);
  }
  if (code === "23505" && message === "catalog_type_install_refuses_redefinition") {
    return new CatalogDefinitionInstallError(message, "/types", "The pack attempts to change an installed type version.",
      "An installed type version is immutable across packs.",
      "Restore the installed type definition, or issue a new type version and update referencing declarations and the pack version as needed.", retry);
  }
  if (code === "23505" && message === "catalog_profile_install_refuses_redefinition") {
    return new CatalogDefinitionInstallError(message, "/subscriptionProfileDefinitions", "The pack attempts to change an installed profile version.",
      "An installed profile version is immutable across packs.",
      "Restore the installed profile definition, or issue a new profile version and update referencing declarations and the pack version as needed.", retry);
  }
  if (code !== "22023" || message !== "definition_unknown_profile_ref" || !("detail" in error) || typeof error.detail !== "string") return;
  let ref: Partial<ProfileRef> | null;
  try { ref = JSON.parse(error.detail) as Partial<ProfileRef> | null; }
  catch { return; }
  if (!ref || Object.keys(ref).length !== 2 || typeof ref.key !== "string" || !Number.isInteger(ref.version)) return;
  const index = refs.findIndex(({ key, version }) => key === ref.key && version === ref.version);
  if (index < 0) return;
  const { key, version } = refs[index]!;
  return new CatalogDefinitionInstallError(message, `/subscriptionProfiles/${index}`,
    `The declared profile reference ${key}@${version} is missing from the installed profile receipts.`,
    "The exact profile version is absent from installed profile receipts.",
    "Declare the referenced profile version in its owning pack and install that pack before the consumer, or reference an already installed compatible version.", retry);
}

function inspectInstall(pack: CatalogPackInput) {
  const { issues, profiles } = inspectCatalogPack(pack);
  if (issues.length) return { issues };
  const prepared = prepareCatalogPackManifest(pack, profiles, true);
  if ("issue" in prepared) return { issues: [prepared.issue] };
  pack.types.forEach(({ validatorRef }, index) => {
    if (!validatorRef) issues.push({ code: "definition_validator_ref_invalid", path: `/types/${index}/validatorRef` });
  });
  const taxKeys = new Set<string>();
  pack.taxClasses.forEach(({ key }, index) => {
    if (taxKeys.has(key)) issues.push({ code: "definition_duplicate_identity", path: `/taxClasses/${index}/key` });
    taxKeys.add(key);
  });
  return { issues, prepared };
}

/** Check a bound declaration before invoking the definition installer.
 * @experimental
 */
export function catalogPackInstallIssues(pack: CatalogPackInput): CatalogDefinitionIssue[] {
  return inspectInstall(pack).issues;
}

/** Supply the native migration-owner executor explicitly. No runtime binding or hook is created.
 * @experimental
 */
export async function installCatalogDefinitions(installExecutor: PgQueryExecutor, pack: CatalogPackInput): Promise<CatalogDefinitionInstallReceipt> {
  const issues = catalogPackInstallIssues(pack);
  if (issues[0]) throw invalidCatalogPack(issues[0]);
  verifyCatalogRulesAtInstall(pack, true);
  const { manifest, canonicalManifest, profileDeclarationBytes } = inspectInstall(pack).prepared!;
  const payload = {
    manifest: canonicalManifest,
    types: pack.types.map(type => ({ canonicalDefinition: catalogDefinitionJson(type) })),
    taxClasses: pack.taxClasses.map(({ key }) => ({ key, label: key })),
    profileDeclarationBytes,
  };
  const { rows } = await installExecutor.query(
    "SELECT public.catalog_definition_install($1::text, $2::integer, $3::jsonb) AS receipt",
    [pack.id, pack.version, JSON.stringify(payload)],
  ).catch((error: unknown) => { throw sqlRefusal(error, manifest.subscriptionProfiles) ?? error; });
  const receipt = rows[0]?.receipt as CatalogDefinitionInstallReceipt | undefined;
  if (rows.length !== 1 || receipt?.manifestDigest !== manifest.digest) throw new Error("invalid_catalog_install_receipt");
  return receipt;
}
