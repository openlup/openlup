import { createHash } from "node:crypto";
import type { BundleLineRef } from "@openlup/core/bundle";
import type { ClassicBundleEditRequest } from "./contracts/editConsent.js";
import { agreedEditTotal, assertRecurringEditQuote } from "./editConsent.js";
import type { EditAgreementBaseline } from "./editConsentBaseline.js";
import type { PackageEditCurrentLine, PackageEditLimits, PackageEditLine, PackageEditMoney, PackageEditQuote, PackageEditQuotePorts,
  PackageEditReadPort, PackageEditRequest, PackageEditSubscription } from "./packageEditContracts.js";

type Quote = Awaited<ReturnType<PackageEditQuotePorts["quotePort"]["createServerAuthoritativeQuote"]>>["quote"];
/** Content identity deliberately excludes observation time and all presentation facts. */
export function hashPackageEditQuote(quote: Quote): string {
  return createHash("sha256").update(JSON.stringify({ totalGross: quote.totalGross, subtotalGross: quote.subtotalGross,
    discountTotalGross: quote.discountTotalGross, lines: quote.lines.map(line => ({ sku: line.sku, quantity: line.quantity,
      unitPriceGross: line.unitPriceGross, lineSubtotalGross: line.lineSubtotalGross, pricingComponents: line.pricingComponents ?? [] })) })).digest("hex");
}
function value<T>(result: PromiseSettledResult<T>): T { if (result.status === "rejected") throw result.reason; return result.value; }
function sanitize(lines: PackageEditLine[], code: string): PackageEditLine[] {
  const result = lines.map(line => ({ variantId: String(line.variantId ?? ""), qty: Math.trunc(Number(line.qty)) }));
  if (result.some(line => !line.variantId || !Number.isInteger(line.qty) || line.qty <= 0)) throw new Error(code);
  if (new Set(result.map(line => line.variantId)).size !== result.length) throw new Error("subscription_reprice_duplicate_variant");
  return result;
}
const bundleLine = (line: PackageEditLine, isAddon: boolean): BundleLineRef => ({ ...line, isAddon });

