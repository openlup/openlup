import {
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
  customerDiagnosticLookupSchema,
} from "../../src/domains/observability/customerJourneyDiagnostics.js";
import { toolInputObjectSchema, type McpToolDefinition } from "../_core/toolFromContract.js";

export const customerDiagnosticsTool: McpToolDefinition = {
  name: "support__customer_diagnostics",
  description: "Search retained anonymous or verified-account diagnostic paths and grouped observations in a bounded time window; use history mode for one segment or overview mode for globally grouped action outcomes. Overview requires customer-diagnostic-history.v2 and separates evidence, source, window, pagination, and rate-applicability state. Requires an active operator and the machine customer-read gate; every read is atomically audited. Browser reports are unverified observations, missing terminal events do not prove failure, and counts do not imply conversion rates. Read-only.",
  path: "mcp://support/customer-diagnostics",
  contractVersion: CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
  httpMethod: "GET",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  requestSchema: customerDiagnosticLookupSchema,
  inputSchema: toolInputObjectSchema(customerDiagnosticLookupSchema),
  call: async (input, { bffClient }) => {
    const parsed = customerDiagnosticLookupSchema.parse(input);
    return bffClient.get("/api/bff/admin/support/customer-diagnostics",
      Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])),
      { contractVersion: CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2 });
  },
};
