import {
  type SellableCatalogItem,
  type SellableCatalogProfile,
} from "../../src/domains/catalog/contracts.js";
import type { SellableCatalogPort } from "../../src/domains/catalog/ports.js";
import type { CreateQuoteRequest, CreateQuoteResponse } from "../../src/domains/commerce/contracts.js";
import { CommerceQuoteError, type CommerceQuotePort } from "../../src/domains/commerce/ports.js";
import type { CheckoutCommandV1 } from "../../src/domains/commerce/checkoutCommandContracts.js";
import type { PaymentExecutionPort } from "../../src/domains/payment/ports.js";
import type { HttpRequest } from "../_lib/types/http.js";
import { productionRolloutConfirmed } from "../_lib/observability/environment.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
  type AdminAuthorization,
} from "../bff/admin/commerce/shared.js";
import { createSupabaseCatalogReadPort } from "./supabase/catalogRead.js";
import { createDbBackedCommerceQuotePort } from "../domains/commerce/dbBackedCommerceQuotePort.js";
import { createSupabaseCommerceOrderDraftPort } from "../adapters/supabase/commerceOrderDraft.js";
import { createSupabaseCommerceSettingsPort } from "./supabase/commerceSettings.js";
import { createSupabaseConfiguratorIntentPersistencePort } from "../adapters/supabase/configuratorIntentPersistence.js";
import { createSupabasePricingResolverPort } from "./supabase/pricingResolver.js";
import { createSupabaseRiskCheckoutBlocklistPort } from "./supabase/riskOrderPaid.js";
import { paymentProviderCapabilityRegistry } from "./paymentProviderCapabilityRegistry.js";
import * as paymentControlDb from "./managed/commerce/paymentControlRuntimePort.js";
import * as renewalDueDb from "./managed/subscription/subscriptionRenewalDuePort.js";
import * as chargeFailure from "./supabase/subscription/cycleChargeFailurePropagation.js";
import { createDeliveryAlignmentAdmissionClient } from "./subscriptionDeliveryAlignmentGateway.js";
import { createStarterPackCyclePort } from "./supabase/subscription/starterPackCycle.js";
import type { SubscriptionRenewalBatchDependencies } from "../domains/subscription/subscriptionRenewalInvocation.js";
import { createHiddenCommerceRuntimePort } from "../bff/admin/commerce/runtime/runtimeComposition.js";
import {
  LOCAL_REFERENCE_CONCRETE_PAYMENT_PROVIDER,
  LOCAL_REFERENCE_PROFILE_ID,
} from "./localReferenceCompositionIdentity.js";
/** Explicit optional/reference adapter. The local profile's brand, country, currency, and
 * mapping to a seeded legacy SKU live here rather than in a generic catalog or checkout domain. */
const localReferenceDemoProfile = {
  id: LOCAL_REFERENCE_PROFILE_ID,
  brand: "Northstar Supply",
  country: "PL",
  currency: "PLN",
  locale: "en",
  timezone: "UTC",
  publicSku: "NORTHSTAR-REFILL-001",
  canonicalSku: "OPENLUP-DOG-LAMB-CAN-400G",
  item: {
    sku: "NORTHSTAR-REFILL-001",
    title: "Northstar Supply Refill",
    unitPrice: { amountMinor: 1490, currency: "PLN" },
    permittedPurchaseModes: ["one_time", "subscription"],
  } satisfies SellableCatalogItem,
} as const;
export const LOCAL_REFERENCE_DEMO_PROFILE = localReferenceDemoProfile.id;
export const LOCAL_REFERENCE_PAYMENT_OUTCOME_ENV = "OSS_REFERENCE_PAYMENT_OUTCOME";
export const LOCAL_REFERENCE_PAYMENT_OCCURRED_AT = "2000-01-01T00:00:00.000Z";
export const LOCAL_REFERENCE_RENEWAL_TICK_AT = "2026-08-01T10:00:00.000Z";
export const LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER =
  LOCAL_REFERENCE_CONCRETE_PAYMENT_PROVIDER;
type LocalReferenceCheckoutClient =
  Parameters<typeof createSupabaseConfiguratorIntentPersistencePort>[0] &
  Parameters<typeof createSupabaseCommerceOrderDraftPort>[0] &
  Parameters<typeof createSupabaseCommerceSettingsPort>[0] &
  Parameters<typeof createSupabaseRiskCheckoutBlocklistPort>[0] &
  Parameters<typeof createSupabaseCatalogReadPort>[0]["client"] &
  Parameters<typeof createSupabasePricingResolverPort>[0]["client"];
type LocalReferenceRenewalClient =
  paymentControlDb.ManagedPaymentControlClient &
  renewalDueDb.DueSubscriptionRpcClient &
  renewalDueDb.ManagedSubscriptionRenewalPersistenceClient &
  SubscriptionRenewalBatchDependencies["deliveryAlignment"];
