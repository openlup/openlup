import { vi } from "vitest";
import { z } from "zod";
import { createBffResponder } from "../../src/bff/index.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import type { CreateQuoteRequest, CreateQuoteResponse, PricingPolicySnapshot, ResolvedAcquisitionTerms } from "../../src/pricing/index.js";
import { mapAcquisitionTermsFailure } from "../../src/pricing/index.js";
import { stableJson } from "../../src/promotions/index.js";
import * as Browser from "../../src/commerce/index.js";
import * as Core from "../../src/commerce/server/index.js";
import type { ConfiguratorIntent, FinalizedCheckoutOrder } from "../../src/commerce/contracts/index.js";
import type { CheckoutRuntimeRequest, CheckoutRuntimeExecutionInput, CheckoutRuntimeExecutionResult } from "../../src/commerce/server/checkoutRuntimeTypes.js";
import type { CheckoutPaymentExecution } from "../../src/commerce/server/commerceCheckoutProviderPayment.js";

export const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
export const ADDRESS_ID = "33333333-3333-4333-8333-333333333333";
export const ORDER_ID = "44444444-4444-4444-8444-444444444444";
export const PAYMENT_INTENT_ID = "55555555-5555-4555-8555-555555555555";
type StarterDeclaration = NonNullable<ReturnType<Parameters<typeof Core.createStarterOfferGuard>[0]["declaration"]>>;
export type Intent = ConfiguratorIntent & { selectedDelivery?: unknown; acquisitionCapability?: unknown; starterOffer?: StarterDeclaration; tag?: string };
export type Provisioned = { clientId: string; addressId: string; replayed: boolean };
export type Snapshot = CreateQuoteResponse & { quote: CreateQuoteResponse["quote"] & { context?: { mode: "one_time" | "subscription"; cadenceDays?: number | null; promoCodes: string[]; pricingPolicy?: PricingPolicySnapshot; acquisitionTerms?: ResolvedAcquisitionTerms; shippingTerms?: unknown; offerVersion?: string; offerEvidence?: Record<string, unknown>; starterPack?: Plan; tag?: string } } };
export type Plan = { schemaVersion: string; starterIntervalDays: number; basisTemplateVersion: number; delivery2: { discountBps: number; discountMinor: number; basisSubtotalMinor: number }; graduation: { cadenceDays: number; sizeConstraint?: Record<string, unknown>; lines: Array<{ sku: string; qty: number; sortOrder: number; isAddon: boolean; quoteLine: Record<string, unknown> }> } };
export const quoteSchema = z.custom<Snapshot>();
const moneySchema = z.object({ amountMinor: z.number().int(), currency: z.string() });
const expectation = z.object({ totalGross: moneySchema, pricingPolicy: z.custom<PricingPolicySnapshot>().optional(), acquisitionTerms: z.object({ revision: z.string(), delivery2DiscountBps: z.number() }).optional(), promotionAcceptanceToken: z.string().optional() });
export const checkoutResponseSchema = Browser.createCheckoutResponseSchemas({ quoteSchema, quoteExpectationSchema: expectation, clientActionSchema: z.union([z.object({ kind: z.literal("none") }), z.object({ kind: z.literal("provider_embedded"), provider: z.literal("embedded"), clientSecret: z.string().optional() }), z.object({ kind: z.literal("redirect"), url: z.string() })]), paymentIntentStatusSchema: z.string(), paymentAttemptStatusSchema: z.string(), failureDisplaySchema: z.string() }).checkoutResponseSchema;
export type Response = z.output<typeof checkoutResponseSchema>;
export type Draft = { contractVersion: string; orderDraft: { orderId: string; status: "draft"; paymentStatus: "not_started"; idempotencyKey: string; quoteSnapshot: Snapshot; replayed: boolean } };
export type SyntheticExecution = CheckoutPaymentExecution & { savedMethodId?: string; recurringModel?: "initial" | "subsequent"; transientCode?: string; channelId?: string };
export type Rail = "hidden_rehearsal" | "noop_payment" | "embedded" | "redirect";
export type RuntimeRequest = CheckoutRuntimeRequest & { paymentProvider: Rail; orderDraft: Draft["orderDraft"]; mode: "one_time" | "subscription_cycle"; clientId: string; shippingAddressId: string; paymentExecution?: SyntheticExecution };
export type Reservation = { reservationId: string; reservationIds: string[]; orderItemId: string; skuId: string; sku: string; status: "reserved"; replayed: boolean };
export type Readiness = { omsEligibility: { allowed: boolean; reason: string | null }; fulfillmentCreate: { allowed: boolean; reason: string | null; omsReason: string | null } };
export type RuntimeResponse = { contractVersion: string; runtime: { orderId: string; orderRef: string; mode: "one_time" | "subscription_cycle"; clientId: string; shippingAddressId: string; total: { amountMinor: number; currency: string }; finalizedReplayed: boolean; reservations: Reservation[]; payment: { paymentIntentId: string; paymentId: string; paymentAttemptId: string | null; status: string; attemptStatus: string | null; provider: RuntimeRequest["paymentProvider"]; continuationActionOrigin?: "fresh_execution" | null; providerClientSecret?: string | null; providerAttemptId?: string | null; providerRedirectUrl?: string | null; providerNextActionKind?: string | null }; readiness: Readiness; nextAction: { kind: string; provider: string } } };
export type ResultRequest = { idempotencyKey: string; orderId: string; paymentIntentId: string; resultStatus: string; occurredAt?: string };
export type Settlement = { contractVersion: string; paymentResult: { paymentIntentId: string; paymentId: string; paymentAttemptId: string; orderId: string; status: string; kind: string; replayed: boolean }; reservationRelease: { attempted: boolean; releasedCount: number }; readiness: Readiness | null };
export const responder = createBffResponder();
export function createResponse(): HttpResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), end: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res); vi.mocked(res.json).mockReturnValue(res); return res;
}
export function request(method: string, body?: unknown, headers: Record<string, string> = {}): HttpRequest { return { method, body, headers, query: {} } as HttpRequest; }
export function intent(mode: "one_time" | "subscription" = "one_time"): Intent {
  return { version: Browser.CONFIGURATOR_INTENT_VERSION, idempotencyKey: "intent-example-a", mode, cadenceDays: mode === "subscription" ? 21 : null, promoCodes: [], contact: { firstName: "Buyer", lastName: "Example", email: "buyer@example.test", phone: "123456789" }, address: { street: "Example 12", postalCode: "00000", city: "Example", country: "AA" }, selectedVariants: [{ variantId: "variant-a", sku: "ITEM-A", qty: 14 }], selectedDelivery: { kind: "courier", deliveryKind: "courier", providerKind: "carrier-a", carrierKind: "carrier-a", carrierCode: "A", service: "standard", serviceCode: "standard", providerRef: null, pickupPoint: null } };
}
export function quoteSnapshot(totalGross = { amountMinor: 1490, currency: "XTS" }): Snapshot {
  const net = { amountMinor: 1380, currency: totalGross.currency }, tax = { amountMinor: totalGross.amountMinor - 1380, currency: totalGross.currency };
  return { contractVersion: "commerce.v0", quote: { currency: totalGross.currency, taxIncluded: true, lines: [{ sku: "ITEM-A", productSlug: "item-a", quantity: 1, unitPriceGross: totalGross, lineSubtotalGross: totalGross, tax: { included: true, country: "AA", category: "standard", vatRateBps: 800, legalBasis: "synthetic", netAmount: net, vatAmount: tax, grossAmount: totalGross } }], discounts: [], subtotalGross: totalGross, discountTotalGross: { amountMinor: 0, currency: totalGross.currency }, totalGross, netTotal: net, taxTotal: tax } };
}
export function makeOrderPort() { return { finalizeOrderForCheckout: vi.fn<(_: RuntimeRequest) => Promise<FinalizedCheckoutOrder<string>>>().mockResolvedValue({ orderId: CLIENT_ID, orderRef: `order_${CLIENT_ID}`, mode: "one_time", clientId: ADDRESS_ID, shippingAddressId: ADDRESS_ID, subscriptionId: null, subscriptionCycleId: null, total: { amountMinor: 4990, currency: "XTS" }, items: [{ orderItemId: ORDER_ID, skuId: ADDRESS_ID, sku: "ITEM-A", quantity: 1 }], replayed: false }) }; }
export function makeInventoryPort() { return { reserveOrderItems: vi.fn().mockResolvedValue([{ reservationId: ADDRESS_ID, reservationIds: [ADDRESS_ID], orderItemId: ORDER_ID, skuId: ADDRESS_ID, sku: "ITEM-A", status: "reserved", replayed: false }]), releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }) }; }
export function makePaymentPort() { return {
  createIntent: vi.fn().mockResolvedValue({ paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentId: "99999999-9999-4999-8999-999999999999", status: "created", replayed: false }),
  recordAttempt: vi.fn().mockResolvedValue({ paymentAttemptId: PAYMENT_INTENT_ID, status: "processing", replayed: false }),
  applyResult: vi.fn().mockResolvedValue({ paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentId: "99999999-9999-4999-8999-999999999999", paymentAttemptId: PAYMENT_INTENT_ID, orderId: CLIENT_ID, status: "succeeded", kind: "applied", replayed: false }),
}; }
export function makeReadinessPort() { return { evaluateOrderReadiness: vi.fn().mockResolvedValue({ omsEligibility: { allowed: false, reason: "order_not_paid" }, fulfillmentCreate: { allowed: false, reason: "order_not_paid", omsReason: "order_not_paid" } }) }; }
export function orderDraftSummary(): Draft["orderDraft"] { return { orderId: `order_${ORDER_ID}`, status: "draft", paymentStatus: "not_started", idempotencyKey: "draft-example-a", replayed: false, quoteSnapshot: quoteSnapshot() }; }
export type PaymentPort = ReturnType<typeof makePaymentPort>;
export type Execution = CheckoutRuntimeExecutionResult & { provider: Rail };
export type ExecutionPort = { execute(input: CheckoutRuntimeExecutionInput<null>): Promise<Execution> };
const defaultExecutionPort: ExecutionPort = { async execute() { return { provider: "hidden_rehearsal", providerAttemptId: null, providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} }; } };
const responseCore = Core.createRuntimeStartResponse<FinalizedCheckoutOrder<string>, Reservation, PaymentPort, Execution, Readiness, RuntimeResponse>({ contractVersion: "commerce.v0", responseSchema: z.custom<RuntimeResponse>(), runtimeResponseExtension: () => ({}), async finalizeDeclinedAttempt(port, input) { const result = await port.applyResult({ ...input, resultStatus: "failed" }); return { paymentAttemptId: result.paymentAttemptId, status: "failed" }; } });
const mapFailure = Core.createCheckoutStartRuntimeFailure({ checkoutProviderAttemptFailure: () => null, prepareConflictReason: "payment_control_provider_attempt_prepare_idempotency_conflict" }).mapStartRuntimeFailure;
export const orchestrateCheckoutJourney = Core.createPaidOrderOrchestration<Provisioned, CreateQuoteRequest, Snapshot, Draft, object, RuntimeResponse, Settlement, SyntheticExecution, Rail, string>({ defaultPaymentProvider: "hidden_rehearsal", rehearsalPaymentProvider: "hidden_rehearsal", confirmationProvider: "embedded", missingConfirmationMessage: "confirmation_missing", providerFlowFor: (_provider, execution) => execution?.flow ?? "one_time_payment", runtimeRequestExtension: () => ({}), mapStartRuntimeFailure: mapFailure }).orchestrateCheckoutJourney;
export const runtimeBindings: Parameters<typeof Core.createCommerceRuntimeService<RuntimeRequest, FinalizedCheckoutOrder<string>, Reservation, PaymentPort, Execution, null, ExecutionPort, object, Error, Readiness, RuntimeResponse, ResultRequest, Settlement, "embedded" | "redirect">>[0] = {
  defaultPaymentProvider: "hidden_rehearsal", defaultProviderFlow: "one_time_payment", preparedRecurringModel: request => request.paymentMethodRecurringModel,
  contractVersion: "commerce.v0", resultResponseSchema: z.custom<Settlement>(), defaultExecutionPort,
  executionSubject: () => ({}), paymentMetadataExtension: () => ({}),
  buildProviderAttemptIdentity: (input) => ({ providerIdempotencyKey: input.localExecutionIdempotencyKey, providerRequestFingerprint: `fingerprint:${input.paymentIntentId}` }), transientProviderInput: () => null,
  requiresPreparedProviderAttempt: (provider): provider is "embedded" | "redirect" => provider === "embedded" || provider === "redirect",
  preparedProviderAttemptPort: (port) => port,
  executePreparedProviderAttempt: vi.fn(async (input) => ({ execution: await input.executionPort.execute(input.executionInput), attempt: { paymentAttemptId: PAYMENT_INTENT_ID, status: "processing" } })),
  isPreDispatch: (error): error is Error => error instanceof Error && error.name === "SyntheticPreDispatchError",
  reopenExhaustedPreDispatchAttempt: async ({ error }) => { throw error; }, preserveProviderDispatchUncertainty: (operation) => operation(),
  recordPaymentAttempt: (port, input) => port.recordAttempt(input), buildStartedRuntimeResponse: responseCore.buildStartedRuntimeResponse,
};
const runtimeCore = Core.createCommerceRuntimeService<RuntimeRequest, FinalizedCheckoutOrder<string>, Reservation, PaymentPort, Execution, null, ExecutionPort, object, Error, Readiness, RuntimeResponse, ResultRequest, Settlement, "embedded" | "redirect">(runtimeBindings);
export const commandSchemas = Browser.createCheckoutCommandSchemas({ sku: z.string(), paymentIntentStatus: z.string(), paymentAttemptStatus: z.string() });
const command = Core.createCheckoutCommandExecutor<Provisioned, Snapshot, Draft, object, RuntimeResponse, Settlement, ExecutionPort, SyntheticExecution, Rail, string>({ commandSchema: commandSchemas.checkoutCommandV1Schema, commandProvisioned: (persistence) => ({ clientId: persistence.clientId, addressId: persistence.shippingAddressId, replayed: persistence.replayed }), orchestrateCheckoutJourney });
type CommandDeps = Parameters<typeof command.executeCheckoutCommand>[1];
export function createCommerceRuntimeService(deps: Parameters<typeof runtimeCore>[0] & Pick<CommandDeps, "quotePort" | "persistencePort" | "orderDraftPort" | "compensationPort" | "now">) {
  const runtime = runtimeCore(deps);
  return { ...runtime, startCheckoutCommand: (request: Parameters<typeof command.executeCheckoutCommand>[0]) => command.executeCheckoutCommand(request, { ...deps, startRuntime: runtime.startRuntime, applyPaymentResult: runtime.applyPaymentResult }) };
}

