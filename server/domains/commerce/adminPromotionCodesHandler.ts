import { createHash } from "node:crypto";

import {
  promotionCodeCreateRequestSchema,
  promotionCodeCreateResponseSchema,
  promotionCodePreviewRequestSchema,
  promotionCodePreviewResponseSchema,
  promotionCodesListRequestSchema,
  promotionCodesListResponseSchema,
  promotionCodeUpdateRequestSchema,
  promotionCodeUpdateResponseSchema,
  type PromotionCodeCreateRequest,
  type PromotionCodePreviewRequest,
  type PromotionCodesListRequest,
  type PromotionCodeUpdateRequest,
} from "../../../src/domains/commerce/adminPromotionCodesContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type {
  AgentDomainMutationSpec,
  AgentDomainQuerySpec,
} from "../../../src/lib/agent-domain/domainSpec.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import {
  createAdminMutationHandler,
  createAdminParameterizedReadHandler,
} from "../../_lib/admin-domain/handlers.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { DomainRpcError, mapRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import { resolveAdmin } from "../../_lib/admin-domain/auth.js";
import type { AdminPromotionCodesDataPort } from "./adminPromotionCodesDataPort.js";
import {
  generatePromotionCode,
  normalizePromotionCode,
  previewPromotionCode,
  verifyPromotionPreviewProof,
} from "./promotionCodePreview.js";

/**
 * The Promotion Code Center is a permanent part of the service (its rollout
 * flags were retired in PR 2243), so these handlers are unconditional: the
 * `enabled` / `flagName` / `disabledMessage` options of the admin-domain kit are
 * omitted, which the kit reads as "always run the handler". The human-actor gate
 * on create/update below is a SECURITY control, not rollout gating, and stays.
 */
const listSpec: AgentDomainQuerySpec<PromotionCodesListRequest> = {
  key: "list",
  requestSchema: promotionCodesListRequestSchema,
  gate: "read",
  allowedActorKinds: ["human", "machine"],
};
const createSpec: AgentDomainMutationSpec<PromotionCodeCreateRequest> = {
  key: "create",
  requestSchema: promotionCodeCreateRequestSchema,
  gate: "mutation",
  allowedActorKinds: ["human"],
  lifecycleMarkers: [],
};
const updateSpec: AgentDomainMutationSpec<PromotionCodeUpdateRequest> = {
  key: "update",
  requestSchema: promotionCodeUpdateRequestSchema,
  gate: "mutation",
  allowedActorKinds: ["human"],
  lifecycleMarkers: [],
};

export interface AdminPromotionCodesHandlerDeps {
  dataPort: AdminPromotionCodesDataPort;
  authorizeAdmin: AuthorizeAdmin;
  previewSecret: string;
}

export function createAdminPromotionCodesListHandler(deps: AdminPromotionCodesHandlerDeps) {
  return createAdminParameterizedReadHandler({
    query: listSpec,
    authorizeAdmin: deps.authorizeAdmin,
    load: (actorId, input) => deps.dataPort.list(actorId, input),
    toResponse: (result) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      ...result,
      // Kept on the wire (constant `true`) so a browser bundle built before the
      // rollout flags were retired still parses this response unchanged.
      capabilities: { mutationsEnabled: true },
    }),
    responseSchema: promotionCodesListResponseSchema,
    invalidRequestMessage: "Invalid promotion code list request",
    invalidResponseMessage: "Invalid promotion code list response",
    failureMessage: "Promotion code list failed",
    mapError: mapPromotionCodeError,
  });
}

export function createAdminPromotionCodePreviewHandler(
  deps: Pick<AdminPromotionCodesHandlerDeps, "authorizeAdmin" | "previewSecret">,
) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await resolveAdmin(deps.authorizeAdmin, res))) return;
    const parsed = promotionCodePreviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid promotion code preview request", {
        details: parsed.error.flatten(),
      });
      return;
    }
    try {
      const result = promotionCodePreviewResponseSchema.parse(
        previewPromotionCode(parsed.data, deps.previewSecret),
      );
      sendBffSuccess(res, result);
    } catch (error) {
      mapPromotionCodeError(res, error, "Promotion code preview failed");
    }
  };
}

export function createAdminPromotionCodeCreateHandler(deps: AdminPromotionCodesHandlerDeps) {
  return createAdminMutationHandler({
    mutation: createSpec,
    authorizeAdmin: deps.authorizeAdmin,
    invoke: async (actorId, request) => {
      verifyActivationPreview(request, deps.previewSecret);
      const resolvedCode = normalizePromotionCode(
        request.code.kind === "automatic" ? generatePromotionCode() : request.code.value,
      );
      return deps.dataPort.create({
        actorId,
        request,
        resolvedCode,
        requestFingerprint: mutationFingerprint(request),
      });
    },
    toResponse: (result) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, ...result }),
    responseSchema: promotionCodeCreateResponseSchema,
    invalidRequestMessage: "Invalid promotion code create request",
    invalidResponseMessage: "Invalid promotion code create response",
    failureMessage: "Promotion code create failed",
    mapError: mapPromotionCodeError,
  });
}

