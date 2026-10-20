import { createAdminBundleReadHandlers } from "@openlup/platform/catalog";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { bundleSpec, BUNDLE_READ_FLAG } from "../../../src/domains/bundle/bundleSpec.js";
import { bundleHistoryResponseSchema, getBundleResponseSchema, listBundlesResponseSchema, previewBundlePriceResponseSchema } from "../../../src/domains/bundle/adminBundleReadContracts.js";
import { createAdminParameterizedReadHandler } from "../../_lib/admin-domain/handlers.js";
import { BundleRpcError } from "./adminBundleWritePort.js";
export { BUNDLE_READ_FLAG };
export const { createAdminBundleListHandler, createAdminBundleGetHandler, createAdminBundleHistoryHandler, createAdminBundlePreviewPriceHandler } = createAdminBundleReadHandlers({ bundleSpec, BundleRpcError, COMMERCE_CONTRACT_VERSION, createAdminParameterizedReadHandler, bundleHistoryResponseSchema, getBundleResponseSchema, listBundlesResponseSchema, previewBundlePriceResponseSchema });
export type { AdminBundleReadHandlerDeps } from "@openlup/platform/catalog";
