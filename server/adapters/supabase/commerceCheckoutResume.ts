import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHECKOUT_RESUME_CONTRACT_VERSION,
  checkoutResumeDraftSchema,
  type CheckoutResumeDraft,
  type CheckoutResumeDraftState,
  type CheckoutResumeSectionId,
} from "../../../src/domains/commerce/checkoutResumeContracts.js";
import {
  CommerceCheckoutResumePersistenceError,
  type CommerceCheckoutResumeDraftPort,
  type CommerceCheckoutResumeDraftReadInput,
  type CommerceCheckoutResumeDraftUpsertInput,
} from "../../../src/domains/commerce/ports.js";

interface CheckoutResumeRow {
  id: string;
  last_section_id: CheckoutResumeSectionId;
  draft_state: CheckoutResumeDraftState;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  "id, last_section_id, draft_state, expires_at, created_at, updated_at";

export function createSupabaseCommerceCheckoutResumePort(
  client: SupabaseClient,
): CommerceCheckoutResumeDraftPort {
  return {
    async upsertDraft(input: CommerceCheckoutResumeDraftUpsertInput) {
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

      if (existing && !isActiveResumeRow(existing, input.now)) {
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
}

function isActiveResumeRow(
  row: { expires_at?: string | null; revoked_at?: string | null },
  now: string,
): boolean {
  return !row.revoked_at && !!row.expires_at && row.expires_at > now;
}

function parseRow(row: unknown, replayed: boolean): CheckoutResumeDraft {
  const data = row as CheckoutResumeRow;
  const parsed = checkoutResumeDraftSchema.safeParse({
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

function mapError(error: { code?: string; message?: string; details?: string }): Error {
  return new CommerceCheckoutResumePersistenceError("Checkout resume draft persistence failed", {
    code: error.code,
    boundary: "commerce_checkout_resume_drafts",
  });
}