const buildQuoteRequest = (input: Intent, _provisioned?: Provisioned, policy?: PricingPolicySnapshot): CreateQuoteRequest & { pricingPolicy?: { capability: string; token: string } } => ({ ...(policy?.pricingPolicyToken ? { pricingPolicy: { capability: "commerce.offer-policy.v2", token: policy.pricingPolicyToken } } : {}), mode: input.mode, lines: input.selectedVariants.map(line => ({ sku: line.sku, quantity: line.qty, modeAtLine: input.mode })), cadenceDays: input.cadenceDays, promoCodes: input.promoCodes });
const runtimeMetadata = (input: Intent) => ({ deliveryContact: Browser.buildOrderDeliveryContact({ recipientName: `${input.contact.firstName} ${input.contact.lastName}`, contactEmail: input.contact.email, contactPhone: input.contact.phone, line1: input.address.street, city: input.address.city, postalCode: input.address.postalCode, country: input.address.country, selectedDelivery: input.selectedDelivery }), invoiceBuyerSnapshot: { email: input.contact.email } });
const starter = Core.createStarterOfferGuard<Intent, Provisioned, CreateQuoteRequest, Snapshot, Plan>({ declaration: input => input.starterOffer, defaultTermsPort: { async resolve() { return { kind: "terms", terms: { intervalDays: 14, steadyCadenceDays: 21, steadyUnits: 14 } }; } }, defaultDiscountBps: 3000, discountMinor: () => 300, planSchema: z.custom<Plan>(), aggregateBySku: entries => entries, rescaleBasket: entries => entries, steadyIntent: (input, cadenceDays, _units, selectedVariants) => ({ ...input, cadenceDays, promoCodes: [], selectedVariants }), buildQuoteRequest });
const quoteGuard = Core.createCheckoutQuoteGuard<Intent, Provisioned, CreateQuoteRequest, Snapshot, Extract<Response, { status: "price_changed" }>, never, Plan>({ buildQuoteRequest, responseSchema: checkoutResponseSchema.options[1], resolveStarterOfferGuard: starter.resolveStarterOfferGuard, withStarterPackContext: Core.withStarterPackContext });
const resume = Core.createCheckoutResumeGuard<Intent, Response>({ responseSchema: checkoutResponseSchema, statusUrl: (orderId, paymentIntentId, clientId) => `/status?orderId=${orderId}&paymentIntentId=${paymentIntentId}&clientId=${clientId}` });
const saved = Core.createSavedAcquisitionContinuation<Intent, Provisioned, CreateQuoteRequest, Snapshot, unknown, Response>({ quoteSchema, buildQuoteRequest, sameSubjectContext: () => true, runtimeMetadata, starterDeclaration: input => input.starterOffer, starterPlan: snapshot => snapshot.quote.context?.starterPack, buildSavedOrderResumeResponse: resume.buildSavedOrderResumeResponse });
const helpers = Core.createCheckoutHandlerHelpers<Intent, Provisioned, Snapshot, Response>({ checkoutClientAction: Core.createCheckoutClientAction("embedded", "redirect"), responder, responseSchema: checkoutResponseSchema, statusUrl: (orderId, paymentIntentId, clientId) => `/status?orderId=${orderId}&paymentIntentId=${paymentIntentId}&clientId=${clientId}`, resolveResumeOpenOrderResponse: resume.resolveResumeOpenOrderResponse });
const promotion = Core.createPromotionPriceChange<Intent, Provisioned, CreateQuoteRequest, Snapshot, Response>({ responder, buildQuoteRequest, buildCheckoutPriceChangedResponse: quoteGuard.buildCheckoutPriceChangedResponse, respondQuoteFailure: (res, error) => { const failure = mapAcquisitionTermsFailure(error); if (!failure) return false; responder.sendBffError(res, failure.code, "Acquisition terms unavailable", { details: failure.details }); return true; } });
const failure = Core.createCheckoutFailureHandler<Intent, Provisioned, CreateQuoteRequest, Snapshot>({ responder, logProviderFailure: () => {}, respondQuoteFailure: () => false, previewDiagnosticsEnabled: () => false, respondToPromotionCodePriceChange: promotion.respondToPromotionCodePriceChange });
const intentSchema = Browser.createConfiguratorIntentSchemas(z.string()).configuratorIntentCoreSchema.extend({ selectedDelivery: z.unknown().optional(), acquisitionCapability: z.unknown().optional(), starterOffer: z.custom<StarterDeclaration>().optional(), tag: z.string().optional() });
const requestSchema = z.object({ intent: intentSchema, paymentProvider: z.enum(["hidden_rehearsal", "noop_payment", "embedded", "redirect"]).default("hidden_rehearsal"), returnContext: z.enum(["public", "account"]).default("public"), paymentAttemptSequence: z.number().optional(), paymentExecution: z.custom<SyntheticExecution>().optional(), declaredBankId: z.string().optional(), invoicePreference: z.unknown().default({ kind: "consumer" }), expectedQuote: expectation.optional() });
const admission = Core.createCheckoutAdmission({ requestSchema, responder, deliveryAllowed: () => true, respondDeliveryRequired: () => {}, rejectMissingPromotionExpectedQuote: promotion.rejectMissingPromotionExpectedQuote });
function observeRuntime(runtime: ReturnType<typeof createCommerceRuntimeService>): ReturnType<typeof createCommerceRuntimeService> { return { ...runtime, startRuntime: vi.fn(runtime.startRuntime), applyPaymentResult: vi.fn(runtime.applyPaymentResult) }; }
export function createPorts() { return { persistencePort: { persistIntent: vi.fn(async (_input: Intent): Promise<Provisioned> => ({ clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: false })) }, quotePort: { createQuote: vi.fn(async (_request: CreateQuoteRequest, _options?: Browser.CreateQuoteOptions<import("../../src/pricing/index.js").CreateQuoteOptions>) => quoteSnapshot()) }, orderDraftPort: { createOrderDraft: vi.fn(async (_input: { idempotencyKey: string; quoteSnapshot: Snapshot }, _options?: { clientId?: string | null }): Promise<Draft> => ({ contractVersion: "commerce.v0", orderDraft: orderDraftSummary() })) }, runtimePort: observeRuntime(createCommerceRuntimeService({ orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort: makePaymentPort(), readinessPort: makeReadinessPort() })), compensationPort: { releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }), cancelUnstartedPromotionOrder: vi.fn().mockResolvedValue({ cancelled: false }), cancelAbandonedOrder: vi.fn().mockResolvedValue({ cancelled: true }) }, checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }), rateLimitMessage: () => "limited", now: () => new Date("1999-01-01T00:00:00.000Z") }; }
export const { resolveSavedPaymentMethodForCheckout } = Core.createCheckoutSavedPaymentMethodResolver((execution: SyntheticExecution | undefined): { flow: "saved_once" | "saved_recurring"; savedMethodId: string } | null => {
  if (execution?.provider !== "redirect" || !execution.savedMethodId || (execution.flow !== "saved_once" && execution.flow !== "saved_recurring")) return null;
  return { flow: execution.flow, savedMethodId: execution.savedMethodId };
});
export type Deps = ReturnType<typeof createPorts> & {
  mintPaymentContinuationCookie?: Core.CheckoutPaymentContinuationMinter<"embedded" | "redirect">;
  savedPaymentMethodResolverPort?: Parameters<typeof resolveSavedPaymentMethodForCheckout>[0]["savedPaymentMethodResolverPort"];
  resolvePricingPolicy?: Parameters<typeof quoteGuard.resolveCheckoutQuoteGuard>[0]["resolvePricingPolicy"];
  verifyPromotionAcceptance?: Parameters<typeof quoteGuard.resolveCheckoutQuoteGuard>[0]["verifyPromotionAcceptance"];
  starterTermsPort?: never;
  customerDefaultsPort?: undefined;
 resumableOrderPort?: Browser.CommerceResumableOrderReadPort; resumeWindowMinutes?: number; offerPolicy?: Browser.CheckoutOfferPolicyPort<Intent, Snapshot["quote"]> };
