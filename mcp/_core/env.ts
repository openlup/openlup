/**
 * MCP agent head — generic `_core` (domain-neutral).
 *
 * Resolves the MCP server's runtime config from the environment, FAIL-CLOSED:
 * any missing value throws before the server boots. Note what is intentionally
 * absent — the service-role key. The MCP head signs in as a service-admin user
 * (anon key + operator creds), so it can never bypass the publish gate.
 */
export interface McpEnvConfig {
  /** BFF origin, e.g. `http://localhost:3000` or a preview host. */
  readonly bffBaseUrl: string;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly operatorEmail: string;
  readonly operatorPassword: string;
}

interface EnvSource {
  [key: string]: string | undefined;
}

export function readMcpEnv(env: EnvSource = process.env): McpEnvConfig {
  const bffBaseUrl = env.openlup_BFF_BASE_URL;
  const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const supabaseAnonKey =
    env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
  const operatorEmail = env.AGENT_OPERATOR_EMAIL;
  const operatorPassword = env.AGENT_OPERATOR_PASSWORD;

  const missing = [
    ["openlup_BFF_BASE_URL", bffBaseUrl],
    ["SUPABASE_URL (or VITE_SUPABASE_URL)", supabaseUrl],
    ["VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)", supabaseAnonKey],
    ["AGENT_OPERATOR_EMAIL", operatorEmail],
    ["AGENT_OPERATOR_PASSWORD", operatorPassword],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`MCP server is not configured. Missing env: ${missing.join(", ")}`);
  }

  return {
    bffBaseUrl: bffBaseUrl as string,
    supabaseUrl: supabaseUrl as string,
    supabaseAnonKey: supabaseAnonKey as string,
    operatorEmail: operatorEmail as string,
    operatorPassword: operatorPassword as string,
  };
}
