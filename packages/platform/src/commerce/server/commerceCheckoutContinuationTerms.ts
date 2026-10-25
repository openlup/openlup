import type { z } from "zod";
import { acquisitionExpectationChanged, type AcquisitionTermsExpectation, type CreateQuoteRequest } from "../../pricing/index.js";
import { stableJson } from "../../promotions/index.js";
import type { CheckoutKind, ConfiguratorIntent } from "../contracts/index.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
import type { StarterDeclaration } from "./commerceStarterOfferGuard.js";
import { selectedDeliveryMatches, type CheckoutResumeGuardDeps } from "./commerceCheckoutResumeGuard.js";
export function createSavedAcquisitionContinuation<Intent extends ConfiguratorIntent & { selectedDelivery?: unknown }, Provisioned, Request extends CreateQuoteRequest, Snapshot extends CheckoutQuoteSnapshot, InvoicePreference, Response>(bindings: {
  quoteSchema: z.ZodType<Snapshot>;
  buildQuoteRequest(intent: Intent, provisioned: Provisioned): Request;
  sameSubjectContext(context: NonNullable<Snapshot["quote"]["context"]>, fresh: Request, provisioned: Provisioned): boolean;
  runtimeMetadata(intent: Intent, kind: CheckoutKind, preference?: InvoicePreference): Record<string, unknown>;
  starterDeclaration(intent: Intent): StarterDeclaration | undefined;
  starterPlan(snapshot: Snapshot): { starterIntervalDays: number; delivery2: { discountBps: number }; graduation: { cadenceDays: number; lines: Array<{ qty: number }> } } | undefined;
  buildSavedOrderResumeResponse(input: { resumable: Awaited<ReturnType<NonNullable<CheckoutResumeGuardDeps["resumableOrderPort"]>["findResumableOrderForClient"]>> & {}; clientId: string; checkoutKind: CheckoutKind; intent: Intent }): Response;
}) {

async function resolveSavedAcquisitionContinuation(input: {
  deps: CheckoutResumeGuardDeps;
  clientId: string;
  provisioned: Provisioned;
  checkoutKind: CheckoutKind;
  intent: Intent;
  invoicePreference?: InvoicePreference;
  expectedQuote?: {
    totalGross: { amountMinor: number; currency: string };
    acquisitionTerms?: AcquisitionTermsExpectation;
  };
  now: () => Date;
}): Promise<Response | null> {
  const { deps, clientId, checkoutKind, intent, expectedQuote } = input;
  if (!deps.resumableOrderPort || !expectedQuote || checkoutKind !== "subscription_initial") return null;
  try {
    const resumable = await deps.resumableOrderPort.findResumableOrderForClient({
      clientId, withinMinutes: deps.resumeWindowMinutes ?? 60,
      now: input.now(), journeyKey: intent.idempotencyKey,
    });
    if (!resumable || !resumable.paymentIntentId || !selectedDeliveryMatches(resumable.metadata, intent)) return null;
    const saved = bindings.quoteSchema.safeParse(resumable.metadata?.quoteSnapshot);
    if (!saved.success) return null;
    const { quote } = saved.data;
    const context = quote.context;
    const fresh = bindings.buildQuoteRequest(intent, input.provisioned);
    if (!context || context.mode !== "subscription" || context.cadenceDays !== fresh.cadenceDays
      || !bindings.sameSubjectContext(context, fresh, input.provisioned) || (context as typeof context & { offerVersion?: string }).offerVersion !== intent.offerVersion

      || stableJson(context.promoCodes) !== stableJson(fresh.promoCodes)
      || lineKey(quote.lines) !== lineKey(fresh.lines)
      || stableJson(quote.totalGross) !== stableJson(expectedQuote.totalGross)
      || acquisitionExpectationChanged(expectedQuote.acquisitionTerms, context.acquisitionTerms)
      || acquisitionExpectationChanged(bindings.starterDeclaration(intent)?.acquisitionTerms, context.acquisitionTerms)) return null;
    const metadata = resumable.metadata ?? {};
    const finalized = record(metadata.runtimeFinalize);
    const savedContact = metadata.deliveryContact ?? finalized?.deliveryContact;
    const freshMetadata = bindings.runtimeMetadata(intent, checkoutKind, input.invoicePreference);
    if (!savedContact || stableJson(savedContact) !== stableJson(freshMetadata.deliveryContact)) return null;
    const savedInvoice = metadata.invoiceBuyerSnapshot ?? finalized?.invoiceBuyerSnapshot;
    if (!savedInvoice || stableJson(savedInvoice) !== stableJson(freshMetadata.invoiceBuyerSnapshot)) return null;
    const starter = bindings.starterPlan(saved.data);
    const declared = bindings.starterDeclaration(intent);
    if (Boolean(starter) !== Boolean(declared)) return null;
    if (starter && declared && (
      starter.starterIntervalDays !== declared.intervalDays
      || starter.delivery2.discountBps !== declared.delivery2DiscountBps
      || starter.graduation.cadenceDays !== declared.steady.cadenceDays
      || starter.graduation.lines.reduce((n, line) => n + line.qty, 0) !== declared.steady.units
    )) return null;
    return bindings.buildSavedOrderResumeResponse({ resumable, clientId, checkoutKind, intent });
  } catch {
    // Lookup is an optimization; regular quote/admission remains authoritative.
    return null;
  }
}

function lineKey(lines: ReadonlyArray<{ sku: string; quantity: number }>): string {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
  return stableJson([...totals].sort(([a], [b]) => a.localeCompare(b)));
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}


return { resolveSavedAcquisitionContinuation };
}
