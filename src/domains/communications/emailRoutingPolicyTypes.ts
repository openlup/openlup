export type CommunicationEmailLedgerRequirement =
  | "email_sends_communication_email_deliveries"
  | "external_provider_ledger"
  | "not_applicable";

export type CommunicationEmailRouteKind =
  | "outbox"
  | "scheduled_direct"
  | "node_action"
  | "bff_route"
  | "auth_hook"
  | "admin_internal"
  | "dormant"
  | "external_provider"
  | (string & {});

export type CommunicationEmailSlaCategory =
  | "immediate_transactional"
  | "scheduled_business_time"
  | "direct_auth"
  | "admin_internal"
  | "dormant_planned";

export type CommunicationEmailMergeGate =
  | "required"
  | "advisory"
  | "must_not_send";

export type CommunicationEmailLatencyAnchor =
  | "event_created_at"
  | "due_at"
  | "request_start"
  | "not_applicable";

export type CommunicationEmailClaimability =
  | "outbox_claimable"
  | "direct_exception"
  | "dormant_not_claimable";

export interface CommunicationEmailRoutingPolicyEntry {
  templateSlug: string;
  routeKind: CommunicationEmailRouteKind;
  ledger: CommunicationEmailLedgerRequirement;
  owner: string;
  sources: readonly string[];
  slaCategory: CommunicationEmailSlaCategory;
  targetSlaSeconds: number | null;
  latencyAnchor: CommunicationEmailLatencyAnchor;
  mergeGate: CommunicationEmailMergeGate;
  claimability: CommunicationEmailClaimability;
  controllingFlags?: readonly string[];
  outboxEventTypes?: readonly string[];
  outboxMatrixCaseIds?: readonly string[];
  exceptionReason?: string;
}

export interface CommunicationEmailDynamicRoutingPolicyEntry
  extends Omit<CommunicationEmailRoutingPolicyEntry, "templateSlug"> {
  patternId: string;
  templatePattern: RegExp;
}

export const LEDGER = "email_sends_communication_email_deliveries" as const;

export const outbox = (
  templateSlug: string,
  eventType: string,
  matrixCaseId: string,
  options: {
    owner: string;
    slaCategory?: Extract<CommunicationEmailSlaCategory, "immediate_transactional" | "scheduled_business_time">;
    source?: "outbox-dispatch" | "marketing-dispatch";
    controllingFlags?: readonly string[];
  },
): CommunicationEmailRoutingPolicyEntry => ({
  templateSlug,
  routeKind: "outbox",
  ledger: LEDGER,
  owner: options.owner,
  sources: [options.source ?? "outbox-dispatch"],
  slaCategory: options.slaCategory ?? "immediate_transactional",
  targetSlaSeconds: 60,
  latencyAnchor: options.slaCategory === "scheduled_business_time" ? "due_at" : "event_created_at",
  mergeGate: "required",
  claimability: "outbox_claimable",
  controllingFlags: options.controllingFlags ?? ["COMMERCE_OUTBOX_DISPATCH_ENABLED"],
  outboxEventTypes: [eventType],
  outboxMatrixCaseIds: [matrixCaseId],
});

export const direct = (
  templateSlug: string,
  routeKind: CommunicationEmailRouteKind,
  options: {
    owner: string;
    sources: readonly string[];
    exceptionReason: string;
    controllingFlags?: readonly string[];
    slaCategory?: Exclude<CommunicationEmailSlaCategory, "admin_internal" | "dormant_planned">;
    targetSlaSeconds?: number;
    latencyAnchor?: Extract<CommunicationEmailLatencyAnchor, "due_at" | "request_start">;
  },
): CommunicationEmailRoutingPolicyEntry => {
  const slaCategory = options.slaCategory ?? (
    routeKind === "auth_hook" ? "direct_auth" :
      routeKind === "scheduled_direct" ? "scheduled_business_time" :
        "immediate_transactional"
  );
  return {
    templateSlug,
    routeKind,
    ledger: LEDGER,
    owner: options.owner,
    sources: options.sources,
    slaCategory,
    targetSlaSeconds: options.targetSlaSeconds ?? (slaCategory === "direct_auth" ? 10 : 60),
    latencyAnchor: options.latencyAnchor ?? (slaCategory === "scheduled_business_time" ? "due_at" : "request_start"),
    mergeGate: "required",
    claimability: "direct_exception",
    controllingFlags: options.controllingFlags ?? [],
    exceptionReason: options.exceptionReason,
  };
};

export const admin = (
  templateSlug: string,
  sources: readonly string[],
  options: {
    targetSlaSeconds?: number;
    latencyAnchor?: Extract<CommunicationEmailLatencyAnchor, "due_at" | "request_start">;
  } = {},
): CommunicationEmailRoutingPolicyEntry => ({
  templateSlug,
  routeKind: "admin_internal",
  ledger: LEDGER,
  owner: "operations",
  sources,
  slaCategory: "admin_internal",
  targetSlaSeconds: options.targetSlaSeconds ?? 300,
  latencyAnchor: options.latencyAnchor ?? "request_start",
  mergeGate: "advisory",
  claimability: "direct_exception",
  exceptionReason: "admin/ops advisory email; not customer-facing GO evidence",
});
