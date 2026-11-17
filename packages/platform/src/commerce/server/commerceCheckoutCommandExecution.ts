import type { z } from "zod";
import type { CreateQuoteRequest, PricingPolicySnapshot } from "../../pricing/index.js";
import type { CheckoutJourney, CommerceOrderDraftWritePort, CheckoutCommandRuntimeResult } from "../contracts/index.js";
import type { CommerceQuotePort } from "../ports.js";
import type { CheckoutCommandV1, CheckoutCommandPersistenceResult } from "../checkoutCommandSchemas.js";
import { buildOrderDeliveryContact } from "../checkoutHelpers.js";
import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "../runtimeErrors.js";
import { tryCompensate, type CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import type { PaidOrderOrchestrationDeps, CheckoutJourneyRuntimeRequest, CheckoutJourneyRuntimeResponse, CheckoutJourneyResultRequest, OrchestratedCheckoutResult } from "./commercePaidOrderOrchestration.js";
import type { CheckoutExecutionProvider } from "./checkoutRuntimeTypes.js";
import type { CheckoutPaymentExecution } from "./commerceCheckoutProviderPayment.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
export interface CheckoutCommandQuoteRequest extends CreateQuoteRequest { customerEligibilityContext: { email: string } }
export interface CheckoutCommandExecutionRequest<Provider extends string = string, MethodKind extends string = string, RecurringModel extends string = string> {
  command: CheckoutCommandV1; paymentProvider: Provider; paymentAttemptSequence?: number;
  paymentMethodRef?: string; paymentMethodAliasType?: MethodKind; paymentMethodRecurringModel?: RecurringModel;
  saveForFutureUse?: boolean; returnContext?: "public" | "account";
  providerPayer?: { email: string; name: string; ip?: string | null; userAgent?: string | null }; metadata?: Record<string, unknown>;
}
export function checkoutCommandJourney(
  command: CheckoutCommandV1,
  metadata: Record<string, unknown> | undefined,
): CheckoutJourney<CheckoutCommandQuoteRequest, PricingPolicySnapshot> {
  return {
    idempotencyKey: command.idempotencyKey,
    contactEmail: command.customer.email,
    createQuoteRequest: () => ({
      mode: command.mode,
      lines: command.lines.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        modeAtLine: command.mode,
      })),
      cadenceDays: command.cadenceDays ?? null,
      promoCodes: [],
      customerEligibilityContext: { email: command.customer.email },
    }),
    createRuntimeMetadata: () => ({
      ...metadata,
      checkoutCommandVersion: command.version,
      cadenceDays: command.cadenceDays,
      deliveryContact: buildOrderDeliveryContact({
        recipientName: `${command.customer.firstName} ${command.customer.lastName}`,
        contactEmail: command.customer.email,
        contactPhone: command.customer.phone,
        line1: command.shippingAddress.street,
        city: command.shippingAddress.city,
        postalCode: command.shippingAddress.postalCode,
        country: command.shippingAddress.country,
      }),
    }),
  };
}

