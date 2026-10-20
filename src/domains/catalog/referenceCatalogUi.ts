import type { SellableCatalogItem, SellableCatalogProfile } from "./contracts.js";
import type { CatalogPublicationReadResult } from "@openlup/platform/catalog/contracts";
import type { ReferenceBuilderBindings } from "../../checkout/composer/referenceBuilderModel.js";
import type { StorefrontSsgMedia } from "./storefrontSsgCatalog.js";

/** Reference application inputs, supplied before SSR and reused for hydration. */
export interface ReferenceCatalogProduct {
  item: SellableCatalogItem;
  path: string;
  description: string;
  media?: readonly StorefrontSsgMedia[];
  details?: readonly { heading: string; body: string }[];
}

export interface ReferenceCatalogSnapshot {
  profile: SellableCatalogProfile;
  catalogPath: string;
  builderPath: string;
  products: readonly ReferenceCatalogProduct[];
  copy: {
    catalog: string;
    builder: string;
    quantity: string;
    mode: string;
    oneTime: string;
    subscription: string;
    quote: string;
    consent: string;
    secondDelivery: string;
    continue: string;
    refused: string;
  };
  lifecycle?: CatalogPublicationReadResult;
}

/** No locale guessing or global data lookup; routes are exact supplied links. */
export interface ReferenceCatalogUi {
  snapshots: readonly ReferenceCatalogSnapshot[];
  builder?: ReferenceBuilderBindings;
}