export const createCommerceCheckoutHandler = Core.createCommerceCheckoutHandler<Deps, Intent, Provisioned, z.output<typeof requestSchema>, Snapshot, object, Awaited<ReturnType<typeof orchestrateCheckoutJourney>>, Response>({ responder, mintPaymentContinuationOnFreshAction: input => Core.mintPaymentContinuationOnFreshAction(input, ["embedded", "redirect"]), mintCheckoutRefusalContinuation: input => Core.mintCheckoutRefusalContinuation(input, ["embedded", "redirect"]), createCheckoutTimingLogger: () => Core.createCheckoutTimingLogger("test-request", "/checkout"), previewCheckoutDiagnosticsEnabled: () => false, admitCheckoutRequest: admission.admitCheckoutRequest, ...helpers, resolveSavedPaymentMethodForCheckout, readCheckoutCustomerDefaultsOrRespond: async () => ({ kind: "read", snapshot: null }),
  async resolveCheckoutQuoteOrContinuation(input) { const response = await saved.resolveSavedAcquisitionContinuation({ ...input, clientId: input.provisioned.clientId }); return response ? { kind: "resumed", response } : quoteGuard.resolveCheckoutQuoteGuard(input); },
  resolveResumeOpenOrderResponse: resume.resolveResumeOpenOrderResponse,
  orchestratePaidOrder: (input) => orchestrateCheckoutJourney(input, { idempotencyKey: input.intent.idempotencyKey, contactEmail: input.intent.contact.email, createQuoteRequest: () => buildQuoteRequest(input.intent), createRuntimeMetadata: () => runtimeMetadata(input.intent) }), respondToCheckoutFailure: failure.respondToCheckoutFailure,
});

export const { resolveCheckoutQuoteGuard, buildCheckoutPriceChangedResponse } = quoteGuard;
export const { rejectMissingPromotionExpectedQuote, respondToPromotionCodePriceChange } = promotion;
export const { resolveSavedAcquisitionContinuation } = saved;
export const { admitCheckoutRequest } = admission;
export const { respondToCheckoutFailure } = failure;
export const { buildStartedRuntimeResponse } = responseCore;

export const { persistCheckoutIdentityOrRespond, buildCheckoutSuccessResponse, respondToProvisionIdentityConflict } = helpers;
export const { resolveResumeOpenOrderResponse } = resume;
export const mapStartRuntimeFailure = mapFailure;
