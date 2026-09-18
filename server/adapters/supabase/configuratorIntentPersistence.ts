import {
  configuratorIntentPersistenceResponseSchema,
  type ConfiguratorIntentPersistenceRequest,
  type ConfiguratorIntentPersistenceResponse,
} from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { CheckoutCommandPersistencePort } from "../../../src/domains/commerce/runtimePorts.js";
import { z } from "../../../src/lib/validation/zod.js";
import { normalizePhoneToE164 } from "../../../src/lib/schemas/fields/phone.js";
import { ConfiguratorIntentPersistenceConflictError } from "../../domains/commerce/configuratorIntentPersistenceHandler.js";

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

interface ConfiguratorIntentIdentityQueryResult {
  data: Array<{ response_payload?: unknown }> | null;
  error: RpcError | null;
}

interface ConfiguratorIntentIdentityQuery {
  eq(column: string, value: unknown): ConfiguratorIntentIdentityQuery;
  limit(count: number): PromiseLike<ConfiguratorIntentIdentityQueryResult>;
}

interface ConfiguratorIntentIdentityTable {
  select(columns: string): ConfiguratorIntentIdentityQuery;
}

/**
 * The identity the ROUTE proved for this request, and the only identity the RPC
 * is allowed to believe.
 *
 * ⛔ It is not read from the request body and never can be: `withVerifiedSubject`
 * writes it last and unconditionally, so a payload that carries the key has it
 * overwritten rather than honoured. A guest is `null`, which is a positive claim
 * that nobody proved anything - not an absence the RPC may fill in.
 */
export interface ConfiguratorIntentPersistenceIdentity {
  authenticatedUserId: string | null;
}

type PersistIntentPayload =
  (ConfiguratorIntentPersistenceRequest | CheckoutCommandV1) & { authenticatedUserId: string | null };

export interface ConfiguratorIntentSupabaseClient {
  rpc(
    functionName: "commerce_configurator_persist_intent",
    args: { p_intent: PersistIntentPayload },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
  from(tableName: "commerce_idempotency_keys"): ConfiguratorIntentIdentityTable;
}

/** Scope used by the persist-intent RPC for its idempotency-key rows. */
const CONFIGURATOR_INTENT_SCOPE = "commerce_configurator_intent";

export function createSupabaseConfiguratorIntentPersistencePort(
  client: ConfiguratorIntentSupabaseClient,
  identity: ConfiguratorIntentPersistenceIdentity = { authenticatedUserId: null },
): ConfiguratorIntentPersistencePort & CheckoutCommandPersistencePort {
  return {
    async persistIntent(
      request: ConfiguratorIntentPersistenceRequest,
    ): Promise<ConfiguratorIntentPersistenceResponse> {
      const { data, error } = await client.rpc("commerce_configurator_persist_intent", {
        p_intent: withVerifiedSubject(withCanonicalIntentPhone(request), identity),
      });
      if (error) throw mapRpcError(error);

      return configuratorIntentPersistenceResponseSchema.parse(data);
    },

    async persistCheckoutCommand(command) {
      const { data, error } = await client.rpc("commerce_configurator_persist_intent", {
        p_intent: withVerifiedSubject(withCanonicalCommandPhone(command), identity),
      });
      if (error) throw mapRpcError(error);

      const persisted = checkoutCommandRpcResponseSchema.parse(data);
      return {
        idempotencyKey: persisted.idempotencyKey,
        clientId: persisted.clientId,
        subjectId: persisted.petId,
        shippingAddressId: persisted.addressId,
        replayed: persisted.replayed,
      };
    },

    async findCompletedIdentity(
      idempotencyKey: string,
    ): Promise<ConfiguratorIntentPersistenceResponse | null> {
      // Read back the identity the RPC stored on the COMPLETED key. The RPC writes
      // the full response object into `response_payload`, so it validates against
      // the same schema persistIntent returns. A different/missing row -> null,
      // which the caller treats as "cannot resume -> 409".
      const { data, error } = await client
        .from("commerce_idempotency_keys")
        .select("response_payload")
        .eq("scope", CONFIGURATOR_INTENT_SCOPE)
        .eq("idempotency_key", idempotencyKey)
        .eq("status", "completed")
        .limit(1);
      if (error) {
        throw new Error(
          `Configurator intent identity lookup failed: ${error.message ?? "query failed"}`,
        );
      }

      const payload = data?.[0]?.response_payload;
      if (!payload) return null;

      const parsed = configuratorIntentPersistenceResponseSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  };
}

// The generic command service never sees this compatibility payload. The
// existing RPC keeps its legacy response for configurator callers, while this
// adapter projects only the neutral persistence facts it needs.
const checkoutCommandRpcResponseSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  clientId: z.guid(),
  petId: z.guid().nullable(),
  addressId: z.guid(),
  replayed: z.boolean(),
}).passthrough();

