import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  accountingInvoiceIssueRequestSchema,
  accountingInvoiceIssueResponseSchema,
  adminAccountingOrderSummaryRequestSchema,
  adminAccountingOrderSummaryResponseSchema,
  accountingProviderSyncEventSchema,
  accountingProviderSyncResponseSchema,
  invoiceDataLookupRequestSchema,
  invoiceDataLookupResponseSchema,
  paymentProviderSettlementRecordSchema,
  paymentProviderSettlementResponseSchema,
} from "../../../src/domains/accounting/invoiceContracts.js";
import {
  AccountingControlConflictError,
  type AccountingControlPort,
  type AccountingReadPort,
  type InvoiceDataLookupPort,
} from "../../../src/domains/accounting/ports.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

interface AccountingHandlerDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  accountingPort: AccountingControlPort;
  mutationsEnabled: () => boolean;
}

export function createAccountingOrderSummaryHandler({
  authorizeAdmin,
  accountingPort,
}: {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  accountingPort: AccountingReadPort;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    try {
      const authorization = await authorizeAdmin(req);
      if (authorization.ok === false) {
        sendBffError(res, authorization.code, authorization.message);
        return;
      }
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return;
    }

    const request = adminAccountingOrderSummaryRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid accounting order summary request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await accountingPort.getOrderSummary(request.data);
      const response = adminAccountingOrderSummaryResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Accounting order summary returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Accounting order summary failed");
    }
  };
}

export function createAccountingInvoiceIssueHandler(deps: AccountingHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorizeAndCheckFlag(req, res, deps))) return;

    const request = accountingInvoiceIssueRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid accounting invoice issue request", {
        details: request.error.flatten(),
      });
      return;
    }

    await sendAccountingResponse(res, () => deps.accountingPort.requestInvoiceIssue(request.data), "issue");
  };
}

export function createAccountingProviderSyncHandler(deps: AccountingHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorizeAndCheckFlag(req, res, deps))) return;

    const request = accountingProviderSyncEventSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid accounting provider sync request", {
        details: request.error.flatten(),
      });
      return;
    }

    await sendAccountingResponse(res, () => deps.accountingPort.recordProviderSyncEvent(request.data), "sync");
  };
}

export function createPaymentSettlementRecordHandler(deps: AccountingHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorizeAndCheckFlag(req, res, deps))) return;

    const request = paymentProviderSettlementRecordSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid payment settlement request", {
        details: request.error.flatten(),
      });
      return;
    }

    await sendAccountingResponse(res, () => deps.accountingPort.recordPaymentSettlement(request.data), "settlement");
  };
}

export function createInvoiceDataLookupHandler({
  lookupPort,
}: {
  lookupPort: InvoiceDataLookupPort;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST") {
      return sendMethodNotAllowed(res, ["GET", "POST"]);
    }

    const request = invoiceDataLookupRequestSchema.safeParse(
      req.method === "GET" ? readLookupQuery(req) : req.body ?? {},
    );
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid invoice data lookup request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await lookupPort.lookupInvoiceData(request.data);
      const response = invoiceDataLookupResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Invoice data lookup returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invoice data lookup failed");
    }
  };
}

async function authorizeAndCheckFlag(
  req: VercelRequest,
  res: VercelResponse,
  deps: AccountingHandlerDeps,
): Promise<boolean> {
  try {
    const authorization = await deps.authorizeAdmin(req);
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return false;
    }
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }

  if (!deps.mutationsEnabled()) {
    sendBffError(res, "FORBIDDEN", "Accounting mutations are not enabled");
    return false;
  }
  return true;
}

async function sendAccountingResponse(
  res: VercelResponse,
  action: () => Promise<unknown>,
  kind: "issue" | "sync" | "settlement",
): Promise<void> {
  try {
    const result = await action();
    if (kind === "issue") {
      const response = accountingInvoiceIssueResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Accounting invoice issue returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
      return;
    }
    const schema =
      kind === "sync" ? accountingProviderSyncResponseSchema : paymentProviderSettlementResponseSchema;
    const response = schema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", `Accounting ${kind} returned invalid response`);
      return;
    }
    sendBffSuccess(res, response.data);
  } catch (error) {
    if (error instanceof AccountingControlConflictError) {
      sendBffError(res, "CONFLICT", error.message, { details: error.details });
      return;
    }
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Accounting mutation failed");
  }
}

function readLookupQuery(req: VercelRequest): Record<string, unknown> {
  return {
    taxId: readQueryValue(req, "taxId"),
    country: readQueryValue(req, "country"),
    providerKind: readQueryValue(req, "providerKind"),
  };
}

function readQueryValue(req: VercelRequest, key: string): string | undefined {
  const value = req.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}
