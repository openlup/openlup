// Keep the reference application's observed response context at composition.
import { createReferenceCatalogItemsHandler as createHandler, type SellableCatalogPort } from "@openlup/platform/catalog";
import { bffResponder } from "../../_lib/bff/response.js";
export function createReferenceCatalogItemsHandler({ catalogPort }: { catalogPort: SellableCatalogPort }) {
  return createHandler({ catalogPort, responder: bffResponder });
}
