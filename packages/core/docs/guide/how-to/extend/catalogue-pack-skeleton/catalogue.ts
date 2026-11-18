import { createCatalogProductTypeRegistry } from "@openlup/platform/catalog";
import type { CatalogConformanceSource } from "@openlup/platform/catalog/testing";
import { fixtures } from "./fixtures.ts";
import { pack } from "./pack.ts";

// Add one entry per pack. Compose runtime readers from these same packs.
export const catalogueConformance = {
  packs: [{ pack, ...fixtures }],
  requiredChecks: ["quantities", "attribute-values", "variant-combinations", "draft-content", "profiles", "owner-refusals"],
} satisfies CatalogConformanceSource;

export const catalogDraftRegistry = createCatalogProductTypeRegistry(catalogueConformance.packs.flatMap(({ pack }) => pack.types));
