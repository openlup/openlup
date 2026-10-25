import { createRuntimeStartResponse } from "@openlup/platform/commerce/server";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { startHiddenCheckoutRuntimeResponseSchema, type HiddenCheckoutRuntimeReservation, type HiddenCheckoutRuntimeReadiness, type StartHiddenCheckoutRuntimeResponse } from "../../../src/domains/commerce/runtimeContracts.js";
import type { FinalizedCheckoutOrder, PaymentControlRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionResult } from "../../../src/domains/payment/types.js";
import { finalizeDeclinedAttempt } from "../../shared/finalizeDeclinedAttempt.js";
export const { buildStartedRuntimeResponse } = createRuntimeStartResponse<FinalizedCheckoutOrder, HiddenCheckoutRuntimeReservation, PaymentControlRuntimePort, PaymentExecutionResult, HiddenCheckoutRuntimeReadiness, StartHiddenCheckoutRuntimeResponse>({ contractVersion: COMMERCE_CONTRACT_VERSION, responseSchema: startHiddenCheckoutRuntimeResponseSchema, runtimeResponseExtension: (order) => ({ petId: order.petId }), finalizeDeclinedAttempt });