/** The generic bundle lane keeps the fixed pool when cadence stays the same. */
export async function quoteClassicBundle(deps: PackageEditQuotePorts, request: ClassicBundleEditRequest,
  baseline: EditAgreementBaseline, subscription: PackageEditSubscription, limits: PackageEditLimits) {
  const { constraintMapper, compositionRulesPort } = deps;
  const currentCore = baseline.lines.filter(line => !line.isAddon).map(line => bundleLine({ variantId: line.variantId, qty: line.quantity }, false));
  const currentAddons = baseline.lines.filter(line => line.isAddon);
  if (currentCore.length === 0) throw new Error("subscription_reprice_no_base_lines");
  const cadenceDays = request.cadenceDays ?? subscription.cadenceDays;
  const cadenceChanged = cadenceDays !== subscription.cadenceDays;
  let constraint = constraintMapper.toCore(request.compositionConstraint ?? subscription.compositionConstraint);
  let core = request.action === "update_bundle" ? request.coreLines.map(line => bundleLine(line, false)) : currentCore;
  const requestedAddons = request.action === "update_bundle" ? request.addonLines : undefined;
  const addons = (requestedAddons ?? currentAddons.map(line => ({ variantId: line.variantId, qty: line.quantity })))
    .map(line => bundleLine(line, true));
  if (request.action === "resize_bundle" || (request.cadenceDays !== undefined && request.compositionConstraint === undefined)) {
    const lever = request.action === "resize_bundle" ? request.resizeLever : { kind: cadenceChanged ? "planLength" : "planLengthConstraint", value: cadenceDays };
    const value = lever.kind === "portionMode"
      ? { planDays: cadenceDays, ...(lever.value && typeof lever.value === "object" && !Array.isArray(lever.value) ? lever.value : { portionMode: lever.value }) }
      : lever.value;
    const resized = await compositionRulesPort.resizeComposition({ coreLines: core, constraint, lever: { kind: lever.kind, value } });
    if (resized) {
      core = resized.coreLines.map(line => bundleLine(line, false));
      constraint = resized.constraint;
    } else if (request.action === "resize_bundle" || cadenceChanged) {
      throw new Error(request.action === "resize_bundle" ? "subscription_reprice_bundle_resize_unservable" : "subscription_reprice_plan_length_unservable");
    }
  }
  if (request.action === "update_bundle") {
    const validation = await compositionRulesPort.validateComposition({ coreLines: core, addonLines: requestedAddons ? addons : [], constraint });
    if (!validation.ok) throw new Error(validation.code);
    const units = (lines: BundleLineRef[]) => lines.reduce((sum, line) => sum + line.qty, 0);
    if (!cadenceChanged && units(core) !== units(currentCore)) throw new Error("subscription_reprice_base_total_mismatch");
  }
  const desired = [...core, ...addons];
  if (!core.length || core.length > limits.maximumBaseLines || addons.length > limits.maximumAddonLines
    || cadenceDays > limits.maximumPlanDays || desired.some(line => !Number.isSafeInteger(line.qty) || line.qty <= 0 || line.qty > limits.maximumQuantity)) {
    throw new Error("subscription_reprice_invalid_request");
  }
  if (new Set(desired.map(line => line.variantId.toLowerCase())).size !== desired.length) throw new Error("subscription_reprice_duplicate_variant");
  const skus = new Map((await deps.quoteCatalogReadPort.listQuoteCatalogItems())
    .filter(item => item.sellability.subscription).map(item => [item.variantId, item.skuCode]));
  const refs = desired.map(line => {
    const sku = skus.get(line.variantId);
    if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
    return { ...line, sku, lineId: line.isAddon && !requestedAddons ? currentAddons.find(old => old.variantId === line.variantId)?.lineId ?? null : null };
  });
  const terms = refs.map(({ variantId,qty,sku }) => ({ variantId,qty,sku }));
  await deps.admitSubscriptionTerms?.({ subscriptionId: request.subscriptionId, nominalPlanDays: cadenceDays, cadenceDays,
    base: terms.slice(0, core.length), addons: terms.slice(core.length) });
  const compositionConstraint = constraintMapper.fromCore(constraint);
  if (compositionConstraint === null) throw new Error("subscription_reprice_bundle_constraint_unavailable");
  const lines = refs.map(line => ({ sku: line.sku, quantity: line.qty, modeAtLine: "subscription" as const, isAddon: line.isAddon }));
  const { quote } = await deps.quotePort.createServerAuthoritativeQuote({ mode: "subscription", cadenceDays, compositionConstraint, promoCodes: [], lines });
  const currentRecurringPrice = agreedEditTotal(baseline);
  assertRecurringEditQuote(currentRecurringPrice.currency, lines, quote);
  return { lines: refs.map((line, index) => ({ ...line, quoteLine: quote.lines[index] })), cadenceDays, compositionConstraint,
    quoteHash: hashPackageEditQuote(quote), expectedTemplateVersion: subscription.templateVersion };
}
/** The entire desired set is quoted verbatim. Cadence changes never resize quantities. */
export function createClassicPackageRepricer(deps: PackageEditQuotePorts & { readPort: PackageEditReadPort }) {
  return createClassicEditRepricer(deps);
}

