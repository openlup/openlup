import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ADDRESS_CANON_CONTRACT_VERSION,
  type AddressCanonLocalitiesLookupResponse,
  type AddressCanonLocalityCandidate,
  type AddressCanonPostalCodeLookupResponse,
  type AddressCanonSource,
  type AddressCanonStreet,
  type AddressCanonStreetsLookupResponse,
} from "../../../../src/domains/address-canon/contracts.js";
import type { AddressCanonLookupPort } from "../../../domains/address-canon/ports.js";

/**
 * Concrete supabase port surface. Extends the contract `AddressCanonLookupPort`
 * with a cheap `probeDataAvailable` existence check so callers (the hidden BFF
 * route in `shared.ts`) can distinguish "directory not loaded / feature offline"
 * from "valid query, zero matches". The extra method is intentionally NOT on the
 * shared `AddressCanonLookupPort` interface — only the route wrapper needs it.
 */
export interface SupabaseAddressCanonLookupPort extends AddressCanonLookupPort {
  /**
   * O(1) existence probe against the canonical localities directory. Returns
   * `false` when the table is empty (directory not imported yet). Frontend
   * semantics: `dataAvailable === false` -> "lookup temporarily offline / not
   * loaded"; `dataAvailable === true && candidates.length === 0` -> "no match".
   */
  probeDataAvailable(): Promise<boolean>;
}

interface SourceRow {
  source_key: AddressCanonSource["sourceKind"];
  status: AddressCanonSource["status"];
  display_name: string;
  official_url: string;
  source_revision: string | null;
  source_updated_at: string | null;
}

interface LocalityRow {
  id: string;
  source_key: AddressCanonSource["sourceKind"];
  country_code: "PL";
  name: string;
  terc_code: string;
  simc_code: string;
  municipality_name: string | null;
  municipality_terc_code: string | null;
  county_name: string | null;
  voivodeship_name: string | null;
}

interface StreetRow {
  id: string;
  locality_id: string;
  source_key: AddressCanonSource["sourceKind"];
  name: string;
  ulic_code: string | null;
}

interface PostalLocalityRow {
  postal_code: string;
  locality_id: string;
  source_key: AddressCanonSource["sourceKind"];
  confidence: AddressCanonLocalityCandidate["confidence"];
}

