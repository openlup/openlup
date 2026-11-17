import { MAX_CADENCE_DAYS } from "@openlup/core/subscription";
import { hashPackageEditQuote } from "./classicPackageQuote.js";
import type { ExactSubscriptionEditQuote, ExactSubscriptionEditRequest, SubscriptionPortionModes } from "./contracts/exactEdit.js";
import type { PackageEditCurrentLine, PackageEditQuotePorts, PackageEditReadPort } from "./packageEditContracts.js";

/** Recurring-only quotes; individual line edits preserve the current order and identity. */
export function createExactSubscriptionRepricer(deps: PackageEditQuotePorts & {
  readPort: PackageEditReadPort; portionModes?: SubscriptionPortionModes;
}) {
  return { async quote(input: ExactSubscriptionEditRequest): Promise<ExactSubscriptionEditQuote | null> {
    const reads = await Promise.allSettled([deps.readPort.readSubscription(input.subscriptionId), deps.readPort.readLines(input.subscriptionId)]);
    if (reads[0].status === "rejected") throw reads[0].reason;
    if (reads[1].status === "rejected") throw reads[1].reason;
    const subscription = reads[0].value, current = reads[1].value;
    const skus = new Map((await deps.quoteCatalogReadPort.listQuoteCatalogItems()).filter(item => item.sellability.subscription)
      .map(item => [item.variantId, item.skuCode]));
    let lines: (Omit<PackageEditCurrentLine, "lineId"> & { lineId: string | null })[] = current.map(line => ({ ...line }));
    let cadenceDays = subscription.cadenceDays, constraint = subscription.compositionConstraint;
    if (input.action === "swap_base_line") {
      if (!lines.some(line => line.variantId === input.fromVariantId)) return null;
      lines = lines.map(line => line.variantId === input.fromVariantId ? { ...line, variantId: input.toVariantId } : line);
    } else if (input.action === "add_addon") {
      lines.push({ lineId: null, variantId: input.variantId, quantity: input.qty, isAddon: true,
        sortOrder: Math.max(0, ...lines.map(line => line.sortOrder)) + 1 });
    } else if (input.action === "remove_addon" || input.action === "update_addon_quantity") {
      if (!lines.some(line => line.variantId === input.variantId && line.isAddon)) return null;
      lines = input.action === "remove_addon" ? lines.filter(line => !(line.variantId === input.variantId && line.isAddon))
        : lines.map(line => line.variantId === input.variantId && line.isAddon ? { ...line, quantity: input.qty } : line);
    } else {
      const base = current.filter(line => !line.isAddon), addons = current.filter(line => line.isAddon);
      if (!base.length) throw new Error("subscription_reprice_no_base_lines");
      let desired = base.map(line => ({ variantId: line.variantId, qty: line.quantity, isAddon: false }));
      if (input.action === "update_base_mix") {
        desired = input.base.map(line => ({ variantId: String(line.variantId ?? ""), qty: Math.trunc(Number(line.qty)), isAddon: false }));
        const valid = await deps.compositionRulesPort.validateComposition({ coreLines: desired, addonLines: [], constraint: deps.constraintMapper.toCore(constraint) });
        if (!valid.ok) throw new Error(valid.code);
        if (desired.reduce((sum, line) => sum + line.qty, 0) !== base.reduce((sum, line) => sum + line.quantity, 0)) {
          throw new Error("subscription_reprice_base_total_mismatch");
        }
      } else {
        if (input.action === "update_portion") {
          const modes = deps.portionModes;
          if (!modes) throw new Error("subscription_reprice_portion_modes_unavailable");
          if (![modes.full.mode, modes.reduced.mode].includes(input.portionMode)) throw new Error("subscription_reprice_invalid_portion_mode");
        }
        const resized = await deps.compositionRulesPort.resizeComposition({ coreLines: desired, constraint: deps.constraintMapper.toCore(constraint),
          lever: input.action === "update_plan_length" ? { kind: "planLength", value: input.planDays }
            : { kind: "portionMode", value: { portionMode: input.portionMode, planDays: cadenceDays } } });
        if (!resized || !resized.coreLines.length) throw new Error(input.action === "update_plan_length"
          ? "subscription_reprice_plan_length_unservable" : "subscription_reprice_portion_unservable");
        desired = resized.coreLines;
        constraint = deps.constraintMapper.fromCore(resized.constraint);
        if (input.action === "update_plan_length") cadenceDays = input.planDays;
        // Only the configured reduced mode must reduce. Full restoration is permitted.
        if (input.action === "update_portion" && input.portionMode === deps.portionModes?.reduced.mode &&
          desired.reduce((sum, line) => sum + line.qty, 0) >= base.reduce((sum, line) => sum + line.quantity, 0)) {
          throw new Error("subscription_reprice_portion_no_reduction");
        }
      }
      lines = [...desired.map((line, index) => ({ lineId: null, variantId: line.variantId, quantity: line.qty, sortOrder: index, isAddon: false })), ...addons];
    }
    if (cadenceDays > MAX_CADENCE_DAYS) throw new Error("subscription_reprice_invalid_plan_length");
    if (deps.admitSubscriptionTerms) {
      const resolve = (line: typeof lines[number]) => {
        const sku = skus.get(line.variantId); if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
        return { variantId: line.variantId, sku, qty: line.quantity };
      };
      await deps.admitSubscriptionTerms({ subscriptionId: input.subscriptionId,
        nominalPlanDays: input.action === "update_plan_length" ? input.planDays
          : deps.constraintMapper.nominalPlanDays(constraint) ?? cadenceDays,
        cadenceDays, base: lines.filter(line => !line.isAddon).map(resolve), addons: lines.filter(line => line.isAddon).map(resolve) });
    }
    const { quote } = await deps.quotePort.createServerAuthoritativeQuote({ mode: "subscription", cadenceDays, compositionConstraint: constraint,
      promoCodes: [], lines: lines.map(line => {
        const sku = skus.get(line.variantId); if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
        return { sku, quantity: line.quantity, isAddon: line.isAddon, modeAtLine: "subscription" };
      }) });
    if (quote.lines.length !== lines.length) throw new Error("subscription_reprice_line_count_mismatch");
    return { quoteHash: hashPackageEditQuote(quote), expectedTemplateVersion: subscription.templateVersion, cadenceDays, compositionConstraint: constraint,
      lines: lines.map((line, index) => ({ lineId: line.lineId, variantId: line.variantId, qty: line.quantity, isAddon: line.isAddon,
        sortOrder: line.sortOrder, quoteLine: quote.lines[index] })),
      ...(input.action === "update_portion" ? { portionModes: deps.portionModes } : {}) };
  } };
}
