import { createSupabaseDataGateway } from "../../adapters/supabase/dataGateway.js";
import { readSupabaseDataGatewayEnv } from "../../adapters/supabase/dataGatewayClientFactory.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { AddressCanonLookupPort } from "../../domains/address-canon/ports.js";
import {
  createSupabaseAddressCanonLookupPort,
  type SupabaseAddressCanonLookupPort,
} from "../../adapters/supabase/address-canon/addressCanonLookup.js";

export type AddressCanonHandlerFactory = (
  lookupPort: AddressCanonLookupPort,
) => (req: VercelRequest, res: VercelResponse) => Promise<void>;

export function createHiddenAddressCanonRoute(factory: AddressCanonHandlerFactory) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const env = readSupabaseDataGatewayEnv();
    if (!env) {
      sendBffError(res, "INTERNAL", "Supabase service environment is not configured");
      return;
    }

    return createSupabaseDataGateway(env).asService(async (client) => {
      const lookupPort = createSupabaseAddressCanonLookupPort(client as never);
      const dataAvailable = await probeDataAvailable(lookupPort);
      // Frontend semantics: meta.dataAvailable === false -> "lookup temporarily
      // offline / directory not loaded"; meta.dataAvailable === true with empty
      // candidates -> "no match for this query". When the probe itself fails the
      // hint is omitted (left undefined) so a transient probe error never
      // mislabels a populated directory as offline.
      return factory(lookupPort)(req, withDataAvailableMeta(res, dataAvailable));
    });
  };
}

/**
 * Runs the port's cheap existence probe. A probe failure is swallowed and
 * returns `null` (hint omitted) — the actual lookup runs in the handler's own
 * try/catch, so the probe must never change the response status.
 */
async function probeDataAvailable(
  lookupPort: SupabaseAddressCanonLookupPort,
): Promise<boolean | null> {
  try {
    return await lookupPort.probeDataAvailable();
  } catch {
    return null;
  }
}

/**
 * Wraps `res.json` so any successful BFF envelope (`ok: true`) emitted by the
 * downstream handler gains `meta.dataAvailable`. The strict response schema lives
 * in `data`; `bffMetaSchema` has `.catchall(z.unknown())`, so attaching the hint
 * to `meta` (never `data`) keeps the contract valid. Error envelopes pass through
 * untouched. No-ops when `dataAvailable` is null (probe failed).
 */
function withDataAvailableMeta(
  res: VercelResponse,
  dataAvailable: boolean | null,
): VercelResponse {
  if (dataAvailable === null) return res;

  const originalJson = res.json.bind(res);
  res.json = function patchedJson(body: unknown): VercelResponse {
    if (isSuccessEnvelope(body)) {
      return originalJson({
        ...body,
        meta: { ...(body.meta as Record<string, unknown> | undefined), dataAvailable },
      });
    }
    return originalJson(body);
  };
  return res;
}

function isSuccessEnvelope(
  body: unknown,
): body is { ok: true; meta?: Record<string, unknown> } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { ok?: unknown }).ok === true
  );
}
