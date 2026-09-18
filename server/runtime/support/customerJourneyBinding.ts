import {
  createPostgresCustomerSupportJourneyPort,
  type CloseableCustomerSupportJourneyPort,
  type CustomerSupportJourneyPort,
  type PostgresCustomerSupportJourneyEnv,
  type PostgresCustomerSupportJourneyOptions,
} from "../../adapters/postgres/customerSupportJourney.js";
import { auditAgentCustomerRead, enforceAgentCustomerRead } from "../../_lib/admin-domain/agentCustomerReadGuard.js";
import type { ClientsAgentReadGovernance } from "../../domains/clients/agentCustomerReadGovernance.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import type { OperatorIdentityMovePort } from "../../domains/support/operatorIdentityMove.js";
import { OperatorSubscriptionAuthorityUnavailableError } from "../../domains/support/customerRecoveryCommand.js";

type Env = Record<string, string | undefined>;

export interface CustomerSupportJourneyActor {
  readonly operatorId: string; readonly isMachineActor: boolean;
  readonly governance?: CustomerSupportJourneyGovernance;
  /**
   * Whether this scope will be used to *command* or only to read. A command
   * writes an append-only ledger row whose `operator_id` carries a foreign key to
   * `platform_communication_operators`, so a principal the eligibility gate
   * admits on its administrator arm alone cannot record one. Declaring the intent
   * lets that be refused by name before anything mutates, without narrowing the
   * read access the admin arm exists to grant. Absent means `read`; a caller that
   * forgets is additionally caught by the 23503 mapping in the adapter, so the
   * default cannot turn a lockout into a silent success.
   */
  readonly intent?: "read" | "command";
}

export type CustomerSupportJourneyGovernance = Pick<ClientsAgentReadGovernance, "flagEnabled">
  & Partial<Pick<ClientsAgentReadGovernance, "auditClient" | "onAuditError">>;

export interface CustomerSupportJourneyBinding {
  readonly identity: string;
  run<T>(actor: CustomerSupportJourneyActor, work: (port: CustomerSupportJourneyPort) => Promise<T>): Promise<T>;
  /**
   * The identity-move port for this bundle. Separate from `run` because it does not
   * speak to the journey authority at all: it moves the sign-in copy of an address,
   * which lives in the auth service. Kept off the journey port for the same reason -
   * a read surface must not carry a verb that can hand away an account.
   */
  identityMove(): OperatorIdentityMovePort;
}

export type CustomerSupportJourneyBindingResolution =
  | { readonly binding: CustomerSupportJourneyBinding; readonly error?: undefined }
  | {
      readonly binding?: undefined;
      readonly error:
        | "database_url_required"
        | "managed_customer_support_scope_required";
    };

/**
 * A managed composition root supplies this scope after it has selected and
 * authenticated its request-scoped client. The binding deliberately knows no
 * Supabase environment keys and cannot manufacture a placeholder port.
 */
export interface ManagedCustomerSupportJourneyScope {
  run<T>(actor: CustomerSupportJourneyActor, work: (port: CustomerSupportJourneyPort) => Promise<T>): Promise<T>;
  identityMove(): OperatorIdentityMovePort;
}

export class CustomerSupportOperatorInactiveError extends Error { constructor() { super("managed_customer_support_operator_inactive"); } }
export class CustomerSupportCommandRequiresHumanError extends Error { constructor() { super("customer_support_command_requires_human"); } }
/**
 * The acting principal is an eligible operator but holds no row in
 * `platform_communication_operators`, so no operator command can leave the
 * receipt and audit row the surface promises: the ledger `operator_id` foreign
 * key would raise 23503 and abort the transaction.
 *
 * This is a refusal, never a grant. It does not decide whether administrators
 * ought to be operators - it only declines to start work whose record cannot be
 * written. It exists because the alternative is worse than a failed command: the
 * e-mail correction moves the authorization copy of the address before the
 * authority is called and outside its transaction, so the rollback leaves
 * `auth.users.email` moved and `clients.email` behind, and the subscriber cannot
 * sign in again from anywhere the panel can reach.
 *
 * The precondition is that the row *exists*, deliberately not that it is active:
 * a foreign key is satisfied by an inactive row, and eligibility is already
 * decided one step earlier by the gate. Checking `active` here would re-decide
 * authorization on a second axis and refuse a principal the gate admitted, which
 * is the opposite of what this guard is for.
 */
export class CustomerSupportOperatorNotProvisionedError extends Error { constructor() { super("operator_identity_not_provisioned"); } }
export class CustomerSupportAgentReadDisabledError extends Error { constructor() { super("customer_support_agent_read_disabled"); } }

export type ManagedCustomerSupportJourneyScopeFactory = (
  env: Env,
) => ManagedCustomerSupportJourneyScope | null;

type PostgresPortFactory = (env: PostgresCustomerSupportJourneyEnv, options?: PostgresCustomerSupportJourneyOptions) => CloseableCustomerSupportJourneyPort;

export interface CustomerSupportJourneyBindingOptions {
  createPostgresPort?: PostgresPortFactory;
  postgres?: PostgresCustomerSupportJourneyOptions;
  managedScopeFactory?: ManagedCustomerSupportJourneyScopeFactory;
  resolveBundle?: typeof resolveBundleId;
}

