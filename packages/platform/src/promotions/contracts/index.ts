/** Promotion-owned preview DTOs. Validation and secrets belong to the server entry. */
export type PromotionCodeBenefit = {
    lane: "product";
    kind: "target_percentage";
    valueBps: number;
} | {
    lane: "product";
    kind: "fixed_amount";
    valueMinor: number;
} | {
    lane: "shipping";
    kind: "fixed_amount";
    valueMinor: number;
} | {
    lane: "product";
    kind: "percentage";
    valueBps: number;
} | {
    lane: "shipping";
    kind: "percentage";
    valueBps: number;
} | {
    lane: "shipping";
    kind: "free_shipping";
} | {
    lane: "product" | "shipping";
    kind: "percentage" | "fixed_amount";
    validationState: "unsupported_legacy_value";
};
export interface PromotionCodePreviewRequest {
    benefits: PromotionCodeBenefit[];
    scopes: Array<"one_time" | "subscription_initial">;
    promotionEngineVersion: "promotion-engine.v1" | "promotion-engine.v2";
    minimumReferenceMinor: number;
    context: {
        referenceProductMinor: number;
        oneTimeProductMinor: number;
        subscriptionProductMinor: number;
        shippingMinor: number;
    };
}
export interface PromotionCodePreviewResponse {
    contractVersion: "commerce.v0";
    promotionEngineVersion: "promotion-engine.v1" | "promotion-engine.v2";
    previewProof: string;
    results: Array<{
        scope: "one_time" | "subscription_initial";
        productPayableMinor: number;
        shippingPayableMinor: number;
        effectiveProductDiscountBps: number;
        winner: "code" | "automatic";
        floorApplied: boolean;
        adjustments: Array<{
            lane: "product" | "shipping";
            kind: "target_percentage" | "percentage" | "fixed_amount" | "free_shipping";
            amountOffMinor: number;
            beforeMinor: number;
            afterMinor: number;
        }>;
    }>;
}
/** Admin DTOs are schema outputs; validation remains in the server entry. */
/** Promotion admin output DTOs. Validation and host policy belong to the server entry. */
export type AdminPromotion = {
    id: string;
    code: string | null;
    name: string;
    triggerType: "coupon_code" | "automatic" | "referral";
    discountType: "percentage" | "fixed_amount" | "free_shipping";
    semanticBenefit: {
        kind: "target_percentage";
        valueBps: number;
        reference: "catalog_list_price";
        unitTargets: {
            variantId: string;
            sku: string | null;
            referenceMinor: number;
            targetMinor: number;
            currency: string;
        }[];
    } | {
        kind: "percentage";
        valuePercent: number;
    } | {
        kind: "fixed_amount";
        valueMinor: number;
        currency: string;
    } | {
        kind: "free_shipping";
    } | {
        kind: "unavailable";
        reason: "system_managed_metadata_incomplete";
    };
    systemManaged: boolean;
    readOnly: boolean;
    v2Mirror: {
        id: string;
        status: "draft" | "active" | "paused" | "archived";
    } | null;
    appliesToKind: "order_total" | "line_with_variant" | "line_with_category";
    stackingRule: "exclusive" | "stackable_with_any" | "stackable_with_loyalty";
    eligibility: Record<string, unknown>;
    validFrom: string;
    validTo: string | null;
    status: "draft" | "active" | "paused" | "archived";
    regionAvailability: string[];
    redemptionLimitGlobal: number | null;
    redemptionLimitPerCustomer: number | null;
};
export type AdminPromotionV2Mirror = {
    id: string;
    status: "draft" | "active" | "paused" | "archived";
};
export type AdminPromotionSemanticBenefit = {
    kind: "target_percentage";
    valueBps: number;
    reference: "catalog_list_price";
    unitTargets: {
        variantId: string;
        sku: string | null;
        referenceMinor: number;
        targetMinor: number;
        currency: string;
    }[];
} | {
    kind: "percentage";
    valuePercent: number;
} | {
    kind: "fixed_amount";
    valueMinor: number;
    currency: string;
} | {
    kind: "free_shipping";
} | {
    kind: "unavailable";
    reason: "system_managed_metadata_incomplete";
};
export interface AdminPromotionsListResponse {
    contractVersion: "commerce.v0";
    promotions: AdminPromotion[];
}
export type AdminPromotionUpdatePayload = {
    name?: string | undefined;
    discountValue?: number | undefined;
    stackingRule?: "exclusive" | "stackable_with_any" | "stackable_with_loyalty" | undefined;
    status?: "draft" | "active" | "paused" | "archived" | undefined;
    eligibility?: Record<string, unknown> | undefined;
    validFrom?: string | undefined;
    validTo?: string | null | undefined;
    redemptionLimitGlobal?: number | null | undefined;
    redemptionLimitPerCustomer?: number | null | undefined;
};
export interface AdminPromotionUpdateRequest {
    id: string;
    updates: AdminPromotionUpdatePayload;
}
export type AdminPromotionUpdateResponse = {
    contractVersion: "commerce.v0";
    updated: true;
    id: string;
};
export type PromotionCodeCreateRequest = {
    name: string;
    description: string | null;
    code: {
        kind: "automatic";
    } | {
        kind: "manual";
        value: string;
    };
    benefits: ({
        lane: "product";
        kind: "target_percentage";
        valueBps: number;
    } | {
        lane: "product";
        kind: "fixed_amount";
        valueMinor: number;
    } | {
        lane: "shipping";
        kind: "percentage";
        valueBps: number;
    } | {
        lane: "shipping";
        kind: "fixed_amount";
        valueMinor: number;
    } | {
        lane: "shipping";
        kind: "free_shipping";
    })[];
    scopes: ("one_time" | "subscription_initial")[];
    validFrom: string;
    validTo: string | null;
    minimumReferenceMinor: number;
    redemptionLimitGlobal: number | null;
    redemptionLimitPerCustomer: number | null;
    status: "draft" | "active";
    idempotencyKey: string;
    previewContext?: {
        referenceProductMinor: number;
        oneTimeProductMinor: number;
        subscriptionProductMinor: number;
        shippingMinor: number;
    } | undefined;
    previewProof?: string | undefined;
};
export type PromotionCodeCreateResponse = {
    contractVersion: "commerce.v0";
    id: string;
    code: string;
    status: "draft" | "active" | "paused" | "archived";
    revision: number;
    idempotent: boolean;
};
export type PromotionCodeUpdateRequest = {
    id: string;
    expectedRevision: number;
    updates: {
        status?: "draft" | "active" | "paused" | "archived" | undefined;
        validFrom?: string | undefined;
        validTo?: string | null | undefined;
        redemptionLimitGlobal?: number | null | undefined;
        redemptionLimitPerCustomer?: number | null | undefined;
    };
    idempotencyKey: string;
    previewContext?: {
        referenceProductMinor: number;
        oneTimeProductMinor: number;
        subscriptionProductMinor: number;
        shippingMinor: number;
    } | undefined;
    previewProof?: string | undefined;
};
export type PromotionCodeUpdateResponse = {
    contractVersion: "commerce.v0";
    id: string;
    status: "draft" | "active" | "paused" | "archived";
    revision: number;
    idempotent: boolean;
};
export type PromotionCodesListRequest = {
    status: "draft" | "active" | "paused" | "archived" | "scheduled" | "expired" | "expired_or_archived" | "all";
    scope: "shipping" | "one_time" | "subscription_initial" | "all" | "both";
    limit: number;
    q?: string | undefined;
    cursor?: string | undefined;
};
export type PromotionCodeSummary = {
    id: string;
    code: string;
    name: string;
    description: string | null;
    benefits: ({
        lane: "product";
        kind: "target_percentage";
        valueBps: number;
    } | {
        lane: "product";
        kind: "fixed_amount";
        valueMinor: number;
    } | {
        lane: "shipping";
        kind: "percentage";
        valueBps: number;
    } | {
        lane: "shipping";
        kind: "fixed_amount";
        valueMinor: number;
    } | {
        lane: "shipping";
        kind: "free_shipping";
    } | {
        lane: "product";
        kind: "percentage";
        valueBps: number;
    } | {
        lane: "shipping";
        kind: "percentage";
        valueBps: number;
    } | {
        lane: "product";
        kind: "fixed_amount";
        valueMinor: number;
    } | {
        lane: "shipping";
        kind: "fixed_amount";
        valueMinor: number;
    } | {
        lane: "product" | "shipping";
        kind: "percentage" | "fixed_amount";
        validationState: "unsupported_legacy_value";
    })[];
    promotionEngineVersion: "promotion-engine.v1" | "promotion-engine.v2";
    scopes: ("one_time" | "subscription_initial")[];
    status: "draft" | "active" | "paused" | "archived";
    effectiveStatus: "draft" | "active" | "paused" | "archived" | "scheduled" | "expired";
    validFrom: string;
    validTo: string | null;
    minimumReferenceMinor: number;
    redemptionLimitGlobal: number | null;
    redemptionLimitPerCustomer: number | null;
    redeemedCount: number;
    reservedCount: number;
    remainingCount: number | null;
    createdAt: string;
    revision: number;
};
export type PromotionCodesListResponse = {
    contractVersion: "commerce.v0";
    codes: {
        id: string;
        code: string;
        name: string;
        description: string | null;
        benefits: ({
            lane: "product";
            kind: "target_percentage";
            valueBps: number;
        } | {
            lane: "product";
            kind: "fixed_amount";
            valueMinor: number;
        } | {
            lane: "shipping";
            kind: "percentage";
            valueBps: number;
        } | {
            lane: "shipping";
            kind: "fixed_amount";
            valueMinor: number;
        } | {
            lane: "shipping";
            kind: "free_shipping";
        } | {
            lane: "product";
            kind: "percentage";
            valueBps: number;
        } | {
            lane: "shipping";
            kind: "percentage";
            valueBps: number;
        } | {
            lane: "product";
            kind: "fixed_amount";
            valueMinor: number;
        } | {
            lane: "shipping";
            kind: "fixed_amount";
            valueMinor: number;
        } | {
            lane: "product" | "shipping";
            kind: "percentage" | "fixed_amount";
            validationState: "unsupported_legacy_value";
        })[];
        promotionEngineVersion: "promotion-engine.v1" | "promotion-engine.v2";
        scopes: ("one_time" | "subscription_initial")[];
        status: "draft" | "active" | "paused" | "archived";
        effectiveStatus: "draft" | "active" | "paused" | "archived" | "scheduled" | "expired";
        validFrom: string;
        validTo: string | null;
        minimumReferenceMinor: number;
        redemptionLimitGlobal: number | null;
        redemptionLimitPerCustomer: number | null;
        redeemedCount: number;
        reservedCount: number;
        remainingCount: number | null;
        createdAt: string;
        revision: number;
    }[];
    nextCursor: string | null;
    capabilities: {
        mutationsEnabled: boolean;
    };
    legacyCompatibility: {
        ready: boolean;
        unprojectedCount: number;
        collisionGroupCount: number;
    };
};
export type PromotionStatus = "draft" | "active" | "paused" | "archived";
export interface AdminSubscriptionBandEntry {
    variantId: string;
    sku: string | null;
    oneTimeMinor: number;
    subscriptionMinor: number;
    percent: number;
}
