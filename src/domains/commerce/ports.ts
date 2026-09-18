import type {
  CreateOrderDraftRequest,
  CreateOrderDraftResponse,
  CreateQuoteRequest,
  CreateQuoteResponse,
} from "./contracts.js";
import type { PricingPolicySnapshot } from "./offerPolicyContracts.js";
import type {
  CheckoutResumeDraft,
  CheckoutResumeDraftState,
  CheckoutResumeSectionId,
} from "./checkoutResumeContracts.js";
import type { AsyncCheckoutStatus, CheckoutKind } from "./checkoutContracts.js";
import type { CommerceCustomerDefaultsSnapshot } from "./customerDefaultsSnapshotContracts.js";
import type {
  ConfiguratorIntentPersistenceRequest,
  ConfiguratorIntentPersistenceResponse,
} from "./configuratorIntentPersistenceContracts.js";
import type {
  CommerceRecommendationRequest,
  CommerceRecommendationResponse,
} from "./recommendationContracts.js";
import type {
  CommerceProductCompatibilityRequest,
  CommerceProductCompatibilityResponse,
} from "./productCompatibilityContracts.js";
export type { RecoveryDestinationIntent, RecoveryDestinationPolicyInput, RecoveryDestinationSource, RecoveryDestinationState } from "./recoveryDestinationPorts.js";
export { hasSubscriptionRecoveryContext, resolveRecoveryDestination } from "./recoveryDestinationPorts.js";
/**
 * Server-resolved options for promo evaluation. Passed OUT-OF-BAND by the caller
 * (orchestration -> provisioned.clientId; preview -> session/null) — NEVER sourced
 * from the client request body — so `first_purchase` eligibility cannot be forged.
 */
export interface CreateQuoteOptions {
  clientId?: string | null;
  pricingPolicy?: PricingPolicySnapshot;
}

export interface CommerceQuotePort {
  createQuote(request: CreateQuoteRequest, options?: CreateQuoteOptions): Promise<CreateQuoteResponse>;
  createServerAuthoritativeQuote?(request: CreateQuoteRequest, options?: CreateQuoteOptions): Promise<CreateQuoteResponse>;
}

export interface ConfiguratorIntentPersistencePort {
  persistIntent(
    request: ConfiguratorIntentPersistenceRequest,
  ): Promise<ConfiguratorIntentPersistenceResponse>;
  /**
   * Resolve the identity already provisioned under a COMPLETED idempotency key,
   * or null when none exists. Lets checkout recover the `clientId` when
   * `persistIntent` raises an idempotency conflict (same key, mutated payload) so
   * the client's in-flight order can be resumed instead of surfacing a
   * transient-looking error. Optional: adapters that cannot read back the
   * completed row simply omit it and the caller falls back to a 409.
   */
  findCompletedIdentity?(
    idempotencyKey: string,
  ): Promise<ConfiguratorIntentPersistenceResponse | null>;
}

export interface CommerceRecommendationPort {
  recommend(request: CommerceRecommendationRequest): Promise<CommerceRecommendationResponse>;
}

export interface CommerceProductCompatibilityPort {
  getCompatibility(
    request: CommerceProductCompatibilityRequest,
  ): Promise<CommerceProductCompatibilityResponse>;
}

export interface CommerceQuoteSnapshotVerifierPort {
  verifyQuoteSnapshot(snapshot: CreateQuoteResponse): Promise<CreateQuoteResponse | void>;
}

export interface CommerceCustomerDefaultsReadPort {
  getCustomerDefaultsSnapshot(input: {
    clientId: string;
    checkoutKind: CheckoutKind;
  }): Promise<CommerceCustomerDefaultsSnapshot | null>;
}

export interface CommerceCheckoutResumeDraftUpsertInput {
  tokenHash: string;
  idempotencyKeyHash: string | null;
  lastSectionId: CheckoutResumeSectionId;
  draftState: CheckoutResumeDraftState;
  expiresAt: string;
  now: string;
}

export interface CommerceCheckoutResumeDraftReadInput {
  tokenHash: string;
  now: string;
}

export interface CommerceCheckoutResumeDraftPort {
  upsertDraft(input: CommerceCheckoutResumeDraftUpsertInput): Promise<CheckoutResumeDraft>;
  readDraftByTokenHash(input: CommerceCheckoutResumeDraftReadInput): Promise<CheckoutResumeDraft | null>;
}

/**
 * Server-resolved options for the order draft. Passed OUT-OF-BAND by the caller
 * (orchestration -> provisioned.clientId; standalone route -> none/null) — NEVER
 * sourced from the client request body — so the persisted client_id (which the
 * outbox dispatcher resolves into an email recipient) cannot be forged.
 */
export interface CreateOrderDraftOptions {
  clientId?: string | null;
}

export interface CommerceOrderDraftWritePort {
  createOrderDraft(
    request: CreateOrderDraftRequest,
    options?: CreateOrderDraftOptions,
  ): Promise<CreateOrderDraftResponse>;
}

/**
 * A still-in-flight order found for a client, for the checkout handler's
 * duplicate-charge guard. `status` is always an in-flight `AsyncCheckoutStatus`.
 */
