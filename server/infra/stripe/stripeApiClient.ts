import Stripe from "stripe";
import { mapStripeIntent, mapSetupIntent, createStripeSandboxPaymentExecutionAdapter,
  createStripePaymentReconciliationProvider } from "@openlup/platform/payments/stripe";

type StripeSandboxClient = Parameters<typeof createStripeSandboxPaymentExecutionAdapter>[0]["client"];
type StripeReader = Parameters<typeof createStripePaymentReconciliationProvider>[0];
type StripeIntentLike = ReturnType<typeof mapStripeIntent>;
const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;
const DEFAULT_STRIPE_TIMEOUT_MS = 10_000;
const DEFAULT_STRIPE_MAX_NETWORK_RETRIES = 0;
const STRIPE_PAGE_SIZE = 100;
const MAX_BALANCE_TRANSACTION_PAGES = 2;
type StripeClientConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>;

type StripePayoutSettlementItem = {
  payoutId: string;
  balanceTransactionId: string;
  providerPaymentId: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  bankReceivedAt: string;
};

interface StripePayoutSettlementReader {
  listRecentSettledPayoutItems(limit: number): Promise<StripePayoutSettlementItem[]>;
}

export interface StripeApiClientOptions {
  secretKey: string;
  apiVersion?: typeof STRIPE_API_VERSION;
  timeoutMs?: number;
  maxNetworkRetries?: number;
}

export function createStripeApiClient(
  options: StripeApiClientOptions,
): StripeSandboxClient & Required<StripeReader> & StripePayoutSettlementReader {
  const stripe = new Stripe(options.secretKey, {
    apiVersion: (options.apiVersion ?? STRIPE_API_VERSION) as StripeClientConfig["apiVersion"],
    typescript: true,
    timeout: options.timeoutMs ?? DEFAULT_STRIPE_TIMEOUT_MS,
    maxNetworkRetries: options.maxNetworkRetries ?? DEFAULT_STRIPE_MAX_NETWORK_RETRIES,
  });

  return {
    async createPaymentIntent(input, { idempotencyKey }): Promise<StripeIntentLike> {
      // Interactive (Payment Element) checkout passes no `paymentMethod`: the FE
      // collects it. For that path we pin the offered methods to `["card"]` —
      // the precise "card + wallets" contract. Apple Pay / Google Pay are
      // wallet presentations of the card method, so they still render in the
      // element; 3DS (`use_stripe_sdk`) is an in-page challenge, not a separate
      // method, so SCA is unaffected. Everything else the Stripe Dashboard may
      // enable for the currency — Klarna (redirect) AND non-redirect methods
      // like Stripe BLIK in PLN — is excluded, matching what the configurator
      // advertises: "Karta (Visa, Mastercard, Apple Pay, Google Pay)". (An
      // `automatic_payment_methods` + `allow_redirects: "never"` approach would
      // still leak non-redirect methods, so we pin the type explicitly.)
      //
      // The off-session / recurring path (saved `paymentMethod` present) charges
      // a concrete saved method, not the element — and Stripe HARD-REJECTS
      // `off_session: true` unless `confirm: true` is set too ("The parameter
      // `off_session` cannot be passed when creating a PaymentIntent unless
      // `confirm` is set to true."). There is no FE to confirm a renewal, so we
      // confirm server-side here. The interactive Payment-Element path (no
      // `paymentMethod`) is confirmed by the FE with the returned client_secret,
      // so it MUST NOT set `confirm`. Gated on `offSession` specifically so the
      // on-session saved-method flow (FE-confirmed) is left untouched.
      const usesPaymentElement = !input.paymentMethod;
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency,
          customer: input.customer,
          payment_method: input.paymentMethod,
          off_session: input.offSession,
          setup_future_usage: input.setupFutureUsage,
          metadata: input.metadata,
          ...(usesPaymentElement ? { payment_method_types: ["card"] } : {}),
          ...(input.offSession ? { confirm: true } : {}),
        },
        { idempotencyKey },
      );
      return mapStripeIntent(intent, usesPaymentElement, "execution");
    },

    async createSetupIntent(input, { idempotencyKey }): Promise<StripeIntentLike> {
      const intent = await stripe.setupIntents.create(
        {
          customer: input.customer,
          payment_method: input.paymentMethod,
          usage: input.usage,
          metadata: input.metadata,
        },
        { idempotencyKey },
      );
      return mapSetupIntent(intent);
    },

    async ensureCustomer(input, { idempotencyKey }): Promise<string> {
      const customer = await stripe.customers.create(
        { metadata: input.metadata },
        { idempotencyKey },
      );
      return customer.id;
    },

    async retrievePaymentIntent(paymentIntentId): Promise<StripeIntentLike> {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return mapStripeIntent(intent);
    },

    async cancelPaymentIntent(paymentIntentId): Promise<StripeIntentLike> {
      const intent = await stripe.paymentIntents.cancel(paymentIntentId);
      return mapStripeIntent(intent);
    },

    async searchPaymentIntentsByMetadata(input): Promise<{ ids: string[] }> {
      // Values are our own UUIDs/refs; escape single quotes defensively so a
      // future non-UUID value cannot break out of the query literal.
      const value = input.value.replace(/'/g, "\\'");
      const result = await stripe.paymentIntents.search({
        query: `metadata['${input.key}']:'${value}'`,
        limit: input.limit ?? 1,
      });
      return { ids: result.data.map((intent) => intent.id) };
    },

    async listRecentSettledPayoutItems(limit): Promise<StripePayoutSettlementItem[]> {
      const payouts = await stripe.payouts.list({
        limit: Math.max(1, Math.min(STRIPE_PAGE_SIZE, Math.trunc(limit))),
        status: "paid",
      });
      const items: StripePayoutSettlementItem[] = [];
      for (const payout of payouts.data) {
        if (payout.status !== "paid" || payout.reconciliation_status !== "completed") continue;
        items.push(...await readPayoutChargeTransactions(stripe, payout));
      }
      return items;
    },
  };
}

