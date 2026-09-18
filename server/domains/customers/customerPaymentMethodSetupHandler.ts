import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CUSTOMER_PAYMENT_METHOD_SETUP_CONTRACT_VERSION,
  customerPaymentMethodSetupRequestSchema,
  customerPaymentMethodSetupResponseSchema,
} from "../../../src/domains/customers/paymentMethodSetupContracts.js";
import type { CustomerPaymentMethodSetupPort } from "./ports.js";

export interface CustomerUserAuthenticationResult {
  ok: true;
  userId: string;
}
export interface CustomerUserAuthenticationFailure {
  ok: false;
  code: "UNAUTHORIZED";
  message: string;
}

export interface StripeSetupIntentInput {
  customer: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}
export interface StripeSetupIntentResult {
  setupIntentId: string;
  clientSecret: string;
}

export interface CustomerPaymentMethodSetupHandlerDeps {
  enabled: () => boolean;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult | CustomerUserAuthenticationFailure>;
  setupPort: CustomerPaymentMethodSetupPort;
  createSetupIntent: (input: StripeSetupIntentInput) => Promise<StripeSetupIntentResult>;
  ensureCustomer: (input: { clientId: string; metadata: Record<string, string>; idempotencyKey: string }) => Promise<string>;
}

export function createCustomerPaymentMethodSetupHandler({
  enabled,
  authenticateUser,
  setupPort,
  createSetupIntent,
  ensureCustomer,
}: CustomerPaymentMethodSetupHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Card update is disabled", {
        details: { feature: "customer-payment-method-setup", reason: "feature_flag_disabled" },
      });
      return;
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const parsed = customerPaymentMethodSetupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid card-setup request", { details: parsed.error.flatten() });
      return;
    }

    const auth = await authenticateUser(req);
    if (!auth.ok) {
      sendBffError(res, "UNAUTHORIZED", "Customer session required");
      return;
    }

    const resolution = await setupPort.resolveSubscriptionForCardSetup({
      userId: auth.userId,
      subscriptionId: parsed.data.subscriptionId,
    });
    if (!resolution) {
      // Either the subscription is not owned by this customer, or the client is unknown.
      sendBffError(res, "FORBIDDEN", "Subscription is not available for a card update", {
        details: { reason: "subscription_not_owned_or_missing" },
      });
      return;
    }

    const metadata: Record<string, string> = {
      clientId: resolution.clientId,
      subscriptionId: resolution.subscriptionId,
      source: "account.card-update",
    };

    // Reuse the subscription's existing Stripe customer so invoice history stays intact;
    // mint a fresh one only when the subscription has never had a Stripe method (e.g. a
    // BLIK-only sub adding a card for the first time).
    const customer = resolution.providerCustomerRef
      ?? (await ensureCustomer({
        clientId: resolution.clientId,
        metadata,
        idempotencyKey: `account-card-customer:${resolution.subscriptionId}:${parsed.data.idempotencyKey}`,
      }));

    const setup = await createSetupIntent({
      customer,
      metadata,
      idempotencyKey: `account-card-setup:${resolution.subscriptionId}:${parsed.data.idempotencyKey}`,
    });

    const response = customerPaymentMethodSetupResponseSchema.parse({
      contractVersion: CUSTOMER_PAYMENT_METHOD_SETUP_CONTRACT_VERSION,
      setup: {
        clientSecret: setup.clientSecret,
        setupIntentId: setup.setupIntentId,
        subscriptionId: resolution.subscriptionId,
      },
    });
    sendBffSuccess(res, response, { contractVersion: CUSTOMER_PAYMENT_METHOD_SETUP_CONTRACT_VERSION });
  };
}