export interface ResumableOrderSnapshot {
  orderId: string;
  paymentIntentId: string;
  status: AsyncCheckoutStatus;
  metadata?: Record<string, unknown> | null;
  /**
   * True when the submitting journey PRODUCED this order — a cart edit, not a
   * cross-device return. Never resume one: superseding re-prices the cart.
   */
  sameJourney: boolean;
}

export interface CommerceResumableOrderReadPort {
  /**
   * Newest still-resumable order for `clientId` within `withinMinutes`, or null.
   * Resumable = payment neither settled nor terminally failed, so a charge may
   * be in flight and re-submitting would double-charge; a paid/dead order is NOT
   * returned. `journeyKey` is resolved here to set `sameJourney`.
   */
  findResumableOrderForClient(input: {
    clientId: string;
    withinMinutes: number;
    now: Date;
    journeyKey: string;
  }): Promise<ResumableOrderSnapshot | null>;
}

export class CommerceNotEnabledError extends Error {
  constructor(feature: "cart" | "checkout" | "order draft" | "order" | "payment") {
    super(`Commerce ${feature} is not enabled yet`);
    this.name = "CommerceNotEnabledError";
  }
}

export class CommerceOrderDraftConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce order draft idempotency conflict",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceOrderDraftConflictError";
    this.details = details;
  }
}

export { CommerceOrderDraftPriceChangedError, CommerceOrderDraftUnsupportedMoneyError } from "./orderDraftErrors.js";
export type { CommerceOrderDraftUnsupportedMoneyReason } from "./orderDraftErrors.js";

export class CommerceOrderDraftInvalidResponseError extends Error {
  constructor() {
    super("Commerce order draft returned invalid response");
    this.name = "CommerceOrderDraftInvalidResponseError";
  }
}

export class CommerceOrderDraftPersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce order draft persistence failed",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceOrderDraftPersistenceError";
    this.details = details;
  }
}

export class CommerceCheckoutResumePersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce checkout resume persistence failed",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceCheckoutResumePersistenceError";
    this.details = details;
  }
}

export type CommerceQuoteSnapshotErrorCode = "QUOTE_SNAPSHOT_MISMATCH";

export class CommerceQuoteSnapshotError extends Error {
  readonly code: CommerceQuoteSnapshotErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: CommerceQuoteSnapshotErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceQuoteSnapshotError";
    this.code = code;
    this.details = details;
  }
}

export type CommerceQuoteErrorCode =
  | "UNKNOWN_SKU"
  | "PRICE_NOT_CONFIGURED"
  | "UNSUPPORTED_TAX_PROFILE"
  | "PRICING_INVARIANT_VIOLATION";

export class CommerceQuoteError extends Error {
  readonly code: CommerceQuoteErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CommerceQuoteErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceQuoteError";
    this.code = code;
    this.details = details;
  }
}

// Re-export hidden checkout runtime ports as commerce public surface so
// neighboring domains (subscription, etc.) can import the abstract port
// interfaces without reaching into another domain's internal modules.
export type { CommerceOfferAvailabilityPort } from "./offerAvailabilityPorts.js";
/**
 * The availability port's answers travel with the vocabulary needed to READ them:
 * the four-rung status ladder, its reason codes, and the two contract types the
 * port speaks. They are re-exported on this public segment because a composed
 * offer — a bundle deriving ONE status from many components — must land on the
 * same rungs a single unit does, and a second copy of the ladder in another domain
 * would drift the first time a rung moved. Consumers therefore reuse this seam
 * instead of reaching into this domain's internals.
 */
export {
  DEFAULT_LOW_STOCK_THRESHOLD,
  reasonCodeFor as offerAvailabilityReasonCode,
  statusForSellableNow as offerAvailabilityStatusFor,
} from "./offerAvailability.js";
export type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
  CommerceOfferAvailabilityStatus,
} from "./offerAvailabilityContracts.js";
export type {
  CommerceCheckoutRuntimeOrderPort,
  CommerceCheckoutRuntimePort,
  CommerceRuntimeReadinessPort,
  InventoryCheckoutReservationPort,
  PaymentControlRuntimePort,
  PreparedProviderAttemptRuntimePort,
} from "./runtimePorts.js";

export interface CommercePackageSizingResult {
  /** The recipe set re-split to cover the requested plan length. */
  recipes: Array<{ variantId: string; qty: number }>;
  /** Canonical package unit count after sizing. */
  totalUnits: number;
  /** True when even the largest supported package cannot meet the target. */
  maxExceeded: boolean;
}

/**
 * Recompute a subscription's recipe unit counts when the plan length changes.
 * Exposed as commerce public surface so the customers domain can resize a box
 * (demand × days -> units, re-split across the same recipes) without importing
 * the commerce-internal package-quantity policy.
 */
export interface CommercePackageSizingPort {
  recomputeRecipeQuantities(input: {
    recipeVariantIds: readonly string[];
    /** Current mix; cadence resize preserves its proportions within kcal/line limits. */
    currentRecipes?: readonly { variantId: string; qty: number }[];
    dailyKcal: number;
    planDays: number;
  }): Promise<CommercePackageSizingResult>;
  /** Published, recipe-eligible (non-addon) catalog variant ids — used to reject
   *  an addon SKU smuggled into a recipe-mix edit. */
  recipeVariantIds(): Promise<Set<string>>;
}
