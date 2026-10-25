import type { AsyncCheckoutStatus, CheckoutKind } from "./index.js";

export interface ConfiguratorIntentPersistencePort<Request, Response> {
  persistIntent(
    request: Request,
  ): Promise<Response>;
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
  ): Promise<Response | null>;
}

export interface CommerceRecommendationPort<Request, Response> {
  recommend(request: Request): Promise<Response>;
}

export interface CommerceProductCompatibilityPort<Request, Response> {
  getCompatibility(
    request: Request,
  ): Promise<Response>;
}

export interface CommerceCustomerDefaultsReadPort<Snapshot> {
  getCustomerDefaultsSnapshot(input: {
    clientId: string;
    checkoutKind: CheckoutKind;
  }): Promise<Snapshot | null>;
}

export interface CommerceCheckoutResumeDraftUpsertInput<Section, State> {
  tokenHash: string;
  idempotencyKeyHash: string | null;
  lastSectionId: Section;
  draftState: State;
  expiresAt: string;
  now: string;
}

export interface CommerceCheckoutResumeDraftReadInput {
  tokenHash: string;
  now: string;
}

export interface CommerceCheckoutResumeDraftPort<Section, State, Draft> {
  upsertDraft(input: CommerceCheckoutResumeDraftUpsertInput<Section, State>): Promise<Draft>;
  readDraftByTokenHash(input: CommerceCheckoutResumeDraftReadInput): Promise<Draft | null>;
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

export interface CommerceOrderDraftWritePort<Request, Response> {
  createOrderDraft(
    request: Request,
    options?: CreateOrderDraftOptions,
  ): Promise<Response>;
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


/** Neutral sizing seam; the host defines demand units and line names. */
export interface CommercePackageSizingPort<Input, Result> {
  recomputeQuantities(input: Input): Promise<Result>;
  eligibleVariantIds(): Promise<Set<string>>;
}

export type CheckoutOfferResolution = { kind: "bound"; offerVersion: string } | { kind: "refused"; reason: string };
/** Offer policy binds or refuses an opaque client ask; evidence is server minted. No executor is included. */
export interface CheckoutOfferPolicyPort<Intent, Quote> {
  resolve(input: { intent: Intent; checkoutKind: CheckoutKind }): Promise<CheckoutOfferResolution>;
  evidence(input: { intent: Intent; offerVersion: string; quote: Quote }): Promise<Record<string, unknown>>;
}

/** Shared journey projection; pricing and host metadata types are supplied by composition. */
export interface CheckoutJourney<Request, Policy> {
  idempotencyKey: string;
  contactEmail: string;
  createQuoteRequest: () => Request;
  createRuntimeMetadata: (pricingPolicy?: Policy) => Record<string, unknown>;
}
