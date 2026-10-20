import { createAdminBundleHandlers } from "@openlup/platform/catalog";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { bundleSpec, BUNDLE_ACTIVATION_FLAG, BUNDLE_MUTATION_FLAG } from "../../../src/domains/bundle/bundleSpec.js";
import { createAdminMutationHandler } from "../../_lib/admin-domain/handlers.js";
import { BundleRpcError } from "./adminBundleWritePort.js";
export { BUNDLE_ACTIVATION_FLAG, BUNDLE_MUTATION_FLAG };
export const { createAdminBundleCreateDraftHandler, createAdminBundleUpdateDraftHandler, createAdminBundleSetCompositionHandler, createAdminBundleSetTargetPriceHandler, createAdminBundleArchiveHandler, createAdminBundleRestoreHandler, createAdminBundleCloneDraftHandler, createAdminBundleActivateHandler, createAdminBundleDeactivateHandler } = createAdminBundleHandlers({ bundleSpec, BundleRpcError, COMMERCE_CONTRACT_VERSION, createAdminMutationHandler });
export type { AdminBundleHandlerDeps } from "@openlup/platform/catalog";
