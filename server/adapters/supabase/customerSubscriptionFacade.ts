import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import type {
  CustomerPaymentRecoveryStartResponse,
  CustomerSubscriptionPreviewResponse,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type {
  CustomerPaymentRecoveryStartPort,
  CustomerSubscriptionPreviewPort,
} from "../../domains/customers/ports.js";
import {
  readSubscriptionBlockers,
  type CustomerSubscriptionEligibilityInput,
} from "./customerAccountV2ReadModels.js";
import type { SubscriptionRepricer } from "./subscriptionEditReprice.js";
import { dateAvailability } from "../../domains/customers/subscriptionDateAvailability.js";
import {
  actionEligibility,
  previewTelemetry,
  resolvePreviewPaymentMethodStatus,
} from "./customerSubscriptionPreviewTelemetry.js";
import { attachSubscriptionPreviewQuote } from "./customerSubscriptionPreviewQuoteLedger.js";
import { readSingleSubscriptionPaymentMethodEvidence } from "./customerSubscriptionPaymentMethodReadModel.js";
import { resolveSubscriptionBundleActionProtocol } from "../../domains/customers/subscriptionGenericBundleActions.js";
import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";

interface SubscriptionFacadeDeps {
  customerClient: SupabaseClient;
  serviceClient: SupabaseClient;
  subscriptionRepricer?: SubscriptionRepricer;
  genericBundleActionsEnabled?: boolean;
}

type SubscriptionFacadePort = CustomerSubscriptionPreviewPort & CustomerPaymentRecoveryStartPort;

export function createSupabaseCustomerSubscriptionFacadePort({
  customerClient,
  serviceClient,
  subscriptionRepricer,
  genericBundleActionsEnabled = false,
}: SubscriptionFacadeDeps): SubscriptionFacadePort {
  return {
    async previewAction(userId, input) {
      const client = await readLinkedClient(customerClient, userId);
      if (!client) return null;
      const action = resolveSubscriptionBundleActionProtocol(
        input.subscriptionAction as CustomerSubscriptionActionRequest,
        genericBundleActionsEnabled,
      );
      const subscription = await readOwnedSubscription(customerClient, client.id, action.subscriptionId);
      if (!subscription) return null;
      // Ownership is established above. Start the independent account reads together,
      // then await them in the historic order so their error precedence stays stable.
      const paymentEvidencePromise = readSingleSubscriptionPaymentMethodEvidence(
        serviceClient,
        action.subscriptionId,
      );
      const nextCycleAt = nullableText(subscription.next_cycle_at);
      const blockersPromise = readSubscriptionBlockers(
        serviceClient,
        [action.subscriptionId],
        new Map([[action.subscriptionId, nextCycleAt]]),
      );
      const addressOwnershipPromise = action.action === "change_shipping_address"
        ? hasOwnedShippingAddress(customerClient, client.id, action.shippingAddressId)
        : Promise.resolve(true);
      const [paymentEvidenceResult, blockersResult, addressOwnershipResult] = await Promise.allSettled([
        paymentEvidencePromise,
        blockersPromise,
        addressOwnershipPromise,
      ]);
      // Retain the historic payment-evidence → blockers → address error order
      // while also observing every started promise (no unhandled rejections).
      const paymentEvidence = settledValue(paymentEvidenceResult);
      const blockers = settledValue(blockersResult);
      const hasOwnedAddress = settledValue(addressOwnershipResult);
      const subscriptionWithPaymentEvidence = {
        ...subscription,
        client_id: client.id,
        payer_email: nullableText(client.email),
        payment_method_client_id: paymentEvidence?.clientId ?? null,
        provider_kind: paymentEvidence?.providerKind ?? null,
        provider_customer_ref: paymentEvidence?.providerCustomerRef ?? null,
        provider_method_ref: paymentEvidence?.providerMethodRef ?? null,
        provider_method_kind: paymentEvidence?.methodKind ?? null,
        payment_method_status: paymentEvidence?.status ?? null,
        payment_method_active: paymentEvidence?.active ?? null,
        payment_method_expires_at: paymentEvidence?.expiresAt ?? null,
      };
      const editCutoffAt = editCutoff(
        nextCycleAt,
        numberOrNull(subscription.edit_window_hours),
      );
      const paymentMethodStatus = resolvePreviewPaymentMethodStatus(subscriptionWithPaymentEvidence);
      const eligibilityInput: CustomerSubscriptionEligibilityInput = {
        subscriptionId: action.subscriptionId,
        status: text(subscription.status) as CustomerSubscriptionEligibilityInput["status"],
        nextCycleAt,
        editCutoffAt,
        paymentMethodKind: nullableText(subscription.payment_method_kind),
        paymentMethodRefPresent: Boolean(nullableText(subscription.payment_method_ref)),
        paymentMethodStatus,
      };
      const preview = action.action === "change_shipping_address" && !hasOwnedAddress
        ? { canEdit: false, reason: "invalid_address" as const }
        : actionEligibility(action.action, eligibilityInput, blockers);
      const telemetry = previewTelemetry({
        action,
        subscription: subscriptionWithPaymentEvidence,
        nextCycleAt,
        blocker: blockers.get(action.subscriptionId),
        previewReason: preview.reason,
        paymentMethodStatus,
      });
      const response: CustomerSubscriptionPreviewResponse = {
        preview: {
          subscriptionId: action.subscriptionId,
          action: action.action,
          canApply: preview.canEdit,
          blockedReason: preview.reason,
          nextCycleAt: eligibilityInput.nextCycleAt,
          editCutoffAt,
            templateVersion: numberOrNull(subscription.template_version),
            ...telemetry,
        },
      };
      if (action.action === "slide_next_cycle") {
        response.preview.dateAvailability = dateAvailability(preview.reason);
      }
      await attachSubscriptionPreviewQuote({
        userId,
        serviceClient,
        subscriptionRepricer,
        action,
        canApply: preview.canEdit,
        nextCycleAt,
        response,
      });
      return response;
    },

    async startPaymentRecovery(userId, input) {
      const client = await readLinkedClient(customerClient, userId);
      if (!client) return null;
      const subscription = await readOwnedSubscription(customerClient, client.id, input.subscriptionId);
      if (!subscription) {
        return { recoverable: false, reason: "subscription_not_found" } satisfies CustomerPaymentRecoveryStartResponse;
      }
      const recovery = await issueCustomerRecoveryToken(serviceClient, input.subscriptionId);
      if (!recovery) {
        return { recoverable: false, reason: "no_open_dunning_case" } satisfies CustomerPaymentRecoveryStartResponse;
      }
      await requeueLatestCustomerDunningNotification(serviceClient, input.subscriptionId);
      return recovery satisfies CustomerPaymentRecoveryStartResponse;
    },
  };
}

async function hasOwnedShippingAddress(client: SupabaseClient, clientId: string, addressId: string) {
  const { data, error } = await client
    .from("addresses")
    .select("id")
    .eq("id", addressId)
    .eq("client_id", clientId)
    .in("kind", ["shipping", "both"])
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

async function readLinkedClient(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("clients")
    .select("id, email")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; email: string | null } | null;
}

async function readOwnedSubscription(client: SupabaseClient, clientId: string, subscriptionId: string) {
  const { data, error } = await client
    .from("subscriptions")
    .select("id, status, next_cycle_at, edit_window_hours, payment_method_kind, payment_method_ref, template_version")
    .eq("id", subscriptionId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

async function requeueLatestCustomerDunningNotification(
  serviceClient: SupabaseClient,
  subscriptionId: string,
): Promise<void> {
  const { data: caseRow, error: caseError } = await serviceClient
    .from("subscription_dunning_cases")
    .select("id")
    .eq("subscription_id", subscriptionId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (caseError) throw caseError;
  const caseId = isRecord(caseRow) ? nullableText(caseRow.id) : null;
  if (!caseId) return;

  const now = new Date().toISOString();
  const { error } = await serviceClient
    .from("subscription_dunning_notifications")
    .update({
      status: "queued",
      scheduled_at: now,
      provider_error: null,
      send_attempts: 0,
      updated_at: now,
    })
    .eq("case_id", caseId)
    .eq("recipient_kind", "customer")
    .in("notification_kind", ["payment_failed", "payment_expired"]);
  if (error) throw error;
}

async function issueCustomerRecoveryToken(
  serviceClient: SupabaseClient,
  subscriptionId: string,
): Promise<CustomerPaymentRecoveryStartResponse | null> {
  const { data: caseRow, error: caseError } = await serviceClient
    .from("subscription_dunning_cases")
    .select("id, subscription_id, cycle_id, order_id, client_id, status, next_retry_at")
    .eq("subscription_id", subscriptionId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (caseError) throw caseError;
  if (!isRecord(caseRow)) return null;

  const caseId = text(caseRow.id);
  const clientId = text(caseRow.client_id);
  if (!caseId || !clientId) return null;

  const token = `rcv_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error: tokenError } = await serviceClient.rpc("subscription_rotate_payment_recovery_token", {
    p_case_id: caseId,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
    p_source: "customer_payment_recovery_start",
  });
  if (tokenError) {
    return { recoverable: false, reason: "token_issue_failed" };
  }

  return {
    recoverable: true,
    recoveryUrlPath: `/konto/platnosc/napraw?token=${encodeURIComponent(token)}`,
    caseId,
    expiresAt,
    nextRetryAt: nullableText(caseRow.next_retry_at),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function editCutoff(nextCycleAt: string | null, editWindowHours: number | null): string | null {
  if (!nextCycleAt) return null;
  const date = new Date(nextCycleAt);
  date.setHours(date.getHours() - (editWindowHours ?? 72));
  return date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
