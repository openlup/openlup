export interface ResolveSavedPaymentMethodInput {
  accessToken: string | null;
  clientId: string;
  savedMethodId: string;
  requestedFlow: "blik_one_click" | "blik_recurring_saved";
  now: Date;
}

export const SAVED_PAYMENT_METHOD_RECURRING_MODELS = ["O", "M"] as const;
export type SavedPaymentMethodRecurringModel = typeof SAVED_PAYMENT_METHOD_RECURRING_MODELS[number];

export interface ResolvedSavedPaymentMethod {
  providerMethodRef: string;
  providerAliasType: "UID" | "PAYID";
  recurringModel?: SavedPaymentMethodRecurringModel;
}

export interface CheckoutSavedPaymentMethodResolverPort {
  resolveSavedPaymentMethod(
    input: ResolveSavedPaymentMethodInput,
  ): Promise<ResolvedSavedPaymentMethod | null>;
}
