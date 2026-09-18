import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommerceCheckoutResumePort } from "./commerceCheckoutResume.js";

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
            petProfile: false, productSelection: false, cadence: false, account: false,
            shipping: false, billing: false, payment: false, review: true,
          },
          redactedFields: ["contact"],
        },
        expires_at: "2030-01-02T00:00:00.000Z",
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
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
      .readDraftByTokenHash({ tokenHash: "hash", now: "2030-01-01T00:00:00.000Z" });

    expect(client.from).toHaveBeenCalledWith("commerce_checkout_resume_drafts");
    expect(result).toMatchObject({ lastSectionId: "review", replayed: true });
  });
});
