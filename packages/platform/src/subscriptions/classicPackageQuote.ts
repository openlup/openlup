import { createHash } from "node:crypto";
import type { BundleLineRef } from "@openlup/core/bundle";
import type { PackageEditCurrentLine, PackageEditLine, PackageEditMoney, PackageEditQuote, PackageEditQuotePorts,
  PackageEditReadPort, PackageEditRequest } from "./packageEditContracts.js";

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
/** The entire desired set is quoted verbatim. Cadence changes never resize quantities. */
export function createClassicPackageRepricer(deps: PackageEditQuotePorts & { readPort: PackageEditReadPort }) {
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
    const quotes = await Promise.allSettled([currentPrice(skus, subscription.cadenceDays, subscription.compositionConstraint, current),
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
