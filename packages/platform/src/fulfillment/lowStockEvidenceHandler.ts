/** Read-only evidence boundary; parsing remains with the owning host schema. */
export function createFulfillmentLowStockEvidenceHandler<Request extends { method?: string; query: Record<string, string | string[] | undefined> }, Response, Query, Result>({ evidencePort, authorizeAdmin, requestSchema, responseSchema, respond }: {
  evidencePort: { getLowStockEvidence(query: Query): Promise<unknown> };
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
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
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
      sendBffError(res, "BAD_REQUEST", "Invalid low-stock evidence request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await evidencePort.getLowStockEvidence(request.data);
      const response = responseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Low-stock evidence returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Low-stock evidence read failed");
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
