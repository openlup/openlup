import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../bff/response.js";
import type {
  AgentDomainMutationSpec,
  AgentDomainQuerySpec,
} from "../../../src/lib/agent-domain/domainSpec.js";
import type { AgentActorKind } from "../../../src/lib/agent-domain/ruleResult.js";
import type { AuthorizeAdmin } from "./auth.js";
import { resolveAdmin } from "./auth.js";
import { mapRpcError } from "./rpcErrors.js";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`api/_lib/admin-domain/`).
 *
 * The write/read handler factories every agent-operable admin domain reuses.
 * `createAdminMutationHandler` is lifted verbatim (behaviour-identical) from the
 * catalog reference's `createCatalogWriteHandler`: POST-only, flag gate, admin
 * authz, contract `safeParse`, structured RPC-error mapping, success envelope.
 * The domain injects the request-scoped data-port call (`invoke`), the envelope
 * shape (`toResponse`), and the exact human-facing strings so behaviour parity
 * is preserved per domain.
 *
 * Neutral home: imports nothing from `src/domains/*` / `api/domains/*`.
 */

export interface AdminMutationHandlerDeps<TReq, TResult> {
  /** The static mutation spec (carries the request schema). */
  readonly mutation: AgentDomainMutationSpec<TReq>;
  /**
   * The feature-flag name surfaced in the disabled envelope. Optional: omit
   * (together with {@link enabled} / {@link disabledMessage}) for an ungated,
   * always-enabled route.
   */
  readonly flagName?: string;
  /**
   * Whether the gating flag is on. Omit for an ungated route (always enabled);
   * pass `false` to emit the disabled envelope.
   */
  readonly enabled?: boolean;
  readonly authorizeAdmin: AuthorizeAdmin;
  /** Request-scoped data-port call. */
  readonly invoke: (actorId: string, input: TReq) => Promise<TResult>;
  /** Shape the success envelope body. */
  readonly toResponse: (result: TResult) => Record<string, unknown>;
  /** Human-facing disabled envelope message; only used when {@link enabled} is `false`. */
  readonly disabledMessage?: string;
  readonly invalidRequestMessage: string;
  readonly failureMessage: string;
  /** Error mapper; defaults to `mapRpcError`. */
  readonly mapError?: (res: VercelResponse, error: unknown, failureMessage: string) => void;
  /** When set, the response body is validated before sending (502 on failure). */
  readonly responseSchema?: { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
  readonly invalidResponseMessage?: string;
}

export function createAdminMutationHandler<TReq, TResult>(
  deps: AdminMutationHandlerDeps<TReq, TResult>,
) {
  const mapError = deps.mapError ?? mapRpcError;
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }
    if (deps.enabled === false) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", deps.disabledMessage ?? "Feature is disabled", {
        details: { reason: "feature_flag_disabled", featureFlag: deps.flagName ?? "unknown" },
      });
      return;
    }
    const authz = await resolveAdmin(deps.authorizeAdmin, res);
    if (!authz) return;

    // Positive publish gate, layer 1 of 2 (§1.3 Invariant 3): the actor kind is
    // re-derived from the DB (`admin_users.is_machine_actor`, never the caller) and
    // must be in this mutation's `allowedActorKinds`. The write RPC independently
    // RAISEs 42501 as layer 2. A human-only op (e.g. `activate`) is thus refused a
    // machine actor here (403) before the RPC is ever reached.
    const actorKind: AgentActorKind = authz.isMachineActor ? "machine" : "human";
    if (!deps.mutation.allowedActorKinds.includes(actorKind)) {
      sendBffError(res, "FORBIDDEN", "Actor kind not permitted for this operation", {
        details: { reason: "actor_kind_not_allowed" },
      });
      return;
    }

    const parsed = deps.mutation.requestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", deps.invalidRequestMessage, {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await deps.invoke(authz.userId, parsed.data);
      const body = deps.toResponse(result);
      if (deps.responseSchema) {
        const validated = deps.responseSchema.safeParse(body);
        if (!validated.success) {
          sendBffError(res, "INVALID_RESPONSE", deps.invalidResponseMessage ?? "Invalid response");
          return;
        }
        sendBffSuccess(res, validated.data);
        return;
      }
      sendBffSuccess(res, body);
    } catch (error) {
      mapError(res, error, deps.failureMessage);
    }
  };
}

