import { z } from "zod";
import { ACQUISITION_TERMS_CAPABILITY, type AcquisitionTerms } from "./contracts/acquisitionTerms.js";
import { acquisitionTermsSchema } from "./acquisitionTermsSchemas.js";
import type { AcquisitionFinancialPolicy } from "./acquisitionFinancialPolicy.js";
import { AcquisitionTermsError } from "./acquisitionTerms.js";
import { OFFER_POLICY_V2_READINESS_CONTRACT } from "./offerPolicyReadiness.js";
export const ACQUISITION_READINESS_CONTRACT = "commerce-acquisition-readiness.v1";

export interface AcquisitionReadinessEvidence extends Omit<AcquisitionTerms, "schemaVersion"> {
  contractVersion: typeof ACQUISITION_READINESS_CONTRACT;
  kind: "legacy_pair" | "v2_standalone";
  legacyPairCount: number;
  standaloneCount: number;
  nextBoundaryAt: string | null;
}

export interface AcquisitionOfferPolicyReadiness {
  contractVersion: typeof OFFER_POLICY_V2_READINESS_CONTRACT;
  ready: boolean;
  checkedAt: string;
  reasons: string[];
  evidence?: { acquisition: AcquisitionReadinessEvidence | null };
}

import type { OfferPolicyReadinessPort } from "./offerPolicyReadiness.js";

interface CacheEntry {
  expiresAtMs: number;
  readiness: AcquisitionOfferPolicyReadiness;
}

export interface AcquisitionReadinessCache {
  read(port: OfferPolicyReadinessPort): Promise<AcquisitionOfferPolicyReadiness>;
  clear(): void;
}

export function createAcquisitionReadinessCache<Row>(input: {
  policy: AcquisitionFinancialPolicy<Row>;
  now?: () => number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
}): AcquisitionReadinessCache {
  if (!input?.policy) throw new AcquisitionTermsError("acquisition_terms_policy_unconfigured");
  const now = input.now ?? Date.now;
  const positiveTtlMs = Math.min(60_000, Math.max(0, input.positiveTtlMs ?? 60_000));
  const negativeTtlMs = Math.min(5_000, Math.max(0, input.negativeTtlMs ?? 5_000));
  let cached: CacheEntry | null = null;
  let inFlight: Promise<AcquisitionOfferPolicyReadiness> | null = null;

  return {
    read(port) {
      const current = now();
      if (cached && cached.expiresAtMs > current) return Promise.resolve(cached.readiness);
      if (inFlight) return inFlight;
      const startedAtMs = current;
      inFlight = loadFailClosed(port)
        .then(async (readiness) => {
          // An RPC started before the boundary can finish after it. Re-read once;
          // never lend the old green result a fresh positive cache window.
          if (readiness.ready && boundaryMs(readiness) <= now()) readiness = await loadFailClosed(port);
          if (readiness.ready && boundaryMs(readiness) <= now()) readiness = unavailable("readiness_acquisition_boundary_elapsed");
          cached = {
            readiness,
            // Bound staleness from the start of the database read. A slow RPC
            // must consume the TTL, not extend a green decision past 60s.
            expiresAtMs: readiness.ready ? Math.min(startedAtMs + positiveTtlMs, boundaryMs(readiness))
              : startedAtMs + negativeTtlMs,
          };
          return readiness;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    clear() {
      cached = null;
      inFlight = null;
    },
  };
}

async function loadFailClosed(port: OfferPolicyReadinessPort): Promise<AcquisitionOfferPolicyReadiness> {
  try {
    const parsed = parseReadiness(await port.readOfferPolicyV2Readiness());
    return parsed ?? unavailable("readiness_contract_invalid");
  } catch {
    return unavailable("readiness_rpc_unavailable");
  }
}

function parseReadiness(value: unknown): AcquisitionOfferPolicyReadiness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.contractVersion !== OFFER_POLICY_V2_READINESS_CONTRACT ||
    typeof record.ready !== "boolean" ||
    typeof record.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(record.checkedAt)) ||
    !Array.isArray(record.reasons) ||
    !record.reasons.every((reason) => typeof reason === "string")
  ) return null;
  const evidence = record.evidence;
  let acquisition: AcquisitionReadinessEvidence | null | undefined;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence) && "acquisition" in evidence) {
    const raw = (evidence as Record<string, unknown>).acquisition;
    acquisition = raw === null && !record.ready ? null : parseAcquisitionEvidence(raw);
    if (acquisition === undefined) return null;
    if (record.ready && acquisition && (Date.parse(acquisition.effectiveFrom) > Date.parse(record.checkedAt)
      || acquisition.effectiveTo !== null && Date.parse(acquisition.effectiveTo) <= Date.parse(record.checkedAt)
      || acquisition.nextBoundaryAt !== null && Date.parse(acquisition.nextBoundaryAt) <= Date.parse(record.checkedAt))) return null;
  }
  return {
    contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
    ready: record.ready,
    checkedAt: record.checkedAt,
    reasons: record.reasons,
    ...(acquisition !== undefined ? { evidence: { acquisition } } : {}),
  };
}

function parseAcquisitionEvidence(value: unknown): AcquisitionReadinessEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { contractVersion, kind, legacyPairCount, standaloneCount, nextBoundaryAt, ...terms } = value as Record<string, unknown>;
  const parsed = acquisitionTermsSchema.safeParse({ ...terms, schemaVersion: ACQUISITION_TERMS_CAPABILITY });
  if (!parsed.success || contractVersion !== ACQUISITION_READINESS_CONTRACT
    || !(kind === "legacy_pair" && legacyPairCount === 1 && standaloneCount === 0
      || kind === "v2_standalone" && legacyPairCount === 0 && standaloneCount === 1)
    || !(nextBoundaryAt === null || z.string().datetime({ offset: true }).safeParse(nextBoundaryAt).success)
    || parsed.data.effectiveTo !== null && (nextBoundaryAt === null
      || Date.parse(nextBoundaryAt as string) > Date.parse(parsed.data.effectiveTo))) return undefined;
  const { schemaVersion: _schema, ...publicTerms } = parsed.data;
  return { ...publicTerms, contractVersion, kind, legacyPairCount, standaloneCount, nextBoundaryAt } as AcquisitionReadinessEvidence;
}

function boundaryMs(readiness: AcquisitionOfferPolicyReadiness): number {
  const boundary = readiness.evidence?.acquisition?.nextBoundaryAt;
  return boundary ? Date.parse(boundary) : Infinity;
}

function unavailable(reason: string): AcquisitionOfferPolicyReadiness {
  return {
    contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
    ready: false,
    checkedAt: new Date(0).toISOString(),
    reasons: [reason],
  };
}
