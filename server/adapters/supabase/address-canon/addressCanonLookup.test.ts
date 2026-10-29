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

function directoryClient(rows: Record<string, unknown[]>, faultTable?: string) {
  const calls: Array<[string, string, ...unknown[]]> = [];
  const client = { from(table: string) {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "like", "limit"]) builder[method] = (...args: unknown[]) => {
      calls.push([table, method, ...args]); return builder;
    };
    builder.then = (resolve: (value: unknown) => void) => Promise.resolve(resolve({ data: rows[table] ?? [], error: table === faultTable ? new Error("fixture read failed") : null }));
    return builder;
  } } as unknown as SupabaseClient;
  return { client, calls };
}
const sourceRow = { source_key: "gus_teryt", status: "active", display_name: "Example directory", official_url: "https://example.invalid/directory", source_revision: "fixture-v1", source_updated_at: "2026-01-01T00:00:00Z" };
const localityRow = { id: "fixture-place", source_key: "gus_teryt", country_code: "PL", name: "Écho Port", terc_code: "01", simc_code: "02", municipality_name: "Example Municipality", municipality_terc_code: "03", county_name: "Example County", voivodeship_name: "Example Region" };

describe("managed directory preservation", () => {
  it("preserves normalized prefix mapping, bounds and every locality/provenance field", async () => {
    const { client, calls } = directoryClient({ address_canon_localities: [localityRow], address_canon_sources: [sourceRow] });
    const result = await createSupabaseAddressCanonLookupPort(client).searchLocalities({ q: " ÉCHO ", limit: 3 });
    expect(calls).toContainEqual(["address_canon_localities", "like", "normalized_name", "echo%"]);
    expect(calls).toContainEqual(["address_canon_localities", "eq", "active", true]);
    expect(calls).toContainEqual(["address_canon_localities", "limit", 3]);
    expect(calls).toContainEqual(["address_canon_sources", "in", "source_key", ["gus_teryt"]]);
    expect(result.candidates).toEqual([{ localityId: "fixture-place", countryCode: "PL", name: "Écho Port", tercCode: "01", simcCode: "02", municipalityName: "Example Municipality", municipalityTercCode: "03", countyName: "Example County", voivodeshipName: "Example Region", postalCode: null, confidence: "partial", resolutionLevel: "locality", sources: result.sources }]);
    expect(result.sources).toEqual([{ sourceKind: "gus_teryt", status: "active", displayName: sourceRow.display_name, officialUrl: sourceRow.official_url, sourceRevision: "fixture-v1", sourceUpdatedAt: sourceRow.source_updated_at }]);
  });
  it("preserves street identity, parent scope, optional prefix and limit", async () => {
    const { client, calls } = directoryClient({ address_canon_streets: [{ id: "fixture-road", locality_id: "fixture-place", source_key: "gus_teryt", name: "Écho Road", ulic_code: "04" }], address_canon_sources: [sourceRow] });
    const port = createSupabaseAddressCanonLookupPort(client);
    const result = await port.listStreets({ localityId: "fixture-place", q: " ÉCHO ", limit: 2 });
    expect(calls).toContainEqual(["address_canon_streets", "eq", "locality_id", "fixture-place"]);
    expect(calls).toContainEqual(["address_canon_streets", "eq", "active", true]);
    expect(calls).toContainEqual(["address_canon_streets", "like", "normalized_name", "echo%"]);
    expect(calls).toContainEqual(["address_canon_streets", "limit", 2]);
    expect(result.streets).toEqual([{ streetId: "fixture-road", localityId: "fixture-place", name: "Écho Road", ulicCode: "04", sources: result.sources }]);
    calls.length = 0; await port.listStreets({ localityId: "fixture-place", limit: 2 });
    expect(calls.some(([, method]) => method === "like")).toBe(false);
  });
  it("keeps valid empty results and skips source queries without rows", async () => {
    const { client, calls } = directoryClient({});
    expect((await createSupabaseAddressCanonLookupPort(client).searchLocalities({ q: "absent", limit: 1 })).candidates).toEqual([]);
    expect(calls.some(([table]) => table === "address_canon_sources")).toBe(false);
  });
  it("does not invent missing provenance or hide disabled source status", async () => {
    const absent = directoryClient({ address_canon_localities: [localityRow] });
    expect((await createSupabaseAddressCanonLookupPort(absent.client).searchLocalities({ q: "echo", limit: 1 })).candidates[0]?.sources).toEqual([]);
    const disabled = directoryClient({ address_canon_localities: [localityRow], address_canon_sources: [{ ...sourceRow, status: "disabled_pending_license" }] });
    expect((await createSupabaseAddressCanonLookupPort(disabled.client).searchLocalities({ q: "echo", limit: 1 })).sources[0]?.status).toBe("disabled_pending_license");
  });
  it("propagates read faults rather than returning a valid empty result", async () => {
    const { client } = directoryClient({}, "address_canon_localities");
    await expect(createSupabaseAddressCanonLookupPort(client).searchLocalities({ q: "echo", limit: 1 })).rejects.toThrow("fixture read failed");
  });
});
