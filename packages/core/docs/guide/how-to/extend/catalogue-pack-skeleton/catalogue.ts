// eslint-disable-next-line no-restricted-imports -- copied application example using the installed Platform registry
import { createCatalogProductTypeRegistry } from "@openlup/platform/catalog";
import { pack } from "./pack.ts";
import { fixtures } from "./fixtures.ts";

export const catalogueConformance = {
  packs: [{ pack, ...fixtures }],
  requiredChecks: ["draft-content", "attribute-values", "variant-combinations"],
};

export function createDraftRegistry() {
  return createCatalogProductTypeRegistry(catalogueConformance.packs.flatMap(entry => entry.pack.types));
}