/**
 * Canonicalize the owner phone to E.164 at the last hop before the write.
 *
 * The contact step already canonicalizes on capture, so this is the belt: a
 * caller that predates or bypasses it — a `localStorage` draft resumed from
 * before that change, an account-mode seed, a direct BFF caller — must not be
 * able to seed the customer record with a bare national number while an
 * otherwise identical order typed with a `+48` prefix lands canonical.
 *
 * Strictly FAIL-OPEN, and that is the whole safety argument.
 * `normalizePhoneToE164` parses with `extract: false`, so a real-world value
 * such as `507231665 (dzwonic po 18)` returns `null`. Such a value must be
 * stored verbatim, never blanked: the outbound fulfillment payload treats a
 * missing recipient phone as a hard error, which would turn a cosmetic format
 * problem into a paid but undispatchable order. Nothing here rejects — the wire
 * contracts keep their existing `min(6).max(32)` shape and remain the only
 * gate.
 *
 * Reads both payloads structurally, because this is a trust boundary: the
 * configurator intent carries `contact.phone` + `address.country` while the
 * neutral checkout command carries `customer.phone` + `shippingAddress.country`,
 * and anything that is not a non-empty string is left exactly as it arrived.
 * Returns `null` for "no rewrite", so an unchanged payload keeps its identity.
 */
function canonicalPhoneRewrite(contact: unknown, address: unknown): string | null {
  const phone = (contact as { phone?: unknown } | undefined)?.phone;
  if (typeof phone !== "string" || phone.trim() === "") return null;

  const country = (address as { country?: unknown } | undefined)?.country;
  const canonical = normalizePhoneToE164(phone, country) ?? phone;
  return canonical === phone ? null : canonical;
}

/**
 * Stamp the route-verified subject onto the payload, LAST.
 *
 * The RPC resolves its client row by e-mail, and an e-mail typed into an
 * anonymous request is a client-supplied object identifier - knowing one is not
 * authorization to edit the record it names. This is the single line that decides
 * whose identity the database is allowed to write, so it overwrites rather than
 * defaults: a caller who puts `authenticatedUserId` in the body gets it replaced.
 */
function withVerifiedSubject<T extends ConfiguratorIntentPersistenceRequest | CheckoutCommandV1>(
  payload: T,
  identity: ConfiguratorIntentPersistenceIdentity,
): T & { authenticatedUserId: string | null } {
  return { ...payload, authenticatedUserId: identity.authenticatedUserId };
}

function withCanonicalIntentPhone(
  request: ConfiguratorIntentPersistenceRequest,
): ConfiguratorIntentPersistenceRequest {
  const phone = canonicalPhoneRewrite(request.contact, request.address);
  if (phone === null) return request;
  return { ...request, contact: { ...request.contact, phone } };
}

function withCanonicalCommandPhone(command: CheckoutCommandV1): CheckoutCommandV1 {
  const phone = canonicalPhoneRewrite(command.customer, command.shippingAddress);
  if (phone === null) return command;
  return { ...command, customer: { ...command.customer, phone } };
}

function mapRpcError(error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (
    error.code === "23505" ||
    /configurator_intent_.*(?:conflict|invalid|missing)/.test(text)
  ) {
    return new ConfiguratorIntentPersistenceConflictError(
      "Configurator intent persistence conflict",
      { code: error.code },
    );
  }

  return new Error(`Configurator intent persistence RPC failed: ${text}`);
}
