import type { BundleLineRef, CompositionConstraint } from "@openlup/core/bundle";
import { agreedSubscriptionTotal, mergeSubscriptionAgreedQuote, splitBySubscriptionAgreement } from "./agreedPlanQuote.js";
import { hashPackageEditQuote } from "./classicPackageQuote.js";
import { createSizedCompositionRules } from "./sizedComposition.js";
import { isSizedOptIn, sameSizedPinnedConstraint, sizedEditPhase } from "./sizedEditContext.js";
import { SIZED_PARCEL_LEVER_KIND } from "./sizedParcelLever.js";
import { type SizedAgreedLine, type SizedEditContext, type SizedEditPolicy, type SizedEditRequest } from "./contracts/sizedEdit.js";
import type { SizedCatalogFact, SizedHostPorts, SizedSubjectFacts } from "./sizedEditPorts.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

export function selectSizedAgreements(context: SizedEditContext, policy: SizedEditPolicy): SizedAgreedLine[] {
  return sizedEditPhase(context, policy) === "graduation_pending"
    ? [...context.graduationLines, ...context.lines.filter(line => line.isAddon)] : context.lines;
}
export async function quoteSizedEdit(input: { db: SubscriptionQueryExecutor; context: SizedEditContext; request: SizedEditRequest;
  policy: SizedEditPolicy; host: SizedHostPorts; point: "preview" | "apply" }) {
  const { db, context, request, policy, host } = input;
  const facts = await host.readFacts(db, context, input.point);
  assertSizedSubjectFacts(facts, context, policy);
  let constraint = context.compositionConstraint;
  let optInFacts: Record<string, unknown> | null = null;
  if (isSizedOptIn(request) && context.binding === "classic") {
    const need = await host.resolveOptInNeed(db, context);
    if (!Number.isSafeInteger(need.dailyNeed) || need.dailyNeed <= 0 || !need.snapshot || typeof need.snapshot !== "object") throw new Error("subscription_reprice_sized_need_unreadable");
    optInFacts = need.snapshot;
    const prior = constraint ?? {};
    constraint = { kind: "unit_count", value: context.lines.filter(line => !line.isAddon).reduce((total, line) => total + line.qty, 0), dailyNeed: need.dailyNeed,
      ...(prior.mode === policy.portionModes.reduced.mode ? { mode: policy.portionModes.reduced.mode, portionFactor: policy.portionModes.reduced.factor } : {}) };
  }
  const dailyNeed = constraint?.dailyNeed;
  if (!constraint || constraint.kind !== "unit_count" || !Number.isSafeInteger(dailyNeed) || Number(dailyNeed) <= 0 || !Number.isSafeInteger(constraint.value)) throw new Error("subscription_reprice_sized_need_unreadable");
  if ("compositionConstraint" in request && !sameSizedPinnedConstraint(request.compositionConstraint, constraint)) throw new Error("subscription_reprice_sized_lever_mismatch");
  const baseline = selectSizedAgreements(context, policy), current = agreedSubscriptionTotal(baseline);
  const catalog = await host.readCatalog(db, context);
  const cadenceDays = request.action === "update_plan_length" ? request.planDays : "cadenceDays" in request ? request.cadenceDays ?? context.cadenceDays : context.cadenceDays;
  const rules = createSizedCompositionRules({ policy, catalog, baseline, exclusions: facts.exclusions, dailyNeed: Number(dailyNeed), cadenceDays,
    useFrozenBaseline: sizedEditPhase(context, policy) === "graduation_pending", proposePortion: host.proposePortion });
  let core: BundleLineRef[] = baseline.filter(line => !line.isAddon).map(line => ({ variantId: line.variantId, qty: line.qty, isAddon: false }));
  let addons: BundleLineRef[] = baseline.filter(line => line.isAddon).map(line => ({ variantId: line.variantId, qty: line.qty, isAddon: true }));
  let coreConstraint: CompositionConstraint = { kind: "subscription.sized", version: 1, data: constraint };
  if (request.action === "update_bundle" || request.action === "update_base_mix") {
    core = (request.action === "update_bundle" ? request.coreLines : request.base).map(line => ({ ...line, isAddon: false }));
    if (request.action === "update_bundle") {
      coreConstraint.data = request.compositionConstraint;
      if (request.addonLines !== undefined) addons = request.addonLines.map(line => ({ ...line, isAddon: true }));
    }
    const validation = await rules.validateComposition({ coreLines: core, addonLines: addons, constraint: coreConstraint });
    if (!validation.ok) throw new Error(validation.code);
    if ((request.action === "update_base_mix" || cadenceDays === context.cadenceDays) && core.reduce((total, line) => total + line.qty, 0) !== baseline.filter(line => !line.isAddon).reduce((total, line) => total + line.qty, 0)) throw new Error("subscription_reprice_base_total_mismatch");
  } else if (request.action === "resize_bundle" || request.action === "update_plan_length" || request.action === "update_portion") {
    if (request.action === "resize_bundle") {
      coreConstraint.data = request.compositionConstraint;
      if (request.resizeLever.kind !== SIZED_PARCEL_LEVER_KIND && request.resizeLever.kind !== "portionMode") throw new Error("subscription_reprice_sized_lever_mismatch");
    }
    const resized = await rules.resizeComposition({ coreLines: core, constraint: coreConstraint, lever: request.action === "resize_bundle" ? request.resizeLever
      : request.action === "update_plan_length" ? { kind: "planLength", value: request.planDays }
        : { kind: "portionMode", value: { portionMode: request.portionMode, planDays: context.cadenceDays } } });
    if (!resized) throw new Error("subscription_reprice_sized_lever_mismatch");
    core = resized.coreLines; coreConstraint = resized.constraint;
  } else {
    const position = addons.findIndex(line => line.variantId.toLowerCase() === request.variantId.toLowerCase());
    if (request.action === "remove_addon") {
      if (position < 0) throw new Error("subscription_reprice_addon_not_found"); addons.splice(position, 1);
    } else if (position >= 0) addons[position] = { ...addons[position], qty: request.qty };
    else if (request.action === "add_addon") addons.push({ variantId: request.variantId, qty: request.qty, isAddon: true });
    else throw new Error("subscription_reprice_addon_not_found");
  }
  const desired = [...core, ...addons], byId = new Map(catalog.map(fact => [fact.variantId.toLowerCase(), fact]));
  const references = desired.map(line => {
    const fact = byId.get(line.variantId.toLowerCase());
    const prior = baseline.find(value => value.variantId.toLowerCase() === line.variantId.toLowerCase() && value.isAddon === (line.isAddon ?? false));
    if (!fact && !prior) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
    return { lineId: prior?.lineId ?? null, variantId: line.variantId, sku: fact?.sku ?? prior!.sku,
      groupId: fact?.groupId ?? prior!.groupId, qty: line.qty, isAddon: line.isAddon ?? false };
  });
  const quoteRequest = { mode: "subscription" as const, cadenceDays, compositionConstraint: coreConstraint.data,
    promoCodes: [], lines: references.map(line => ({ sku: line.sku, quantity: line.qty, modeAtLine: "subscription" as const, isAddon: line.isAddon })) };
  const split = splitBySubscriptionAgreement(quoteRequest, baseline);
  const changed = split.changed.length ? (await host.quotePort.createServerAuthoritativeQuote({ ...quoteRequest, lines: split.changed.map(value => value.line) })).quote : null;
  const quote = mergeSubscriptionAgreedQuote({ request: quoteRequest, unchanged: split.unchanged, changedQuote: changed, currency: current.currency });
  const lines = references.map((line, index) => ({ ...line, quoteLine: quote.lines[index] as SizedAgreedLine["quoteLine"] }));
  return { lines, cadenceDays, compositionConstraint: coreConstraint.data, expectedTemplateVersion: context.templateVersion,
    quoteHash: hashPackageEditQuote(quote), quote, currentRecurringPrice: current, newRecurringPrice: quote.totalGross,
    delta: { amountMinor: quote.totalGross.amountMinor - current.amountMinor, currency: current.currency },
    changedLines: split.changed.length, unchangedLines: split.unchanged.length, subjectFacts: facts, optInFacts };
}
export function assertSizedSubjectFacts(facts: SizedSubjectFacts, context: SizedEditContext, policy: SizedEditPolicy): void {
  if (!facts || typeof facts.clientId !== "string" || typeof facts.subscriptionId !== "string" ||
    facts.clientId.toLowerCase() !== context.clientId.toLowerCase() || facts.subscriptionId.toLowerCase() !== context.subscriptionId.toLowerCase() ||
    !facts.subjectRef || !Array.isArray(facts.exclusions) || facts.exclusions.length > policy.maximumExclusions ||
    facts.exclusions.some(key => typeof key !== "string" || !key) || !facts.snapshot || typeof facts.snapshot !== "object") throw new Error("subscription_reprice_sized_subject_facts_unreadable");
}
export function sizedCandidateCompatibility(catalog: readonly SizedCatalogFact[], facts: SizedSubjectFacts) {
  return catalog.map(fact => ({ ...fact, selectable: Array.isArray(fact.exclusions) && !fact.exclusions.some(key => facts.exclusions.includes(key)) }));
}
