import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type {
  CatalogHistoryRequest,
  GetCatalogProductRequest,
  ListCatalogProductsRequest,
} from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import {
  catalogHistoryResponseSchema,
  getCatalogProductResponseSchema,
  listCatalogProductsResponseSchema,
} from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import {
  catalogSpec,
  type CatalogQueryKey,
} from "../../../src/domains/commerce/catalogSpec.js";
import type { AgentDomainQuerySpec } from "../../../src/lib/agent-domain/domainSpec.js";
import { createAdminParameterizedReadHandler } from "../../_lib/admin-domain/handlers.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import type {
  AdminCatalogReadDataPort,
  CatalogHistoryResult,
  ListCatalogProductsResult,
} from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import type { CatalogProductDetail } from "../../../src/domains/commerce/adminCatalogReadContracts.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain READ handlers.
 *
 * Each handler is the generic kit factory `createAdminParameterizedReadHandler`
 * driven by one query of `catalogSpec.queries`. The factory owns the shared spine
 * (GET-only, admin authz, actor-kind gate, query parse, error map, response
 * validation, success envelope); this module only injects the read-port call and
 * the catalog read response shape. Catalog reads are unconditional since
 * release-gates-w7 (the launch read flag was deleted); the factory's optional
 * gate is simply omitted. Mirrors `adminCatalogHandler.ts`. */

const CATALOG_READ_INVALID = "Invalid catalog read request";
const CATALOG_READ_FAILURE = "Catalog read failed";

export interface AdminCatalogReadHandlerDeps {
  dataPort: AdminCatalogReadDataPort;
  authorizeAdmin: AuthorizeAdmin;
}

function query<TReq>(key: CatalogQueryKey): AgentDomainQuerySpec<TReq> {
  const spec = catalogSpec.queries?.[key];
  if (!spec) throw new Error(`catalogSpec.queries.${key} is not defined`);
  return spec as AgentDomainQuerySpec<TReq>;
}

export function createAdminCatalogListHandler(deps: AdminCatalogReadHandlerDeps) {
  return createAdminParameterizedReadHandler<ListCatalogProductsRequest, ListCatalogProductsResult>({
    query: query<ListCatalogProductsRequest>("list"),
    authorizeAdmin: deps.authorizeAdmin,
    load: (_actorId, input) => deps.dataPort.list(input),
    toResponse: (data) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      products: data.products,
      total: data.total,
    }),
    responseSchema: listCatalogProductsResponseSchema,
    invalidRequestMessage: CATALOG_READ_INVALID,
    invalidResponseMessage: "Invalid catalog list response",
    failureMessage: CATALOG_READ_FAILURE,
  });
}

export function createAdminCatalogGetHandler(deps: AdminCatalogReadHandlerDeps) {
  return createAdminParameterizedReadHandler<GetCatalogProductRequest, CatalogProductDetail>({
    query: query<GetCatalogProductRequest>("get"),
    authorizeAdmin: deps.authorizeAdmin,
    load: (_actorId, input) => deps.dataPort.get(input.slug),
    toResponse: (product) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, product }),
    responseSchema: getCatalogProductResponseSchema,
    invalidRequestMessage: CATALOG_READ_INVALID,
    invalidResponseMessage: "Invalid catalog detail response",
    failureMessage: CATALOG_READ_FAILURE,
  });
}

export function createAdminCatalogHistoryHandler(deps: AdminCatalogReadHandlerDeps) {
  return createAdminParameterizedReadHandler<CatalogHistoryRequest, CatalogHistoryResult>({
    query: query<CatalogHistoryRequest>("history"),
    authorizeAdmin: deps.authorizeAdmin,
    load: (_actorId, input) => deps.dataPort.history(input),
    toResponse: (data) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      events: data.events,
      total: data.total,
    }),
    responseSchema: catalogHistoryResponseSchema,
    invalidRequestMessage: CATALOG_READ_INVALID,
    invalidResponseMessage: "Invalid catalog history response",
    failureMessage: CATALOG_READ_FAILURE,
  });
}
