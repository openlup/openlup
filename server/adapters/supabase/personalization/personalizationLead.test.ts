import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePersonalizationLeadPort } from "./personalizationLead.js";

describe("supabase personalization lead port", () => {
  it("calls the RPC with the mapped args and returns the clientId", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { clientId: "c-1", matchReason: "client_match_exact_email" }, error: null });
    const port = createSupabasePersonalizationLeadPort({ rpc } as unknown as SupabaseClient);

    const result = await port.persistLead({
      email: "anna@example.com",
      firstName: "Anna",
      lastName: "Nowak",
      phone: "600100200",
    });

    expect(rpc).toHaveBeenCalledWith("personalization_persist_lead", {
      p_email: "anna@example.com",
      p_first_name: "Anna",
      p_last_name: "Nowak",
      p_phone: "600100200",
      p_country: null,
    });
    expect(result).toEqual({ clientId: "c-1", matchReason: "client_match_exact_email" });
  });

  it("nulls missing optional fields", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { clientId: "c-2" }, error: null });
    const port = createSupabasePersonalizationLeadPort({ rpc } as unknown as SupabaseClient);

    await port.persistLead({ email: "a@b.com" });

    expect(rpc).toHaveBeenCalledWith("personalization_persist_lead", {
      p_email: "a@b.com",
      p_first_name: null,
      p_last_name: null,
      p_phone: null,
      p_country: null,
    });
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const port = createSupabasePersonalizationLeadPort({ rpc } as unknown as SupabaseClient);

    await expect(port.persistLead({ email: "a@b.com" })).rejects.toThrow(/boom/);
  });

  it("throws when the RPC returns no clientId", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { matchReason: "x" }, error: null });
    const port = createSupabasePersonalizationLeadPort({ rpc } as unknown as SupabaseClient);

    await expect(port.persistLead({ email: "a@b.com" })).rejects.toThrow(/no clientId/);
  });
});
