import { createServiceRoleClient } from "../../../_lib/admin-domain/auth.js";
import {
  createSupabasePublicPreferenceTokenPort,
  type PublicPreferenceTokenSupabaseClient,
} from "./publicPreferenceToken.js";

export interface SupabaseCommunicationsEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseCommunicationsGatewayOptions {
  clientFactory?: (env: SupabaseCommunicationsEnv) => unknown;
}

export function createSupabasePublicCommunicationPreferencesGateway(
  env: SupabaseCommunicationsEnv,
  options: SupabaseCommunicationsGatewayOptions = {},
) {
  let port: ReturnType<typeof createSupabasePublicPreferenceTokenPort> | null = null;

  return {
    preferenceTokenPort: () => {
      if (!port) {
        const client = (options.clientFactory ?? createServiceRoleClient)(env) as unknown as PublicPreferenceTokenSupabaseClient;
        port = createSupabasePublicPreferenceTokenPort(client);
      }
      return port;
    },
  };
}
