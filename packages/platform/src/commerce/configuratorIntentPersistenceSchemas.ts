import { z } from "zod";
import { CONFIGURATOR_INTENT_VERSION } from "./configuratorIntentSchemas.js";
export const CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION =
  "commerce.configurator_intent_persistence.v1";

const uuidSchema = z.guid();


export const configuratorIntentClientMatchReasonSchema = z.enum([
  "client_created",
  "client_match_exact_email",
  // Historical replay value; current writers need not emit it.
  "client_match_plus_normalized_fallback",
]);

export const configuratorIntentPersistenceResponseCoreSchema = z
  .object({
    contractVersion: z.literal(CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION),
    intentVersion: z.literal(CONFIGURATOR_INTENT_VERSION),
    idempotencyKey: z.string().trim().min(8).max(120),
    clientId: uuidSchema,
    addressId: uuidSchema,
    clientMatchReason: configuratorIntentClientMatchReasonSchema.optional(),
    replayed: z.boolean(),
  })
  .strict();
