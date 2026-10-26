import { createConfiguratorIntentPersistenceHandler as create } from "@openlup/platform/commerce/server";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { configuratorIntentPersistenceRequestSchema, configuratorIntentPersistenceResponseSchema } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
export { ConfiguratorIntentPersistenceConflictError } from "@openlup/platform/commerce/server";
export interface ConfiguratorIntentPersistenceHandlerDeps { persistencePort: ConfiguratorIntentPersistencePort }
export function createConfiguratorIntentPersistenceHandler(deps: ConfiguratorIntentPersistenceHandlerDeps) { return create({ ...deps, responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, requestSchema: configuratorIntentPersistenceRequestSchema, responseSchema: configuratorIntentPersistenceResponseSchema }); }
