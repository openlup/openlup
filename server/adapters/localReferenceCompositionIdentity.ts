/**
 * Composition identities used only by the loopback reference profile. Keeping
 * them in one leaf prevents generic commands and use cases from inventing
 * profile or payment defaults. The captured adapter still performs no provider
 * call or egress.
 */
export const LOCAL_REFERENCE_PROFILE_ID = "local-supabase-demo-v1" as const;
export const LOCAL_REFERENCE_CONCRETE_PAYMENT_PROVIDER = "stripe" as const;