export interface AdminReadHandlerDeps<TData> {
  readonly authorizeAdmin: AuthorizeAdmin;
  /** Load the data (admin already resolved). */
  readonly load: () => Promise<TData>;
  /** Build the response body (including `contractVersion`). */
  readonly toResponse: (data: TData) => Record<string, unknown>;
  /** Validate the body before sending; an invalid body is a 502. */
  readonly responseSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
  readonly invalidResponseMessage: string;
  readonly failureMessage: string;
}

export function createAdminReadHandler<TData>(deps: AdminReadHandlerDeps<TData>) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    const authz = await resolveAdmin(deps.authorizeAdmin, res);
    if (!authz) return;

    try {
      const data = await deps.load();
      const parsed = deps.responseSchema.safeParse(deps.toResponse(data));
      if (!parsed.success) {
        sendBffError(res, "INVALID_RESPONSE", deps.invalidResponseMessage);
        return;
      }
      sendBffSuccess(res, parsed.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", deps.failureMessage);
    }
  };
}

export interface AdminParameterizedReadHandlerDeps<TReq, TData> {
  /** The static query spec (carries the request schema + actor gate). */
  readonly query: AgentDomainQuerySpec<TReq>;
  /**
   * The feature-flag name surfaced in the disabled envelope. Optional: omit
   * (together with {@link enabled} / {@link disabledMessage}) for an ungated,
   * always-enabled read route.
   */
  readonly flagName?: string;
  /**
   * Whether the gating read flag is on. Omit for an ungated route (always
   * enabled); pass `false` to emit the disabled envelope.
   */
  readonly enabled?: boolean;
  readonly authorizeAdmin: AuthorizeAdmin;
  /** Request-scoped data-port call; receives the resolved admin id + parsed query. */
  readonly load: (actorId: string, input: TReq) => Promise<TData>;
  /** Build the response body (including `contractVersion`). */
  readonly toResponse: (data: TData) => Record<string, unknown>;
  /** Validate the body before sending; an invalid body is a 502. */
  readonly responseSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
  /** Human-facing disabled envelope message; only used when {@link enabled} is `false`. */
  readonly disabledMessage?: string;
  readonly invalidRequestMessage: string;
  readonly invalidResponseMessage: string;
  readonly failureMessage: string;
  /** Error mapper; defaults to `mapRpcError`. */
  readonly mapError?: (res: VercelResponse, error: unknown, failureMessage: string) => void;
}

/**
 * GET-only parameterized READ handler. Mirrors `createAdminMutationHandler`'s
 * spine (flag gate, admin authz, actor-kind gate, contract parse, structured
 * error map, response validation, success envelope) but reads `req.query`
 * (query-string params) instead of `req.body`, and never writes. Reads carry no
 * `dry_run`/idempotency — the data port is a pure load.
 */
export function createAdminParameterizedReadHandler<TReq, TData>(
  deps: AdminParameterizedReadHandlerDeps<TReq, TData>,
) {
  const mapError = deps.mapError ?? mapRpcError;
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    if (deps.enabled === false) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", deps.disabledMessage ?? "Feature is disabled", {
        details: { reason: "feature_flag_disabled", featureFlag: deps.flagName ?? "unknown" },
      });
      return;
    }
    const authz = await resolveAdmin(deps.authorizeAdmin, res);
    if (!authz) return;

    // Same DB-derived actor-kind gate as the mutation factory: actor kind comes
    // from `admin_users.is_machine_actor`, never the caller. Reads admit both
    // human and machine actors by spec.
    const actorKind: AgentActorKind = authz.isMachineActor ? "machine" : "human";
    if (!deps.query.allowedActorKinds.includes(actorKind)) {
      sendBffError(res, "FORBIDDEN", "Actor kind not permitted for this operation", {
        details: { reason: "actor_kind_not_allowed" },
      });
      return;
    }

    const parsed = deps.query.requestSchema.safeParse(req.query);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", deps.invalidRequestMessage, {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const data = await deps.load(authz.userId, parsed.data);
      const validated = deps.responseSchema.safeParse(deps.toResponse(data));
      if (!validated.success) {
        sendBffError(res, "INVALID_RESPONSE", deps.invalidResponseMessage);
        return;
      }
      sendBffSuccess(res, validated.data);
    } catch (error) {
      mapError(res, error, deps.failureMessage);
    }
  };
}
