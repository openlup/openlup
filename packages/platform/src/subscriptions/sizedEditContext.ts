import { z } from "zod";
import { assertAgreedQuoteLine } from "./agreedPlanQuote.js";
import type { SizedAgreedLine, SizedEditContext, SizedEditPolicy, SizedEditPhase, SizedEditRequest } from "./contracts/sizedEdit.js";
import { SIZED_PARCEL_LEVER_KIND } from "./sizedParcelLever.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { nativeRenewalTermsSchema } from "./nativeRenewalTerms.js";

const uuid = z.uuid().transform(value => value.toLowerCase());
const requestedLine = z.object({ variantId: uuid, qty: z.number().int().positive() }).strict();
const acceptance = { subscriptionId: uuid, expectedTemplateVersion: z.number().int().positive().optional(), acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() };
const constraint = z.record(z.string(), z.unknown());
const parcel = z.object({ kind: z.literal(SIZED_PARCEL_LEVER_KIND), value: z.object({ coreLines: z.array(requestedLine).min(1), optInToSized: z.literal(true).optional() }).strict() }).strict();
const sizedRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...acceptance, action: z.literal("resize_bundle"), cadenceDays: z.number().int().positive(), compositionConstraint: constraint,
    resizeLever: z.union([parcel, z.object({ kind: z.literal("portionMode"), value: z.object({ portionMode: z.string().min(1), planDays: z.number().int().positive() }).strict() }).strict()]) }).strict(),
  z.object({ ...acceptance, action: z.literal("update_bundle"), coreLines: z.array(requestedLine).min(1),
    addonLines: z.array(requestedLine).optional(), cadenceDays: z.number().int().positive().optional(), compositionConstraint: constraint }).strict(),
  z.object({ ...acceptance, action: z.literal("update_base_mix"), base: z.array(requestedLine).min(1) }).strict(),
  z.object({ ...acceptance, action: z.literal("update_plan_length"), planDays: z.number().int().positive() }).strict(),
  z.object({ ...acceptance, action: z.literal("update_portion"), portionMode: z.string().min(1) }).strict(),
  z.object({ ...acceptance, action: z.literal("add_addon"), variantId: uuid, qty: z.number().int().positive() }).strict(),
  z.object({ ...acceptance, action: z.literal("update_addon_quantity"), variantId: uuid, qty: z.number().int().positive() }).strict(),
  z.object({ ...acceptance, action: z.literal("remove_addon"), variantId: uuid }).strict(),
]);
/** Internal parser for the shipped sized wire. @experimental */
export function parseSizedEditRequest(request: unknown): SizedEditRequest {
  const parsed = tryParseSizedEditRequest(request);
  if (!parsed) throw new Error("subscription_reprice_invalid_request");
  return parsed;
}

/** Internal parse for receipt dispatch. @experimental */
export function tryParseSizedEditRequest(request: unknown): SizedEditRequest | null {
  const result = sizedRequestSchema.safeParse(request);
  return result.success ? result.data : null;
}

/** The successor wire requires the flat form for both requested and effective constraints.
 * @experimental
 */
export function parseSuccessorSizedEditRequest(input: unknown, evidence?: { subscriptionId: string; applyPayload: unknown }): SizedEditRequest {
  const payload = evidence ? constraint.safeParse(evidence.applyPayload) : undefined;
  const raw = constraint.safeParse(input);
  if (!raw.success || payload?.success === false) throw new Error("subscription_reprice_invalid_request");
  const request = evidence ? { ...raw.data, subscriptionId: evidence.subscriptionId } : raw.data;
  // A retained graduation quote can carry its original portion mode alongside the resolved lever.
  if (evidence && request.action === "resize_bundle" && Object.hasOwn(request, "portionMode")) {
    const lever = constraint.safeParse(request.resizeLever);
    if (lever.success && lever.data.kind === "portionMode") {
      const value = constraint.safeParse(lever.data.value);
      if (value.success && request.portionMode === value.data.portionMode) delete request.portionMode;
    }
  }
  const parsed = parseSizedEditRequest(request);
  if (payload?.success && Object.hasOwn(payload.data, "recipeLines")) throw new Error("subscription_reprice_invalid_request");
  const flat = (value: unknown) => value == null || (typeof value === "object" && !Array.isArray(value)
    && !Object.hasOwn(value, "version") && !Object.hasOwn(value, "data"));
  if (!flat(payload?.data.compositionConstraint) || ("compositionConstraint" in parsed && !flat(parsed.compositionConstraint))) {
    throw new Error("subscription_reprice_invalid_request");
  }
  return parsed;
}

