import {
  checkoutCommandV1Schema,
  type CheckoutCommandV1,
} from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { CreateOrderDraftResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceOrderDraftWritePort, CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type {
  ApplyHiddenCheckoutPaymentResultRequest,
  ApplyHiddenCheckoutPaymentResultResponse,
  StartHiddenCheckoutRuntimeRequest,
  StartHiddenCheckoutRuntimeResponse,
} from "../../../src/domains/commerce/runtimeContracts.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
  type CheckoutCommandPersistencePort,
  type CheckoutCommandRuntimeRequest,
  type CheckoutCommandRuntimeResult,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import { tryCompensate, type CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import {
  CheckoutOrchestrationError,
  orchestratePaidOrder,
} from "./commerceCheckoutOrchestration.js";
import {
  buildOrderDeliveryContact,
  type CheckoutJourney,
} from "./commerceCheckoutOrchestrationHelpers.js";

interface CheckoutCommandExecutionDeps {
  quotePort?: CommerceQuotePort;
  persistencePort?: CheckoutCommandPersistencePort;
  orderDraftPort?: CommerceOrderDraftWritePort;
  resolveExecutionPort?: (providerKind: string) => PaymentExecutionPort;
  /** Enables reservation compensation for a failure after `startRuntime`. */
  compensationPort?: CheckoutCompensationPort;
  now?: () => Date;
  startRuntime: (request: StartHiddenCheckoutRuntimeRequest, executionPort: PaymentExecutionPort) =>
    Promise<StartHiddenCheckoutRuntimeResponse>;
  applyPaymentResult: (request: ApplyHiddenCheckoutPaymentResultRequest) =>
    Promise<ApplyHiddenCheckoutPaymentResultResponse>;
}

/**
 * Orchestration outcomes the caller can act on. Everything else stays an
 * upstream failure. Without this map every mid-saga error collapsed into one
 * opaque `UPSTREAM_UNAVAILABLE`.
 */
const COMMAND_CONFLICT_REASONS = new Set([
  "journey_consumed",
  "promotion_code_price_changed",
  "provider_attempt_in_flight",
]);

/** Neutral mapping: `CheckoutCommandV1` -> the shared journey projection. */
export function checkoutCommandJourney(
  command: CheckoutCommandV1,
  metadata: Record<string, unknown> | undefined,
): CheckoutJourney {
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

export async function executeCheckoutCommand(
  request: CheckoutCommandRuntimeRequest,
  deps: CheckoutCommandExecutionDeps,
): Promise<CheckoutCommandRuntimeResult> {
  const command = checkoutCommandV1Schema.safeParse(request.command);
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
  const executionPort = adapter as PaymentExecutionPort;
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
    orderDraft: CreateOrderDraftResponse | null;
    runtime: StartHiddenCheckoutRuntimeResponse | null;
    settlement: ApplyHiddenCheckoutPaymentResultResponse | null;
  } = { orderDraft: null, runtime: null, settlement: null };
  try {
    await orchestratePaidOrder({
      journey,
      provisioned: {
        clientId: persistence.clientId,
        petId: null,
        addressId: persistence.shippingAddressId,
      },
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
    });
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
