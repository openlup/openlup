import {
  customerSubscriptionPreviewResponseSchema,
  type CustomerSubscriptionPreviewRequest,
  type CustomerSubscriptionPreviewResponse,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import {
  customerSubscriptionActionResponseSchema,
  type CustomerSubscriptionActionRequest,
  type CustomerSubscriptionActionResponse,
} from "../../../src/domains/customers/selfServiceContracts.js";
import {
  customerSubscriptionControlResponseSchema,
  type CustomerSubscriptionControlResponse,
} from "../../../src/domains/customers/subscriptionControlContracts.js";
import { CustomerSubscriptionActionConflictError } from "../../domains/customers/customerSubscriptionActionHandler.js";
import type {
  CustomerSubscriptionActionPort,
  CustomerSubscriptionControlPort,
  CustomerSubscriptionPreviewPort,
} from "../../domains/customers/ports.js";

type RpcError = { code?: string; message?: string; details?: string; hint?: string };
type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: RpcError | null;
  }>;
};

export interface PostgresCustomerSubscriptionControlPort
  extends CustomerSubscriptionActionPort,
    CustomerSubscriptionPreviewPort,
    CustomerSubscriptionControlPort {}

export function createPostgresCustomerSubscriptionControlPort(
  gateway: RpcClient,
): PostgresCustomerSubscriptionControlPort {
  return {
    async getSnapshot() {
      const { data, error } = await gateway.rpc(
        "customer_subscription_control_snapshot_as_actor",
      );
      if (error) throw mapControlError(error);
      if (data === null) return null;
      return customerSubscriptionControlResponseSchema.parse(
        data,
      ) as CustomerSubscriptionControlResponse;
    },

    async previewAction(_userId, input) {
      const action = requireBundleAction(input.subscriptionAction);
      const { data, error } = await gateway.rpc(
        "customer_subscription_preview_bundle_as_actor",
        previewArgs(action),
      );
      if (error) throw mapControlError(error);
      if (data === null) return null;
      return customerSubscriptionPreviewResponseSchema.parse(
        data,
      ) as CustomerSubscriptionPreviewResponse;
    },

    async applyAction(_userId, input) {
      const action = requireBundleAction(input);
      if (!action.acceptedQuoteHash) {
        throw conflict("subscription_edit_quote_required", "BAD_REQUEST");
      }
      const { data, error } = await gateway.rpc(
        "customer_subscription_apply_bundle_as_actor",
        {
          ...previewArgs(action),
          p_accepted_quote_hash: action.acceptedQuoteHash,
        },
      );
      if (error) throw mapControlError(error);
      if (data === null) return null;
      return customerSubscriptionActionResponseSchema.parse(
        data,
      ) as CustomerSubscriptionActionResponse;
    },
  };
}

type BundleAction = Extract<CustomerSubscriptionActionRequest, { action: "update_bundle" }>;

function requireBundleAction(input: CustomerSubscriptionActionRequest): BundleAction {
  if (input.action !== "update_bundle") {
    throw conflict("node_postgres_subscription_edit_action_unsupported", "BAD_REQUEST");
  }
  return input;
}

function previewArgs(action: BundleAction) {
  return {
    p_subscription_id: action.subscriptionId,
    p_idempotency_key: action.idempotencyKey,
    p_core_lines: JSON.stringify(action.coreLines),
    p_addon_lines: JSON.stringify(action.addonLines ?? []),
    p_composition_constraint: JSON.stringify(action.compositionConstraint),
    p_cadence_days: action.cadenceDays ?? null,
    p_expected_template_version: action.expectedTemplateVersion ?? null,
  };
}

function mapControlError(error: RpcError) {
  const reason = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .match(/subscription_edit_[a-z_]+/)?.[0];
  if (!reason) return error;
  return conflict(
    reason,
    reason.includes("invalid_") || reason.endsWith("quote_required")
      ? "BAD_REQUEST"
      : "CONFLICT",
  );
}

function conflict(
  reason: string,
  code: "CONFLICT" | "BAD_REQUEST" = "CONFLICT",
) {
  return new CustomerSubscriptionActionConflictError(
    code,
    code === "BAD_REQUEST"
      ? "Invalid customer subscription action request"
      : "Customer subscription action is not allowed",
    { reason },
  );
}