export function createAdminPromotionCodeUpdateHandler(deps: AdminPromotionCodesHandlerDeps) {
  return createAdminMutationHandler({
    mutation: updateSpec,
    authorizeAdmin: deps.authorizeAdmin,
    invoke: async (actorId, request) => {
      await verifyUpdateLifecycle(deps.dataPort, actorId, request, deps.previewSecret);
      return deps.dataPort.update({
        actorId,
        request,
        requestFingerprint: mutationFingerprint(request),
      });
    },
    toResponse: (result) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, ...result }),
    responseSchema: promotionCodeUpdateResponseSchema,
    invalidRequestMessage: "Invalid promotion code update request",
    invalidResponseMessage: "Invalid promotion code update response",
    failureMessage: "Promotion code update failed",
    mapError: mapPromotionCodeError,
  });
}

function verifyActivationPreview(request: PromotionCodeCreateRequest, secret: string): void {
  if (request.status !== "active") return;
  if (!request.previewContext || !request.previewProof) {
    throw new DomainRpcError("22023", "promotion_preview_required");
  }
  const previewInput: PromotionCodePreviewRequest = {
    benefits: request.benefits,
    scopes: request.scopes,
    promotionEngineVersion: "promotion-engine.v2",
    minimumReferenceMinor: request.minimumReferenceMinor,
    context: request.previewContext,
  };
  previewPromotionCode(previewInput, secret);
  if (!verifyPromotionPreviewProof(previewInput, request.previewProof, secret)) {
    throw new DomainRpcError("22023", "promotion_preview_proof_mismatch");
  }
}

async function verifyUpdateLifecycle(
  dataPort: AdminPromotionCodesDataPort,
  actorId: string,
  request: PromotionCodeUpdateRequest,
  secret: string,
): Promise<void> {
  const definition = await dataPort.definition(actorId, request.id);
  if (definition.revision !== request.expectedRevision) {
    // Let the transactional RPC decide between an idempotent replay (whose
    // original revision is now stale by definition) and a genuine 409.
    return;
  }
  const resultingValidFrom = request.updates.validFrom ?? definition.validFrom;
  const resultingValidTo = request.updates.validTo === undefined
    ? definition.validTo
    : request.updates.validTo;
  if (resultingValidTo !== null && Date.parse(resultingValidTo) <= Date.parse(resultingValidFrom)) {
    throw new DomainRpcError("22023", "promotion_code_invalid_validity_window");
  }
  const beforeEffective = isEffectivelyActive(
    definition.status,
    definition.validFrom,
    definition.validTo,
  );
  const afterEffective = isEffectivelyActive(
    request.updates.status ?? definition.status,
    resultingValidFrom,
    resultingValidTo,
  );
  const transitionsToActiveStatus = definition.status !== "active"
    && (request.updates.status ?? definition.status) === "active";
  if (!transitionsToActiveStatus && (beforeEffective || !afterEffective)) return;
  if (!request.previewContext || !request.previewProof) {
    throw new DomainRpcError("22023", "promotion_preview_required");
  }
  const actualPreview = {
    benefits: definition.benefits,
    scopes: definition.scopes,
    promotionEngineVersion: definition.promotionEngineVersion,
    minimumReferenceMinor: definition.minimumReferenceMinor,
    context: request.previewContext,
  };
  previewPromotionCode(actualPreview, secret);
  if (!verifyPromotionPreviewProof(actualPreview, request.previewProof, secret)) {
    throw new DomainRpcError("22023", "promotion_preview_proof_mismatch");
  }
}

function isEffectivelyActive(
  status: "draft" | "active" | "paused" | "archived",
  validFrom: string,
  validTo: string | null,
  now = Date.now(),
): boolean {
  return status === "active"
    && Date.parse(validFrom) <= now
    && (validTo === null || Date.parse(validTo) > now);
}

function mapPromotionCodeError(
  res: VercelResponse,
  error: unknown,
  failureMessage: string,
): void {
  if (error instanceof DomainRpcError && error.sqlstate === "22023") {
    sendBffError(res, "BAD_REQUEST", error.pgMessage, {
      details: { reason: error.pgMessage },
    });
    return;
  }
  if (error instanceof RangeError) {
    sendBffError(res, "BAD_REQUEST", error.message, {
      details: { reason: error.message },
    });
    return;
  }
  mapRpcError(res, error, failureMessage);
}

function mutationFingerprint(request: PromotionCodeCreateRequest | PromotionCodeUpdateRequest): string {
  const sanitized = "code" in request && request.code.kind === "automatic"
    ? { ...request, code: { kind: "automatic" } }
    : request;
  return createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");
}
