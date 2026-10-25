import { createCheckoutStartRuntimeFailure } from "@openlup/platform/commerce/server";
import { PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT } from "../../shared/providerAttemptFailureDiagnostic.js";
import { checkoutProviderAttemptFailure } from "./commerceProviderAttemptFailure.js";
export const { mapStartRuntimeFailure } = createCheckoutStartRuntimeFailure({
  checkoutProviderAttemptFailure, prepareConflictReason: PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT,
});
