import { createSupabaseDataGateway } from "../../adapters/supabase/dataGateway.js";
import { readSupabaseDataGatewayEnv } from "../../adapters/supabase/dataGatewayClientFactory.js";

export type CommerceServiceDataGateway = ReturnType<typeof createSupabaseDataGateway>;

export function readCommerceServiceDataGateway(): CommerceServiceDataGateway | null {
  const env = readSupabaseDataGatewayEnv();
  return env ? createSupabaseDataGateway(env) : null;
}

export function readCommerceServiceDataGatewayWithLegacyServiceKeyFallback(
  env: Record<string, string | undefined> = process.env,
): CommerceServiceDataGateway | null {
  const standard = readSupabaseDataGatewayEnv(env);
  if (standard) return createSupabaseDataGateway(standard);

  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceRoleKey) return null;

  const anonKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
    env.SUPABASE_ANON_KEY ??
    "";

  return createSupabaseDataGateway({ url, anonKey, serviceRoleKey });
}
