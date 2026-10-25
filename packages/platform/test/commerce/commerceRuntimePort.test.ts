import { describe, expect, it, vi } from "vitest";

import { mapStartRuntimeFailure } from "./checkoutTestFixtures.js";
import { mapRpcError } from "../../src/commerce/server/commerceRuntimePort.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
} from "../../src/commerce/index.js";

describe("managed commerce runtime port rpc error mapping", () => {
  it("maps the consumed-journey raise to a conflict with reason journey_consumed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mapped = mapRpcError({
      code: "23505",
      message: "commerce_runtime_finalize_journey_consumed",
    });
    expect(mapped).toBeInstanceOf(CommerceRuntimeConflictError);
    expect((mapped as CommerceRuntimeConflictError).details).toMatchObject({
      reason: "journey_consumed",
    });
  });

  it("keeps the generic finalize conflict for in-flight idempotency collisions", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mapped = mapRpcError({
      code: "23505",
      message: "commerce_runtime_finalize_idempotency_conflict",
    });
    expect(mapped).toBeInstanceOf(CommerceRuntimeConflictError);
    expect((mapped as CommerceRuntimeConflictError).details).not.toMatchObject({
      reason: "journey_consumed",
    });
  });

  it("carries the locked SQL stale-epoch refusal into safe draft compensation and normal repricing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mapped = mapRpcError({ code: "55000", message: "acquisition_terms_changed" });
    expect(mapped).toBeInstanceOf(CommerceRuntimeConflictError);
    expect(mapStartRuntimeFailure(mapped, "fresh-draft")).toMatchObject({
      reason: "acquisition_terms_changed", orderIdForCompensation: "fresh-draft",
    });
  });

  it("maps unknown rpc failures to a persistence error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mapped = mapRpcError({ code: "XX000", message: "boom" });
    expect(mapped).toBeInstanceOf(CommerceRuntimePersistenceError);
  });
});

import { z } from "zod";
import { createManagedCommerceRuntimeOrderPort } from "../../src/commerce/server/index.js";
describe("generic runtime finalize store", () => {
  it("sends the bound arguments unchanged and preserves host order extensions", async () => {
    const args = { p_idempotency_key: "journey-a", p_order_id: "order-a", p_metadata: { opaque: true } };
    const order = { items: [{ sku: "ITEM-A" }], hostEvidence: { value: 7 } };
    const rpc = vi.fn().mockResolvedValue({ data: { contractVersion: "commerce.v0", finalizedOrder: order }, error: null });
    const finalizeArgs = vi.fn(() => args);
    const port = createManagedCommerceRuntimeOrderPort({ rpc }, { finalizeArgs, responseEnvelopeSchema: z.object({ contractVersion: z.literal("commerce.v0") }).passthrough() });
    const input = { journey: "journey-a" };
    expect(await port.finalizeOrderForCheckout(input)).toBe(order);
    expect(finalizeArgs).toHaveBeenCalledExactlyOnceWith(input);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("commerce_finalize_order_for_checkout", args);
    expect(rpc.mock.calls[0][1]).toBe(args);
  });
  it.each([null, {}, { contractVersion: "bad" }, { contractVersion: "commerce.v0" }, { contractVersion: "commerce.v0", finalizedOrder: {} }, { contractVersion: "commerce.v0", finalizedOrder: { items: [] } }])("refuses malformed response %j", async data => {
    const port = createManagedCommerceRuntimeOrderPort({ rpc: async () => ({ data, error: null }) }, { finalizeArgs: () => ({}), responseEnvelopeSchema: z.object({ contractVersion: z.literal("commerce.v0") }).passthrough() });
    await expect(port.finalizeOrderForCheckout({})).rejects.toBeInstanceOf(CommerceRuntimePersistenceError);
  });
});
