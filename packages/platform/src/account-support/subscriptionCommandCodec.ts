import type { CustomerContext, LegacySubscriptionRequest, NativePreviewProjection, NativeSubscriptionCommand, NativeSubscriptionPreview, RawSubscriptionCommands, SubscriptionDriver } from "./contracts/index.js";

/** Encode only verified identity and the host's resolved request; no verb aliases. */
export function encodeNativeSubscriptionCommand<Action extends string, Payload extends Record<string, unknown>>(
  context: CustomerContext, request: LegacySubscriptionRequest<Action, Payload>, now: string,
): NativeSubscriptionCommand {
  return { actorId: context.principalId, clientId: context.clientId, idempotencyKey: request.idempotencyKey,
    subscriptionId: request.subscriptionId, action: request.action, payload: request.payload, now };
}

export function decodeNativeSubscriptionPreview<Preview>(result: Record<string, unknown>, project: (record: NativeSubscriptionPreview) => Preview): NativePreviewProjection<Preview> {
  if (result.status !== "previewed") return { kind: "owner", result };
  if (result.canApply !== true
    || !Number.isSafeInteger(result.templateVersion) || Number(result.templateVersion) < 1
    || typeof result.quoteHash !== "string" || !/^[a-f0-9]{64}$/.test(result.quoteHash)
    || typeof result.quoteExpiresAt !== "string" || !Number.isFinite(Date.parse(result.quoteExpiresAt))
    || !Number.isSafeInteger(result.currentTotalMinor) || Number(result.currentTotalMinor) < 0
    || !Number.isSafeInteger(result.newTotalMinor) || Number(result.newTotalMinor) < 0
    || !Array.isArray(result.lines) || result.lines.length === 0 || !result.lines.every(line =>
      line !== null && typeof line === "object" && typeof line.variantId === "string"
      && Number.isSafeInteger(line.quantity) && line.quantity > 0 && typeof line.isAddon === "boolean"
      && Number.isSafeInteger(line.sortOrder) && line.sortOrder >= 0
      && Number.isSafeInteger(line.unitPriceMinor) && line.unitPriceMinor >= 0 && typeof line.currency === "string")
    || result.priceAgreementPolicy === null || typeof result.priceAgreementPolicy !== "object"
    || !("kind" in result.priceAgreementPolicy) || result.priceAgreementPolicy.kind !== "lock_until_edit"
    || !("proration" in result.priceAgreementPolicy) || result.priceAgreementPolicy.proration !== "none"
    || !("cycleEffect" in result.priceAgreementPolicy) || result.priceAgreementPolicy.cycleEffect !== "future_unlocked_cycles_only") {
    throw new Error("subscription_command_preview_invalid");
  }
  return { kind: "projected", preview: project(result as NativeSubscriptionPreview) };
}

/** Preview and apply are separate transactions. Apply never creates a quote. */
export function createNativeSubscriptionDriver<Action extends string, Payload extends Record<string, unknown>, Preview>(input: {
  owner: RawSubscriptionCommands;
  now(): string;
  previewProjection(record: NativeSubscriptionPreview): Preview;
}): SubscriptionDriver<LegacySubscriptionRequest<Action, Payload>, NativePreviewProjection<Preview>, Record<string, unknown>> {
  return {
    async preview(context, request) {
      const command = encodeNativeSubscriptionCommand(context, request, input.now());
      const payload = { ...command.payload };
      delete payload.acceptedQuoteHash;
      return decodeNativeSubscriptionPreview(await input.owner.preview({ ...command, payload }), input.previewProjection);
    },
    apply(context, request) { return input.owner.apply(encodeNativeSubscriptionCommand(context, request, input.now())); },
  };
}
