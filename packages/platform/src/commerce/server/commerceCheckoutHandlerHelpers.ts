import type { z } from "zod";
import type { HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import { projectPublicQuoteSnapshot } from "../../pricing/index.js";
import { CHECKOUT_CONTRACT_VERSION } from "../checkoutSchemas.js";
import type { CheckoutKind, ConfiguratorIntentPersistencePort, ConfiguratorIntent as NeutralIntent } from "../contracts/index.js";
import { ConfiguratorIntentPersistenceConflictError } from "./configuratorIntentPersistenceHandler.js";
import type { OrchestratedCheckoutResult } from "./commercePaidOrderOrchestration.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
import type { CheckoutExecutionProvider } from "./checkoutRuntimeTypes.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
import { subscriptionResponse, type CheckoutResumeGuardDeps } from "./commerceCheckoutResumeGuard.js";
import type { ResolveSavedMethodResult } from "./commerceCheckoutSavedPaymentMethod.js";
const ACCOUNT_LINK_TIMEOUT_MS = 1500;
export async function runBestEffortAccountLink(
  linkCustomerAccount: (email: string) => Promise<void>,
  email: string,
  context?: { trigger: string },
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
      console.warn("checkout_account_link_timed_out", JSON.stringify({ ...context }));
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createCheckoutHandlerHelpers<Intent extends NeutralIntent, Provisioned extends { clientId: string }, Snapshot extends CheckoutQuoteSnapshot, Response>(bindings: {
  checkoutClientAction(input: { provider: string; status: "paid" | "processing" | "failed"; providerClientSecret: string | null; providerRedirectUrl: string | null }): unknown;
  responder: BffResponder; responseSchema: z.ZodType<Response>;
  statusUrl(orderId: string, paymentIntentId: string, clientId: string): string;
  resolveResumeOpenOrderResponse(input: { deps: CheckoutResumeGuardDeps; clientId: string; checkoutKind: CheckoutKind; intent: Intent; now: () => Date }): Promise<Response | null>;
}) {
  const { sendBffError, sendBffSuccess } = bindings.responder;


async function persistCheckoutIdentityOrRespond(input: {
  res: HttpResponse;
  persistencePort: ConfiguratorIntentPersistencePort<Intent, Provisioned>;
  resumeGuardDeps: CheckoutResumeGuardDeps;
  intent: Intent;
  checkoutKind: CheckoutKind;
  now: () => Date;
  previewDiagnosticsEnabled: boolean;
  recordPersistStage: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<
  | { kind: "provisioned"; provisioned: Provisioned }
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

function respondToSavedPaymentMethodRejection(
  res: HttpResponse,
  reason: Extract<ResolveSavedMethodResult, { kind: "rejected" }>["reason"],
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

function buildCheckoutSuccessResponse(input: {
  orchestrated: OrchestratedCheckoutResult<Snapshot>;
  paymentProvider: CheckoutExecutionProvider;
  checkoutKind: CheckoutKind;
  intent: Intent;
  clientId: string;
}): Response {
  const { orchestrated, paymentProvider, checkoutKind, intent, clientId } = input;
  const { orderId, paymentIntentId, providerClientSecret, providerPaymentId, providerRedirectUrl, status } =
    orchestrated;

  const clientAction = bindings.checkoutClientAction({
    provider: paymentProvider,
    status,
    providerClientSecret,
    providerRedirectUrl,
  });
  const statusUrl =
    status === "processing"
      ? bindings.statusUrl(orderId, paymentIntentId, clientId)
      : undefined;

  return bindings.responseSchema.parse({
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

async function respondToProvisionIdentityConflict(input: {
  res: HttpResponse;
  persistencePort: ConfiguratorIntentPersistencePort<Intent, Provisioned>;
  resumeGuardDeps: CheckoutResumeGuardDeps;
  intent: Intent;
  checkoutKind: CheckoutKind;
  now: () => Date;
}): Promise<void> {
  const { res, persistencePort, resumeGuardDeps, intent, checkoutKind, now } = input;
  const existing = await resolveCompletedIdentity(persistencePort, intent.idempotencyKey);
  if (existing) {
    // No `acceptedQuote`: this path runs before any quote, and deliberately so.
    // (persist-intent updates the identity in place), so what survives to this
    // point is a double-submit race — same payload, twice — where resuming IS
    // the duplicate-charge guard. See the parameter's docblock.
    const resumeResponse = await bindings.resolveResumeOpenOrderResponse({
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

async function resolveCompletedIdentity(
  port: ConfiguratorIntentPersistencePort<Intent, Provisioned>,
  idempotencyKey: string,
): Promise<Provisioned | null> {
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

return { persistCheckoutIdentityOrRespond, respondToSavedPaymentMethodRejection, buildCheckoutSuccessResponse, respondToProvisionIdentityConflict };
}