type LocalReferenceWorkerIsolationStore = { from(table: string): { select(columns: string, options: { count: "exact"; head: true }): PromiseLike<{ count: number | null; error: unknown }> } };
const referenceItem: SellableCatalogItem = localReferenceDemoProfile.item;
type LocalProfileEnv = Record<string, string | undefined> & {
  OSS_REFERENCE_STORE_PROFILE?: string;
  LOCAL_BFF?: string;
  RAILWAY_ENVIRONMENT?: string;
  openlup_ENVIRONMENT?: string;
  NODE_ENV?: string;
};
const hostedRuntimeKeys = new Set(["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION"]);
export function localReferenceDemoProfileEnabled(
  env: LocalProfileEnv = process.env,
): boolean {
  if (env.OSS_REFERENCE_STORE_PROFILE !== LOCAL_REFERENCE_DEMO_PROFILE) return false;
  // A deployment that declares itself production AND carries its operator's rollout
  // confirmation selected this profile deliberately; loopback DB evidence is not the only
  // honest proof of intent. Every runtime short of those two keys keeps today's refusals.
  if (productionRolloutConfirmed(env)) return true;
  if (env.LOCAL_BFF !== "1") return false;
  if (env.RAILWAY_ENVIRONMENT || Object.entries(env).some(([key, value]) => hostedRuntimeKeys.has(key) && Boolean(value))) return false;
  if (env.APP_ENVIRONMENT?.trim() || env.openlup_ENVIRONMENT || env.NODE_ENV === "production") return false;
  const urls = Object.entries(env)
    .filter(([key, value]) => isSupabaseUrlKey(key) && Boolean(value?.trim()))
    .map(([, value]) => value as string);
  if (urls.length > 0) return urls.every(isLoopbackUrl);
  // The second bundle carries no managed URL key at all, so requiring one made this profile
  // unreachable there. A loopback DATABASE_URL is the same evidence of locality.
  return isLoopbackUrl(env.DATABASE_URL?.trim() ?? "");
}
export function createLocalReferenceDemoSellableCatalogPort(): SellableCatalogPort {
  return {
    async getStorefrontProfile() {
      return storefrontProfile();
    },
    async listSellableItems() {
      return [referenceItem];
    },
  };
}
/** Maps only the local public SKU before delegating to the existing quote port. */
export function createLocalReferenceDemoQuotePort(
  canonicalQuotePort: CommerceQuotePort,
): CommerceQuotePort {
  return {
    async createQuote(request: CreateQuoteRequest): Promise<CreateQuoteResponse> {
      if (request.lines.length !== 1 || request.lines[0]?.sku !== referenceItem.sku) {
        throw new CommerceQuoteError("UNKNOWN_SKU", "Reference catalog accepts one refill SKU");
      }
      if (!referenceItem.permittedPurchaseModes.includes(request.mode)) {
        throw new CommerceQuoteError("PRICE_NOT_CONFIGURED", "Reference purchase mode is unavailable");
      }
      return canonicalQuotePort.createQuote({
        ...request,
        lines: request.lines.map((line) => ({
          ...line,
          sku: localReferenceDemoProfile.canonicalSku,
        })),
      });
    },
  };
}
export function localReferenceCommandMatchesProfile(command: CheckoutCommandV1): boolean {
  return command.currency === localReferenceDemoProfile.currency &&
    command.shippingAddress.country === localReferenceDemoProfile.country &&
    // Admission follows the catalog rather than restating it; mode/cadence is schema-checked.
    referenceItem.permittedPurchaseModes.includes(command.mode) &&
    command.lines.length === 1 &&
    command.lines[0]?.sku === referenceItem.sku;
}
/** A subscription needs the mandate-capable provider: the rehearsal marker mints no
 * confirmation capability, so renewals would have no stored method. Mode-selected only. */
export function localReferencePaymentProviderFor(command: Pick<CheckoutCommandV1, "mode">) {
  return command.mode === "subscription" ? LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER : "hidden_rehearsal";
}
/**
 * Captured/no-egress payment simulator selected only by the trusted local BFF
 * composition. The refusal marker is part of the server-owned fixture
 * convention; it is not browser-selectable.
 */
