import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import type { z } from "zod";

import {
  promotionCodeCreateResponseSchema,
  promotionCodePreviewResponseSchema,
  promotionCodesListResponseSchema,
  promotionCodeUpdateResponseSchema,
  type PromotionCodeCreateRequest,
  type PromotionCodeCreateResponse,
  type PromotionCodePreviewRequest,
  type PromotionCodePreviewResponse,
  type PromotionCodesListRequest,
  type PromotionCodesListResponse,
  type PromotionCodeUpdateRequest,
  type PromotionCodeUpdateResponse,
} from "./adminPromotionCodesContracts";

const basePath = "/api/bff/admin/commerce/promotion-codes";

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

export function getAdminPromotionCodes(
  accessToken: string,
  request: PromotionCodesListRequest,
  options: BffRequestOptions = {},
): Promise<PromotionCodesListResponse> {
  const query = new URLSearchParams();
  if (request.q) query.set("q", request.q);
  query.set("status", request.status);
  query.set("scope", request.scope);
  if (request.cursor) query.set("cursor", request.cursor);
  query.set("limit", String(request.limit));

  return requestBff(`${basePath}/list?${query}`, promotionCodesListResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function previewAdminPromotionCode(
  accessToken: string,
  request: PromotionCodePreviewRequest,
  options: BffRequestOptions = {},
): Promise<PromotionCodePreviewResponse> {
  return post(accessToken, "preview", request, promotionCodePreviewResponseSchema, options);
}

export function createAdminPromotionCode(
  accessToken: string,
  request: PromotionCodeCreateRequest,
  options: BffRequestOptions = {},
): Promise<PromotionCodeCreateResponse> {
  return post(accessToken, "create", request, promotionCodeCreateResponseSchema, options);
}

export function updateAdminPromotionCode(
  accessToken: string,
  request: PromotionCodeUpdateRequest,
  options: BffRequestOptions = {},
): Promise<PromotionCodeUpdateResponse> {
  return post(accessToken, "update", request, promotionCodeUpdateResponseSchema, options);
}

function post<T>(
  accessToken: string,
  action: string,
  body: unknown,
  schema: z.ZodType<T>,
  options: BffRequestOptions,
): Promise<T> {
  return requestBff(`${basePath}/${action}`, schema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body,
  });
}
