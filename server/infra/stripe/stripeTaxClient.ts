import StripeSdk from "stripe";
import type { StripeTaxAdapterOptions } from "@openlup/platform/tax/stripe";
import { assertStripeKeyMode } from "../providerReadiness.js";

type Client = StripeTaxAdapterOptions["client"];
const TIMEOUT_MS = 10_000;

function reject(field: string, remedy: string, code = "tax_invalid_input"): never {
  throw Object.assign(new Error(remedy), { name: "TaxProviderRejection", field, code });
}

async function request<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof StripeSdk.errors.StripeError)) throw error;
    if (error.type === "StripeIdempotencyError") {
      reject("/key", "The provider already knows this reference or key. Reconcile the original request.", "tax_reference_conflict");
    }
    if (error.code === "customer_tax_location_invalid" || error.param?.startsWith("customer_details[address]")) {
      reject("/input/destination/address", "The provider rejected the destination. Supply a complete, supported tax address.");
    }
    if (error.param === "tax_date") reject("/input/taxDate", "The provider rejected the tax instant. Use a whole-second UTC date within its supported window.");
    if (error.param === "posted_at") reject("/postedAt", "The provider rejected posting time. Use an instant within the calculation's posting window.");
    if (error.param === "reference") {
      reject("/transactionRef", "The provider did not accept the reference. Reconcile the original reference before retrying.", "tax_reference_conflict");
    }
    if (error.code === "tax_calculation_expired") {
      reject("/calculationRef", "The provider calculation expired. Reconcile the original obligation.", "tax_calculation_expired");
    }
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      reject("/client", "The provider denied access or could not find the resource. Verify the routed account and original reference.", "tax_calculation_unusable");
    }
    if (error.statusCode === 400) {
      reject("/providerRequest", "The provider rejected the tax request. Check the calculation, market pack and reserved reporting amounts.");
    }
    // Preserve uncertainty for timeouts, rate limiting and ambiguous service responses.
    throw new Error("The tax provider request failed in transit or the service could not confirm it.");
  }
}

/** Verify the routed account and mode before exposing any Tax methods. */
export async function createStripeTaxClient(options: {
  secretKey: string; liveConfirmed?: boolean; scope: Client["scope"]; connectedAccount?: string;
}) {
  const scope = Object.freeze({ ...options.scope });
  const mode = assertStripeKeyMode(options.secretKey, { STRIPE_LIVE_CONFIRMED: String(options.liveConfirmed === true) });
  if ((mode === "live") !== (scope.mode === "live")) throw new Error("Supply a credential for the requested tax mode.");
  if (options.connectedAccount && options.connectedAccount !== scope.accountRef) {
    throw new Error("Use a connected-account route matching the tax account.");
  }
  const sdk = new StripeSdk(options.secretKey, {
    apiVersion: "2026-07-29.dahlia", typescript: true, timeout: TIMEOUT_MS, maxNetworkRetries: 0,
    // The SDK can retry a raw closed-connection error even with a zero retry budget.
    httpClient: StripeSdk.createFetchHttpClient(async (url, init) => {
      try { return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
      catch { throw new Error("The tax provider transport was interrupted."); }
    }),
  });
  const route = options.connectedAccount ? { stripeAccount: options.connectedAccount } : {};
  const account = await request(() => sdk.accounts.retrieve(null, {}, route));
  const balance = await request(() => sdk.balance.retrieve({}, route));
  if (account.id !== scope.accountRef || balance.livemode !== (scope.mode === "live")) {
    throw new Error("The provider account or mode differs. Verify the selected route and credential.");
  }
  return {
    scope,
    calculations: {
      create: (params, opts) => request(() => sdk.tax.calculations.create(params, { ...route, ...opts })),
      retrieve: id => request(() => sdk.tax.calculations.retrieve(id, {}, route)),
      listLineItems: (id, params) => request(() => sdk.tax.calculations.listLineItems(id, params, route)),
    },
    registrations: { list: params => request(() => sdk.tax.registrations.list(params, route)) },
    transactions: {
      createFromCalculation: (params, opts) => request(() => sdk.tax.transactions.createFromCalculation(params, { ...route, ...opts })),
      createReversal: (params, opts) => request(() => sdk.tax.transactions.createReversal(params, { ...route, ...opts })),
      retrieve: id => request(() => sdk.tax.transactions.retrieve(id, {}, route)),
      listLineItems: (id, params) => request(() => sdk.tax.transactions.listLineItems(id, params, route)),
    },
  } satisfies Client;
}