/** Consent compares the validated agreement without pricing the former basket. */
export function createClassicEditRepricer(deps: PackageEditQuotePorts & { readPort: PackageEditReadPort }, agreed?: PackageEditMoney) {
  const { readPort, constraintMapper, compositionRulesPort, quotePort, quoteCatalogReadPort } = deps;
  async function quoteLines(skus: ReadonlyMap<string, string>, cadenceDays: number, compositionConstraint: Record<string, unknown> | null,
    lines: { variantId: string; qty: number; isAddon: boolean }[]) {
    return quotePort.createServerAuthoritativeQuote({ mode: "subscription", cadenceDays, compositionConstraint, promoCodes: [],
      lines: lines.map(line => {
        const sku = skus.get(line.variantId); if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
        return { sku, quantity: line.qty, modeAtLine: "subscription", isAddon: line.isAddon };
      }) });
  }
  async function currentPrice(skus: ReadonlyMap<string, string>, cadence: number, constraint: Record<string, unknown> | null,
    lines: PackageEditCurrentLine[]): Promise<PackageEditMoney> {
    const sellable = lines.filter(line => skus.has(line.variantId)), retired = lines.filter(line => !skus.has(line.variantId));
    let frozen: PackageEditMoney | undefined;
    for (const line of retired) {
      const price = line.frozenLineSubtotalGross;
      if (!price || (frozen && frozen.currency !== price.currency)) throw new Error("subscription_reprice_current_package_unpriceable");
      frozen = { amountMinor: (frozen?.amountMinor ?? 0) + price.amountMinor, currency: price.currency };
    }
    if (!sellable.length) { if (!frozen) throw new Error("subscription_reprice_current_package_unpriceable"); return frozen; }
    const { quote } = await quoteLines(skus, cadence, constraint, sellable.map(line => ({ variantId: line.variantId, qty: line.quantity, isAddon: line.isAddon })));
    if (frozen && frozen.currency !== quote.totalGross.currency) throw new Error("subscription_reprice_current_package_unpriceable");
    return { ...quote.totalGross, amountMinor: quote.totalGross.amountMinor + (frozen?.amountMinor ?? 0) };
  }
  return { async quote(input: Pick<PackageEditRequest, "subscriptionId" | "planDays" | "base" | "addons">): Promise<PackageEditQuote> {
    const reads = await Promise.allSettled([readPort.readSubscription(input.subscriptionId), readPort.readLines(input.subscriptionId)]);
    const subscription = value(reads[0]), current = value(reads[1]);
    const skus = new Map((await quoteCatalogReadPort.listQuoteCatalogItems()).filter(item => item.sellability.subscription).map(item => [item.variantId, item.skuCode]));
    if (!current.some(line => !line.isAddon)) throw new Error("subscription_reprice_no_base_lines");
    const base = sanitize(input.base, "subscription_reprice_invalid_base_mix"), addons = sanitize(input.addons ?? [], "subscription_reprice_invalid_addons");
    const validation = await compositionRulesPort.validateComposition({ coreLines: base.map(line => bundleLine(line, false)),
      addonLines: addons.map(line => bundleLine(line, true)), constraint: constraintMapper.toCore(subscription.compositionConstraint) });
    if (!validation.ok) throw new Error(validation.code);
    if (base.reduce((total, line) => total + line.qty, 0) < await readPort.readMinimumBaseUnits()) throw new Error("subscription_reprice_below_minimum_order_units");
    const nominal = constraintMapper.nominalPlanDays(subscription.compositionConstraint) ?? subscription.cadenceDays;
    const normalized = await compositionRulesPort.resizeComposition({ coreLines: base.map(line => bundleLine(line, false)),
      constraint: constraintMapper.toCore(subscription.compositionConstraint), lever: { kind: "planLengthConstraint", value: input.planDays } });
    const constraint = normalized ? constraintMapper.fromCore(normalized.constraint) : subscription.compositionConstraint;
    const cadenceDays = input.planDays === nominal ? subscription.cadenceDays : input.planDays;
    const desired = [...base.map(line => bundleLine(line, false)), ...addons.map(line => bundleLine(line, true))];
    if (deps.admitSubscriptionTerms) {
      const resolve = (line: PackageEditLine) => {
        const sku = skus.get(line.variantId); if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
        return { ...line, sku };
      };
      await deps.admitSubscriptionTerms({ subscriptionId: input.subscriptionId, nominalPlanDays: input.planDays,
        cadenceDays, base: base.map(resolve), addons: addons.map(resolve) });
    }
    const quotes = await Promise.allSettled([agreed ?? currentPrice(skus, subscription.cadenceDays, subscription.compositionConstraint, current),
      quoteLines(skus, cadenceDays, constraint, desired)]);
    const before = value(quotes[0]), after = value(quotes[1]).quote;
    if (after.lines.length !== desired.length) throw new Error("subscription_reprice_line_count_mismatch");
    return { currentRecurringPrice: before, newRecurringPrice: after.totalGross,
      delta: { amountMinor: after.totalGross.amountMinor - before.amountMinor, currency: after.totalGross.currency }, quoteHash: hashPackageEditQuote(after),
      baseLines: base.map((line, index) => ({ ...line, quoteLine: after.lines[index] })),
      addonLines: addons.map((line, index) => ({ ...line, quoteLine: after.lines[base.length + index] })), cadenceDays,
      expectedTemplateVersion: subscription.templateVersion, compositionConstraint: constraint };
  } };
}