const object = z.record(z.string(), z.unknown());
const line = z.object({ lineId: z.uuid().nullable(), variantId: z.uuid(), sku: z.string().min(1), groupId: z.string().min(1),
  qty: z.number().int().positive(), isAddon: z.boolean(), quoteLine: object });
const contextSchema = z.object({ subscriptionId: z.uuid(), clientId: z.uuid(), binding: z.enum(["classic", "sized.v1"]),
  templateVersion: z.number().int().positive(), cadenceDays: z.number().int().positive(), compositionConstraint: object.nullable(),
  nextCycleAt: z.string().nullable(), paidCycleCount: z.number().int().nonnegative(), marker: object.nullable(),
  lines: z.array(line).min(1), graduationLines: z.array(line) });
export async function readSizedEditContext(db: SubscriptionQueryExecutor, clientId: string, id: string, optIn = false): Promise<SizedEditContext> {
  const { rows } = await db.query("SELECT public.subscription_sized_edit_context($1::uuid,$2::uuid,$3::boolean) AS context", [clientId, id, optIn]);
  const result = contextSchema.safeParse(rows.length === 1 ? rows[0].context : undefined);
  if (!result.success) throw new Error("subscription_reprice_sized_context_unreadable");
  const value = result.data;
  if (value.subscriptionId.toLowerCase() !== id.toLowerCase() || value.clientId.toLowerCase() !== clientId.toLowerCase()) throw new Error("subscription_command_forbidden");
  function agreed(current: z.infer<typeof line>): SizedAgreedLine {
    assertAgreedQuoteLine(current.quoteLine);
    if (current.quoteLine.sku !== current.sku || current.quoteLine.quantity !== current.qty) throw new Error("subscription_reprice_sized_agreed_price_unreadable");
    return { ...current, quoteLine: current.quoteLine };
  }
  let marker: SizedEditContext["marker"] = null;
  if (value.marker) {
    // Marker validation is shared with native renewal, including its money/phase carriers.
    const parsed = nativeRenewalTermsSchema.shape.starterPack.safeParse(value.marker);
    if (!parsed.success || !parsed.data) throw new Error("subscription_reprice_sized_marker_unreadable");
    marker = parsed.data;
  }
  return { ...value, marker, lines: value.lines.map(agreed), graduationLines: value.graduationLines.map(agreed) };
}
const numberedPhaseSchema = z.strictObject({ upcomingCycle: z.number().int().positive(), phase: z.enum(["fixed","graduation_pending","none"]) });
export async function readSizedConsentPhase(db: SubscriptionQueryExecutor, clientId: string, subscriptionId: string) {
  const { rows } = await db.query("SELECT public.subscription_sized_consent_phase($1::uuid,$2::uuid) AS phase", [clientId,subscriptionId]);
  const parsed = numberedPhaseSchema.safeParse(rows.length === 1 ? rows[0].phase : undefined);
  if (!parsed.success) throw new Error("subscription_edit_cycle_history_unreadable");
  return parsed.data;
}
/** Construct once per authenticated request; do not share across preview/apply. */
export function createSizedEditContextScope(read: (id: string, optIn: boolean) => Promise<SizedEditContext>) {
  const contexts = new Map<string, Promise<SizedEditContext>>();
  return (id: string, optIn = false) => {
    const key = `${id.toLowerCase()}:${optIn}`;
    let value = contexts.get(key);
    if (!value) { value = Promise.resolve().then(() => read(id, optIn)); contexts.set(key, value); }
    return value.then(context => structuredClone(context));
  };
}
export function sizedEditPhase(context: Pick<SizedEditContext, "marker" | "templateVersion" | "paidCycleCount" | "numberedPhase">, policy: SizedEditPolicy): SizedEditPhase {
  if (context.numberedPhase) return context.numberedPhase.phase;
  if (!context.marker) return "none";
  const upcoming = context.paidCycleCount + 1;
  if (upcoming <= policy.fixedThroughCycle) return "fixed";
  if (upcoming === policy.graduationCycle && context.templateVersion === context.marker.basisTemplateVersion) return "graduation_pending";
  return "none";
}
export function isSizedOptIn(request: { action: string; resizeLever?: unknown }): boolean {
  if (request.action !== "resize_bundle") return false;
  const lever = request.resizeLever as { kind?: string; value?: { optInToSized?: boolean } } | undefined;
  return lever?.kind === SIZED_PARCEL_LEVER_KIND && lever.value?.optInToSized === true;
}
export function sameSizedPinnedConstraint(asked: Record<string, unknown>, stored: Record<string, unknown>): boolean {
  const pinned = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["value", "mode", "portionFactor"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(pinned(asked)) === JSON.stringify(pinned(stored));
}
export function normalizeSizedEdit(request: SizedEditRequest, context: SizedEditContext, policy: SizedEditPolicy): SizedEditRequest {
  const phase = sizedEditPhase(context, policy);
  if ((isSizedOptIn(request) && context.binding === "classic" && phase !== "none") || phase === "fixed") throw new Error("subscription_edit_invalid_intro_fixed");
  if (phase !== "graduation_pending") return request;
  if (["add_addon", "remove_addon", "update_addon_quantity"].includes(request.action)) throw new Error("subscription_edit_invalid_graduation_addon");
  const cadence = context.marker!.graduation.cadenceDays;
  if (!policy.allowedCadences.includes(cadence)) throw new Error("subscription_reprice_sized_cadence_invalid");
  if (request.action === "update_portion") return { ...request, action: "resize_bundle", cadenceDays: cadence,
    compositionConstraint: context.marker!.graduation.sizeConstraint ?? context.compositionConstraint!,
    resizeLever: { kind: "portionMode", value: { portionMode: request.portionMode, planDays: cadence } } };
  if (request.action !== "update_base_mix" && request.action !== "update_bundle") return request;
  if (request.action === "update_bundle" && request.addonLines !== undefined) throw new Error("subscription_reprice_sized_graduation_addon_rewrite_unavailable");
  const desired = request.action === "update_base_mix" ? request.base : request.coreLines;
  const count = desired.reduce((total, current) => total + current.qty, 0);
  if (count !== context.graduationLines.filter(current => !current.isAddon).reduce((total, current) => total + current.qty, 0)) throw new Error("subscription_reprice_base_total_mismatch");
  if (request.action === "update_bundle" && (request.compositionConstraint.value !== count ||
    !sameSizedPinnedConstraint(request.compositionConstraint, context.compositionConstraint ?? {}))) throw new Error("subscription_reprice_sized_lever_mismatch");
  const constraint = context.marker!.graduation.sizeConstraint ?? context.compositionConstraint!;
  return { subscriptionId: request.subscriptionId, expectedTemplateVersion: request.expectedTemplateVersion, acceptedQuoteHash: request.acceptedQuoteHash,
    action: "resize_bundle", cadenceDays: request.action === "update_bundle" ? request.cadenceDays ?? cadence : cadence,
    compositionConstraint: { ...constraint, value: count }, resizeLever: { kind: SIZED_PARCEL_LEVER_KIND, value: { coreLines: desired } } };
}
