import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_COMMAND_V1, checkoutCommandV1Schema } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import { COMMERCE_CURRENCIES } from "../../../src/domains/commerce/types.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
} from "../../../src/domains/commerce/runtimePorts.js";
import { PAYMENT_EXECUTION_PROVIDERS } from "../../../src/domains/payment/types.js";
import { ProviderAttemptInFlightError } from "../../shared/preparedProviderAttempt.js";
import { createCommerceRuntimeService } from "./commerceRuntimeService.js";
import { checkoutCommandJourney } from "./commerceCheckoutCommandExecution.js";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import { createPorts, createResponse, intent, request } from "./commerceCheckoutHandler.testFixtures.js";
import { makeInventoryPort, makeOrderPort, makePaymentPort, makeReadinessPort, orderDraftSummary } from "./commerceRuntimeService.fixtures.js";

// Pass-through spy on the single paid-order application service. The real
// implementation still runs for every case below; the spy only records who
// entered it, which is what proves there is no second saga.
const orchestration = vi.hoisted(() => ({ entries: vi.fn() }));
vi.mock("./commerceCheckoutOrchestration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commerceCheckoutOrchestration.js")>();
  return {
    ...actual,
    orchestratePaidOrder: (deps: Parameters<typeof actual.orchestratePaidOrder>[0]) => {
      orchestration.entries(deps);
      return actual.orchestratePaidOrder(deps);
    },
  };
});

