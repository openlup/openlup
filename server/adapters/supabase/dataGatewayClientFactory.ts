// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. It binds the real supabase-js `createClient` and the process environment as
// the defaults the reference call sites rely on.

import { createClient } from "@supabase/supabase-js";
import {
  createActorClient as createPlatformActorClient,
  createServiceClient as createPlatformServiceClient,
  readSupabaseActorDataGatewayEnv as readPlatformActorEnv,
  readSupabaseDataGatewayEnv as readPlatformEnv,
  type SupabaseCreateClient,
  type SupabaseDataGatewayEnv,
} from "@openlup/platform/data";

export type { SupabaseCreateClient, SupabaseDataGatewayEnv } from "@openlup/platform/data";

/** The real supabase-js client factory. */
export const supabaseCreateClient = createClient as unknown as SupabaseCreateClient;

/** Read the gateway env from process env using the same precedence the inline sites use today. */
export function readSupabaseDataGatewayEnv(
  env: Record<string, string | undefined> = process.env,
): SupabaseDataGatewayEnv | null {
  return readPlatformEnv(env);
}

/** Read env for actor-only gateway consumers. Does not require the elevated service-role key. */
export function readSupabaseActorDataGatewayEnv(
  env: Record<string, string | undefined> = process.env,
): SupabaseDataGatewayEnv | null {
  return readPlatformActorEnv(env);
}

export function createServiceClient(
  env: SupabaseDataGatewayEnv,
  factory: SupabaseCreateClient = supabaseCreateClient,
): unknown {
  return createPlatformServiceClient(env, factory);
}

export function createActorClient(
  env: SupabaseDataGatewayEnv,
  accessToken: string | null,
  factory: SupabaseCreateClient = supabaseCreateClient,
): unknown {
  return createPlatformActorClient(env, accessToken, factory);
}
