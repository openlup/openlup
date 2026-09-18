import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

import {
  createBundleDraftResponseSchema,
  setBundleCompositionResponseSchema,
  setBundleTargetPriceResponseSchema,
  updateBundleDraftResponseSchema,
  type CreateBundleDraftRequest,
  type CreateBundleDraftResponse,
  type SetBundleCompositionRequest,
  type SetBundleCompositionResponse,
  type SetBundleTargetPriceRequest,
  type SetBundleTargetPriceResponse,
  type UpdateBundleDraftRequest,
  type UpdateBundleDraftResponse,
} from "./adminBundleContracts";
import {
  bundleHistoryResponseSchema,
  getBundleResponseSchema,
  listBundlesResponseSchema,
  previewBundlePriceResponseSchema,
  type BundleHistoryRequest,
  type BundleHistoryResponse,
  type GetBundleRequest,
  type GetBundleResponse,
  type ListBundlesRequest,
  type ListBundlesResponse,
  type PreviewBundlePriceRequest,
  type PreviewBundlePriceResponse,
} from "./adminBundleReadContracts";
import {
  activateBundleResponseSchema,
  archiveBundleResponseSchema,
  cloneBundleDraftResponseSchema,
  deactivateBundleResponseSchema,
  restoreBundleResponseSchema,
  type ActivateBundleRequest,
  type ActivateBundleResponse,
  type ArchiveBundleRequest,
  type ArchiveBundleResponse,
  type CloneBundleDraftRequest,
  type CloneBundleDraftResponse,
  type DeactivateBundleRequest,
  type DeactivateBundleResponse,
  type RestoreBundleRequest,
  type RestoreBundleResponse,
} from "./adminBundleLifecycleContracts";

/**
 * Browser -> BFF client for the admin bundle surface — the human head of the
 * agent-operable bundle domain. It speaks the SAME write contracts the MCP agent
 * head uses (one contract, two heads). Bearer-authed admin only.
 *
 * `activateBundle` and `deactivateBundle` are the two calls the agent head does
 * not have: publish-state transitions are human-only, and the agent surface has
 * no route to them at all.
 */
const BUNDLE_BFF_BASE = "/api/bff/admin/commerce/bundles";

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function post<TRequest, TResponse>(
  path: string,
  schema: { parse: (value: unknown) => TResponse },
): (accessToken: string, request: TRequest, options?: BffRequestOptions) => Promise<TResponse> {
  return (accessToken, request, options: BffRequestOptions = {}) =>
    requestBff(`${BUNDLE_BFF_BASE}/${path}`, schema as never, {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: request,
    }) as Promise<TResponse>;
}

export const createBundleDraft = post<CreateBundleDraftRequest, CreateBundleDraftResponse>(
  "create",
  createBundleDraftResponseSchema,
);

export const updateBundleDraft = post<UpdateBundleDraftRequest, UpdateBundleDraftResponse>(
  "update",
  updateBundleDraftResponseSchema,
);

export const setBundleComposition = post<SetBundleCompositionRequest, SetBundleCompositionResponse>(
  "set-composition",
  setBundleCompositionResponseSchema,
);

export const setBundleTargetPrice = post<SetBundleTargetPriceRequest, SetBundleTargetPriceResponse>(
  "set-target-price",
  setBundleTargetPriceResponseSchema,
);

export const archiveBundle = post<ArchiveBundleRequest, ArchiveBundleResponse>(
  "archive",
  archiveBundleResponseSchema,
);

export const restoreBundle = post<RestoreBundleRequest, RestoreBundleResponse>(
  "restore",
  restoreBundleResponseSchema,
);

export const cloneBundleDraft = post<CloneBundleDraftRequest, CloneBundleDraftResponse>(
  "clone-draft",
  cloneBundleDraftResponseSchema,
);

/**
 * Publish a draft bundle (draft -> active). Human-only: the route is gated on the
 * activation flag and the write routine RAISEs for machine actors. This is the
 * button the MCP agent head deliberately does not have.
 */
export const activateBundle = post<ActivateBundleRequest, ActivateBundleResponse>(
  "activate",
  activateBundleResponseSchema,
);

/** Unpublish a live bundle (active -> draft). Human-only, same as activate. */
export const deactivateBundle = post<DeactivateBundleRequest, DeactivateBundleResponse>(
  "deactivate",
  deactivateBundleResponseSchema,
);

/**
 * The READ half. Every bundle read is a GET carrying its parameters in the query
 * string, because the handler factory parses `req.query` and refuses any other
 * method — a read is a pure load, so it has no body, no `mode` and no
 * idempotency key.
 *
 * Optional parameters are DROPPED rather than serialised as "undefined": the
 * request contracts are `.strict()` and apply their own defaults server-side, so
 * sending a key the operator never chose would be this client inventing input.
 */
function get<TRequest extends Record<string, unknown>, TResponse>(
  path: string,
  schema: { parse: (value: unknown) => TResponse },
): (accessToken: string, request: TRequest, options?: BffRequestOptions) => Promise<TResponse> {
  return (accessToken, request, options: BffRequestOptions = {}) => {
    const query = new URLSearchParams(
      Object.entries(request)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => [key, String(value)]),
    ).toString();
    return requestBff(
      `${BUNDLE_BFF_BASE}/${path}${query ? `?${query}` : ""}`,
      schema as never,
      { ...options, method: "GET", headers: authHeaders(accessToken, options) },
    ) as Promise<TResponse>;
  };
}

/** Lifecycle-inclusive list: drafts, live and archived bundles alike. */
export const listBundles = get<ListBundlesRequest, ListBundlesResponse>(
  "list",
  listBundlesResponseSchema,
);

/** Full admin detail for one bundle: composition, price rows, resolved currency. */
export const getBundle = get<GetBundleRequest, GetBundleResponse>("get", getBundleResponseSchema);

/** The operator trail for one bundle. */
export const getBundleHistory = get<BundleHistoryRequest, BundleHistoryResponse>(
  "history",
  bundleHistoryResponseSchema,
);

/**
 * Price a candidate target WITHOUT writing it. The answer is the pricing kernel's
 * allocation over TODAY's component prices, so it moves with the catalogue rather
 * than with the last save — which is exactly why an operator may trust it as a
 * preview of what `setBundleTargetPrice` would commit.
 */
export const previewBundlePrice = get<PreviewBundlePriceRequest, PreviewBundlePriceResponse>(
  "preview-price",
  previewBundlePriceResponseSchema,
);
