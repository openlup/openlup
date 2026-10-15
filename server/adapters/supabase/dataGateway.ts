// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. It binds the real supabase-js `createClient` as the default.

import type { DataGatewayPort } from "@openlup/core/platform-runtime";
import {
  createSupabaseDataGateway as createPlatformSupabaseDataGateway,
  type SupabaseCreateClient,
  type SupabaseDataGatewayEnv,
} from "@openlup/platform/data";
import { supabaseCreateClient } from "./dataGatewayClientFactory.js";

type ActorClaims = { sub?: string; role?: string } | null;

export interface SupabaseDataGatewayOptions {
  /** Injection seam for the supabase-js client factory (tests pass a stub; default = real). */
  createClientImpl?: SupabaseCreateClient;
  /** Resolve an actor's Bearer access token from their claims; null selects the anon client. */
  resolveAccessToken?: (claims: ActorClaims) => string | null;
}

export function createSupabaseDataGateway(
  env: SupabaseDataGatewayEnv,
  options: SupabaseDataGatewayOptions = {},
): DataGatewayPort {
  return createPlatformSupabaseDataGateway(env, {
    ...options,
    createClientImpl: options.createClientImpl ?? supabaseCreateClient,
  });
}
