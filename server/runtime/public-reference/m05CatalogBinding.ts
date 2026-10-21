import { createCatalogContribution } from "@openlup/platform/composition";
import { createCatalogDraftHandler, createPostgresCatalogDraftStore, createPostgresCatalogSkuEnvelopeReadPort, createPostgresBundleCatalogStore, type BundleStockPort, type CatalogProductTypeRegistry } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { readBearerToken, type AdminAuthBinding } from "@openlup/platform/identity";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createPostgresCommercePriceAuthorityPort } from "../../adapters/postgres/pricingResolver.js";
import { createPostgresBundleAdminWriteStore } from "../../adapters/postgres/bundleAdminWriteStore.js";
import type { PostgresDataGatewayEnv, PostgresDataGatewayOptions } from "../../adapters/postgres/dataGateway.js";
import { createAdminBundleCreateDraftHandler, createAdminBundleSetCompositionHandler, createAdminBundleSetTargetPriceHandler, createAdminBundleActivateHandler, createAdminBundleDeactivateHandler, createAdminBundleArchiveHandler, createAdminBundleRestoreHandler } from "../../domains/bundle/adminBundleHandler.js";
import { createAdminBundleListHandler, createAdminBundleGetHandler, createAdminBundleHistoryHandler, createAdminBundlePreviewPriceHandler } from "../../domains/bundle/adminBundleReadHandler.js";
import { createBundleAvailabilityService } from "../../domains/bundle/bundleAvailabilityService.js";
import { createSellableBundleHandler } from "../../domains/bundle/sellableBundleHandler.js";
import { m05CatalogSchema, M05_CATALOG_CAPABILITIES, M05_UNSUPPORTED_CAPABILITIES } from "./m05CatalogSchema.js";

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void>;
/** Explicit native selection only. No environment discovery, default registration or activation. */
export function createM05CatalogBinding(input: {
  executor: PgQueryExecutor;
  data: PostgresDataGatewayEnv;
  dataOptions?: PostgresDataGatewayOptions;
  auth: AdminAuthBinding;
  stock: BundleStockPort;
  registry: CatalogProductTypeRegistry;
  version: string;
  catalogue: { version: string; migration: string };
  quote: (...args: never[]) => unknown;
  offer: (...args: never[]) => unknown;
  applyPromotions: (...args: never[]) => unknown;
  flags?: { read?: boolean; mutations?: boolean; activation?: boolean };
}) {
  if (!input.executor || typeof input.executor.query !== "function") throw new Error("m05_catalog_store_required");
  if (!input.stock || typeof input.stock.getAvailability !== "function") throw new Error("m05_catalog_stock_required");
  if (!input.auth || typeof input.auth.run !== "function") throw new Error("m05_catalog_authorization_required");
  for (const callback of [input.quote, input.offer, input.applyPromotions]) if (typeof callback !== "function") throw new Error("m05_catalog_callback_required");
  const catalog = createPostgresCatalogSkuEnvelopeReadPort(input.executor);
  const draftStore = createPostgresCatalogDraftStore(input.executor);
  const priceAuthority = createPostgresCommercePriceAuthorityPort(input.executor);
  const bundleRead = createPostgresBundleCatalogStore(input.executor);
  const bundleWrite = createPostgresBundleAdminWriteStore(input.data, input.dataOptions);
  const availabilityService = createBundleAvailabilityService({ bundleCatalogReadPort: bundleRead, offerAvailabilityPort: input.stock });
  const authorize = (req: HttpRequest) => {
    const token = readBearerToken(req);
    return input.auth.run(token, auth => auth.authorize(token, { allowedRoles: ["admin"] }));
  };
  const drafts = createCatalogDraftHandler({ store: draftStore, registry: input.registry,
    authorizeOperator: async (req: HttpRequest) => {
      const actor = await authorize(req);
      return actor.ok ? { actorId: actor.principalId } : null;
    },
  });
  const writeFactories = {
    create: createAdminBundleCreateDraftHandler, setComposition: createAdminBundleSetCompositionHandler,
    setTargetPrice: createAdminBundleSetTargetPriceHandler, activate: createAdminBundleActivateHandler,
    deactivate: createAdminBundleDeactivateHandler, archive: createAdminBundleArchiveHandler, restore: createAdminBundleRestoreHandler,
  };
  const handlers: Record<string, Handler> = {};
  const authFor = (req: HttpRequest) => async () => {
    const actor = await authorize(req);
    return actor.ok ? { ok: true as const, userId: actor.principalId, role: actor.role, isMachineActor: actor.isMachineActor } : actor;
  };
  for (const [name, factory] of Object.entries(writeFactories)) handlers[`/api/bff/admin/commerce/bundles/${name}`] = (req, res) => factory({
    writePort: bundleWrite, authorizeAdmin: authFor(req), mutationsEnabled: input.flags?.mutations === true, activationEnabled: input.flags?.activation === true,
  })(req, res);
  for (const [name, factory] of Object.entries({ list: createAdminBundleListHandler, get: createAdminBundleGetHandler, history: createAdminBundleHistoryHandler, previewPrice: createAdminBundlePreviewPriceHandler })) handlers[`/api/bff/admin/commerce/bundles/${name}`] = (req, res) => factory({
    readPort: bundleRead, availabilityService, authorizeAdmin: authFor(req), readsEnabled: input.flags?.read === true,
  })(req, res);
  handlers["/api/bff/catalog/bundles"] = createSellableBundleHandler({ availabilityService, enabled: input.flags?.read === true });
  const contribution = createCatalogContribution({ version: input.version, requiredSchema: m05CatalogSchema(input.catalogue),
    catalog: { read: catalog.getSkuEnvelope, draftApply: draftStore.apply, draftRead: draftStore.get, bundleRead: bundleRead.getBundle, bundleWrite: bundleWrite.setComposition, stock: input.stock.getAvailability, authorize: input.auth.run },
    pricing: { authority: priceAuthority.resolvePrice, quote: input.quote, offer: input.offer },
    promotions: { apply: input.applyPromotions },
    routes: Object.entries(handlers).map(([id, handle]) => ({ id, handle })),
  });
  return { catalog, draftStore, drafts, priceAuthority, bundleRead, bundleWrite, availabilityService, handlers,
    quote: input.quote, offer: input.offer, capabilities: M05_CATALOG_CAPABILITIES, unsupported: M05_UNSUPPORTED_CAPABILITIES,
    ...contribution, close: () => bundleWrite.close(),
  };
}
export type M05CatalogBinding = ReturnType<typeof createM05CatalogBinding>;
