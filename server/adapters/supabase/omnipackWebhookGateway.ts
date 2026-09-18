import { createClient } from "@supabase/supabase-js";
import type { AccountingInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import type { OmnipackWebhookPort } from "../../domains/fulfillment/omnipackWebhookHandler.js";
import {
  createSupabaseOmnipackWebhookPort,
  type OmnipackWebhookSupabaseClient,
} from "./omnipackWebhookPort.js";

type ClientFactory = typeof createClient;

export type SupabaseOmnipackWebhookEnv = Record<string, string | undefined> & {
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export interface SupabaseOmnipackWebhookGatewayOptions {
  accountingEnabled?: boolean;
  accountingPortFactory?: (client: OmnipackWebhookSupabaseClient) => AccountingInvoiceIssuePort;
  accountingProviderKind?: string;
  clientFactory?: ClientFactory;
}

export interface SupabaseOmnipackWebhookGateway {
  port: OmnipackWebhookPort;
}

export function createSupabaseOmnipackWebhookGateway(
  env: SupabaseOmnipackWebhookEnv,
  options: SupabaseOmnipackWebhookGatewayOptions = {},
): SupabaseOmnipackWebhookGateway | null {
  const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;

  const client = (options.clientFactory ?? createClient)(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as OmnipackWebhookSupabaseClient;
  const accountingPort = options.accountingEnabled && options.accountingPortFactory
    ? options.accountingPortFactory(client)
    : undefined;

  return {
    port: createSupabaseOmnipackWebhookPort(client, {
      accountingPort,
      accountingProviderKind: options.accountingProviderKind,
    }),
  };
}
