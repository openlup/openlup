import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION,
  configuratorIntentPersistenceRequestSchema,
  configuratorIntentPersistenceResponseSchema,
} from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";

export class ConfiguratorIntentPersistenceConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Configurator intent idempotency conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConfiguratorIntentPersistenceConflictError";
    this.details = details;
  }
}

export interface ConfiguratorIntentPersistenceHandlerDeps {
  persistencePort: ConfiguratorIntentPersistencePort;
}

export function createConfiguratorIntentPersistenceHandler({
  persistencePort,
}: ConfiguratorIntentPersistenceHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = configuratorIntentPersistenceRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid configurator intent", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const persisted = await persistencePort.persistIntent(request.data);
      const response = configuratorIntentPersistenceResponseSchema.safeParse(persisted);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Configurator intent persistence returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION,
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
