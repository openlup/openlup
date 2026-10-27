import { createRiskPrivacyContributor, type RiskPrivacyContributor, type RiskPrivacyDependencies } from "./privacyContributor.js";

/** Opaque host-owned future binding. This selects no transfer/restore contract or runtime. */
export interface RiskPrivacyBinding<Context, Portability> {
  contributor: RiskPrivacyContributor<Context>;
  portability: { status: "deferred" } | { status: "host-bound"; binding: Portability };
}
/** Append contributor to the existing M03 registry; no default/reference registration.
 * A supplied portability value is carried unchanged, never invoked or certified.
 */
export function createRiskPrivacyBinding<Context, Portability = never>(input: RiskPrivacyDependencies<Context> & {
  portability?: Portability;
}): RiskPrivacyBinding<Context, Portability> {
  return { contributor: createRiskPrivacyContributor(input), portability: input.portability === undefined
    ? { status: "deferred" } : { status: "host-bound", binding: input.portability } };
}