export function createSupabaseAddressCanonLookupPort(
  client: SupabaseClient,
): SupabaseAddressCanonLookupPort {
  return {
    async probeDataAvailable(): Promise<boolean> {
      // Cheap O(1) existence probe without exact counts on the canonical table.
      const { data, error } = await client
        .from("address_canon_localities")
        .select("id")
        .eq("active", true)
        .limit(1);
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async lookupPostalCode({ postalCode, limit }) {
      const { data: postalRows, error } = await client
        .from("address_canon_postal_localities")
        .select("postal_code, locality_id, source_key, confidence")
        .eq("postal_code", postalCode)
        .eq("active", true)
        .limit(limit);
      if (error) throw error;

      const rows = (postalRows ?? []) as PostalLocalityRow[];
      const localities = await readLocalities(client, rows.map((row) => row.locality_id));
      const sources = await readSources(client, rows.map((row) => row.source_key));
      const sourceMap = new Map(sources.map((source) => [source.sourceKind, source]));

      return {
        contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
        query: { postalCode },
        resolutionLevel: "postal_code",
        sources,
        candidates: rows.flatMap((row) => {
          const locality = localities.get(row.locality_id);
          if (!locality) return [];
          return [mapLocality(locality, sourceMap, row.postal_code, row.confidence, "postal_code")];
        }),
      } satisfies AddressCanonPostalCodeLookupResponse;
    },

    async searchLocalities({ q, limit }) {
      const normalized = normalizeDirectoryText(q);
      const { data, error } = await client
        .from("address_canon_localities")
        .select(
          "id, source_key, country_code, name, terc_code, simc_code, municipality_name, municipality_terc_code, county_name, voivodeship_name",
        )
        .eq("active", true)
        .like("normalized_name", `${normalized}%`)
        .limit(limit);
      if (error) throw error;

      const rows = (data ?? []) as LocalityRow[];
      const sources = await readSources(client, rows.map((row) => row.source_key));
      const sourceMap = new Map(sources.map((source) => [source.sourceKind, source]));

      return {
        contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
        query: { q },
        resolutionLevel: "locality",
        sources,
        candidates: rows.map((row) => mapLocality(row, sourceMap, null, "partial", "locality")),
      } satisfies AddressCanonLocalitiesLookupResponse;
    },

    async listStreets({ localityId, q, limit }) {
      let query = client
        .from("address_canon_streets")
        .select("id, locality_id, source_key, name, ulic_code")
        .eq("locality_id", localityId)
        .eq("active", true)
        .limit(limit);

      if (q) {
        query = query.like("normalized_name", `${normalizeDirectoryText(q)}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = (data ?? []) as StreetRow[];
      const sources = await readSources(client, rows.map((row) => row.source_key));
      const sourceMap = new Map(sources.map((source) => [source.sourceKind, source]));

      return {
        contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
        query: { localityId, q: q ?? null },
        resolutionLevel: "street",
        sources,
        streets: rows.map((row) => mapStreet(row, sourceMap)),
      } satisfies AddressCanonStreetsLookupResponse;
    },
  };
}

async function readLocalities(
  client: SupabaseClient,
  localityIds: string[],
): Promise<Map<string, LocalityRow>> {
  const ids = [...new Set(localityIds)];
  if (ids.length === 0) return new Map();

  const { data, error } = await client
    .from("address_canon_localities")
    .select(
      "id, source_key, country_code, name, terc_code, simc_code, municipality_name, municipality_terc_code, county_name, voivodeship_name",
    )
    .in("id", ids)
    .eq("active", true);
  if (error) throw error;

  return new Map(((data ?? []) as LocalityRow[]).map((row) => [row.id, row]));
}

async function readSources(
  client: SupabaseClient,
  sourceKeys: AddressCanonSource["sourceKind"][],
): Promise<AddressCanonSource[]> {
  const keys = [...new Set(sourceKeys)];
  if (keys.length === 0) return [];

  const { data, error } = await client
    .from("address_canon_sources")
    .select("source_key, status, display_name, official_url, source_revision, source_updated_at")
    .in("source_key", keys);
  if (error) throw error;

  return ((data ?? []) as SourceRow[]).map((row) => ({
    sourceKind: row.source_key,
    status: row.status,
    displayName: row.display_name,
    officialUrl: row.official_url,
    sourceRevision: row.source_revision,
    sourceUpdatedAt: row.source_updated_at,
  }));
}

function mapLocality(
  row: LocalityRow,
  sourceMap: Map<AddressCanonSource["sourceKind"], AddressCanonSource>,
  postalCode: string | null,
  confidence: AddressCanonLocalityCandidate["confidence"],
  resolutionLevel: AddressCanonLocalityCandidate["resolutionLevel"],
): AddressCanonLocalityCandidate {
  return {
    localityId: row.id,
    countryCode: row.country_code,
    name: row.name,
    tercCode: row.terc_code,
    simcCode: row.simc_code,
    municipalityName: row.municipality_name,
    municipalityTercCode: row.municipality_terc_code,
    countyName: row.county_name,
    voivodeshipName: row.voivodeship_name,
    postalCode,
    confidence,
    resolutionLevel,
    sources: compactSource(row.source_key, sourceMap),
  };
}

function mapStreet(
  row: StreetRow,
  sourceMap: Map<AddressCanonSource["sourceKind"], AddressCanonSource>,
): AddressCanonStreet {
  return {
    streetId: row.id,
    localityId: row.locality_id,
    name: row.name,
    ulicCode: row.ulic_code,
    sources: compactSource(row.source_key, sourceMap),
  };
}

function compactSource(
  sourceKey: AddressCanonSource["sourceKind"],
  sourceMap: Map<AddressCanonSource["sourceKind"], AddressCanonSource>,
): AddressCanonSource[] {
  const source = sourceMap.get(sourceKey);
  return source ? [source] : [];
}

function normalizeDirectoryText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
