import type { CatalogConformanceSubject } from "@openlup/platform/catalog/testing";
import { pack } from "./pack.ts";
import { drafts } from "./catalogue.ts";

export const subject = { pack, drafts } satisfies CatalogConformanceSubject["packs"][number];
