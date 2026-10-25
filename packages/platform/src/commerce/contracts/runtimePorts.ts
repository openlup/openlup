export interface CommercePaymentRuntimeVocabulary {
  currency: string; intentStatus: string; executionProvider: string; executionAttemptStatus: string;
  nextActionKind: string; attemptStatus: string; targetKind: string;
}

export interface FinalizedCheckoutOrderItem {
  orderItemId: string;
  skuId: string;
  sku: string;
  quantity: number;
}

export interface FinalizedCheckoutOrder<Currency> {
  orderId: string;
  orderRef: string;
  mode: "one_time" | "subscription_cycle";
  clientId: string;
  shippingAddressId: string;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
  total: { amountMinor: number; currency: Currency };
  items: FinalizedCheckoutOrderItem[];
  replayed: boolean;
}

export interface CommerceCheckoutRuntimeOrderPort<Request, Order> {
  finalizeOrderForCheckout(
    request: Request,
  ): Promise<Order>;
}

export interface InventoryCheckoutReservationPort<Order, PaymentStatus, Reservation> {
  reserveOrderItems(input: {
    idempotencyKey: string;
    order: Order;
    paymentStatus: PaymentStatus;
    metadata?: Record<string, unknown>;
  }): Promise<Reservation[]>;
  releaseOrderReservations(input: {
    idempotencyKey: string;
    orderId: string;
    reason: string;
  }): Promise<{ releasedCount: number }>;
}

export interface PaymentControlRuntimePort<V extends CommercePaymentRuntimeVocabulary, Result extends { resultStatus: string }, Evidence = never> {
  createIntent(input: {
    idempotencyKey: string;
    targetKind: V["targetKind"];
    orderId: string;
    subscriptionId: string | null;
    subscriptionCycleId: string | null;
    amountMinor: number;
    currency: V["currency"];
    metadata: Record<string, unknown>;
  }): Promise<{
    paymentIntentId: string;
    paymentId: string;
    status: V["intentStatus"];
    replayed: boolean;
  }>;
  recordAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    provider: V["executionProvider"];
    providerAttemptId: string | null;
    providerSessionId: string | null;
    attemptStatus: V["executionAttemptStatus"];
    nextActionKind: V["nextActionKind"] | null;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  }): Promise<{
    paymentAttemptId: string;
    status: V["attemptStatus"];
    replayed: boolean;
  }>;
  applyResult(input: Result): Promise<{
    paymentIntentId: string;
    paymentAttemptId: string;
    paymentId: string;
    orderId: string;
    status: Result["resultStatus"];
    kind: string;
    replayed: boolean;
  }>;
  reopenInteractivePreparedAttempt?(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    expectedOrderId: string;
    expectedSubscriptionId: string | null;
    expectedSubscriptionCycleId: string | null;
    evidence: Evidence;
  }): Promise<{
    paymentAttemptId: string;
    paymentIntentId: string;
    paymentAttemptStatus: "failed";
    paymentIntentStatus: "failed";
    replayed: boolean;
  }>;
}

export interface InteractivePreparedAttemptRuntimePort<V extends CommercePaymentRuntimeVocabulary, Result extends { resultStatus: string }, Evidence> extends PaymentControlRuntimePort<V, Result, Evidence> {
  reopenInteractivePreparedAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    expectedOrderId: string;
    expectedSubscriptionId: string | null;
    expectedSubscriptionCycleId: string | null;
    evidence: Evidence;
  }): Promise<{
    paymentAttemptId: string;
    paymentIntentId: string;
    paymentAttemptStatus: "failed";
    paymentIntentStatus: "failed";
    replayed: boolean;
  }>;
}

export interface PreparedProviderAttemptRuntimePort<V extends CommercePaymentRuntimeVocabulary, Result extends { resultStatus: string }, Evidence = never> extends PaymentControlRuntimePort<V, Result, Evidence> {
  prepareProviderAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    provider: V["executionProvider"];
    providerIdempotencyKey: string;
    providerRequestFingerprint: string;
    providerFlow: string;
    paymentMethodRef?: string | null;
    requestPayload: Record<string, unknown>;
  }): Promise<{
    paymentAttemptId: string;
    status: V["attemptStatus"];
    replayed: boolean;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    nextActionKind: V["nextActionKind"] | null;
  }>;
  finalizeProviderAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    providerIdempotencyKey: string;
    providerRequestFingerprint: string;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    attemptStatus: V["executionAttemptStatus"];
    nextActionKind: V["nextActionKind"] | null;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  }): Promise<{
    paymentAttemptId: string;
    status: V["attemptStatus"];
    replayed: boolean;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    nextActionKind: V["nextActionKind"] | null;
  }>;
}

export interface CommerceRuntimeReadinessPort<Readiness> {
  evaluateOrderReadiness(input: {
    orderId: string;
    fallbackOrderItemCount: number | null;
    allOrderItemsHaveSku: boolean;
  }): Promise<Readiness>;
}

export interface CommerceCheckoutRuntimePort<StartRequest, StartResponse, ResultRequest, ResultResponse> {
  startRuntime(
    request: StartRequest,
  ): Promise<StartResponse>;
  applyPaymentResult(
    request: ResultRequest,
  ): Promise<ResultResponse>;
}

export interface CheckoutCommandPersistencePort<Command, Persistence> {
  persistCheckoutCommand(command: Command): Promise<Persistence>;
}

export interface CheckoutCommandRuntimeRequest<Command, Provider> {
  command: Command;
  paymentProvider: Provider;
  paymentAttemptSequence?: number;
  metadata?: Record<string, unknown>;
}

export interface CheckoutCommandRuntimeResult<Quote, Persistence, OrderDraft, Runtime, Settlement> {
  quoteSnapshot: Quote;
  persistence: Persistence;
  orderDraft: OrderDraft;
  runtime: Runtime;
  settlement: Settlement | null;
}

export interface CheckoutCommandRuntimePort<Request, Response> {
  startCheckoutCommand(
    request: Request,
  ): Promise<Response>;
}
