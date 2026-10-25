import type { z } from "zod";
import { CHECKOUT_RESUME_CONTRACT_VERSION } from "../checkoutResumeSchemas.js";
import { CommerceCheckoutResumePersistenceError } from "../errors.js";
import type { CommerceCheckoutResumeDraftPort, CommerceCheckoutResumeDraftUpsertInput, CommerceCheckoutResumeDraftReadInput } from "../contracts/ports.js";
interface ResumeResult { data: unknown; error: { code?: string; message?: string; details?: string } | null }
interface ResumeQuery {
  select(columns: string): ResumeQuery;
  eq(column: string, value: unknown): ResumeQuery;
  is(column: string, value: null): ResumeQuery;
  gt(column: string, value: string): ResumeQuery;
  single(): PromiseLike<ResumeResult>;
  maybeSingle(): PromiseLike<ResumeResult>;
}
export interface CommerceCheckoutResumeClient {
  from(table: "commerce_checkout_resume_drafts"): {
    select(columns: string): ResumeQuery;
    update(payload: Record<string, unknown>): ResumeQuery;
    insert(payload: Record<string, unknown>): ResumeQuery;
  };
}

interface CheckoutResumeRow<Section, State> {
  id: string;
  last_section_id: Section;
  draft_state: State;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  "id, last_section_id, draft_state, expires_at, created_at, updated_at";

export function createSupabaseCommerceCheckoutResumePort<Section, State extends { redactedFields: unknown }, Draft>(
  client: CommerceCheckoutResumeClient,
  draftSchema: z.ZodType<Draft>,
): CommerceCheckoutResumeDraftPort<Section, State, Draft> {
  return {
    async upsertDraft(input: CommerceCheckoutResumeDraftUpsertInput<Section, State>) {
      const payload = {
        token_hash: input.tokenHash,
        idempotency_key_hash: input.idempotencyKeyHash,
        last_section_id: input.lastSectionId,
        draft_state: input.draftState,
        redacted_fields: input.draftState.redactedFields,
        expires_at: input.expiresAt,
        revoked_at: null,
        updated_at: input.now,
      };

      const { data: existing, error: existingError } = await client
        .from("commerce_checkout_resume_drafts")
        .select("id, expires_at, revoked_at")
        .eq("token_hash", input.tokenHash)
        .maybeSingle();
      if (existingError) throw mapError(existingError);

      if (existing && !isActiveResumeRow(existing as { expires_at?: string | null; revoked_at?: string | null }, input.now)) {
        throw new CommerceCheckoutResumePersistenceError(
          "Checkout resume draft token is expired or revoked",
          { boundary: "commerce_checkout_resume_drafts", reason: "expired_or_revoked" },
        );
      }

      const query = existing
        ? client
            .from("commerce_checkout_resume_drafts")
            .update(payload)
            .eq("token_hash", input.tokenHash)
            .is("revoked_at", null)
            .gt("expires_at", input.now)
        : client.from("commerce_checkout_resume_drafts").insert(payload);

      const { data, error } = await query.select(SELECT_COLUMNS).single();
      if (error) throw mapError(error);

      return parseRow(data, false);
    },

    async readDraftByTokenHash(input: CommerceCheckoutResumeDraftReadInput) {
      const { data, error } = await client
        .from("commerce_checkout_resume_drafts")
        .select(SELECT_COLUMNS)
        .eq("token_hash", input.tokenHash)
        .is("revoked_at", null)
        .gt("expires_at", input.now)
        .maybeSingle();
      if (error) throw mapError(error);
      if (!data) return null;

      return parseRow(data, true);
    },
  };

  function isActiveResumeRow(
    row: { expires_at?: string | null; revoked_at?: string | null },
    now: string,
  ): boolean {
    return !row.revoked_at && !!row.expires_at && row.expires_at > now;
  }

  function parseRow(row: unknown, replayed: boolean): Draft {
    const data = row as CheckoutResumeRow<Section, State>;
    const parsed = draftSchema.safeParse({
      id: data.id,
      contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
      lastSectionId: data.last_section_id,
      draftState: data.draft_state,
      expiresAt: data.expires_at,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      replayed,
    });

    if (!parsed.success) {
      throw new CommerceCheckoutResumePersistenceError(
        "Checkout resume draft response invalid",
        { boundary: "commerce_checkout_resume_drafts" },
      );
    }

    return parsed.data;
  }

}

function mapError(error: { code?: string; message?: string; details?: string }): Error {
  return new CommerceCheckoutResumePersistenceError("Checkout resume draft persistence failed", {
    code: error.code,
    boundary: "commerce_checkout_resume_drafts",
  });
}
