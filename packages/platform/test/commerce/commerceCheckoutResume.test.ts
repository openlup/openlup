import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommerceCheckoutResumePort } from "./storeTestFixtures.js";

describe("Supabase commerce checkout resume adapter", () => {
  it("executes the characterized active-draft read and maps the neutral contract", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        last_section_id: "review",
        draft_state: {
          version: "commerce.checkout_resume.v1",
          mode: "one_time",
          cadenceDays: null,
          cart: { items: [] },
          completion: {
            productSelection: false, cadence: false, account: false,
            shipping: false, billing: false, payment: false, review: true,
          },
          redactedFields: ["contact"],
        },
        expires_at: "1999-01-02T00:00:00.000Z",
        created_at: "1999-01-01T00:00:00.000Z",
        updated_at: "1999-01-01T00:00:00.000Z",
      },
      error: null,
    });
    const chain = {
      select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), maybeSingle,
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain);
    chain.gt.mockReturnValue(chain);
    const client = { from: vi.fn().mockReturnValue(chain) };

    const result = await createSupabaseCommerceCheckoutResumePort(client as never)
      .readDraftByTokenHash({ tokenHash: "hash", now: "1999-01-01T00:00:00.000Z" });

    expect(client.from).toHaveBeenCalledWith("commerce_checkout_resume_drafts");
    expect(result).toMatchObject({ lastSectionId: "review", replayed: true });
  });
});

import { resumeSchemas, type ResumeState } from "./storeTestFixtures.js";
import { CommerceCheckoutResumePersistenceError } from "../../src/commerce/index.js";
const now = "1999-01-01T00:00:00.000Z", expires = "1999-01-02T00:00:00.000Z";
const state: ResumeState = resumeSchemas.checkoutResumeDraftStateSchema.parse({ version: "commerce.checkout_resume.v1", completion: {}, redactedFields: ["contact"] });
const input = { tokenHash: "hash-a", idempotencyKeyHash: "key-hash-a", lastSectionId: "review" as const, draftState: state, expiresAt: expires, now };
function resumeClient(existing: unknown = null, writeError: { code: string } | null = null) {
  const row = { id: "11111111-1111-4111-8111-111111111111", last_section_id: "review", draft_state: state, expires_at: expires, created_at: now, updated_at: now };
  const chain = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), single: vi.fn().mockResolvedValue({ data: row, error: writeError }), maybeSingle: vi.fn().mockResolvedValue({ data: existing, error: null }) };
  for (const method of [chain.select, chain.eq, chain.is, chain.gt]) method.mockReturnValue(chain);
  const table = { select: chain.select, insert: vi.fn().mockReturnValue(chain), update: vi.fn().mockReturnValue(chain) };
  const client = { from: vi.fn().mockReturnValue(table) };
  return { client, table, chain };
}
it("inserts a new resume draft with the exact persisted fields", async () => {
  const f = resumeClient();
  expect(await createSupabaseCommerceCheckoutResumePort(f.client).upsertDraft(input)).toMatchObject({ replayed: false, draftState: state });
  expect(f.table.insert).toHaveBeenCalledExactlyOnceWith({ token_hash: input.tokenHash, idempotency_key_hash: input.idempotencyKeyHash, last_section_id: "review", draft_state: state, redacted_fields: ["contact"], expires_at: expires, revoked_at: null, updated_at: now });
  expect(f.table.update).not.toHaveBeenCalled();
});
it("updates only an active token and retains expiry/revocation write fences", async () => {
  const f = resumeClient({ expires_at: expires, revoked_at: null });
  await createSupabaseCommerceCheckoutResumePort(f.client).upsertDraft(input);
  expect(f.table.update).toHaveBeenCalledOnce();
  expect(f.table.insert).not.toHaveBeenCalled();
  expect(f.chain.eq).toHaveBeenCalledWith("token_hash", input.tokenHash);
  expect(f.chain.is).toHaveBeenCalledWith("revoked_at", null);
  expect(f.chain.gt).toHaveBeenCalledWith("expires_at", now);
});
it.each([{ expires_at: now }, { expires_at: expires, revoked_at: now }, {}, { expires_at: "1998-01-01T00:00:00.000Z" }])("refuses expired or revoked token %j before writing", async existing => {
  const f = resumeClient(existing);
  await expect(createSupabaseCommerceCheckoutResumePort(f.client).upsertDraft(input)).rejects.toMatchObject({ details: { reason: "expired_or_revoked" } });
  expect(f.table.insert).not.toHaveBeenCalled(); expect(f.table.update).not.toHaveBeenCalled();
});
it("maps a racing update failure without falling back to insert", async () => {
  const f = resumeClient({ expires_at: expires, revoked_at: null }, { code: "PGRST116" });
  await expect(createSupabaseCommerceCheckoutResumePort(f.client).upsertDraft(input)).rejects.toBeInstanceOf(CommerceCheckoutResumePersistenceError);
  expect(f.table.insert).not.toHaveBeenCalled();
});
it("returns null for a missing active read and rejects malformed stored state", async () => {
  const f = resumeClient();
  expect(await createSupabaseCommerceCheckoutResumePort(f.client).readDraftByTokenHash({ tokenHash: "hash-a", now })).toBeNull();
  f.chain.maybeSingle.mockResolvedValue({ data: { id: "invalid" }, error: null });
  await expect(createSupabaseCommerceCheckoutResumePort(f.client).readDraftByTokenHash({ tokenHash: "hash-a", now })).rejects.toBeInstanceOf(CommerceCheckoutResumePersistenceError);
});
