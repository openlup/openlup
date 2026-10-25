import type { z } from "zod";
import type { ConfiguratorIntentPersistencePort } from "../contracts/ports.js";
import type { CheckoutCommandPersistencePort } from "../contracts/runtimePorts.js";
import type { RpcError } from "../contracts/omsTypes.js";
import { ConfiguratorIntentPersistenceConflictError } from "./configuratorIntentPersistenceHandler.js";

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

type PersistIntentPayload<Request, Command> =
  (Request | Command) & { authenticatedUserId: string | null };

export interface ConfiguratorIntentRpcQueryClient<Request, Command> {
  rpc(
    functionName: "commerce_configurator_persist_intent",
    args: { p_intent: PersistIntentPayload<Request, Command> },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
  from(tableName: "commerce_idempotency_keys"): ConfiguratorIntentIdentityTable;
}

/** Scope used by the persist-intent RPC for its idempotency-key rows. */
const CONFIGURATOR_INTENT_SCOPE = "commerce_configurator_intent";

export function createConfiguratorIntentPersistenceRpcPort<Request extends object, Response, Command extends object, Persistence>(
  client: ConfiguratorIntentRpcQueryClient<Request, Command>,
  bindings: {
    responseSchema: z.ZodType<Response>;
    decodeCommandResponse(data: unknown): Persistence;
    normalizePhoneToE164(phone: string, country: unknown): string | null;
  },
  identity: ConfiguratorIntentPersistenceIdentity = { authenticatedUserId: null },
): ConfiguratorIntentPersistencePort<Request, Response> & CheckoutCommandPersistencePort<Command, Persistence> {
  return {
    async persistIntent(
      request: Request,
    ): Promise<Response> {
      const { data, error } = await client.rpc("commerce_configurator_persist_intent", {
        p_intent: withVerifiedSubject(withCanonicalIntentPhone(request), identity),
      });
      if (error) throw mapRpcError(error);

      return bindings.responseSchema.parse(data);
    },

    async persistCheckoutCommand(command) {
      const { data, error } = await client.rpc("commerce_configurator_persist_intent", {
        p_intent: withVerifiedSubject(withCanonicalCommandPhone(command), identity),
      });
      if (error) throw mapRpcError(error);

      return bindings.decodeCommandResponse(data);
    },

    async findCompletedIdentity(
      idempotencyKey: string,
    ): Promise<Response | null> {
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

      const parsed = bindings.responseSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  };

  // Canonicalization is fail-open: an unparseable non-empty phone is preserved verbatim.
  function canonicalPhoneRewrite(contact: unknown, address: unknown): string | null {
    const phone = (contact as { phone?: unknown } | undefined)?.phone;
    if (typeof phone !== "string" || phone.trim() === "") return null;

    const country = (address as { country?: unknown } | undefined)?.country;
    const canonical = bindings.normalizePhoneToE164(phone, country) ?? phone;
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
  function withVerifiedSubject<T extends object>(
    payload: T,
    identity: ConfiguratorIntentPersistenceIdentity,
  ): T & { authenticatedUserId: string | null } {
    return { ...payload, authenticatedUserId: identity.authenticatedUserId };
  }

  function withCanonicalIntentPhone(
    request: Request,
  ): Request {
    const phone = canonicalPhoneRewrite((request as { contact?: unknown }).contact, (request as { address?: unknown }).address);
    if (phone === null) return request;
    return { ...request, contact: { ...(request as { contact?: object }).contact, phone } };
  }

  function withCanonicalCommandPhone(command: Command): Command {
    const phone = canonicalPhoneRewrite((command as { customer?: unknown }).customer, (command as { shippingAddress?: unknown }).shippingAddress);
    if (phone === null) return command;
    return { ...command, customer: { ...(command as { customer?: object }).customer, phone } };
  }

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
