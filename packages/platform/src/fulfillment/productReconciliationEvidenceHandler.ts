/** Read-only evidence boundary; parsing remains with the owning host schema. */
export function createProductReconciliationEvidenceHandler<Request extends { method?: string; query: Record<string, string | string[] | undefined> }, Response, Query, Result>({ evidencePort, authorizeAdmin, requestSchema, responseSchema, respond }: {
  evidencePort: { getProductReconciliationEvidence(query: Query): Promise<unknown> };
  authorizeAdmin(request: Request): Promise<boolean>;
  requestSchema: { safeParse(input: unknown): { success: true; data: Query } | { success: false; error: { flatten(): unknown } } };
  responseSchema: { safeParse(input: unknown): { success: true; data: Result } | { success: false } };
  respond: {
    sendBffError(res: Response, code: "UPSTREAM_UNAVAILABLE" | "UNAUTHORIZED" | "BAD_REQUEST" | "INVALID_RESPONSE", message: string, options?: { details: unknown }): void;
    sendBffSuccess(res: Response, data: Result): void;
    sendMethodNotAllowed(res: Response, methods: readonly string[]): void;
  };
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: Request, res: Response): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    let authorized = false;
    try {
      authorized = await authorizeAdmin(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed", {
        details: { reason: "product_reconciliation_authorization_unavailable" },
      });
      return;
    }

    if (!authorized) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    const request = requestSchema.safeParse({
      statusFilter: scalarQuery(req.query.statusFilter),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid product reconciliation request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await evidencePort.getProductReconciliationEvidence(request.data);
      const response = responseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Product reconciliation returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Product reconciliation read failed", {
        details: { reason: "product_reconciliation_read_unavailable" },
      });
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
