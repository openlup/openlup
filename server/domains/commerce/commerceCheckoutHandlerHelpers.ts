import {
  CHECKOUT_CONTRACT_VERSION,
  checkoutResponseSchema,
  type CheckoutKind,
  type CheckoutResponse,
} from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
import type { PaymentExecutionProvider } from "../../../src/domains/payment/types.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess } from "../../_lib/bff/response.js";
import type { OrchestratedCheckoutResult } from "./commerceCheckoutOrchestration.js";
import { checkoutClientAction } from "./commerceCheckoutProviderPayment.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
import {
  resolveResumeOpenOrderResponse,
  type CheckoutResumeGuardDeps,
} from "./commerceCheckoutResumeGuard.js";
import type { ResolveSavedTpayMethodResult } from "./commerceCheckoutSavedPaymentMethod.js";
import { ConfiguratorIntentPersistenceConflictError } from "./configuratorIntentPersistenceHandler.js";
import { projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";

const ACCOUNT_LINK_TIMEOUT_MS = 1500;

export function isDhlCourierDelivery(intent: ConfiguratorIntent): boolean {
  const delivery = intent.selectedDelivery;
  return (
    delivery.kind === "courier" &&
    (!delivery.providerKind || delivery.providerKind === "dhl") &&
    delivery.carrierKind === "dhl" &&
    delivery.service === "dhl_courier_standard" &&
    !delivery.providerRef &&
    !delivery.pickupPoint
  );
}

export function subscriptionResponse(
  intent: ConfiguratorIntent,
  checkoutKind: CheckoutKind,
) {
  if (checkoutKind === "one_time") {
    return {
      requested: false,
      cadenceDays: null,
      activationStatus: "not_applicable" as const,
    };
  }

  return {
    requested: true,
    cadenceDays: intent.cadenceDays,
    activationStatus: "pending_payment_success" as const,
  };
}

export async function runBestEffortAccountLink(
  linkCustomerAccount: (email: string) => Promise<void>,
  email: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      linkCustomerAccount(email).then(() => "completed" as const),
      new Promise<"timed_out">((resolve) => {
        timeout = setTimeout(() => resolve("timed_out"), ACCOUNT_LINK_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timed_out") {
      console.warn("checkout_account_link_timed_out", JSON.stringify({}));
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function persistCheckoutIdentityOrRespond(input: {
  res: VercelResponse;
  persistencePort: ConfiguratorIntentPersistencePort;
  resumeGuardDeps: CheckoutResumeGuardDeps;
  intent: ConfiguratorIntent;
  checkoutKind: CheckoutKind;
  now: () => Date;
  previewDiagnosticsEnabled: boolean;
  recordPersistStage: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<
  | { kind: "provisioned"; provisioned: ConfiguratorIntentPersistenceResponse }
  | { kind: "responded"; outcome: "error" | "rejected" }
> {
  const { res, persistencePort, resumeGuardDeps, intent, checkoutKind, now } = input;
  try {
    return {
      kind: "provisioned",
      provisioned: await input.recordPersistStage(() => persistencePort.persistIntent(intent)),
    };
  } catch (error) {
    if (error instanceof ConfiguratorIntentPersistenceConflictError) {
      await respondToProvisionIdentityConflict({
        res,
        persistencePort,
        resumeGuardDeps,
        intent,
        checkoutKind,
        now,
      });
      return { kind: "responded", outcome: "rejected" };
    }
    const provisioningCause = safeCommerceDiagnosticValue(
      error instanceof Error ? error.message : String(error),
    );
    console.error(
      "checkout_identity_provisioning_failed",
      JSON.stringify({ message: provisioningCause }),
    );
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout identity provisioning failed", {
      details: {
        feature: "checkout",
        stage: "provision_identity",
        ...(input.previewDiagnosticsEnabled && provisioningCause
          ? { diagnostic: provisioningCause }
          : {}),
      },
    });
    return { kind: "responded", outcome: "error" };
  }
}

export function respondToSavedPaymentMethodRejection(
  res: VercelResponse,
  reason: Extract<ResolveSavedTpayMethodResult, { kind: "rejected" }>["reason"],
): void {
  if (reason === "saved_payment_method_resolver_unavailable") {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Saved payment method resolver is unavailable", {
      details: { feature: "checkout", reason },
    });
    return;
  }
  if (reason === "saved_payment_method_session_required") {
    sendBffError(res, "UNAUTHORIZED", "Customer session required", {
      details: { feature: "checkout", reason },
    });
    return;
  }
  if (reason === "saved_payment_method_read_failed") {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Saved payment method read failed", {
      details: { feature: "checkout", reason },
    });
    return;
  }
  sendBffError(res, "BAD_REQUEST", "Saved payment method is unavailable", {
    details: { feature: "checkout", reason },
  });
}

/**
 * Assemble the validated checkout response from an orchestration result. Extracted
 * from the handler so the handler stays within its LOC budget. `statusUrl` is
 * surfaced only for the async `processing` path; `clientId` is included on
 * success responses so the FE can fetch owned post-payment recaps.
 */
export function buildCheckoutSuccessResponse(input: {
  orchestrated: OrchestratedCheckoutResult;
  paymentProvider: PaymentExecutionProvider;
  checkoutKind: CheckoutKind;
  intent: ConfiguratorIntent;
  clientId: string;
}): CheckoutResponse {
  const { orchestrated, paymentProvider, checkoutKind, intent, clientId } = input;
  const { orderId, paymentIntentId, providerClientSecret, providerPaymentId, providerRedirectUrl, status } =
    orchestrated;

  const clientAction = checkoutClientAction({
    provider: paymentProvider,
    status,
    providerClientSecret,
    providerRedirectUrl,
  });
  const statusUrl =
    status === "processing"
      ? `/api/bff/commerce/payment-status?orderId=${encodeURIComponent(orderId)}&paymentIntentId=${encodeURIComponent(paymentIntentId)}&clientId=${encodeURIComponent(clientId)}`
      : undefined;

  return checkoutResponseSchema.parse({
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    checkoutKind,
    orderRef: `order_${orderId}`,
    orderId,
    status,
    paymentIntentId,
    ...(providerPaymentId ? { providerPaymentId } : {}),
    clientId,
    clientAction,
    ...(statusUrl ? { statusUrl } : {}),
    subscription: subscriptionResponse(intent, checkoutKind),
    payment: { requiresReusablePaymentMethod: checkoutKind === "subscription_initial" },
    authoritativeQuote: projectPublicQuoteSnapshot(orchestrated.quoteSnapshot),
  });
}

/**
 * Respond to a persist-intent idempotency CONFLICT (same idempotencyKey, mutated
 * payload — e.g. a resubmit whose volatile field shifted, a re-quote, or a
 * double-submit race). The conflict is DETERMINISTIC, not transient: surfacing it
 * as a 503 "try again" makes the client hammer the endpoint. Recover the identity
 * already minted for the key and resume the client's in-flight order; if nothing
 * is resumable, send a non-transient 409 so the FE stops retrying. Extracted from
 * the handler to keep it within its LOC budget; owns sending the response.
 */
export async function respondToProvisionIdentityConflict(input: {
  res: VercelResponse;
  persistencePort: ConfiguratorIntentPersistencePort;
  resumeGuardDeps: CheckoutResumeGuardDeps;
  intent: ConfiguratorIntent;
  checkoutKind: CheckoutKind;
  now: () => Date;
}): Promise<void> {
  const { res, persistencePort, resumeGuardDeps, intent, checkoutKind, now } = input;
  const existing = await resolveCompletedIdentity(persistencePort, intent.idempotencyKey);
  if (existing) {
    // No `acceptedQuote`: this path runs before any quote, and deliberately so.
    // Since 20260714201100 an ordinary cart edit no longer conflicts here at all
    // (persist-intent updates the identity in place), so what survives to this
    // point is a double-submit race — same payload, twice — where resuming IS
    // the duplicate-charge guard. See the parameter's docblock.
    const resumeResponse = await resolveResumeOpenOrderResponse({
      deps: resumeGuardDeps,
      clientId: existing.clientId,
      checkoutKind,
      intent,
      now,
    });
    if (resumeResponse) {
      sendBffSuccess(res, resumeResponse, { contractVersion: CHECKOUT_CONTRACT_VERSION });
      return;
    }
  }
  console.warn(
    "checkout_identity_provisioning_conflict",
    JSON.stringify({ stage: "provision_identity", resumed: false }),
  );
  sendBffError(res, "CONFLICT", "Checkout already submitted", {
    details: {
      feature: "checkout",
      stage: "provision_identity",
      reason: "checkout_already_submitted",
    },
  });
}

/**
 * Best-effort lookup of the identity already minted for a completed idempotency
 * key. Returns null when the port cannot resolve it (capability absent OR a
 * lookup error) — the caller then degrades to a non-transient 409 rather than
 * failing closed.
 */
async function resolveCompletedIdentity(
  port: ConfiguratorIntentPersistencePort,
  idempotencyKey: string,
): Promise<ConfiguratorIntentPersistenceResponse | null> {
  if (!port.findCompletedIdentity) return null;
  try {
    return await port.findCompletedIdentity(idempotencyKey);
  } catch (error) {
    console.warn(
      "checkout_identity_conflict_lookup_failed",
      JSON.stringify({
        message: safeCommerceDiagnosticValue(
          error instanceof Error ? error.message : String(error),
        ),
      }),
    );
    return null;
  }
}
