import { z } from "../../lib/validation/zod.js";
import {
  configuratorIntentSchema,
  CONFIGURATOR_INTENT_VERSION,
} from "./configuratorIntentContracts.js";

export const CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION =
  "commerce.configurator_intent_persistence.v1";

const uuidSchema = z.guid();

export const configuratorIntentPersistenceRequestSchema = configuratorIntentSchema;

export const configuratorIntentClientMatchReasonSchema = z.enum([
  "client_created",
  "client_match_exact_email",
  // Deprecated (CJ01-AC): the plus-normalized fallback was removed in migration
  // 20260712130000 so a guest `base+tag@` no longer folds onto an unrelated
  // `base@` client. Retained in the enum only so historical/replayed idempotency
  // responses still parse; the RPC no longer emits it.
  "client_match_plus_normalized_fallback",
]);

export const configuratorIntentPersistenceResponseSchema = z
  .object({
    contractVersion: z.literal(CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION),
    intentVersion: z.literal(CONFIGURATOR_INTENT_VERSION),
    idempotencyKey: z.string().trim().min(8).max(120),
    clientId: uuidSchema,
    petId: uuidSchema,
    addressId: uuidSchema,
    clientMatchReason: configuratorIntentClientMatchReasonSchema.optional(),
    replayed: z.boolean(),
  })
  .strict();

export type ConfiguratorIntentPersistenceRequest = z.input<
  typeof configuratorIntentPersistenceRequestSchema
>;
export type ConfiguratorIntentPersistenceResponse = z.infer<
  typeof configuratorIntentPersistenceResponseSchema
>;
