import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerSubscriptionActionRequest,
  CustomerSubscriptionActionResponse,
} from "../../../src/domains/customers/selfServiceContracts.js";
import {
  mapSubscriptionRepriceError,
  mapSubscriptionRpcError,
} from "../../domains/customers/subscriptionActionErrorMapping.js";
import { withSubscriptionRepricePayload } from "../../domains/customers/subscriptionActionRepricePayload.js";
import { subscriptionActionPayload } from "../../domains/customers/customerSelfServiceClientModels.js";
import type { SubscriptionRepricer } from "./subscriptionEditReprice.js";
import { resolveSubscriptionBundleActionProtocol } from "../../domains/customers/subscriptionGenericBundleActions.js";

export async function applyCustomerSubscriptionAction({
  serviceClient,
  subscriptionRepricer,
  genericBundleActionsEnabled,
  userId,
  input,
}: {
  serviceClient: SupabaseClient;
  subscriptionRepricer?: SubscriptionRepricer;
  genericBundleActionsEnabled: boolean;
  userId: string;
  input: CustomerSubscriptionActionRequest;
}): Promise<CustomerSubscriptionActionResponse> {
  const protocolInput = resolveSubscriptionBundleActionProtocol(input, genericBundleActionsEnabled);
  let payload = subscriptionActionPayload(protocolInput);
  try {
    payload = await withSubscriptionRepricePayload(subscriptionRepricer, protocolInput, payload);
  } catch (repriceError) {
    throw mapSubscriptionRepriceError(repriceError, protocolInput.action);
  }
  const { data, error } = await serviceClient.rpc("customer_self_service_apply_subscription_action", {
    p_auth_user_id: userId,
    p_idempotency_key: protocolInput.idempotencyKey,
    p_subscription_id: protocolInput.subscriptionId,
    p_action: protocolInput.action,
    p_payload: payload,
    p_requested_at: new Date().toISOString(),
  });
  if (error) throw mapSubscriptionRpcError(error, { action: protocolInput.action });
  return data as CustomerSubscriptionActionResponse;
}
