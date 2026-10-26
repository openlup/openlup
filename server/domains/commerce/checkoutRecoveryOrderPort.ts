import type { CheckoutRecoveryOrderSnapshot as Snapshot, CheckoutRecoveryOrderReadPort as ReadPort } from "@openlup/platform/commerce/server";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { PaymentIntentStatus } from "../../../src/domains/payment/types.js";
export type { CheckoutRecoveryPriorPaymentEvidence } from "@openlup/platform/commerce/server";
export type CheckoutRecoveryOrderSnapshot = Snapshot<CreateQuoteResponse, PaymentIntentStatus, { petName: string | null; petId?: string | null }>;
export type CheckoutRecoveryOrderReadPort = ReadPort<CheckoutRecoveryOrderSnapshot>;
