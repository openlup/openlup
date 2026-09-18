import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import { CustomerSubscriptionActionConflictError } from "./customerSubscriptionActionHandler.js";

export type SubscriptionProtocolAction = CustomerSubscriptionActionRequest & {
  action: CustomerSubscriptionActionRequest["action"] | "update_bundle" | "resize_bundle";
  protocolSourceAction?: CustomerSubscriptionActionRequest["action"];
};

export function resolveSubscriptionBundleActionProtocol(
  input: CustomerSubscriptionActionRequest,
  genericBundleActionsEnabled: boolean,
): SubscriptionProtocolAction {
  if (isGenericBundleAction(input.action)) {
    if (!genericBundleActionsEnabled) {
      throw new CustomerSubscriptionActionConflictError("BAD_REQUEST", "generic_bundle_actions_disabled");
    }
    return input as SubscriptionProtocolAction;
  }

  if (!genericBundleActionsEnabled) return input as SubscriptionProtocolAction;

  if (input.action === "update_recipe_mix") {
    return {
      action: "update_bundle",
      idempotencyKey: input.idempotencyKey,
      subscriptionId: input.subscriptionId,
      coreLines: input.recipes,
      ...quoteLockFields(input),
      protocolSourceAction: input.action,
    } as SubscriptionProtocolAction;
  }

  if (input.action === "update_plan_length") {
    return {
      action: "resize_bundle",
      idempotencyKey: input.idempotencyKey,
      subscriptionId: input.subscriptionId,
      cadenceDays: input.planDays,
      resizeLever: { kind: "planLength", value: input.planDays },
      ...quoteLockFields(input),
      protocolSourceAction: input.action,
    } as SubscriptionProtocolAction;
  }

  if (input.action === "set_portion_mode") {
    return {
      action: "resize_bundle",
      idempotencyKey: input.idempotencyKey,
      subscriptionId: input.subscriptionId,
      resizeLever: { kind: "portionMode", value: { portionMode: input.portionMode } },
      ...quoteLockFields(input),
      protocolSourceAction: input.action,
    } as SubscriptionProtocolAction;
  }

  if (input.action === "update_package_template") {
    return {
      action: "update_bundle",
      idempotencyKey: input.idempotencyKey,
      subscriptionId: input.subscriptionId,
      coreLines: input.recipes,
      addonLines: input.addons.map((line) => ({ ...line, isAddon: true })),
      cadenceDays: input.planDays,
      ...quoteLockFields(input),
      protocolSourceAction: input.action,
    } as SubscriptionProtocolAction;
  }

  return input as SubscriptionProtocolAction;
}

export function isGenericBundleAction(action: string): action is "update_bundle" | "resize_bundle" {
  return action === "update_bundle" || action === "resize_bundle";
}

function quoteLockFields(input: CustomerSubscriptionActionRequest): {
  expectedTemplateVersion?: number;
  acceptedQuoteHash?: string;
} {
  const maybe = input as { expectedTemplateVersion?: unknown; acceptedQuoteHash?: unknown };
  return {
    ...(typeof maybe.expectedTemplateVersion === "number"
      ? { expectedTemplateVersion: maybe.expectedTemplateVersion }
      : {}),
    ...(typeof maybe.acceptedQuoteHash === "string"
      ? { acceptedQuoteHash: maybe.acceptedQuoteHash }
      : {}),
  };
}