export function readLocalReferencePaymentOutcome(
  env: Record<string, string | undefined> = process.env,
): "captured" | "refused" {
  const value = env[LOCAL_REFERENCE_PAYMENT_OUTCOME_ENV]?.trim() || "captured";
  if (value !== "captured" && value !== "refused") {
    throw new Error("Invalid local reference payment outcome");
  }
  return value;
}
export function createLocalReferenceDemoPaymentExecutionPort(
  outcome: "captured" | "refused",
  provider: "hidden_rehearsal" | typeof LOCAL_REFERENCE_CONCRETE_PAYMENT_PROVIDER = "hidden_rehearsal",
): PaymentExecutionPort {
  return {
    async execute(input) {
      const refused = outcome === "refused";
      return {
        provider,
        providerAttemptId: null,
        providerSessionId: null,
        attemptStatus: "processing",
        nextActionKind: null,
        clientSecret: !refused && provider === LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER
          ? "local_reference_confirmation_capability"
          : null,
        requestPayload: {
          source: "reference_store.local.payment_simulator.v1",
          providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.providerRequestFingerprint,
        },
        responsePayload: { providerCall: false, outcome: refused ? "refused" : "captured" },
        providerDecline: refused
          ? { code: "payment_failed", mandateUnsupported: false }
          : null,
        webhookExpected: false,
      };
    },
  };
}
export function createLocalReferenceRenewalRuntimePorts(client: unknown) {
  const runtimeClient = Object.assign(client as LocalReferenceRenewalClient, createDeliveryAlignmentAdmissionClient(client), createStarterPackCyclePort(client as never));
  const executionPort = createLocalReferenceDemoPaymentExecutionPort(readLocalReferencePaymentOutcome(), LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER);
  return {
    persistence: renewalDueDb.createManagedSubscriptionRenewalPersistencePort(runtimeClient),
    deliveryAlignment: runtimeClient,
    chargeFailurePropagation: chargeFailure.createSupabaseCycleChargeFailurePropagationPort(runtimeClient as never),
    paymentPort: paymentControlDb.createManagedPaymentControlRuntimePort(runtimeClient),
    duePort: renewalDueDb.createManagedSubscriptionRenewalDuePort(runtimeClient),
    resolveExecutionPort: () => ({ port: executionPort, reason: null }),
    capabilities: paymentProviderCapabilityRegistry,
  };
}
/** Refuse the global renewal/dunning workers unless this local proof DB is disposable. */
export async function assertLocalReferenceWorkerIsolation(client: unknown): Promise<void> {
  const rows = await Promise.all(["subscriptions", "subscription_dunning_notifications"].map((table) => (client as LocalReferenceWorkerIsolationStore).from(table).select("id", { count: "exact", head: true })));
  if (rows.some((row) => row.error || row.count !== 0)) throw new Error("Local reference workers require zero subscriptions/dunning notifications with successful readbacks");
}
export async function authorizeLocalReferenceAdmin(
  req: HttpRequest,
): Promise<AdminAuthorization> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) throw new Error("Reference admin environment is not configured");
  const accessToken = readBearerToken(req);
  return authorizeCommerceAdminWithUser(
    createAdminAuthClient(env, accessToken),
    accessToken,
  );
}
export function createLocalReferenceCheckoutRuntimePort(client: unknown) {
  const {
    serviceClient,
    persistencePort,
    orderDraftPort,
    canonicalQuotePort,
  } = localReferenceCheckoutComposition(client);
  return createHiddenCommerceRuntimePort(serviceClient, {
    persistencePort,
    quotePort: createLocalReferenceDemoQuotePort(canonicalQuotePort),
    orderDraftPort,
    resolveExecutionPort: (kind: string) => createLocalReferenceDemoPaymentExecutionPort(
      readLocalReferencePaymentOutcome(), localReferencePaymentProviderFor({ mode: kind === LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER ? "subscription" : "one_time" }),
    ),
    // Deterministic demo settlement instant, so the durable artifact of a
    // reference run does not depend on wall-clock time.
    now: () => new Date(LOCAL_REFERENCE_PAYMENT_OCCURRED_AT),
  });
}
export function createLocalReferenceSharedCheckoutRuntime(client: unknown) {
  const {
    serviceClient,
    persistencePort,
    orderDraftPort,
    catalogReadPort,
    canonicalQuotePort,
  } = localReferenceCheckoutComposition(client);
  return {
    catalogReadPort,
    runtimePort: createHiddenCommerceRuntimePort(serviceClient, {
      persistencePort,
      quotePort: canonicalQuotePort,
      orderDraftPort,
      resolveExecutionPort: () => createLocalReferenceDemoPaymentExecutionPort(
        readLocalReferencePaymentOutcome(),
        LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER,
      ),
    }),
  };
}
function localReferenceCheckoutComposition(client: unknown) {
  const serviceClient = client as LocalReferenceCheckoutClient;
  const persistencePort = createSupabaseConfiguratorIntentPersistencePort(serviceClient);
  const orderDraftPort = createSupabaseCommerceOrderDraftPort(serviceClient);
  const catalogReadPort = createSupabaseCatalogReadPort({
    client: serviceClient,
  });
  const canonicalQuotePort = createDbBackedCommerceQuotePort({
    catalogReadPort,
    pricingResolverPort: createSupabasePricingResolverPort({
      client: serviceClient,
    }),
    commerceSettingsPort: createSupabaseCommerceSettingsPort(serviceClient),
  });
  return {
    serviceClient,
    persistencePort,
    orderDraftPort,
    catalogReadPort,
    canonicalQuotePort,
  };
}
export function createLocalReferenceRiskCheckoutBlocklistPort(client: unknown) {
  return createSupabaseRiskCheckoutBlocklistPort(
    client as LocalReferenceCheckoutClient,
  );
}
function storefrontProfile(): SellableCatalogProfile {
  const { id, brand, country, currency, locale, timezone } = localReferenceDemoProfile;
  return { id, brand, country, currency, locale, timezone };
}
function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
function isSupabaseUrlKey(key: string): boolean { return /supabase/i.test(key) && /url|uri|endpoint/i.test(key); }