describe("checkout command execution", () => {
  it("freezes the neutral command delivery contact in runtime metadata", () => {
    const command = checkoutCommandV1Schema.parse(commandInput());
    const runtime = checkoutCommandJourney(command, { source: "test" })
      .createRuntimeMetadata();

    expect(runtime.deliveryContact).toEqual({
      schemaVersion: 1,
      source: "checkout_submission",
      revision: 1,
      recipientName: `${command.customer.firstName} ${command.customer.lastName}`,
      contactEmail: command.customer.email,
      contactPhone: command.customer.phone,
      line1: command.shippingAddress.street,
      line2: null,
      city: command.shippingAddress.city,
      postalCode: command.shippingAddress.postalCode,
      country: command.shippingAddress.country,
      selectedDelivery: null,
      deliveryInstructions: null,
      courierInstructions: null,
    });
  });

  it("runs neutral commands through the existing ports", async () => {
    const ports = commandPorts();
    const command = checkoutCommandV1Schema.parse(commandInput());
    const result = await createCommerceRuntimeService(ports).startCheckoutCommand({ command, paymentProvider: TEST_NOOP_PROVIDER });
    expect(result).toMatchObject({
      persistence: { subjectId: null, replayed: false },
      runtime: { runtime: { orderId: "11111111-1111-4111-8111-111111111111", petId: null, total: { amountMinor: 4990, currency: TEST_CURRENCY }, finalizedReplayed: false,
        payment: { paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentId: "99999999-9999-4999-8999-999999999999", status: "created", attemptStatus: "processing" } } },
    });
    expect(ports.quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription", cadenceDays: 21, lines: [{ sku: "REFILL-01", quantity: 2, modeAtLine: "subscription" }],
    }));
    expect([ports.persistencePort.persistCheckoutCommand, ports.orderDraftPort.createOrderDraft, ports.orderPort.finalizeOrderForCheckout, ports.inventoryPort.reserveOrderItems, ports.paymentPort.createIntent].every((port) => port.mock.calls.length === 1)).toBe(true);
    // Settle is the shared one: keyed by the journey key (not a second
    // `:reference-capture` key) and stamped by the injected clock.
    expect(ports.paymentPort.applyResult).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "neutral-command-subscription-1",
      resultStatus: "succeeded",
      occurredAt: "2026-01-02T03:04:05.000Z",
    }));
    expect(result.settlement?.paymentResult).toMatchObject({ status: "succeeded", replayed: false });
  });

  it.each(["missing resolver", "throwing resolver", "undefined resolver", "invalid resolver", "missing currency"])("fails closed before writes: %s", async (kind) => {
    const ports = commandPorts();
    const { currency: _, ...missingCurrency } = commandInput();
    const deps = kind === "missing resolver"
      ? (() => { const { resolveExecutionPort: _resolver, ...rest } = ports; return rest; })()
      : kind === "throwing resolver"
        ? { ...ports, resolveExecutionPort: () => { throw new Error("payment_provider_adapter_unavailable:selected"); } }
        : kind === "undefined resolver"
          ? { ...ports, resolveExecutionPort: () => undefined as never }
          : kind === "invalid resolver"
            ? { ...ports, resolveExecutionPort: () => ({}) as never }
        : ports;
    await expect(createCommerceRuntimeService(deps as never).startCheckoutCommand({
      command: kind === "missing currency" ? missingCurrency as never : checkoutCommandV1Schema.parse(commandInput()),
      paymentProvider: TEST_UNAVAILABLE_PROVIDER,
    })).rejects.toThrow();
    expectNoCommandWrites(ports);
  });

  it("compensates the reservation when the neutral saga fails after startRuntime", async () => {
    const ports = commandPorts();
    ports.paymentPort.createIntent.mockRejectedValue(new Error("payment_control_timeout"));

    await expect(createCommerceRuntimeService(ports).startCheckoutCommand({
      command: checkoutCommandV1Schema.parse(commandInput()),
      paymentProvider: TEST_NOOP_PROVIDER,
    })).rejects.toBeInstanceOf(CommerceRuntimePersistenceError);

    // The order is already finalized and its stock reserved at this point; the
    // neutral path used to abandon both.
    expect(ports.inventoryPort.reserveOrderItems).toHaveBeenCalledTimes(1);
    expect(ports.compensationPort.releaseOrderReservations).toHaveBeenCalledWith({
      idempotencyKey: "neutral-command-subscription-1:checkout-compensation",
      orderId: DRAFT_ORDER_UUID,
      reason: "checkout_orchestration_failed",
    });
    expect(ports.compensationPort.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: "neutral-command-subscription-1",
      orderId: DRAFT_ORDER_UUID,
      reason: "checkout_orchestration_failed_before_runtime",
    });
  });

  it.each([
    ["journey conflict", () => new CommerceRuntimeConflictError("Commerce checkout journey already completed", { reason: "journey_consumed" }), CommerceRuntimeConflictError, "journey_consumed", true],
    ["provider attempt in flight", () => new ProviderAttemptInFlightError({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555", status: "processing",
      providerAttemptId: null, providerSessionId: null,
    }), CommerceRuntimeConflictError, "provider_attempt_in_flight", false],
    ["upstream failure", () => new Error("finalize_timeout"), CommerceRuntimePersistenceError, null, true],
  ])("maps a %s to its own neutral outcome", async (_case, failure, expected, reason, compensates) => {
    const ports = commandPorts();
    ports.orderPort.finalizeOrderForCheckout.mockRejectedValue(failure());

    const rejection = await createCommerceRuntimeService(ports).startCheckoutCommand({
      command: checkoutCommandV1Schema.parse(commandInput()),
      paymentProvider: TEST_NOOP_PROVIDER,
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(expected);
    expect((rejection as CommerceRuntimeConflictError).details).toMatchObject({ stage: "start_runtime", reason });
    // A possibly-charged provider attempt must never be compensated.
    expect(ports.compensationPort.releaseOrderReservations.mock.calls.length > 0).toBe(compensates);
  });

  it("keeps a named D8 prepare conflict fenced without compensation or a second Tpay call", async () => {
    const ports = commandPorts();
    const execute = vi.fn();
    ports.resolveExecutionPort = () => ({ execute });
    ports.paymentPort.prepareProviderAttempt.mockRejectedValue(new CommerceRuntimeConflictError(
      "Payment-control prepare attempt idempotency conflict",
      {
        code: "23505",
        reason: "payment_control_provider_attempt_prepare_idempotency_conflict",
      },
    ));

    const rejection = await createCommerceRuntimeService(ports).startCheckoutCommand({
      command: checkoutCommandV1Schema.parse(commandInput()),
      paymentProvider: "tpay",
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CommerceRuntimeConflictError);
    expect((rejection as CommerceRuntimeConflictError).details).toMatchObject({
      stage: "start_runtime",
      reason: "provider_attempt_in_flight",
    });
    expect(ports.paymentPort.prepareProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "neutral-command-subscription-1:payment-execution:prepare-attempt",
      provider: "tpay",
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(ports.compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(ports.compensationPort.cancelUnstartedPromotionOrder).not.toHaveBeenCalled();
    expect(ports.compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
  });

  it("enters the same paid-order service from the neutral command and from the legacy configurator", async () => {
    orchestration.entries.mockClear();

    await createCommerceRuntimeService(commandPorts()).startCheckoutCommand({
      command: checkoutCommandV1Schema.parse(commandInput()),
      paymentProvider: TEST_NOOP_PROVIDER,
    });
    await createCommerceCheckoutHandler(createPorts())(request("POST", { intent: intent() }), createResponse());

    const [neutral, legacy] = orchestration.entries.mock.calls.map(([deps]) => deps);
    expect(orchestration.entries).toHaveBeenCalledTimes(2);
    expect(neutral?.journey?.idempotencyKey).toBe("neutral-command-subscription-1");
    expect(neutral?.intent).toBeUndefined();
    expect(legacy?.intent?.idempotencyKey).toBe("intent-2026-06-05-rex");
    expect(legacy?.journey).toBeUndefined();
  });

  it("keeps neutral command sources independent from the campaign-step script", () => {
    const entries = [
      "src/domains/commerce/checkoutCommandContracts.ts",
      "src/domains/commerce/runtimePorts.ts",
      "server/domains/commerce/commerceRuntimeService.ts",
      "server/adapters/supabase/configuratorIntentPersistence.ts",
    ];
    for (const entry of entries) expect(localImportClosure(resolve(entry))).not.toContain("scripts/e2e-customer-journey-campaign-steps.ts");
  });
});

function commandInput() {
  return {
    version: CHECKOUT_COMMAND_V1, idempotencyKey: "neutral-command-subscription-1", mode: "subscription",
    lines: [{ sku: "REFILL-01", quantity: 2 }],
    customer: { firstName: "Alex", lastName: "Example", email: "alex@example.test", phone: "+12025550123" },
    shippingAddress: { street: "12 Market Street", postalCode: "10001", city: "Example City", country: "US" },
    currency: TEST_CURRENCY, cadenceDays: 21,
  };
}

function commandPorts() {
  const paymentPort = makePaymentPort();
  paymentPort.applyResult.mockResolvedValue({
    paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentAttemptId: "55555555-5555-4555-8555-555555555555",
    paymentId: "99999999-9999-4999-8999-999999999999", orderId: "11111111-1111-4111-8111-111111111111",
    status: "succeeded", kind: "capture", replayed: false,
  });
  return {
    orderPort: makeOrderPort(),
    inventoryPort: makeInventoryPort(),
    paymentPort,
    readinessPort: makeReadinessPort(),
    compensationPort: {
      releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }),
      cancelUnstartedPromotionOrder: vi.fn().mockResolvedValue({ cancelled: false }),
      cancelAbandonedOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    quotePort: { createQuote: vi.fn().mockResolvedValue(orderDraftSummary().quoteSnapshot) },
    persistencePort: { persistCheckoutCommand: vi.fn().mockResolvedValue(commandIdentity()) },
    orderDraftPort: { createOrderDraft: vi.fn().mockResolvedValue({ contractVersion: "commerce.v0", orderDraft: orderDraftSummary() }) },
    resolveExecutionPort: () => ({ execute: vi.fn().mockResolvedValue({ provider: TEST_NOOP_PROVIDER, providerAttemptId: null, providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} }) }),
  };
}

function commandIdentity() {
  return {
    idempotencyKey: "neutral-command-subscription-1", clientId: "22222222-2222-4222-8222-222222222222", subjectId: null, shippingAddressId: "33333333-3333-4333-8333-333333333333",
    replayed: false,
  };
}

function expectNoCommandWrites(ports: ReturnType<typeof commandPorts>) {
  expect([ports.persistencePort.persistCheckoutCommand, ports.orderDraftPort.createOrderDraft, ports.orderPort.finalizeOrderForCheckout, ports.inventoryPort.reserveOrderItems, ports.paymentPort.createIntent].every((port) => port.mock.calls.length === 0)).toBe(true);
}

function localImportClosure(entry: string, visited = new Set<string>()): Set<string> {
  if (visited.has(entry)) return visited;
  visited.add(entry);
  for (const match of readFileSync(entry, "utf8").matchAll(/from\s+["'](.+?)["']/g)) {
    if (!match[1].startsWith(".")) continue;
    const base = resolve(dirname(entry), match[1].replace(/\.[cm]?js$/, ""));
    const dependency = [".ts", ".tsx", ".js", ".mjs", "/index.ts"].map((suffix) => `${base}${suffix}`).find(existsSync);
    if (dependency) localImportClosure(dependency, visited);
  }
  return new Set([...visited].map((file) => file.replace(`${process.cwd()}/`, "")));
}

const TEST_CURRENCY = COMMERCE_CURRENCIES[0];
const TEST_NOOP_PROVIDER = PAYMENT_EXECUTION_PROVIDERS[0];
const TEST_UNAVAILABLE_PROVIDER = PAYMENT_EXECUTION_PROVIDERS[2];
const DRAFT_ORDER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
