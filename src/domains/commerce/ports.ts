import type {
  CreateOrderDraftRequest,
  CreateOrderDraftResponse,
  CreateQuoteRequest,
  CreateQuoteResponse,
} from "./contracts.js";
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
import type { CreateQuoteOptions as PricingQuoteOptions } from "@openlup/platform/pricing";
export type CreateQuoteOptions = import("@openlup/platform/commerce").CreateQuoteOptions<PricingQuoteOptions>;
export type CommerceQuotePort = import("@openlup/platform/commerce").CommerceQuotePort<CreateQuoteRequest, CreateQuoteResponse, PricingQuoteOptions>;

export type ConfiguratorIntentPersistencePort = import("@openlup/platform/commerce/contracts").ConfiguratorIntentPersistencePort<ConfiguratorIntentPersistenceRequest, ConfiguratorIntentPersistenceResponse>;
export type CommerceRecommendationPort = import("@openlup/platform/commerce/contracts").CommerceRecommendationPort<CommerceRecommendationRequest, CommerceRecommendationResponse>;
export type CommerceProductCompatibilityPort = import("@openlup/platform/commerce/contracts").CommerceProductCompatibilityPort<CommerceProductCompatibilityRequest, CommerceProductCompatibilityResponse>;
export type CommerceQuoteSnapshotVerifierPort = import("@openlup/platform/pricing").CommerceQuoteSnapshotVerifierPort<CreateQuoteResponse>;
export type CommerceCustomerDefaultsReadPort = import("@openlup/platform/commerce/contracts").CommerceCustomerDefaultsReadPort<CommerceCustomerDefaultsSnapshot>;
export type CommerceCheckoutResumeDraftUpsertInput = import("@openlup/platform/commerce/contracts").CommerceCheckoutResumeDraftUpsertInput<CheckoutResumeSectionId, CheckoutResumeDraftState>;
export type { CommerceCheckoutResumeDraftReadInput, CreateOrderDraftOptions, ResumableOrderSnapshot, CommerceResumableOrderReadPort } from "@openlup/platform/commerce/contracts";
export type CommerceCheckoutResumeDraftPort = import("@openlup/platform/commerce/contracts").CommerceCheckoutResumeDraftPort<CheckoutResumeSectionId, CheckoutResumeDraftState, CheckoutResumeDraft>;
export type CommerceOrderDraftWritePort = import("@openlup/platform/commerce/contracts").CommerceOrderDraftWritePort<CreateOrderDraftRequest, CreateOrderDraftResponse>;

export { CommerceNotEnabledError, CommerceOrderDraftConflictError, CommerceOrderDraftInvalidResponseError, CommerceOrderDraftPersistenceError, CommerceCheckoutResumePersistenceError, CommerceOrderDraftPriceChangedError, CommerceOrderDraftUnsupportedMoneyError } from "@openlup/platform/commerce";
export type { CommerceOrderDraftUnsupportedMoneyReason } from "@openlup/platform/commerce";

export { CommerceQuoteError, CommerceQuoteSnapshotError } from "@openlup/platform/pricing";
export type { CommerceQuoteErrorCode, CommerceQuoteSnapshotErrorCode } from "@openlup/platform/pricing";

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
type PackageSizingInput = {
  recipeVariantIds: readonly string[];
  currentRecipes?: readonly { variantId: string; qty: number }[];
  dailyKcal: number;
  planDays: number;
};
type PackageSizing = import("@openlup/platform/commerce/contracts").CommercePackageSizingPort<PackageSizingInput, CommercePackageSizingResult>;
export interface CommercePackageSizingPort {
  recomputeRecipeQuantities: PackageSizing["recomputeQuantities"];
  recipeVariantIds: PackageSizing["eligibleVariantIds"];
}
