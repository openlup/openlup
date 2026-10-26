import type { PaymentExecutionBaseInput, PaymentExecutionBaseResult } from "@openlup/core/payment";
export type CheckoutExecutionProvider = string;
export type CheckoutProviderFlow = string;
export interface CheckoutRuntimeRequest<MethodKind extends string = string, RecurringModel extends string = string> {
  idempotencyKey: string; paymentProvider: CheckoutExecutionProvider; providerFlow: CheckoutProviderFlow;
  paymentAttemptSequence?: number; paymentMethodRef?: string; paymentMethodAliasType?: MethodKind;
  paymentMethodRecurringModel?: RecurringModel; providerPayer?: { email: string; name: string; ip?: string | null; userAgent?: string | null };
  saveForFutureUse?: boolean; returnContext?: "public" | "account"; paymentExecution?: unknown; declaredBankId?: string;
  metadata: Record<string, unknown>;
}
export interface CheckoutRuntimeExecutionInput<Transient, Flow extends string = string, MethodKind extends string = string, RecurringModel extends string = string> extends PaymentExecutionBaseInput {
  orderRef: string; providerFlow?: Flow; clientId?: string; orderId?: string;
  paymentMethodRef?: string; paymentMethodAliasType?: MethodKind; paymentMethodRecurringModel?: RecurringModel;
  payer?: { email: string; name: string; ip?: string | null; userAgent?: string | null };
  saveForFutureUse?: boolean; returnContext?: "public" | "account"; transientProviderInput?: Transient | null;
}
export interface CheckoutRuntimeExecutionResult extends PaymentExecutionBaseResult {
  provider: CheckoutExecutionProvider; clientSecret?: string | null; redirectUrl?: string | null;
}
export interface CheckoutRuntimeExecutionPort<Execution, Transient, Flow extends string = string, MethodKind extends string = string, RecurringModel extends string = string> { execute(input: CheckoutRuntimeExecutionInput<Transient, Flow, MethodKind, RecurringModel>): Promise<Execution> }
export interface CheckoutRuntimeResultRequest { idempotencyKey: string; orderId: string; paymentIntentId: string; resultStatus: string }
export interface CheckoutRuntimePaymentPort {
  createIntent(input: { idempotencyKey: string; targetKind: "one_time_order" | "subscription_cycle"; orderId: string; subscriptionId: string | null; subscriptionCycleId: string | null; amountMinor: number; currency: string; metadata: Record<string, unknown> }): Promise<{ paymentIntentId: string; paymentId: string; status: string; replayed: boolean }>;
  applyResult(input: CheckoutRuntimeResultRequest): Promise<{ orderId: string; kind: string }>;
}
export interface CheckoutRuntimeResponse { runtime: { orderId: string } }
