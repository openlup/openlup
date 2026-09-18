import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAddressCanonLookupPort } from "./addressCanonLookup.js";

/**
 * Builds a supabase-js client stub whose `.from(...).select(...).eq(...).limit(...)`
 * chain resolves to `{ data, error }`. The probe only awaits the terminal builder,
 * so the chain links return `this` until the final `limit()` resolves.
 */
function createProbeClient(result: {
  data?: unknown[] | null;
  error?: unknown;
}): { client: SupabaseClient; select: ReturnType<typeof vi.fn> } {
  const builder: Record<string, unknown> = {};
  const limit = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  const eq = vi.fn(() => builder);
  const select = vi.fn(() => builder);
  builder.eq = eq;
  builder.select = select;
  builder.limit = limit;
  const from = vi.fn(() => builder);
  return { client: { from } as unknown as SupabaseClient, select };
}

describe("supabaseAddressCanonLookupPort.probeDataAvailable", () => {
  it("reports dataAvailable=false when the localities directory is empty", async () => {
    const { client } = createProbeClient({ data: [] });
    const port = createSupabaseAddressCanonLookupPort(client);

    await expect(port.probeDataAvailable()).resolves.toBe(false);
  });

  it("reports dataAvailable=true when the localities directory has rows", async () => {
    const { client } = createProbeClient({ data: [{ id: "loc_1" }] });
    const port = createSupabaseAddressCanonLookupPort(client);

    await expect(port.probeDataAvailable()).resolves.toBe(true);
  });

  it("treats null data as not available", async () => {
    const { client } = createProbeClient({ data: null });
    const port = createSupabaseAddressCanonLookupPort(client);

    await expect(port.probeDataAvailable()).resolves.toBe(false);
  });

  it("issues a limit-one existence probe rather than exact counts", async () => {
    const { client, select } = createProbeClient({ data: [{ id: "loc_1" }] });
    const port = createSupabaseAddressCanonLookupPort(client);

    await port.probeDataAvailable();

    expect(client.from).toHaveBeenCalledWith("address_canon_localities");
    expect(select).toHaveBeenCalledWith("id");
  });

  it("surfaces a probe error so the caller can decide to omit the hint", async () => {
    const { client } = createProbeClient({ error: new Error("relation missing") });
    const port = createSupabaseAddressCanonLookupPort(client);

    await expect(port.probeDataAvailable()).rejects.toThrow("relation missing");
  });
});
