import type {
  PromotionCodeCreateRequest,
  PromotionCodeSummary,
  PromotionCodesListRequest,
  PromotionCodeUpdateRequest,
} from "../../../src/domains/commerce/adminPromotionCodesContracts.js";

export interface PromotionCodesListResult {
  codes: PromotionCodeSummary[];
  nextCursor: string | null;
  legacyCompatibility: {
    ready: boolean;
    unprojectedCount: number;
    collisionGroupCount: number;
  };
}

export interface PromotionCodeCreateResult {
  id: string;
  code: string;
  status: "draft" | "active" | "paused" | "archived";
  idempotent: boolean;
  revision: number;
}

export interface PromotionCodeUpdateResult {
  id: string;
  status: "draft" | "active" | "paused" | "archived";
  idempotent: boolean;
  revision: number;
}

export interface AdminPromotionCodesDataPort {
  list(actorId: string, input: PromotionCodesListRequest): Promise<PromotionCodesListResult>;
  definition(actorId: string, id: string): Promise<{
    benefits: PromotionCodeSummary["benefits"];
    scopes: PromotionCodeCreateRequest["scopes"];
    minimumReferenceMinor: number;
    revision: number;
    status: "draft" | "active" | "paused" | "archived";
    validFrom: string;
    validTo: string | null;
    promotionEngineVersion: "promotion-engine.v1" | "promotion-engine.v2";
  }>;
  create(input: {
    actorId: string;
    request: PromotionCodeCreateRequest;
    resolvedCode: string;
    requestFingerprint: string;
  }): Promise<PromotionCodeCreateResult>;
  update(input: {
    actorId: string;
    request: PromotionCodeUpdateRequest;
    requestFingerprint: string;
  }): Promise<PromotionCodeUpdateResult>;
}
