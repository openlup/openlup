import { createNativeSubscriptionBinding } from "@openlup/platform/subscriptions";
import { createSubscriptionContribution } from "@openlup/platform/composition";

/** Host composition of the public native pipeline and existing job descriptor. */
export function createM10SubscriptionReferenceBinding(input: Parameters<typeof createNativeSubscriptionBinding>[0] & {
  version: string; cadenceSeconds: number;
}) {
  const { services, schema, realizationAdmitted } = createNativeSubscriptionBinding(input);
  const contribution = createSubscriptionContribution({ version: input.version, requiredSchema: schema,
    run: input.enabled === true ? services.run : null, cadenceSeconds: input.cadenceSeconds });
  return { services, ...contribution, schema, realizationAdmitted };
}
