import {
  customerSubscriptionActionResponseSchema,
  type CustomerSubscriptionActionRequest,
  type CustomerSubscriptionActionResponse,
} from "../../../src/domains/customers/selfServiceContracts.js";
import { CustomerSubscriptionActionConflictError } from "../../domains/customers/customerSubscriptionActionHandler.js";
import { mapSubscriptionRpcError } from "../../domains/customers/subscriptionActionErrorMapping.js";
import type { CustomerSubscriptionActionPort } from "../../domains/customers/ports.js";

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string; details?: string; hint?: string } | null;
  }>;
};

type PlatformPauseResult = {
  contractVersion: "platform.subscription.lifecycle.v1";
  subscriptionAction: {
    subscriptionId: string;
    action: "pause";
    status: "applied" | "replayed" | "noop";
    subscriptionStatus: "active" | "paused" | "cancelled";
    nextCycleAt: string | null;
    eventId: string | null;
  };
};

/** Direct-Postgres pause mutation; its caller supplies one actor-scoped gateway. */
export function createPostgresCustomerSubscriptionPausePort(
  gateway: RpcClient,
): CustomerSubscriptionActionPort {
  return {
    async applyAction(_userId, input) {
      assertSupportedPause(input);
      const { data, error } = await gateway.rpc(
        "customer_subscription_pause_as_actor",
        {
          p_subscription_id: input.subscriptionId,
          p_idempotency_key: input.idempotencyKey,
          p_pause_preset: "pausePreset" in input ? input.pausePreset : "indefinite",
          p_reason: input.reason ?? null,
        },
      );
      if (error) throw mapSubscriptionRpcError(error, { action: "pause" });
      if (data === null) return null;

      const platform = parsePlatformPauseResult(data);
      return customerSubscriptionActionResponseSchema.parse({
        contractVersion: "customer.self_service.v1",
        subscriptionAction: {
          ...platform.subscriptionAction,
          templateVersion: null,
        },
      }) as CustomerSubscriptionActionResponse;
    },
  };
}

function assertSupportedPause(
  input: CustomerSubscriptionActionRequest,
): asserts input is Extract<CustomerSubscriptionActionRequest, { action: "pause" }> {
  if (input.action !== "pause") {
    throw unsupported("node_postgres_pause_only");
  }
  if (("survey" in input && input.survey !== undefined)
    || ("saveOffer" in input && input.saveOffer !== undefined)) {
    throw unsupported("node_postgres_pause_metadata_unsupported");
  }
}

function unsupported(reason: string) {
  return new CustomerSubscriptionActionConflictError(
    "BAD_REQUEST",
    "Invalid customer subscription action request",
    { reason },
  );
}

function parsePlatformPauseResult(data: unknown): PlatformPauseResult {
  if (!data || typeof data !== "object") throw new Error("invalid_platform_pause_response");
  const value = data as Partial<PlatformPauseResult>;
  if (value.contractVersion !== "platform.subscription.lifecycle.v1"
    || !value.subscriptionAction
    || value.subscriptionAction.action !== "pause") {
    throw new Error("invalid_platform_pause_response");
  }
  return value as PlatformPauseResult;
}