export function createCheckoutCommandExecutor<Provisioned extends { clientId: string; addressId: string }, Snapshot extends CheckoutQuoteSnapshot, Draft extends { orderDraft: { orderId: string } }, Extension extends object, Runtime extends CheckoutJourneyRuntimeResponse<Provider>, Settlement, ExecutionPort extends object, PaymentExecution extends CheckoutPaymentExecution, Provider extends string, Flow extends string, MethodKind extends string = string, RecurringModel extends string = string>(bindings: {
  commandSchema: z.ZodType<CheckoutCommandV1>;
  commandProvisioned(persistence: CheckoutCommandPersistenceResult): Provisioned;
  orchestrateCheckoutJourney(deps: PaidOrderOrchestrationDeps<Provisioned, CheckoutCommandQuoteRequest, Snapshot, Draft, Extension, Runtime, Settlement, PaymentExecution, Provider, Flow, MethodKind, RecurringModel>, journey: CheckoutJourney<CheckoutCommandQuoteRequest, PricingPolicySnapshot>): Promise<OrchestratedCheckoutResult<Snapshot, Provider>>;
}) {
  type CheckoutCommandExecutionDeps = {
    quotePort?: CommerceQuotePort<CheckoutCommandQuoteRequest, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>;
    persistencePort?: { persistCheckoutCommand(command: CheckoutCommandV1): Promise<CheckoutCommandPersistenceResult> };
    orderDraftPort?: CommerceOrderDraftWritePort<{ idempotencyKey: string; quoteSnapshot: Snapshot }, Draft>;
    resolveExecutionPort?: (provider: string) => ExecutionPort;
    compensationPort?: CheckoutCompensationPort; now?: () => Date;
    startRuntime(request: CheckoutJourneyRuntimeRequest<Snapshot, PaymentExecution, Provider, Flow, MethodKind, RecurringModel> & Extension, executionPort: ExecutionPort): Promise<Runtime>;
    applyPaymentResult(request: CheckoutJourneyResultRequest): Promise<Settlement>;
  };

const COMMAND_CONFLICT_REASONS = new Set([
  "journey_consumed",
  "promotion_code_price_changed",
  "provider_attempt_in_flight",
]);

async function executeCheckoutCommand(
  request: CheckoutCommandExecutionRequest<Provider, MethodKind, RecurringModel>,
  deps: CheckoutCommandExecutionDeps,
): Promise<CheckoutCommandRuntimeResult<Snapshot, CheckoutCommandPersistenceResult, Draft, Runtime, Settlement>> {
  const command = bindings.commandSchema.safeParse(request.command);
  if (!command.success) throw new CommerceRuntimeConflictError("Checkout command is invalid");
  const { quotePort, persistencePort, orderDraftPort, resolveExecutionPort } = deps;
  if (!quotePort || !persistencePort || !orderDraftPort || !resolveExecutionPort) {
    throw new CommerceRuntimePersistenceError(
      "Checkout command runtime composition is incomplete",
      { missing: [!quotePort && "quote", !persistencePort && "persistence", !orderDraftPort && "order_draft", !resolveExecutionPort && "payment_provider"].filter(Boolean) },
    );
  }

  const adapter = resolveExecutionPort(request.paymentProvider) as unknown;
  if (typeof adapter !== "object" || adapter === null || !("execute" in adapter) || typeof adapter.execute !== "function") {
    throw new CommerceRuntimePersistenceError("Checkout command payment provider adapter is unavailable");
  }
  const executionPort = adapter as ExecutionPort;
  const journey = checkoutCommandJourney(command.data, request.metadata);
  // Quote and its currency guard stay ahead of every write: a mismatched
  // currency must not leave a persisted client, address, or draft behind.
  const quoteSnapshot = await quotePort.createQuote(journey.createQuoteRequest());
  if (quoteSnapshot.quote.currency !== command.data.currency) {
    throw new CommerceRuntimeConflictError("Checkout command currency does not match quote", {
      commandCurrency: command.data.currency,
      quoteCurrency: quoteSnapshot.quote.currency,
    });
  }

  const persistence = await persistencePort.persistCheckoutCommand(command.data);
  if (persistence.subjectId !== null) {
    throw new CommerceRuntimePersistenceError("Checkout command persistence returned an unexpected subject");
  }

  // From here the neutral command runs the SAME application service as the
  // legacy configurator checkout: one stage sequence, one start-runtime failure
  // mapping, one provider invariant set, one settle step, one compensation.
  const captured: {
    orderDraft: Draft | null;
    runtime: Runtime | null;
    settlement: Settlement | null;
  } = { orderDraft: null, runtime: null, settlement: null };
  try {
    const orchestrationDeps: PaidOrderOrchestrationDeps<Provisioned, CheckoutCommandQuoteRequest, Snapshot, Draft, Extension, Runtime, Settlement, PaymentExecution, Provider, Flow, MethodKind, RecurringModel> & { journey: CheckoutJourney<CheckoutCommandQuoteRequest, PricingPolicySnapshot> } = {
      journey,
      provisioned: bindings.commandProvisioned(persistence),
      checkoutKind: command.data.mode === "subscription" ? "subscription_initial" : "one_time",
      quotePort,
      quoteSnapshot,
      orderDraftPort: {
        createOrderDraft: async (draftRequest, options) => {
          captured.orderDraft = await orderDraftPort.createOrderDraft(draftRequest, options);
          return captured.orderDraft;
        },
      },
      runtimePort: {
        startRuntime: async (startRequest) => {
          captured.runtime = await deps.startRuntime(startRequest, executionPort);
          return captured.runtime;
        },
        applyPaymentResult: async (settleRequest) => {
          captured.settlement = await deps.applyPaymentResult(settleRequest);
          return captured.settlement;
        },
      },
      paymentProvider: request.paymentProvider,
      paymentAttemptSequence: request.paymentAttemptSequence,
      paymentMethodRef: request.paymentMethodRef,
      paymentMethodAliasType: request.paymentMethodAliasType,
      paymentMethodRecurringModel: request.paymentMethodRecurringModel,
      saveForFutureUse: request.saveForFutureUse,
      returnContext: request.returnContext,
      providerPayer: request.providerPayer,
      now: deps.now ?? (() => new Date()),
    };
    await bindings.orchestrateCheckoutJourney(orchestrationDeps, journey);
  } catch (error) {
    throw await mapOrchestrationFailure(error, journey.idempotencyKey, deps.compensationPort);
  }
  if (!captured.orderDraft || !captured.runtime) {
    throw new CommerceRuntimePersistenceError("Checkout command runtime produced no result");
  }

  return {
    quoteSnapshot,
    persistence,
    orderDraft: captured.orderDraft,
    runtime: captured.runtime,
    settlement: captured.settlement,
  };
}

async function mapOrchestrationFailure(
  error: unknown,
  idempotencyKey: string,
  compensationPort: CheckoutCompensationPort | undefined,
): Promise<unknown> {
  if (!(error instanceof CheckoutOrchestrationError)) return error;
  // `orderIdForCompensation` is a compensation capability, not an order id: the
  // saga deliberately withholds it when a provider attempt may be in flight.
  if (error.orderIdForCompensation && compensationPort) {
    await tryCompensate(compensationPort, idempotencyKey, error.orderIdForCompensation);
  }
  const details = { stage: error.message.split(":")[0], reason: error.reason };
  return error.reason && COMMAND_CONFLICT_REASONS.has(error.reason)
    ? new CommerceRuntimeConflictError("Checkout command could not be completed", details)
    : new CommerceRuntimePersistenceError("Checkout command runtime failed", details);
}

return { executeCheckoutCommand };
}
