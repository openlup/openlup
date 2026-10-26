import type { z } from "zod";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { ConfiguratorIntentPersistencePort } from "../contracts/index.js";

export class ConfiguratorIntentPersistenceConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Configurator intent idempotency conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConfiguratorIntentPersistenceConflictError";
    this.details = details;
  }
}

export function createConfiguratorIntentPersistenceHandler<Request, Response>({
  persistencePort, responder, requestSchema, responseSchema,
}: { persistencePort: ConfiguratorIntentPersistencePort<Request, Response>; responder: BffResponder; requestSchema: z.ZodType<Request>; responseSchema: z.ZodType<Response> }) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = requestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid configurator intent", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const persisted = await persistencePort.persistIntent(request.data);
      const response = responseSchema.safeParse(persisted);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Configurator intent persistence returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: "commerce.configurator_intent_persistence.v1",
      });
    } catch (error) {
      if (error instanceof ConfiguratorIntentPersistenceConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Configurator intent persistence failed");
    }
  };
}
