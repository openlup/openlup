import type {
  AccountingControlPort,
  AccountingInvoiceIssuePort,
  AccountingInvoiceRuntimePort,
  AccountingReadPort,
} from "../../../src/domains/accounting/ports.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import { createSupabaseAccountingControlPort } from "./accounting/accountingControl.js";
import { createSupabaseAccountingReadPort } from "./accounting/accountingRead.js";
import { createSupabaseAccountingInvoicePort } from "./accountingInvoicePort.js";
import {
  readAccountingE2eInvoice,
  type AccountingE2eInvoiceReadSupabaseClient,
  type AccountingE2eInvoiceRow,
} from "./accounting/accountingE2eRead.js";

export type { AccountingE2eInvoiceRow };

type AccountingControlClient = Parameters<typeof createSupabaseAccountingControlPort>[0];
type AccountingReadClient = Parameters<typeof createSupabaseAccountingReadPort>[0];
type AccountingInvoiceClient = Parameters<typeof createSupabaseAccountingInvoicePort>[0];

export interface SupabaseAdminAccountingEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseAdminAccountingGatewayOptions {
  clientFactory?: (env: SupabaseAdminAccountingEnv) => unknown;
}

export interface SupabaseAdminAccountingGateway {
  controlPort: () => AccountingControlPort;
  readPort: () => AccountingReadPort;
  invoicePort: () => AccountingInvoiceIssuePort & AccountingInvoiceRuntimePort;
  readE2eInvoice: (invoiceId: string) => Promise<AccountingE2eInvoiceRow | null>;
}

export function createSupabaseAdminAccountingGateway(
  env: SupabaseAdminAccountingEnv,
  options: SupabaseAdminAccountingGatewayOptions = {},
): SupabaseAdminAccountingGateway {
  let client: unknown | null = null;
  let controlPort: AccountingControlPort | null = null;
  let readPort: AccountingReadPort | null = null;
  let invoicePort: (AccountingInvoiceIssuePort & AccountingInvoiceRuntimePort) | null = null;

  function getClient(): unknown {
    client ??= (options.clientFactory ?? createServiceRoleClient)(env);
    return client;
  }

  return {
    controlPort: () => {
      controlPort ??= createSupabaseAccountingControlPort(getClient() as AccountingControlClient);
      return controlPort;
    },
    readPort: () => {
      readPort ??= createSupabaseAccountingReadPort(getClient() as AccountingReadClient);
      return readPort;
    },
    invoicePort: () => {
      invoicePort ??= createSupabaseAccountingInvoicePort(getClient() as AccountingInvoiceClient);
      return invoicePort;
    },
    readE2eInvoice: (invoiceId) =>
      readAccountingE2eInvoice(getClient() as AccountingE2eInvoiceReadSupabaseClient, invoiceId),
  };
}
