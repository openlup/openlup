import { describe, expect, it, vi } from "vitest";

import { mapRpcError } from "./commerceRuntimePort.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
} from "../../../../src/domains/commerce/runtimePorts.js";

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

  it("maps unknown rpc failures to a persistence error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mapped = mapRpcError({ code: "XX000", message: "boom" });
    expect(mapped).toBeInstanceOf(CommerceRuntimePersistenceError);
  });
});
