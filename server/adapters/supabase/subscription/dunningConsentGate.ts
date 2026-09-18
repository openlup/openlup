// The managed per-recipient leg of the dunning consent gate.
//
// WHY NOT THE EXISTING POLICY ROUTINE. `communication_evaluate_email_policy`
// already exists and already accepts the dunning purpose — but reading its
// behaviour for that purpose shows it takes no blocking branch at all, so it
// would answer "allowed" to every question this gate exists to ask. It also
// WRITES a decision row per call, which would add a durable row to every dunning
// send that never influenced one. A gate that cannot refuse is not a gate, and
// paying for it in rows would be worse than not asking. So this reads the
// permission state directly, in fixed-shape reads, and copies no routine body.
//
// TWO READS, NEVER MORE: the contact for this address, then that contact's
// recorded permissions. Both are ordinary selects on tables the communications
// consent gate already publishes.
//
// FAIL-OPEN BY CONTRACT. Every unhappy path — no contact, no permission row, a
// read error, a thrown query — answers ALLOW, because the notice being gated is
// the one that gets a paying customer's money moving again. Only an explicitly
// recorded `denied` or `suppressed` state refuses. See the contract file for why
// this is the opposite of the marketing evaluator's rule.

import type {
  DunningConsentDecision,
  DunningConsentGate,
  DunningConsentRequest,
} from "../../../domains/subscription/dunningConsentGate.js";

interface ConsentQueryBuilder {
  select(columns: string): ConsentQueryBuilder;
  eq(column: string, value: unknown): ConsentQueryBuilder;
  in(column: string, values: readonly unknown[]): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface DunningConsentQueryClient {
  from(table: string): ConsentQueryBuilder;
}

/**
 * The purposes a dunning notice could plausibly be recorded against. Both are
 * read because a deployment that captured a blanket transactional suppression
 * for someone means it for this notice too.
 */
export const DUNNING_CONSENT_PURPOSES = ["subscription_dunning", "transactional"] as const;

/** The two recorded states that are an actual refusal, by equality on a list. */
const REFUSING_STATES = new Set(["denied", "suppressed"]);

const ALLOWED: DunningConsentDecision = { verdict: "allow" };

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function createSupabaseDunningConsentGate(
  client: DunningConsentQueryClient,
): DunningConsentGate {
  return {
    async evaluate(request: DunningConsentRequest): Promise<DunningConsentDecision> {
      const email = normalizedEmail(request.recipientEmail);
      if (email.length === 0) return ALLOWED;
      try {
        const contact = await client
          .from("communication_contacts")
          .select("id")
          .eq("normalized_email", email)
          .maybeSingle();
        if (contact.error || !contact.data || typeof contact.data !== "object") return ALLOWED;
        const contactId = (contact.data as Record<string, unknown>).id;
        if (typeof contactId !== "string" || contactId.length === 0) return ALLOWED;

        const permissions = await client
          .from("communication_permissions")
          .select("purpose, state")
          .eq("contact_id", contactId)
          .eq("channel", "email")
          .in("purpose", DUNNING_CONSENT_PURPOSES);
        if (permissions.error) return ALLOWED;
        const rows = Array.isArray(permissions.data)
          ? (permissions.data as Array<Record<string, unknown>>)
          : [];
        const refused = rows.some(
          (row) => typeof row.state === "string" && REFUSING_STATES.has(row.state),
        );
        return refused ? { verdict: "refuse", refusalCode: "consent_denied" } : ALLOWED;
      } catch {
        return ALLOWED;
      }
    },
  };
}
