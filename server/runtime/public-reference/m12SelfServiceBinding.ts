import { createSelfServiceCommandFacade, type CustomerContext, type SelfServiceCommandFacadeInput } from "@openlup/platform/account-support";

/** Default-off recipe only. The caller verifies context before selecting host parts. */
export function createM12SelfServiceReferenceBinding<Request extends { subscriptionId: string; action: string }, PreviewRequest, Preview, Receipt,
  ProfileRequest, ProfileResult, MethodRequest, MethodResult, CommerceRequest, CommerceResult, RecoveryRequest, RecoveryResult, ControlSnapshot = unknown>(input: {
  enabled?: boolean;
  select?(context: CustomerContext): Promise<SelfServiceCommandFacadeInput<Request, PreviewRequest, Preview, Receipt,
    ProfileRequest, ProfileResult, MethodRequest, MethodResult, CommerceRequest, CommerceResult, RecoveryRequest, RecoveryResult, ControlSnapshot>>;
}) {
  if (input.enabled !== true) return { enabled: false as const };
  const select = input.select;
  if (!select) throw new Error("customer_self_service_lane_configuration_required");
  return {
    enabled: true as const,
    async select(context: CustomerContext) {
      const selected = await select(context);
      if (selected.context.principalId !== context.principalId || selected.context.clientId !== context.clientId
        || selected.context.graph !== context.graph) throw new Error("customer_principal_mismatch");
      return createSelfServiceCommandFacade(selected);
    },
  };
}
