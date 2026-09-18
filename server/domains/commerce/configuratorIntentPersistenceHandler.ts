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

// Consumer-defined port (hexagonal): commerce declares the minimal personalization
// hook it needs; the personalization domain's createPersonalizationOnPersist() is
// structurally compatible and wired in by the BFF route. Avoids a cross-domain
// import of the personalization internals.
export interface PersonalizationOnPersistHook {
  onNamesPersisted(event: {
    clientId: string;
    primaryPetId: string | null;
    ownerName: string | null;
    dogName: string | null;
  }): Promise<void>;
}

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
  // Optional /v2 hero personalization hook. Injected only when the personalization
  // flag is on; absent => no-op. Best-effort: a failure here never fails persist.
  personalizationOnPersist?: PersonalizationOnPersistHook;
  // Optional Set-Cookie minter for the signed `openlup_pid` identity + `openlup_pzn`
  // hint cookies (built by the route). Injected only when the flag + secret are
  // present; a failure here never fails persist.
  mintPersonalizationCookies?: (clientId: string) => string[];
}

export function createConfiguratorIntentPersistenceHandler({
  persistencePort,
  personalizationOnPersist,
  mintPersonalizationCookies,
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

      // Best-effort personalization precompute (flag-gated via injection). Never
      // let a personalization failure fail the persist the customer just made.
      if (personalizationOnPersist) {
        try {
          await personalizationOnPersist.onNamesPersisted({
            clientId: response.data.clientId,
            primaryPetId: response.data.petId,
            ownerName: request.data.contact?.firstName ?? null,
            dogName: request.data.petProfile?.name ?? null,
          });
        } catch (personalizationError) {
          console.warn(
            "[configurator-intent] personalization precompute failed (non-fatal)",
            personalizationError instanceof Error
              ? personalizationError.message
              : String(personalizationError),
          );
        }
      }

      // Mint the identity + hint cookies so the /v2 hero recognises this returning
      // visitor on their next visit. Best-effort — never fail the persist.
      if (mintPersonalizationCookies) {
        try {
          const cookies = mintPersonalizationCookies(response.data.clientId);
          if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
        } catch (cookieError) {
          console.warn(
            "[configurator-intent] personalization cookie mint failed (non-fatal)",
            cookieError instanceof Error ? cookieError.message : String(cookieError),
          );
        }
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
