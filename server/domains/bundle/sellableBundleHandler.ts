import { createSellableBundleHandlers } from "@openlup/platform/catalog";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { SELLABLE_BUNDLE_CONTRACT_VERSION, sellableBundleListResponseSchema } from "../../../src/domains/bundle/sellableBundleContracts.js";
export const { createSellableBundleHandler } = createSellableBundleHandlers({ responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, sellableBundleListResponseSchema, SELLABLE_BUNDLE_CONTRACT_VERSION });
export { toSellableBundle } from "@openlup/platform/catalog";
export type { SellableBundleHandlerDeps } from "@openlup/platform/catalog";
