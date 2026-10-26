import type { AccountSupportLaneUnavailable, SelfServiceCommandFacade, SelfServiceCommandFacadeInput } from "./contracts/index.js";

const HOST_BINDING_REQUIRED: AccountSupportLaneUnavailable<"host_binding_required"> = Object.freeze({ supported: false, refusalCode: "host_binding_required" });

/** Neutral per-request graph selection. The host supplies all owner implementations. */
export function createSelfServiceCommandFacade<Request extends { subscriptionId: string; action: string }, PreviewRequest, Preview, Receipt,
  ProfileRequest, ProfileResult, MethodRequest, MethodResult, CommerceRequest, CommerceResult, RecoveryRequest, RecoveryResult, ControlSnapshot = unknown>(
  input: SelfServiceCommandFacadeInput<Request, PreviewRequest, Preview, Receipt,
    ProfileRequest, ProfileResult, MethodRequest, MethodResult, CommerceRequest, CommerceResult, RecoveryRequest, RecoveryResult, ControlSnapshot>,
): SelfServiceCommandFacade<Request, PreviewRequest, Preview, Receipt,
  ProfileRequest, ProfileResult, MethodRequest, MethodResult, CommerceRequest, CommerceResult, RecoveryRequest, RecoveryResult, ControlSnapshot> {
  const context = { ...input.context }, native = input.nativeLegacySubscription;
  function requireMethods(lane: object | undefined, methods: string[]) {
    if (lane !== undefined && (!lane || methods.some(method => typeof (lane as Record<string, unknown>)[method] !== "function"))) {
      throw new Error("customer_self_service_lane_configuration_required");
    }
  }
  requireMethods(input.managedSubscription, ["previewAction", "applyAction"]);
  requireMethods(native, ["ownershipRefusal"]);
  if (native) {
    if (!native.explicitPause || !native.control) throw new Error("customer_self_service_lane_configuration_required");
    requireMethods(native.explicitPause, ["applyAction"]);
    requireMethods(native.control, ["applyAction", "previewAction", "hasSubscription", "getSnapshot"]);
  }
  requireMethods(input.nativeRawSubscription, ["preview", "apply"]);
  requireMethods(input.nativeSubscription, ["preview", "apply"]);
  requireMethods(input.profile, ["updateProfile"]);
  requireMethods(input.paymentMethod, ["execute"]);
  requireMethods(input.commerce, ["execute"]);
  requireMethods(input.recovery, ["startPaymentRecovery"]);
  if ((!input.paymentMethod && input.capabilities.paymentMethodSetup.supported)
    || (!input.commerce && (input.capabilities.commerceRecovery.supported || input.capabilities.configuredPurchase.supported))
    || (!(input.managedSubscription || native || input.nativeRawSubscription || input.nativeSubscription)
      && (input.capabilities.subscriptions.genericBundleCommands.supported || input.capabilities.subscriptions.commandBoundReceipts.supported))) {
    throw new Error("customer_self_service_lane_configuration_required");
  }
  if (input.capabilities.graph !== context.graph
    || (input.managedSubscription && context.graph !== "managed")
    || ((native || input.nativeRawSubscription || input.nativeSubscription) && context.graph !== "native")) {
    throw new Error("customer_graph_mismatch");
  }
  function verify(principalId: string, clientId: string) {
    if (principalId !== context.principalId || clientId !== context.clientId) throw new Error("customer_principal_mismatch");
  }
  const managed = input.managedSubscription, raw = input.nativeRawSubscription, typed = input.nativeSubscription;
  const profile = input.profile, method = input.paymentMethod, commerce = input.commerce, recovery = input.recovery;
  const methodUnavailable = input.capabilities.paymentMethodSetup.supported ? undefined : input.capabilities.paymentMethodSetup;
  const commerceUnavailable = input.capabilities.commerceRecovery.supported ? undefined : input.capabilities.commerceRecovery;
  return {
    capabilities: input.capabilities,
    managedSubscription: {
      async previewAction(userId, request) { verify(userId, context.clientId); return managed ? managed.previewAction(userId, request) : HOST_BINDING_REQUIRED; },
      async applyAction(userId, request) { verify(userId, context.clientId); return managed ? managed.applyAction(userId, request) : HOST_BINDING_REQUIRED; },
    },
    nativeLegacySubscription: {
      async previewAction(userId, request) { verify(userId, context.clientId); return native ? native.control.previewAction(userId, request) : HOST_BINDING_REQUIRED; },
      async applyAction(userId, request) {
        verify(userId, context.clientId);
        if (!native) return HOST_BINDING_REQUIRED;
        if (request.action === "pause") return native.explicitPause.applyAction(userId, request);
        if (request.action !== "update_bundle") return native.control.applyAction(userId, request);
        const canonical = { ...request, subscriptionId: request.subscriptionId.toLowerCase() };
        if (!await native.control.hasSubscription(userId, canonical.subscriptionId)) throw native.ownershipRefusal();
        return native.control.applyAction(userId, canonical);
      },
    },
    subscriptionControl: {
      async getSnapshot(userId) { verify(userId, context.clientId); return native ? native.control.getSnapshot(userId) : HOST_BINDING_REQUIRED; },
    },
    nativeRawSubscription: {
      async preview(command) { verify(command.actorId, command.clientId); return raw ? raw.preview(command) : HOST_BINDING_REQUIRED; },
      async apply(command) { verify(command.actorId, command.clientId); return raw ? raw.apply(command) : HOST_BINDING_REQUIRED; },
    },
    nativeSubscription: {
      async preview(command) { verify(command.actor.actorId, command.actor.clientId); return typed ? typed.preview(command) : HOST_BINDING_REQUIRED; },
      async apply(command) { verify(command.actor.actorId, command.actor.clientId); return typed ? typed.apply(command) : HOST_BINDING_REQUIRED; },
    },
    profile: { async updateProfile(userId, request) { verify(userId, context.clientId); return profile ? profile.updateProfile(userId, request) : HOST_BINDING_REQUIRED; } },
    paymentMethod: { async execute(userId, request) { verify(userId, context.clientId); return method ? method.execute(userId, request) : methodUnavailable!; } },
    commerce: { async execute(userId, request) { verify(userId, context.clientId); return commerce ? commerce.execute(userId, request) : commerceUnavailable!; } },
    recovery: { async startPaymentRecovery(userId, request) { verify(userId, context.clientId); return recovery ? recovery.startPaymentRecovery(userId, request) : HOST_BINDING_REQUIRED; } },
  };
}
