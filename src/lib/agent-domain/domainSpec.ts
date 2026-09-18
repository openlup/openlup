import type { ZodType } from "zod";

import type { AgentActorKind, RuleResult } from "./ruleResult.js";
import type { LifecycleMarker } from "./lifecycleRules.js";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`src/lib/agent-domain/`).
 *
 * `AgentDomainSpec` is the single typed seam the handler factory AND the future
 * MCP tool generator both consume, so "what a domain must fill in" is a COMPILE
 * error if incomplete. Heads are projections of this one spec: the MCP generator
 * drops every mutation carrying a `lifecycleMarker` (agents are draft-only); a
 * human React head keeps `LIFECYCLE_ACTIVATE`. Adding a head never touches the
 * core or the rules.
 *
 * Neutral home: imports nothing from `src/domains/*` / `api/domains/*`.
 */

/** Which feature flag gates a mutation. */
export type AgentDomainGate = "mutation" | "activation";

/**
 * The static description of one READ (query) operation. Reads carry NO lifecycle
 * marker (they never mutate, so the MCP generator never drops them) and a fixed
 * `gate: "read"`. Domain-time wiring (the data-port call, the response shaping,
 * the runtime `enabled` flag) is injected when the read handler is built; this
 * carries only what the MCP generator and the read-handler factory need
 * structurally.
 */
export interface AgentDomainQuerySpec<TReq = unknown> {
  /** Stable operation key; basis for the MCP tool name `${domainKey}__${key}`. */
  readonly key: string;
  /** The request contract; the MCP tool input schema is derived from this. */
  readonly requestSchema: ZodType<TReq, unknown>;
  /** Reads are always `"read"`-gated. */
  readonly gate: "read";
  /** Actor kinds the read handler admits (reads: human+machine). */
  readonly allowedActorKinds: readonly AgentActorKind[];
}

/**
 * The static description of one mutation operation. Domain-time wiring (the data
 * port call, the envelope shaping, the runtime `enabled` flag) is injected when
 * the handler is built; this carries only what the MCP generator and the handler
 * factory need to know structurally.
 */
export interface AgentDomainMutationSpec<TReq = unknown> {
  /** Stable operation key; basis for the MCP tool name `${domainKey}__${key}`. */
  readonly key: string;
  /** The request contract; the MCP tool input schema is derived from this. */
  readonly requestSchema: ZodType<TReq, unknown>;
  /** Which feature flag gates this op. */
  readonly gate: AgentDomainGate;
  /** Actor kinds the handler admits (create/update: human+machine; activate: human). */
  readonly allowedActorKinds: readonly AgentActorKind[];
  /** Lifecycle markers; a non-empty list means the MCP generator drops the tool. */
  readonly lifecycleMarkers: readonly LifecycleMarker[];
}

/**
 * Marker base for a domain's server-side data port. Concrete ports (e.g.
 * `AdminCatalogDataPort`) declare their per-operation methods; the generics
 * anchor the id/row types a head reads back through the typed client.
 */
export interface AdminDomainDataPort<TId extends string, TRow> {
  readonly __idBrand?: TId;
  readonly __rowBrand?: TRow;
}

export interface AgentDomainSpec<
  TId extends string,
  TRuleCode extends string,
  TRow,
> {
  readonly domainKey: string;
  readonly mutationFlag: `${string}_MUTATIONS_ENABLED`;
  readonly activationFlag: `${string}_ACTIVATION_ENABLED`;
  /** Open validated string — NEVER `z.enum` (see the catalog slug post-mortem). */
  readonly idSchema: ZodType<TId, unknown>;
  readonly ruleCodes: readonly TRuleCode[];
  readonly rules: (input: {
    operation: string;
    actorKind: AgentActorKind;
  }) => RuleResult<TRuleCode>;
  /** `admin_audit_events.entity_type` for this domain. */
  readonly auditEntityType: string;
  /** Every mutation the domain exposes, keyed by operation. */
  readonly mutations: Readonly<Record<string, AgentDomainMutationSpec>>;
  /** Which feature flag gates this domain's READ surface (optional). */
  readonly readFlag?: `${string}_READ_ENABLED`;
  /** Every read (query) the domain exposes, keyed by operation (optional). */
  readonly queries?: Readonly<Record<string, AgentDomainQuerySpec>>;
  /** Phantom anchor for the row type a head reads back. */
  readonly _row?: TRow;
}