/** Resolve one customer-support capability without exposing either driver. */
export function resolveCustomerSupportJourneyBinding(
  env: Env = process.env,
  options: CustomerSupportJourneyBindingOptions = {},
): CustomerSupportJourneyBindingResolution {
  const bundleId = (options.resolveBundle ?? resolveBundleId)(env);
  if (bundleId === "node-postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    const createPort = options.createPostgresPort ?? createPostgresCustomerSupportJourneyPort;
    return {
      binding: {
        identity: bundleId,
        async run(actor, work) {
          const scopedOperatorId = requireCustomerSupportActor(actor);
          if (!scopedOperatorId) throw new Error("customer_support_operator_required");
          const port = createPort(
            { connectionString, operatorId: scopedOperatorId },
            { ...options.postgres, isMachineActor: actor.isMachineActor },
          );
          try {
            return await work(governCustomerSupportJourneyPort(port, actor));
          } finally {
            await port.close();
          }
        },
        /** No auth service behind this bundle, so a named refusal rather than a stub
         * that silently succeeds and leaves the two address copies disagreeing. */
        identityMove() {
          throw new OperatorSubscriptionAuthorityUnavailableError();
        },
      },
    };
  }

  const createScope = options.managedScopeFactory;
  if (!createScope) return { error: "managed_customer_support_scope_required" };
  return {
    binding: {
      identity: bundleId,
      async run(actor, work) {
        requireCustomerSupportActor(actor);
        const scope = createScope(env);
        if (!scope) throw new Error("managed_customer_support_scope_unavailable");
        return scope.run(actor, work);
      },
      // Forwarded, never constructed here: the runtime layer selects an
      // implementation, it does not name one.
      identityMove: () => {
        const scope = createScope(env);
        if (!scope?.identityMove) throw new Error("managed_customer_support_scope_unavailable");
        return scope.identityMove();
      },
    },
  };
}

export function requireCustomerSupportActor(actor: CustomerSupportJourneyActor): string {
  const operatorId = actor.operatorId.trim();
  if (!operatorId) throw new Error("customer_support_operator_required");
  if (actor.isMachineActor && (!actor.governance || enforceAgentCustomerRead({
    isMachineActor: true,
    flagEnabled: actor.governance.flagEnabled,
  }).blocked)) throw new CustomerSupportAgentReadDisabledError();
  return operatorId;
}

export function governCustomerSupportJourneyPort(
  port: CustomerSupportJourneyPort,
  actor: CustomerSupportJourneyActor,
): CustomerSupportJourneyPort {
  const audit = async (route: string, query: Record<string, unknown>, customerIds: string[]) => {
    if (!actor.isMachineActor || !actor.governance?.auditClient) return;
    await auditAgentCustomerRead(actor.governance.auditClient, {
      actorId: actor.operatorId, route, query, customerIds,
    }, actor.governance.onAuditError);
  };
  return {
    async getPortableSummary(request) { const result = await port.getPortableSummary(request); await audit("/api/bff/admin/clients/summary", {}, []); return result; },
    async searchPortableClients(request) { const result = await port.searchPortableClients(request); await audit("/api/bff/admin/clients/search", { ...request, query: "[redacted]" }, result.candidates.map((c) => c.subject.subjectId)); return actor.isMachineActor ? { ...result, candidates: result.candidates.map((c) => ({ ...c, subject: { ...c.subject, email: null, phone: null } })) } : result; },
    async getPortableClientDetail(request) { const result = await port.getPortableClientDetail(request); if (result) await audit("/api/bff/admin/clients/detail", { subjectId: request.subjectId }, [request.subjectId]); return result; },
    async searchCustomerJourney(request) { const result = await port.searchCustomerJourney(request); await audit("/api/bff/admin/support/customer-journey", safeJourneyQuery(request), result.candidates.map((c) => c.subjectId)); return actor.isMachineActor ? { ...result, candidates: result.candidates.map((c) => ({ ...c, email: null })) } : result; },
    async getCustomerJourney(request) { const result = await port.getCustomerJourney(request); if (result) await audit("/api/bff/admin/support/customer-journey", safeJourneyQuery(request), [result.subject.subjectId]); return result; },
    issueRecovery: (input) => port.issueRecovery(input),
    // Operator commands are audited durably by the authority itself — one
    // receipt and one audit row per command, refusals included — so this
    // wrapper adds no second, weaker ledger and redacts nothing: the only
    // addresses in play are the ones the operator typed.
    applySubscriptionAction: (input) => port.applySubscriptionAction(input),
    correctSubjectEmail: (input) => port.correctSubjectEmail(input),
    correctSubjectPhone: (input) => port.correctSubjectPhone(input),
    // Absorption carries no address outward at all - counts and an id the operator
    // already named - so there is nothing here for a machine actor to redact either.
    absorbLead: (input) => port.absorbLead(input),
  };
}

function safeJourneyQuery(value: object): Record<string, unknown> {
  const query = value as Record<string, unknown>; return { ...query, query: query.query ? "[redacted]" : undefined, email: query.email ? "[redacted]" : undefined };
}
