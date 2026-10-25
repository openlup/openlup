import {
  canonicalStatusToken,
  customerStepFromSignals,
  stepForToken,
  type CustomerFulfillmentStep,
} from "../domains/fulfillment/statusMap.js";

export {
  FULFILLMENT_STATUS_MAP,
  // The canon's token->step and step->label readers. Re-exported here because
  // this module is the documented cross-domain seam: src/domains/commerce must
  // not import src/domains/fulfillment internals directly, which
  // architectureGuardrails enforces.
  stepForToken,
  timelineLabelForStep,
  type CustomerFulfillmentStep,
} from "../domains/fulfillment/statusMap.js";

import { resolveProviderExceptionRecovery as resolveRecovery } from "@openlup/platform/commerce";
export { customerStepForTerminalOrder, customerStepFromTimedSignals, customerSafeEvidenceToken } from "@openlup/platform/commerce";
export type { TimedFulfillmentSignal, ReleasedProviderExceptionHold, ProviderStatusEvidence, ResolvedProviderExceptionRecovery } from "@openlup/platform/commerce/contracts";
const AUTOMATIC_EXCEPTION_HOLD_SOURCE = "commerce.fulfillment.omnipack_provider_exception";
const AUTOMATIC_EXCEPTION_RELEASE_SOURCE = "commerce.fulfillment.omnipack_provider_exception_healed";
export function resolveProviderExceptionRecovery(input: Omit<Parameters<typeof resolveRecovery>[0], "automaticHoldSource" | "automaticReleaseSource">) {
 return resolveRecovery({ ...input, automaticHoldSource: AUTOMATIC_EXCEPTION_HOLD_SOURCE, automaticReleaseSource: AUTOMATIC_EXCEPTION_RELEASE_SOURCE });
}