async function readPayoutChargeTransactions(
  stripe: Stripe,
  payout: Stripe.Payout,
): Promise<StripePayoutSettlementItem[]> {
  const items: StripePayoutSettlementItem[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_BALANCE_TRANSACTION_PAGES; page += 1) {
    const transactions = await stripe.balanceTransactions.list({
      payout: payout.id,
      type: "charge",
      limit: STRIPE_PAGE_SIZE,
      expand: ["data.source"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const transaction of transactions.data) {
      const charge = chargeSettlementRef(transaction.source);
      if (!charge || transaction.amount < 0 || transaction.fee < 0 || transaction.net < 0) continue;
      if (charge.amount !== transaction.amount || charge.currency !== transaction.currency.toUpperCase()) continue;
      items.push({
        payoutId: payout.id,
        balanceTransactionId: transaction.id,
        providerPaymentId: charge.paymentIntentId,
        grossMinor: transaction.amount,
        feeMinor: transaction.fee,
        netMinor: transaction.net,
        currency: transaction.currency.toUpperCase(),
        bankReceivedAt: new Date(payout.arrival_date * 1000).toISOString(),
      });
    }
    if (!transactions.has_more) return items;
    startingAfter = transactions.data.at(-1)?.id;
    if (!startingAfter) return items;
  }
  throw new Error(`stripe_settlement_payout_page_limit:${payout.id}`);
}

function chargeSettlementRef(source: Stripe.BalanceTransaction["source"]): {
  paymentIntentId: string;
  amount: number;
  currency: string;
} | null {
  if (!source || typeof source === "string" || source.object !== "charge") return null;
  const paymentIntent = source.payment_intent;
  const paymentIntentId = typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id ?? null;
  if (!paymentIntentId || !Number.isSafeInteger(source.amount) || !source.currency) return null;
  return { paymentIntentId, amount: source.amount, currency: source.currency.toUpperCase() };
}
